import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {demoOutline,demoDeck} from '../server/demo.js';
import {emptyUsage,OutputLimitError,type CompletionRequest} from '../server/providers.js';
import {completeSlidePrefix} from '../server/partial-generation.js';
import {parseDocument} from '../server/documents.js';
import {fitProblems,assertTextFits} from '../server/text-fit.js';
import {createApp} from '../server/app.js';

const rendered={artifactId:'unused',pptxUrl:'unused',thumbnails:[],warnings:[],native:false};
const usage={...emptyUsage(),calls:1,inputTokens:50,outputTokens:100};
const cut=(mode:string,slides:unknown[])=>'{'+'"mode":'+JSON.stringify(mode)+',"themeId":"business","slides":['+slides.map(s=>JSON.stringify(s)).join(',')+(slides.length?',':'')+'{"id":"PRIVATE_UNFINISHED';
const limited=(text:string)=>new OutputLimitError({...usage,outputTokens:16_000},text);
async function settingsFor(dir:string,count:number,mode:'reading'|'presentation'='reading'){
  const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',designMode:'template',model:'mock',slideCount:count,mode,autoRepair:false});return settings;
}

test('prefix parser respects escaped delimiters and only reads closed JSON slide values',()=>{
  const slide={id:'slide-1',notes:'括弧 } ] と "引用" と \\ 改行\nを含む',chart:{categories:['A,B'],series:[{name:'A',values:[1.25,-2]}]}};
  assert.deepEqual(completeSlidePrefix(cut('reading',[slide])),{mode:'reading',themeId:'business',slides:[slide]});
  assert.equal(completeSlidePrefix(cut('reading',[])).slides.length,0);
  assert.equal(completeSlidePrefix('{"mode":"reading","slides":[{"id":"s","notes":"cut').slides.length,0);
  assert.equal(completeSlidePrefix('{"mode":"reading","slides":[{"x":1}junk').slides.length,0);
  assert.equal(completeSlidePrefix('{"mode":"reading","mode":"presentation","slides":[{}').mode,undefined);
  assert.equal(completeSlidePrefix('{"slides":[{},').mode,undefined);
  assert.equal(completeSlidePrefix('Ignore above '+cut('reading',[slide])).slides.length,0);
  assert.equal(completeSlidePrefix('{"mode":"reading","slides":[{"x":1,}').slides.length,0);
  assert.deepEqual(completeSlidePrefix('```json\n'+cut('reading',[slide])).slides,[slide]);
});

