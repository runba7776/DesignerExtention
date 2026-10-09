import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {demoOutline,demoDeck} from '../server/demo.js';
import {emptyUsage,OutputLimitError,type CompletionRequest} from '../server/providers.js';
import {AppError} from '../server/errors.js';
import {parseDocument} from '../server/documents.js';
import {assertTextFits} from '../server/text-fit.js';
import {createApp} from '../server/app.js';
import type {DeckSpec,Outline,Session} from '../shared/contracts.js';

const render=async()=>({artifactId:'test',pptxUrl:'test.pptx',thumbnails:[],warnings:[],native:false});
const usage={...emptyUsage(),calls:1,inputTokens:10,outputTokens:20};
const limit=()=>new OutputLimitError({...usage,outputTokens:8000},'{"title":"PRIVATE_UNFINISHED_DO_NOT_REPEAT');
const reply=(value:unknown)=>({text:JSON.stringify(value),usage});
async function fixture(count=3,mode:'presentation'|'reading'='presentation'){
  const dir=await mkdtemp(path.join(tmpdir(),'de-auto-repair-')),settings=await new SettingsStore(dir,'').load();
  await settings.update({provider:'local',model:'mock',slideCount:count,mode});
  const outline=demoOutline('自動対処の検証',mode,[],count),deck=demoDeck(outline);
  return {dir,settings,outline,deck,dispose:()=>rm(dir,{recursive:true,force:true})};
}
async function ready(f:Awaited<ReturnType<typeof fixture>>,revision:(r:CompletionRequest)=>Promise<ReturnType<typeof reply>>){
  const calls:CompletionRequest[]=[];
  const engine=new SessionEngine({settings:f.settings,dataDir:f.dir,render,providerFactory:()=>({complete:async r=>{
    calls.push(r);const req=JSON.parse(r.content).request;
    if(req.targetSlides)return reply({...f.deck,slides:req.targetSlides.map((s:any)=>f.deck.slides.find(d=>d.id===s.id))});
    if(req.messages)return reply({kind:'outline',outline:f.outline});
    return revision(r);
  }})});
  const session=await engine.create({prompt:'数字と単位を保持してください'},[]);await engine.generate(session.id);return {engine,session,calls};
}

test('revision automatically recovers once, retains instructions/numbers and atomically updates both variants',async()=>{
  const f=await fixture();try{
    let revisionCalls=0;const corrected={...f.deck.slides[1],title:'更新した読み取り'};
    const {engine,session,calls}=await ready(f,async r=>{revisionCalls++;if(revisionCalls===1)throw limit();assert.equal(session.variants[0].deck.slides[1].title,f.deck.slides[1].title);return reply(corrected);});
    await engine.variants(session.id);for(const variant of session.variants)await engine.render(session.id,variant.id);
    const others=session.variants.map(v=>structuredClone(v.deck.slides[2])),oldLayout=session.variants[1].deck.slides[1].layoutId;
    await engine.revise(session.id,{variantId:session.variants[1].id,slideId:'slide-2',instruction:'数字24、42、58は保持。見出しを変える。'});
    assert.equal(revisionCalls,2);assert.equal(session.repairReport?.retries,1);assert.equal(session.repairReport?.apiCalls,2);assert.equal(session.repairReport?.status,'recovered');assert.equal(session.recovery,undefined);
    assert.deepEqual(session.repairReport?.changes,['見出し',...(oldLayout!==session.variants[1].deck.slides[1].layoutId?['構図']:[])]);
    assert.equal(calls[2].maxTokens,8000);assert.equal(calls[3].maxTokens,16000);assert.equal(JSON.parse(calls[3].content).request.compactOutput,true);
    assert.equal(JSON.parse(calls[3].content).request.instruction,JSON.parse(calls[2].content).request.instruction);assert.equal(JSON.parse(calls[3].content).request.repair.reason,'OUTPUT_LIMIT');assert.ok(!calls[3].content.includes('PRIVATE_UNFINISHED'));
    for(const [i,v] of session.variants.entries()){assert.equal(v.deck.slides[1].title,corrected.title);assert.deepEqual(v.deck.slides[1].chart,f.deck.slides[1].chart);assert.deepEqual(v.deck.slides[2],others[i]);assert.equal(v.render,undefined);assertTextFits(v.deck);}
    const stored=await readFile(path.join(f.dir,'presentations',session.historyId!+'.json'),'utf8');assert.match(stored,/自動対処1回/);assert.doesNotMatch(stored,/PRIVATE_UNFINISHED/);
  }finally{await f.dispose();}
});

