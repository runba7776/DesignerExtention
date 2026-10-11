import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {HistoryStore} from '../server/history.js';
import {demoOutline,demoDeck} from '../server/demo.js';
import {createProvider,emptyUsage,type CompletionRequest} from '../server/providers.js';
import type {Session,SubscriptionService,RenderResult} from '../shared/contracts.js';

const render=async():Promise<RenderResult>=>({artifactId:'sample',pptxUrl:'/api/artifacts/sample/presentation.pptx',thumbnails:[],native:false,warnings:[]});
async function fixture(count=6){
  const directory=await mkdtemp(path.join(tmpdir(),'de-subscription-engine-'));
  const settings=await new SettingsStore(directory,'DO_NOT_IMPORT_ENV_SECRET').load();
  await settings.update({provider:'subscription',subscriptionService:'chatgpt',slideCount:count,autoRepair:false,designMode:'template'});
  const bindings:Partial<Record<SubscriptionService,string>>={chatgpt:'opaque-account-A-generation-1',claude:'opaque-claude-generation-1'};
  const calls:CompletionRequest[]=[];
  const outline=demoOutline('説明する内容','presentation',[],count),deck=demoDeck(outline);
  let afterComplete:(()=>void)|undefined;
  const engine=new SessionEngine({settings,dataDir:directory,render,subscriptionBinding:service=>bindings[service],providerFactory:(snapshot)=>({complete:async(request)=>{
    assert.equal(snapshot.provider,'subscription');assert.equal(snapshot.subscriptionService,'chatgpt');calls.push(request);
    const input=JSON.parse(request.content).request;
    const result=input.targetSlides?{...deck,slides:deck.slides.filter(slide=>input.targetSlides.some((target:any)=>target.id===slide.id))}:input.targetSlide?input.targetSlide:{kind:'outline',outline};
    afterComplete?.();return {text:JSON.stringify(result),usage:{...emptyUsage(),calls:1,inputTokens:12,outputTokens:24}};
  }})});
  return {directory,settings,bindings,calls,outline,deck,engine,setAfterComplete:(callback?:()=>void)=>{afterComplete=callback;},dispose:()=>rm(directory,{recursive:true,force:true})};
}
const errorCode=(expected:string)=>(error:unknown)=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code===expected);

test('subscription settings preserve manual default, select auto model, reject unsupported service and exclude credentials',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'de-subscription-settings-'));
  try{
    const store=await new SettingsStore(directory,'DO_NOT_IMPORT_ENV_SECRET').load();assert.equal(store.get().provider,'chat');
    let next=await store.update({provider:'subscription',subscriptionService:'chatgpt',apiKey:'DO_NOT_PERSIST_KEY'});
    assert.equal(next.provider,'subscription');assert.equal(next.model,'auto');assert.equal(next.subscriptionService,'chatgpt');assert.equal(next.hasKey,false);
    await store.update({model:'explicit-model'});next=await store.update({subscriptionService:'claude'});assert.equal(next.model,'auto');
    assert.equal((await new SettingsStore(directory).load()).get().subscriptionService,'claude');
    await assert.rejects(store.update({subscriptionService:'public-untrusted-service'}));
    await assert.rejects(store.update({provider:'claude'}),errorCode('PAID_API_DISABLED'));
    const file=await readFile(path.join(directory,'settings.json'),'utf8');assert.doesNotMatch(file,/DO_NOT_|apiKey|accessToken|refreshToken|binding|hasKey/);
    assert.throws(()=>createProvider({...next,provider:'subscription'}),errorCode('SUBSCRIPTION_CONNECTION_REQUIRED'));
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('subscription creation requires explicit cloud consent and connected account before constructing provider',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.engine.create({prompt:'秘密の資料を説明'},[]),errorCode('CLOUD_CONSENT_REQUIRED'));assert.equal(f.calls.length,0);
    delete f.bindings.chatgpt;await assert.rejects(f.engine.create({prompt:'秘密の資料を説明',cloudConsent:true},[]),errorCode('SUBSCRIPTION_CONNECTION_REQUIRED'));assert.equal(f.calls.length,0);
    f.bindings.chatgpt='opaque-account-A-generation-2';
    const session=await f.engine.create({prompt:'資料を説明',cloudConsent:true},[]);
    assert.equal(session.provider,'subscription');assert.equal(session.subscriptionService,'chatgpt');assert.equal(session.phase,'outline');assert.equal(session.chatHandoff,undefined);assert.equal(f.calls.length,1);
    await f.engine.generate(session.id);assert.equal(session.phase,'ready');assert.equal(f.calls.length,2);assert.equal(session.usage.calls,2);
    const saved=await readFile(path.join(f.directory,'presentations',session.historyId+'.json'),'utf8');assert.doesNotMatch(saved,/opaque-account|subscriptionBinding|accessToken|refreshToken/);assert.equal(JSON.parse(saved).session.subscriptionService,'chatgpt');
  }finally{await f.dispose();}
});

