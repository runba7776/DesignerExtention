import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {createProvider,emptyUsage,OutputLimitError,type CompletionRequest} from '../server/providers.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {demoOutline} from '../server/demo.js';
import {parseDocument} from '../server/documents.js';
import {createApp} from '../server/app.js';
import {AppError} from '../server/errors.js';
import {PLAN_OUTPUT_TOKENS,PLAN_RETRY_OUTPUT_TOKENS} from '../shared/contracts.js';

const rendered={artifactId:'unused',pptxUrl:'unused',thumbnails:[],warnings:[],native:false};
const limit=(text='{"kind":"outline","outline":{"title":"PRIVATE_OUTPUT_SECRET')=>new OutputLimitError({...emptyUsage(),calls:1,inputTokens:100,outputTokens:16_000,cacheReadTokens:40},text);
async function local(dir:string){const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',designMode:'template',model:'mock',autoRepair:false});return settings;}

test('local output-limit signals preserve usage, remain distinct from input limits, and never retry themselves',async()=>{
  for(const kind of ['local'] as const){let calls=0;
    const provider=createProvider({provider:kind,model:'mock',mode:'presentation',endpoint:'http://127.0.0.1:11434/v1'},'not-real',async()=>{
      calls++;return new Response(JSON.stringify({choices:[{message:{content:'{"unfinished":'},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:16_000}}));
    });
    await assert.rejects(provider.complete({system:'test',content:'test',maxTokens:16_000}),error=>{assert.ok(error instanceof OutputLimitError);assert.equal(error.code,'OUTPUT_LIMIT');assert.equal(error.partialText,'{"unfinished":');assert.equal(error.usage.outputTokens,16_000);assert.match(error.message,/入力の文字数制限とは別/);return true;});assert.equal(calls,1);
  }
  const context=createProvider({provider:'local',designMode:'template',model:'mock',mode:'presentation',endpoint:'http://127.0.0.1:11434/v1'},undefined,async()=>new Response(JSON.stringify({choices:[{message:{content:''},finish_reason:'model_context_window_exceeded'}],usage:{prompt_tokens:100,completion_tokens:10}})));
  await assert.rejects(context.complete({system:'test',content:'test',maxTokens:16000}),error=>{assert.ok(error instanceof AppError);assert.equal(error.code,'CONTEXT_LIMIT');assert.ok(!(error instanceof OutputLimitError));return true;});
});

test('initial plan limit retains original instructions/sources/usage; explicit compact retry retains all 30 reading slides',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-plan-limit-'));
  try{
    const settings=await local(dir);await settings.update({mode:'reading',slideCount:30});
    const document=await parseDocument('条件.txt',Buffer.from('保存値=0012。比較期間は2026年。'));
    const outline=demoOutline('長い資料','reading',[],30);outline.inputBrief='読む資料、表紙込み30枚。保存値0012、比較期間2026年を保持。';
    const calls:CompletionRequest[]=[];const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async request=>{calls.push(request);if(calls.length===1)throw limit();return {text:JSON.stringify({kind:'outline',outline}),usage:{...emptyUsage(),calls:1,inputTokens:90,outputTokens:3000}};}})});
    const prompt='全ての条件を保持。'.repeat(1600),session=await engine.create({prompt},[document]);
    assert.equal(session.phase,'clarifying');assert.equal(session.messages[0].text,prompt);assert.equal(session.usage.calls,1);assert.equal(session.usage.outputTokens,16000);assert.equal(session.usage.cacheReadTokens,40);
    assert.equal(session.recovery?.retryAvailable,true);assert.equal(calls.length,1);assert.equal(engine.get(session.id),session);assert.equal(session.outline,undefined);assert.equal(session.variants.length,0);assert.ok(!JSON.stringify(session).includes('PRIVATE_OUTPUT_SECRET'));
    await assert.rejects(engine.generate(session.id),/先に構成案/);assert.equal(calls.length,1);
    const retried=await engine.retryPlan(session.id);assert.equal(retried.phase,'outline');assert.equal(retried.outline?.slides.length,30);assert.equal(retried.outline?.mode,'reading');assert.equal(retried.recovery,undefined);assert.equal(retried.usage.calls,2);assert.equal(retried.usage.inputTokens,190);assert.equal(retried.usage.outputTokens,19000);
    assert.equal(calls[0].maxTokens,PLAN_OUTPUT_TOKENS);assert.equal(calls[1].maxTokens,PLAN_RETRY_OUTPUT_TOKENS);assert.ok(calls[1].maxTokens>calls[0].maxTokens);
    const first=JSON.parse(calls[0].content),second=JSON.parse(calls[1].content);assert.equal(first.request.needsInputBrief,true);assert.equal(second.request.outputRetry,true);assert.equal(second.request.compactOutline,true);assert.deepEqual(second.request.messages,first.request.messages);assert.deepEqual(second.documents,first.documents);assert.ok(!calls[1].content.includes('PRIVATE_OUTPUT_SECRET'));assert.match(calls[1].system,/本文.*発表者ノート.*作りません/);
    await assert.rejects(engine.retryPlan(session.id),/指示がありません/);assert.equal(calls.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('repeated plan limits stop another unchanged retry, while a new instruction can revise the conditions',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-plan-repeated-'));
  try{
    const settings=await local(dir),outline=demoOutline('構成の確認','presentation',[]);let calls=0;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{calls++;if(calls<=2)throw limit();return {text:JSON.stringify({kind:'outline',outline}),usage:emptyUsage()};}})});
    const session=await engine.create({prompt:'詳細な資料を作る'},[]);await engine.retryPlan(session.id);assert.equal(calls,2);assert.equal(session.recovery?.retryAvailable,false);
    await assert.rejects(engine.retryPlan(session.id),/追加の呼び出しは行っていません/);assert.equal(calls,2);assert.equal(session.usage.calls,2);
    await engine.message(session.id,'構成は見出しと一文の役割だけ。');assert.equal(session.phase,'outline');assert.equal(calls,3);assert.equal(session.recovery,undefined);assert.equal(session.messages[0].text,'詳細な資料を作る');assert.equal(session.messages[1].text,'構成は見出しと一文の役割だけ。');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a follow-up plan limit keeps the answer once and checks provider changes before retrying',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-plan-answer-'));
  try{
    const settings=await local(dir);let calls=0;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{calls++;if(calls===1)return {text:JSON.stringify({kind:'questions',message:'読み手は？'}),usage:emptyUsage()};throw limit();}})});
    const session=await engine.create({prompt:'説明したい'},[]);await engine.message(session.id,'学生向けの読む資料');assert.equal(session.messages.filter(m=>m.text==='学生向けの読む資料').length,1);assert.equal(calls,2);assert.ok(session.recovery);
    await settings.update({provider:'chat'});await assert.rejects(engine.retryPlan(session.id),/処理先が変更/);assert.equal(calls,2);assert.equal(session.usage.calls,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('complete JSON at the output boundary is validated and used; incomplete or schema-invalid plans are not exposed',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-plan-boundary-'));
  try{
    const settings=await local(dir),outline=demoOutline('境界の確認','presentation',[]);
    const good=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{throw limit(JSON.stringify({kind:'outline',outline}));}})});
    const session=await good.create({prompt:'説明する'},[]);assert.equal(session.phase,'outline');assert.equal(session.usage.calls,1);assert.equal(session.usage.outputTokens,16000);assert.equal(session.recovery,undefined);
    const bad=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{throw limit(JSON.stringify({kind:'outline',outline:{...outline,slides:outline.slides.slice(0,1)}}));}})});
    await assert.rejects(bad.create({prompt:'説明する'},[]),/2〜30枚/);
    const network=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{throw new Error('network-test');}})});await assert.rejects(network.create({prompt:'説明する'},[]),/network-test/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('HTTP plan recovery returns only safe session content and supports one authenticated user retry',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-plan-http-')),server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token='q'.repeat(64);let calls=0;
  try{
    const app=await createApp({authToken:token,port,dataDir:dir,webRoot:dir,artifactRoot:dir,environmentKey:'',nativeAvailable:()=>false,render:async()=>rendered,providerFactory:()=>({complete:async()=>{calls++;if(calls===1)throw limit();return {text:JSON.stringify({kind:'outline',outline:demoOutline('復元した構成','presentation',[])}),usage:emptyUsage()};}})});server.on('request',app);
    const bootstrap=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    await fetch(origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({provider:'local',designMode:'template',model:'mock',autoRepair:false})});
    const created=await fetch(origin+'/api/sessions',{method:'POST',headers,body:JSON.stringify({prompt:'入力を残して作成'})});assert.equal(created.status,200);const session=await created.json() as any;assert.equal(session.usage.calls,1);assert.equal(session.recovery.task,'plan');assert.ok(!JSON.stringify(session).includes('PRIVATE_OUTPUT_SECRET'));
    assert.equal((await fetch(origin+`/api/sessions/${session.id}/retry-plan`,{method:'POST'})).status,401);assert.equal(calls,1);
    const retry=await fetch(origin+`/api/sessions/${session.id}/retry-plan`,{method:'POST',headers,body:'{}'});assert.equal(retry.status,200);assert.equal((await retry.json() as any).phase,'outline');assert.equal(calls,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