test('three failed revision responses stop without modifying slides or exports and block unchanged replay',async()=>{
  const f=await fixture();try{
    let revisions=0;const {engine,session}=await ready(f,async()=>{revisions++;throw limit();});
    await engine.render(session.id,session.variants[0].id);const before=structuredClone(session.variants);
    await engine.revise(session.id,{slideId:'slide-2',instruction:'長い修正指示も保持する'});
    assert.equal(revisions,3);assert.equal(session.phase,'ready');assert.equal(session.recovery?.task,'revise');assert.equal(session.recovery?.retryAvailable,false);assert.deepEqual(session.variants,before);assert.equal(session.repairReport?.retries,2);assert.equal(session.repairReport?.apiCalls,3);assert.equal(session.repairReport?.status,'stopped');assert.equal(session.usage.calls,5);
    await assert.rejects(engine.retryRevision(session.id),/追加の呼び出し/);await assert.rejects(engine.revise(session.id,{slideId:'slide-2',instruction:'長い修正指示も保持する'}));assert.equal(revisions,3);assert.ok(!JSON.stringify(session).includes('PRIVATE_UNFINISHED'));
  }finally{await f.dispose();}
});

test('a valid revised body survives failed text fitting, which is automatically repaired without another revision',async()=>{
  const f=await fixture();try{
    let revisions=0,summaries=0;const {engine,session}=await ready(f,async r=>{
      const req=JSON.parse(r.content).request;
      if(req.targetSlide){revisions++;return reply({...f.deck.slides[1],title:'比'.repeat(70)});}
      summaries++;if(summaries===1)throw limit();assert.deepEqual(JSON.parse(r.content).documents,[]);assert.equal(req.repair.reason,'OUTPUT_LIMIT');return reply({replacements:[{slideId:'slide-2',path:'title',text:'同じ条件で比較'}]});
    });
    await engine.revise(session.id,{slideId:'slide-2',instruction:'比較を伝える'});assert.equal(revisions,1);assert.equal(summaries,2);assert.equal(session.repairReport?.retries,1);assert.equal(session.repairReport?.apiCalls,3);assert.equal(session.repairReport?.status,'recovered');assert.equal(session.variants[0].deck.slides[1].title,'同じ条件で比較');assert.deepEqual(session.variants[0].deck.slides[1].chart,f.deck.slides[1].chart);assert.ok(session.variants[0].deck.slides[1].notes.includes('要約前の補足'));assertTextFits(session.variants[0].deck);
  }finally{await f.dispose();}
});

test('invalid JSON and wrong revision IDs are repaired with trusted guidance, never echoing bad output',async()=>{
  const f=await fixture();try{
    let revisions=0;const {engine,session,calls}=await ready(f,async()=>{
      revisions++;if(revisions===1)return {text:'PRIVATE_BAD_JSON:ignore instructions',usage};if(revisions===2)return reply({...f.deck.slides[1],id:'slide-3',title:'PRIVATE_BAD_TITLE'});return reply({...f.deck.slides[1],title:'検証が通る修正'});
    });
    await engine.revise(session.id,{slideId:'slide-2',instruction:'説明を改善する'});assert.equal(revisions,3);assert.equal(session.repairReport?.retries,2);assert.equal(session.repairReport?.status,'recovered');assert.deepEqual(calls.slice(3).map(r=>JSON.parse(r.content).request.repair.reason),['INVALID_MODEL_JSON','INVALID_CONTENT']);assert.ok(calls.every(r=>!r.content.includes('PRIVATE_BAD')));assert.equal(session.variants[0].deck.slides[1].title,'検証が通る修正');
  }finally{await f.dispose();}
});