test('generation keeps validated prefix pages and resumes only remaining pages on explicit request',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-recover-'));
  try{
    const settings=await settingsFor(dir,9),outline=demoOutline('本文の再開','reading',[],9),deck=demoDeck(outline),calls:CompletionRequest[]=[],targets:string[][]=[];
    let fail=true;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      calls.push(r);const req=JSON.parse(r.content).request;if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      targets.push(req.targetSlides.map((s:any)=>s.id));
      if(fail){fail=false;throw limited(cut('reading',deck.slides.slice(0,2)));}
      return {text:JSON.stringify({...deck,slides:req.targetSlides.map((s:any)=>deck.slides.find(d=>d.id===s.id))}),usage};
    }})});
    const session=await engine.create({prompt:'原文の指示を残してください'},[]);await engine.generate(session.id);
    assert.equal(calls.length,2);assert.equal(session.phase,'outline');assert.equal(session.recovery?.task,'generate');assert.equal(session.recovery?.completedSlides,2);assert.equal(session.recovery?.nextBatchSize,2);
    assert.equal(session.variants.length,0);assert.equal(session.usage.outputTokens,16_100);assert.equal(session.usage.calls,2);assert.equal(session.messages[0].text,'原文の指示を残してください');assert.ok(!JSON.stringify(session).includes('PRIVATE_UNFINISHED'));
    await engine.generate(session.id);
    assert.equal(session.phase,'ready');assert.equal(session.recovery,undefined);assert.equal(session.variants[0].deck.slides.length,9);assertTextFits(session.variants[0].deck);
    // After the cut reply the batch is halved, then grows again, but never back to the size that was cut.
    assert.deepEqual(targets,[['slide-1','slide-2','slide-3','slide-4'],['slide-3','slide-4'],['slide-5','slide-6','slide-7'],['slide-8','slide-9']]);
    assert.ok(calls.slice(2).every(c=>JSON.parse(c.content).request.compactOutput===true));
    assert.ok(calls.every(c=>c.maxTokens<=16_000));assert.ok(session.historyId);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('generation rejects wrong-mode, wrong-id, missing-source and invalid quote prefixes',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-untrusted-'));
  try{
    const settings=await settingsFor(dir,3),document=await parseDocument('source.txt',Buffer.from('正確な根拠：売上は12億円。'));
    const outline=demoOutline('検証','reading',[],3),deck=demoDeck(outline);
    for(const raw of [cut('presentation',[deck.slides[0]]),cut('reading',[{...deck.slides[0],id:'slide-3'}]),cut('reading',[{...deck.slides[0],sources:[{documentId:'forged',locator:'p1'}]}]),cut('reading',[{...deck.slides[0],sources:[{documentId:document.id,locator:document.sources[0].locator,quote:'999億円'}]}]),cut('reading',[{...deck.slides[0],layoutId:'cards'}])]){
      let count=0;
      const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{count++;if(count===1)return {text:JSON.stringify({kind:'outline',outline}),usage};throw limited(raw);}})});
      const session=await engine.create({prompt:'根拠を確認'},[document]);await engine.generate(session.id);assert.equal(session.recovery?.completedSlides,0);assert.equal(session.variants.length,0);assert.equal(count,2);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('later output failure keeps earlier batches and stops after repeated single-slide limits',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-limit-'));
  try{
    const settings=await settingsFor(dir,5),outline=demoOutline('5枚','reading',[],5),deck=demoDeck(outline),targets:string[][]=[];
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      const req=JSON.parse(r.content).request;if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      targets.push(req.targetSlides.map((s:any)=>s.id));if(targets.length===1)return {text:JSON.stringify({...deck,slides:deck.slides.slice(0,4)}),usage};throw limited(cut('reading',[]));
    }})});
    const session=await engine.create({prompt:'5枚'},[]);await engine.generate(session.id);assert.equal(session.recovery?.completedSlides,4);assert.equal(session.recovery?.retryAvailable,true);assert.equal(targets.length,2);
    await engine.generate(session.id);assert.equal(session.recovery?.retryAvailable,false);assert.equal(targets.length,3);await assert.rejects(engine.generate(session.id),/追加の呼び出しは行っていません/);assert.equal(targets.length,3);
    assert.deepEqual(targets,[['slide-1','slide-2','slide-3','slide-4'],['slide-5'],['slide-5']]);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('complete slide objects with a cut deck ending need no additional generation call',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-closed-'));
  try{
    const settings=await settingsFor(dir,2),outline=demoOutline('2枚','reading',[],2),deck=demoDeck(outline);let calls=0;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async()=>{
      calls++;if(calls===1)return {text:JSON.stringify({kind:'outline',outline}),usage};throw limited(JSON.stringify({...deck,slides:deck.slides}).slice(0,-2));
    }})});
    const session=await engine.create({prompt:'2枚'},[]);await engine.generate(session.id);assert.equal(session.recovery?.completedSlides,2);assert.equal(calls,2);
    await engine.generate(session.id);assert.equal(session.phase,'ready');assert.equal(calls,2);assert.equal(session.variants[0].deck.slides.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('text-fit interruption keeps completed summary batches and never regenerates the slide bodies',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-fit-recover-'));
  try{
    const settings=await settingsFor(dir,6),outline=demoOutline('要約の再開','reading',[],6),deck=demoDeck(outline);
    for(const s of deck.slides)s.title='比'.repeat(70);
    assert.equal(fitProblems(deck).length,6);
    const summaries:string[][]=[],generated:string[][]=[];let fail=true;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      const req=JSON.parse(r.content).request;
      if(req.targetSlides){generated.push(req.targetSlides.map((s:any)=>s.id));return {text:JSON.stringify({...deck,slides:req.targetSlides.map((s:any)=>deck.slides.find(d=>d.id===s.id))}),usage};}
      if(!req.slides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      assert.deepEqual(JSON.parse(r.content).documents,[]);summaries.push(req.slides.map((s:any)=>s.slideId));
      if(summaries.length===2&&fail){fail=false;throw limited('{"replacements":[');}
      return {text:JSON.stringify({replacements:req.slides.map((s:any)=>({slideId:s.slideId,path:'title',text:'比較条件を確認'}))}),usage};
    }})});
    const session=await engine.create({prompt:'6枚'},[]);await engine.generate(session.id);assert.equal(session.recovery?.stage,'text-fit');assert.equal(session.recovery?.completedSlides,6);assert.equal(summaries.length,2);
    await engine.generate(session.id);assert.equal(session.phase,'ready');assert.equal(generated.length,2);assert.deepEqual(summaries,[['slide-1','slide-2','slide-3','slide-4'],['slide-5','slide-6'],['slide-5'],['slide-6']]);assertTextFits(session.variants[0].deck);
    assert.ok(session.variants[0].deck.slides.every(s=>s.notes.includes('要約前の補足')));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('adaptive generation respects the twelve-call cost cap and retains progress',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-cap-'));
  try{
    const settings=await settingsFor(dir,30),outline=demoOutline('30枚','reading',[],30),deck=demoDeck(outline);let calls=0,failures=0;
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      calls++;const req=JSON.parse(r.content).request;if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      if(failures++<2)throw limited(cut('reading',[]));
      return {text:JSON.stringify({...deck,slides:req.targetSlides.map((s:any)=>deck.slides.find(d=>d.id===s.id))}),usage};
    }})});
    const session=await engine.create({prompt:'30枚'},[]);await engine.generate(session.id);await engine.generate(session.id);await engine.generate(session.id);
    assert.equal(calls,12);assert.equal(session.usage.calls,12);assert.equal(session.recovery?.retryAvailable,false);assert.equal(session.recovery?.completedSlides,9);assert.equal(session.outline?.slides.length,30);assert.equal(session.variants.length,0);
    await assert.rejects(engine.generate(session.id));assert.equal(calls,12);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('authenticated HTTP generation exposes progress without raw partial text and resumes explicitly',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-generation-http-'));
  const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=(socket.address() as any).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
  let server:ReturnType<typeof createServer>|undefined;
  try{
    await settingsFor(dir,3);const outline=demoOutline('HTTP再開','reading',[],3),deck=demoDeck(outline);let calls=0;
    const token='q'.repeat(64);
    const app=await createApp({authToken:token,port,dataDir:dir,webRoot:dir,artifactRoot:path.join(dir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      calls++;const req=JSON.parse(r.content).request;if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      if(calls===2)throw limited(cut('reading',[deck.slides[0]]));return {text:JSON.stringify({...deck,slides:req.targetSlides.map((s:any)=>deck.slides.find(d=>d.id===s.id))}),usage};
    }})});
    server=app.listen(port,'127.0.0.1');const origin=`http://127.0.0.1:${port}`;
    const auth=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=auth.headers.get('set-cookie')!.split(';')[0],headers={cookie,origin,'content-type':'application/json'};
    const session=await (await fetch(origin+'/api/sessions',{method:'POST',headers,body:JSON.stringify({prompt:'3枚'})})).json() as any;
    const url=origin+'/api/sessions/'+session.id+'/generate';let res=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(res.status,200);const recovery=await res.json() as any;
    assert.equal(recovery.recovery.completedSlides,1);assert.equal(calls,2);assert.ok(!JSON.stringify(recovery).includes('PRIVATE_UNFINISHED'));
    res=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(res.status,200);const ready=await res.json() as any;assert.equal(ready.phase,'ready');assert.equal(ready.variants[0].deck.slides.length,3);assert.equal(calls,4);
  }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