test('existing work rejects account switching, disconnection and service switching without any additional call',async()=>{
  const f=await fixture();try{
    const session=await f.engine.create({prompt:'送信先を固定する',cloudConsent:true},[]);
    const original=f.bindings.chatgpt;f.bindings.chatgpt='opaque-account-B';
    await assert.rejects(f.engine.generate(session.id),errorCode('SUBSCRIPTION_ACCOUNT_CHANGED'));
    await assert.rejects(f.engine.cloudConsent(session.id),errorCode('SUBSCRIPTION_ACCOUNT_CHANGED'));
    delete f.bindings.chatgpt;await assert.rejects(f.engine.message(session.id,'追加の指示'),errorCode('SUBSCRIPTION_CONNECTION_REQUIRED'));
    f.bindings.chatgpt=original;await f.settings.update({subscriptionService:'claude'});
    await assert.rejects(f.engine.message(session.id,'追加の指示'),errorCode('SUBSCRIPTION_SERVICE_CHANGED'));
    assert.equal(f.calls.length,1);assert.equal(session.usage.calls,1);assert.equal(session.messages[0].text,'送信先を固定する');
  }finally{await f.dispose();}
});

test('binding is rechecked between generation batches, preventing a second batch going to another account',async()=>{
  const f=await fixture(9);try{
    const session=await f.engine.create({prompt:'9枚で説明',cloudConsent:true},[]);
    f.setAfterComplete(()=>{f.bindings.chatgpt='changed-after-first-batch';});
    await assert.rejects(f.engine.generate(session.id),errorCode('SUBSCRIPTION_ACCOUNT_CHANGED'));
    assert.equal(f.calls.length,2);assert.equal(session.usage.calls,2);assert.notEqual(session.phase,'ready');assert.equal(session.variants.length,0);
  }finally{await f.dispose();}
});

test('restored history is viewable offline and requires new consent with a stable binding before remote changes',async()=>{
  const f=await fixture();try{
    const history=new HistoryStore(f.directory);
    const ready:Session={id:randomUUID(),provider:'subscription',subscriptionService:'claude',phase:'ready',messages:[{role:'user',text:'過去の指示'}],outline:f.outline,variants:[{id:'variant-a',label:'A',deck:f.deck}],usage:emptyUsage(),warnings:[]};
    Object.assign(ready,{apiKey:'HISTORY_SECRET',subscriptionBinding:'ACCOUNT_ID_PRIVATE',accessToken:'TOKEN_PRIVATE'});
    const saved=await history.save(ready,[]);assert.equal(saved.session.subscriptionService,'claude');
    const restored=(await f.engine.restoreHistory(saved.id)).session;
    assert.equal(restored.phase,'ready');assert.equal(restored.subscriptionService,'chatgpt');assert.equal(restored.cloudConsentRequired,true);
    await assert.rejects(f.engine.message(restored.id,'説明を変えて'),errorCode('CLOUD_CONSENT_REQUIRED'));assert.equal(f.calls.length,0);
    await f.engine.cloudConsent(restored.id);await f.engine.message(restored.id,'説明を変えて');assert.equal(f.calls.length,1);
    delete f.bindings.chatgpt;
    const disconnected=(await f.engine.restoreHistory(saved.id)).session;assert.equal(disconnected.phase,'ready');assert.equal(disconnected.cloudConsentRequired,true);
    await assert.rejects(f.engine.cloudConsent(disconnected.id),errorCode('SUBSCRIPTION_CONNECTION_REQUIRED'));
    f.bindings.chatgpt='account-reconnected';await assert.rejects(f.engine.cloudConsent(disconnected.id),errorCode('SUBSCRIPTION_ACCOUNT_CHANGED'));
    const reopened=(await f.engine.restoreHistory(saved.id)).session;await f.engine.cloudConsent(reopened.id);assert.equal(reopened.cloudConsentRequired,false);
    const raw=await readFile(path.join(f.directory,'presentations',saved.id+'.json'),'utf8');assert.doesNotMatch(raw,/HISTORY_SECRET|ACCOUNT_ID_PRIVATE|TOKEN_PRIVATE|subscriptionBinding|accessToken|apiKey/);
  }finally{await f.dispose();}
});