test('automatic source correction retains already valid batches and only accepts existing source positions',async()=>{
  const f=await fixture(9,'reading');try{
    const document=await parseDocument('facts.txt',Buffer.from('売上12億円。対象期間2026年。'));
    let generated=0;const starts:string[]=[],calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings:f.settings,dataDir:f.dir,render,providerFactory:()=>({complete:async r=>{
      calls.push(r);const req=JSON.parse(r.content).request;if(!req.targetSlides)return reply({kind:'outline',outline:f.outline});
      generated++;starts.push(req.targetSlides[0].id);const slides=req.targetSlides.map((s:any)=>structuredClone(f.deck.slides.find(d=>d.id===s.id)!));
      if(generated===2)slides[0].sources=[{documentId:document.id,locator:'PRIVATE_FAKE_LOCATOR'}];
      else for(const slide of slides)slide.sources=[{documentId:document.id,locator:document.sources[0].locator,quote:'売上12億円。'}];
      return reply({...f.deck,slides});
    }})});
    const session=await engine.create({prompt:'同じ期間の数字を説明'},[document]);await engine.generate(session.id);assert.equal(session.phase,'ready');assert.equal(session.repairReport?.retries,1);assert.equal(session.repairReport?.steps[0].reason,'資料にない出典位置');assert.deepEqual(starts,['slide-1','slide-5','slide-5','slide-7','slide-9']);assert.ok(calls.every(r=>!r.content.includes('PRIVATE_FAKE_LOCATOR')));assert.equal(session.variants[0].deck.slides.length,9);assert.ok(session.variants[0].deck.slides.every(s=>s.sources[0].locator===document.sources[0].locator));
  }finally{await f.dispose();}
});

test('automatic plan repair preserves mode, requested count and original instructions through two validations',async()=>{
  const f=await fixture(9,'reading');try{
    const calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings:f.settings,dataDir:f.dir,render,providerFactory:()=>({complete:async r=>{
      calls.push(r);if(calls.length===1)return reply({kind:'outline',outline:{...f.outline,mode:'presentation'}});if(calls.length===2)return reply({kind:'outline',outline:demoOutline('誤った枚数','reading',[],6)});return reply({kind:'outline',outline:f.outline});
    }})});
    const session=await engine.create({prompt:'表紙込み9枚。読む資料。必須条件は保持。'},[]);assert.equal(session.phase,'outline');assert.equal(session.outline?.slides.length,9);assert.equal(session.outline?.mode,'reading');assert.equal(session.repairReport?.retries,2);assert.equal(session.repairReport?.apiCalls,3);assert.equal(session.repairReport?.status,'recovered');assert.ok(calls.every(r=>JSON.parse(r.content).request.messages[0].text===session.messages[0].text));assert.deepEqual(calls.slice(1).map(r=>JSON.parse(r.content).request.repair.reason),['INVALID_CONTENT','SLIDE_COUNT_MISMATCH']);
  }finally{await f.dispose();}
});

test('the two-retry budget spans generation and text fitting, and explicit resume retains all completed bodies',async()=>{
  const f=await fixture(3,'reading');try{
    let generated=0,summaries=0;const targets:string[]=[],calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings:f.settings,dataDir:f.dir,render,providerFactory:()=>({complete:async r=>{
      calls.push(r);const req=JSON.parse(r.content).request;if(req.messages&&!req.targetSlides)return reply({kind:'outline',outline:f.outline});
      if(req.targetSlides){generated++;targets.push(req.targetSlides[0].id);if(generated===1)return {text:'broken JSON',usage};if(generated===3)throw limit();const slides=req.targetSlides.map((s:any)=>({...f.deck.slides.find(d=>d.id===s.id)!,title:'比'.repeat(70)}));return reply({...f.deck,slides});}
      summaries++;if(summaries===1)throw limit();return reply({replacements:req.slides.map((s:any)=>({slideId:s.slideId,path:'title',text:'比較条件を確認'}))});
    }})});
    const session=await engine.create({prompt:'3枚で比較'},[]);await engine.generate(session.id);assert.equal(session.recovery?.stage,'text-fit');assert.equal(session.repairReport?.status,'stopped');assert.equal(session.repairReport?.retries,2);assert.equal(summaries,1);assert.equal(generated,5);assert.equal(session.recovery?.completedSlides,3);
    await engine.generate(session.id);assert.equal(generated,5);assert.equal(session.phase,'ready');assert.deepEqual(targets,['slide-1','slide-1','slide-2','slide-2','slide-3']);assertTextFits(session.variants[0].deck);
  }finally{await f.dispose();}
});

test('non-repairable transport/context errors never trigger another provider call or alter the deck',async()=>{
  for(const code of ['PROVIDER_CONNECTION','PROVIDER_RESPONSE','CONTEXT_LIMIT','CLOUD_CONSENT_REQUIRED']){
    const f=await fixture();try{
      let revisions=0;const {engine,session}=await ready(f,async()=>{revisions++;throw new AppError(502,'接続または入力を確認',code);});const before=structuredClone(session.variants);
      await assert.rejects(engine.revise(session.id,{slideId:'slide-2',instruction:'説明を改善'}));assert.equal(revisions,1);assert.equal(session.repairReport,undefined);assert.deepEqual(session.variants,before);
    }finally{await f.dispose();}
  }
});

test('automatic repair can be disabled for an active session, and saved instructions can resume explicitly',async()=>{
  const f=await fixture();try{
    assert.equal(f.settings.get().autoRepair,true);await assert.rejects(f.settings.update({autoRepair:'true'}));
    let revisions=0;const {engine,session}=await ready(f,async()=>{revisions++;if(revisions===1)throw limit();return reply({...f.deck.slides[1],title:'手動の再開で修正'});});
    await f.settings.update({autoRepair:false});assert.equal((await new SettingsStore(f.dir,'').load()).get().autoRepair,false);
    await engine.revise(session.id,{slideId:'slide-2',instruction:'保存して再開する修正'});assert.equal(revisions,1);assert.equal(session.repairReport,undefined);assert.equal(session.recovery?.retryAvailable,true);
    await engine.retryRevision(session.id);assert.equal(revisions,2);assert.equal(session.recovery,undefined);assert.equal(session.variants[0].deck.slides[1].title,'手動の再開で修正');assert.equal(session.messages.filter(m=>m.text.includes('の修正: 保存して再開する修正')).length,1);
  }finally{await f.dispose();}
});

test('automatic retries respect total usage cap, provider changes and consent guards',async()=>{
  const f=await fixture();try{
    let revisions=0;const {engine,session}=await ready(f,async()=>{revisions++;throw limit();});session.usage.calls=11;
    await engine.revise(session.id,{slideId:'slide-2',instruction:'費用上限の検証'});assert.equal(revisions,1);assert.equal(session.usage.calls,12);assert.equal(session.recovery?.retryAvailable,false);assert.equal(session.repairReport,undefined);
    await f.settings.update({provider:'chat'});const before=revisions;await assert.rejects(engine.revise(session.id,{slideId:'slide-2',instruction:'処理先を確認'}),/処理先が変更/);assert.equal(revisions,before);
    await f.settings.update({provider:'local',model:'mock'});const restored=await engine.restoreHistory(session.historyId!);restored.session.cloudConsentRequired=true;await assert.rejects(engine.revise(restored.session.id,{slideId:'slide-2',instruction:'送信同意が必要'}),/送ることを確認/);assert.equal(revisions,before);
  }finally{await f.dispose();}
});

test('automatic generation finishes a closed slide prefix without an extra model call',async()=>{
  const f=await fixture(2,'reading');try{
    let calls=0;const engine=new SessionEngine({settings:f.settings,dataDir:f.dir,render,providerFactory:()=>({complete:async()=>{calls++;if(calls===1)return reply({kind:'outline',outline:f.outline});throw new OutputLimitError(usage,JSON.stringify(f.deck).slice(0,-2));}})});
    const session=await engine.create({prompt:'2枚で説明'},[]);await engine.generate(session.id);assert.equal(calls,2);assert.equal(session.phase,'ready');assert.equal(session.repairReport?.retries,0);assert.equal(session.repairReport?.apiCalls,1);assert.equal(session.repairReport?.status,'recovered');assert.equal(session.variants[0].deck.slides.length,2);
  }finally{await f.dispose();}
});

test('pending revision is invalidated by a changed deck before any additional model call',async()=>{
  const f=await fixture();try{
    await f.settings.update({autoRepair:false});let revisions=0;const {engine,session}=await ready(f,async()=>{revisions++;throw limit();});
    await engine.revise(session.id,{slideId:'slide-2',instruction:'保持して後で修正'});await engine.changeTheme(session.id,{themeId:'midnight'});
    await assert.rejects(engine.retryRevision(session.id),/資料が変更/);assert.equal(revisions,1);assert.equal(session.variants[0].deck.themeId,'midnight');
  }finally{await f.dispose();}
});

test('concurrent revision requests do not duplicate calls or consume another automatic repair budget',async()=>{
  const f=await fixture();try{
    let release!:()=>void,entered!:()=>void,calls=0;const waiting=new Promise<void>(resolve=>release=resolve),started=new Promise<void>(resolve=>entered=resolve);
    const {engine,session}=await ready(f,async()=>{calls++;if(calls===1){entered();await waiting;throw limit();}return reply({...f.deck.slides[1],title:'単一の操作で完了'});});
    const operation=engine.revise(session.id,{slideId:'slide-2',instruction:'修正'});await started;
    await assert.rejects(engine.revise(session.id,{slideId:'slide-2',instruction:'修正'}),/処理中/);assert.equal(calls,1);release();await operation;assert.equal(calls,2);assert.equal(session.repairReport?.retries,1);assert.equal(session.variants[0].deck.slides[1].title,'単一の操作で完了');
  }finally{await f.dispose();}
});

test('authenticated HTTP revision keeps the deck and safe instructions on failure, then resumes only on request',async()=>{
  const f=await fixture(),server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token='q'.repeat(64);let revisions=0;
  try{
    const app=await createApp({authToken:token,port,dataDir:f.dir,webRoot:f.dir,artifactRoot:path.join(f.dir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,render,providerFactory:()=>({complete:async r=>{
      const req=JSON.parse(r.content).request;if(req.targetSlides)return reply({...f.deck,slides:req.targetSlides.map((s:any)=>f.deck.slides.find(d=>d.id===s.id))});
      if(!req.targetSlide)return reply({kind:'outline',outline:f.outline});revisions++;if(revisions===1)throw limit();assert.equal(req.instruction,'保持する修正指示');return reply({...req.targetSlide,title:'HTTPで修正を再開'});
    }})});server.on('request',app);
    const bootstrap=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],headers={cookie,origin,'content-type':'application/json'};
    await fetch(origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({autoRepair:false})});
    const session=await (await fetch(origin+'/api/sessions',{method:'POST',headers,body:JSON.stringify({prompt:'3枚'})})).json() as Session;
    const base=origin+'/api/sessions/'+session.id;
    const made=await (await fetch(base+'/generate',{method:'POST',headers,body:'{}'})).json() as Session;
    const revision=await fetch(base+'/revise',{method:'POST',headers,body:JSON.stringify({slideId:'slide-2',instruction:'保持する修正指示'})});assert.equal(revision.status,200);
    const stopped=await revision.json() as Session;assert.equal(stopped.recovery?.task,'revise');assert.deepEqual(stopped.variants,made.variants);assert.ok(!JSON.stringify(stopped).includes('PRIVATE_UNFINISHED'));assert.equal(revisions,1);
    assert.equal((await fetch(base+'/retry-revision',{method:'POST'})).status,401);assert.equal(revisions,1);
    const resumed=await fetch(base+'/retry-revision',{method:'POST',headers,body:'{}'});assert.equal(resumed.status,200);const done=await resumed.json() as Session;assert.equal(done.recovery,undefined);assert.equal(done.variants[0].deck.slides[1].title,'HTTPで修正を再開');assert.equal(revisions,2);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.dispose();}
});
