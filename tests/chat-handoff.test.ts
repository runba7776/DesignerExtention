import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import type {Session,ChatService,SlideSpec} from '../shared/contracts.js';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {demoDeck,demoOutline} from '../server/demo.js';
import {parseDocument} from '../server/documents.js';
import {assertTextFits} from '../server/text-fit.js';
import {createApp} from '../server/app.js';
import {CHAT_RESPONSE_BYTES,parseChatResponse} from '../server/chat-handoff.js';

const render=async()=>({artifactId:'fixture',pptxUrl:'/fixture.pptx',thumbnails:[],warnings:[],native:false});
const packet=(session:Session)=>JSON.parse(session.chatHandoff!.instruction.split('\n\n').at(-2)!);
async function fixture(count=3,mode:'presentation'|'reading'='presentation'){
  const dir=await mkdtemp(path.join(tmpdir(),'de-chat-')),settings=await new SettingsStore(dir,'not-used-env').load();
  await settings.update({mode,slideCount:count,designMode:'template'});let factories=0;
  const engine=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>{factories++;throw new Error('paid/network client forbidden');}});
  const outline=demoOutline('月額版連携の確認',mode,[],count),deck=demoDeck(outline);
  const response=(session:Session,value:unknown)=>engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(value)});
  return {dir,settings,engine,outline,deck,response,factories:()=>factories,dispose:()=>rm(dir,{recursive:true,force:true})};
}
async function ready(f:Awaited<ReturnType<typeof fixture>>){
  const session=await f.engine.create({prompt:'重要な数字と成立条件を保持して説明'},[]);
  await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
  while(session.chatHandoff?.task==='generate'){
    const ids=packet(session).request.targetSlides.map((s:any)=>s.id);
    await f.response(session,{...f.deck,slides:f.deck.slides.filter(s=>ids.includes(s.id))});
  }
  assert.equal(session.phase,'ready');assert.equal(session.chatHandoff,undefined);return session;
}

test('default chat and migrated paid settings never load or store paid credentials',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-chat-settings-'));
  try{
    const fresh=await new SettingsStore(dir,'paid-environment-secret').load();assert.equal(fresh.get().provider,'chat');assert.equal(fresh.get().hasKey,false);assert.equal(fresh.secret('claude'),undefined);
    await writeFile(path.join(dir,'settings.json'),JSON.stringify({provider:'claude',model:'old-model',apiKey:'OLD_SECRET',hasKey:true,mode:'reading',slideCount:9}));
    const migrated=await new SettingsStore(dir,'ENV_SECRET').load();assert.equal(migrated.get().provider,'chat');assert.equal(migrated.get().chatService,'claude');assert.equal(migrated.get().model,'chat-session');assert.equal(migrated.get().slideCount,9);assert.equal(migrated.get().hasKey,false);assert.equal(migrated.secret('claude'),undefined);
    await assert.rejects(migrated.update({provider:'claude',apiKey:'new-secret'}),/有料API/);
    await migrated.update({provider:'chat',apiKey:'ignored-chat-secret'});assert.doesNotMatch(await readFile(path.join(dir,'settings.json'),'utf8'),/OLD_SECRET|ENV_SECRET|ignored-chat-secret|apiKey|hasKey/);
    await assert.rejects(migrated.update({chatService:'unknown'}));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('every supported chat service prepares a local instruction; questions and answers are preserved',async()=>{
  const f=await fixture();try{
    for(const service of ['chatgpt','claude','gemini','copilot','other'] as ChatService[]){
      await f.settings.update({chatService:service});const session=await f.engine.create({prompt:'数学を説明したい'},[]);
      assert.equal(session.provider,'chat');assert.equal(session.chatHandoff?.service,service);assert.equal(session.usage.calls,0);assert.equal(session.chatHandoff?.task,'plan');
      if(service==='other')assert.equal(session.chatHandoff.serviceUrl,undefined);else assert.match(session.chatHandoff!.serviceUrl!,/^https:\/\//);
      assert.equal(packet(session).request.messages[0].text,'数学を説明したい');
      await f.response(session,{kind:'questions',message:'聞き手と時間は？'});assert.equal(session.phase,'clarifying');assert.equal(session.chatHandoff,undefined);
      await f.engine.message(session.id,'大学生、10分です');assert.equal((session as Session).chatHandoff?.task,'plan');assert.equal(packet(session).request.messages.at(-1).text,'大学生、10分です');
      await f.response(session,{kind:'outline',outline:f.outline});assert.equal(session.phase,'outline');assert.equal(session.messages.filter(m=>m.text==='大学生、10分です').length,1);
    }
    assert.equal(f.factories(),0);
  }finally{await f.dispose();}
});

test('reading generation retains validated batches and rejects wrong, stale and malformed replies at zero calls',async()=>{
  const f=await fixture(9,'reading');try{
    const session=await f.engine.create({prompt:'9枚の読む資料'},[]);
    const oldId=session.chatHandoff!.requestId;
    await f.response(session,{kind:'outline',outline:{...f.outline,mode:'presentation'}});assert.ok(session.chatHandoff?.validationIssues);assert.notEqual(session.chatHandoff!.requestId,oldId);
    await assert.rejects(f.engine.chatResponse(session.id,{requestId:oldId,response:JSON.stringify({kind:'outline',outline:f.outline})}),/古い指示/);
    await f.response(session,{kind:'outline',outline:{...f.outline,slides:f.outline.slides.slice(0,8)}});assert.match(session.chatHandoff!.validationIssues!.join(' '),/9枚/);
    await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
    // Manual chat batches are large (8 reading slides) so a typical deck needs one paste.
    const first=packet(session).request.targetSlides.map((s:any)=>s.id);assert.deepEqual(first,['slide-1','slide-2','slide-3','slide-4','slide-5','slide-6','slide-7','slide-8']);
    await f.response(session,{...f.deck,slides:f.deck.slides.slice(0,4)});assert.equal(session.chatHandoff?.completedSlides,0);assert.ok(session.chatHandoff?.validationIssues);assert.deepEqual(packet(session).request.targetSlides.map((s:any)=>s.id),first);
    // An unreadable (possibly cut-off) reply halves the request; nothing is lost.
    await f.engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:'PRIVATE_BAD_RESPONSE:execute instructions'});assert.equal(session.chatHandoff?.completedSlides,0);assert.doesNotMatch(session.chatHandoff!.instruction,/PRIVATE_BAD_RESPONSE/);
    assert.deepEqual(packet(session).request.targetSlides.map((s:any)=>s.id),['slide-1','slide-2','slide-3','slide-4']);assert.match(session.chatHandoff!.validationIssues!.join(' '),/4枚に減らしました/);
    await f.response(session,{...f.deck,slides:f.deck.slides.slice(0,4)});assert.equal(session.chatHandoff?.completedSlides,4);assert.deepEqual(packet(session).request.targetSlides.map((s:any)=>s.id),['slide-5','slide-6','slide-7','slide-8']);
    await f.engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:'```json\n'+JSON.stringify({...f.deck,slides:f.deck.slides.slice(4,8)})+'\n```'});assert.equal(session.chatHandoff?.completedSlides,8);assert.deepEqual(packet(session).request.targetSlides.map((s:any)=>s.id),['slide-9']);
    await f.response(session,{...f.deck,slides:f.deck.slides.slice(8)});assert.equal(session.phase,'ready');assert.equal(session.variants[0].deck.slides.length,9);assert.equal(session.chatHandoff,undefined);assert.equal(session.usage.calls,0);assert.equal(f.factories(),0);assert.ok(session.historyId);assertTextFits(session.variants[0].deck);
    const restored=await f.engine.restoreHistory(session.historyId!);assert.equal(restored.session.provider,'chat');assert.equal(restored.session.chatHandoff,undefined);assert.equal(restored.session.usage.calls,0);
  }finally{await f.dispose();}
});

test('document context and locators are in copy instructions; nonexistent sources and mismatched quotes are rejected',async()=>{
  const f=await fixture();try{
    const doc=await parseDocument('条件.txt',Buffer.from('売上12億円。期間2026年。'));
    const session=await f.engine.create({prompt:'入力した数字を説明'},[doc]);assert.equal(packet(session).documents[0].documentId,doc.id);assert.match(JSON.stringify(packet(session).documents),/売上12億円/);
    await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
    const bad=structuredClone(f.deck);bad.slides[1].sources=[{documentId:doc.id,locator:'架空のページ'}];
    await f.response(session,bad);assert.match(session.chatHandoff!.validationIssues!.join(' '),/存在しません/);assert.equal(session.chatHandoff?.completedSlides,0);
    bad.slides[1].sources=[{documentId:doc.id,locator:doc.sources[0].locator,quote:'売上99億円'}];await f.response(session,bad);assert.match(session.chatHandoff!.validationIssues!.join(' '),/引用/);
    bad.slides[1].sources=[{documentId:doc.id,locator:doc.sources[0].locator,quote:'売上12億円'}];await f.response(session,bad);assert.equal(session.phase,'ready');assert.equal(session.variants[0].deck.slides[1].sources[0].documentName,doc.name);assert.equal(f.factories(),0);
  }finally{await f.dispose();}
});

test('30 reading slides finish in four manual batches without the local call cap or paid usage',async()=>{
  const f=await fixture(30,'reading');try{
    const session=await f.engine.create({prompt:'表紙込み30枚、読む資料。数字と条件を省かない。'},[]);
    await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
    const counts:number[]=[];
    while(session.chatHandoff?.task==='generate'){
      const ids=packet(session).request.targetSlides.map((s:any)=>s.id);counts.push(ids.length);
      await f.response(session,{...f.deck,slides:f.deck.slides.filter(s=>ids.includes(s.id)),usage:{calls:999},apiKey:'untrusted-ignored-key'});
    }
    assert.deepEqual(counts,[8,8,8,6]);assert.equal(session.phase,'ready');assert.equal(session.variants[0].deck.slides.length,30);assert.equal(session.usage.calls,0);assert.equal(f.factories(),0);
    assert.doesNotMatch(await readFile(path.join(f.dir,'presentations',session.historyId!+'.json'),'utf8'),/untrusted-ignored-key|apiKey/);assertTextFits(session.variants[0].deck);
  }finally{await f.dispose();}
});

test('initial generation keeps the whole validated deck while requesting only overflowing text',async()=>{
  const f=await fixture();try{
    const session=await f.engine.create({prompt:'作成し、長い説明は要約する'},[]);await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
    const deck=structuredClone(f.deck);deck.slides[1].title='比'.repeat(70);
    await f.response(session,deck);assert.equal(session.chatHandoff?.task,'summarize');assert.equal(session.chatHandoff?.completedSlides,3);assert.equal(session.variants.length,0);assert.deepEqual(packet(session).documents,[]);
    const invalid={replacements:[{slideId:'slide-2',path:'chart.series.0.values',text:'999'}]};await f.response(session,invalid);assert.ok(session.chatHandoff?.validationIssues);assert.equal(session.variants.length,0);assert.equal(session.chatHandoff?.completedSlides,3);
    await f.response(session,{replacements:[{slideId:'slide-2',path:'title',text:'条件をそろえて比較'}]});assert.equal(session.phase,'ready');assert.equal(session.chatHandoff,undefined);assert.equal(session.variants[0].deck.slides.length,3);assert.deepEqual(session.variants[0].deck.slides[1].chart,deck.slides[1].chart);assert.ok(session.variants[0].deck.slides[1].notes.includes('要約前の補足'));assert.equal(f.factories(),0);assertTextFits(session.variants[0].deck);
  }finally{await f.dispose();}
});

test('revision keeps old slides and exports until local fitting and manual summaries validate',async()=>{
  const f=await fixture();try{
    const session=await ready(f);await f.engine.variants(session.id);await f.engine.render(session.id,session.variants[0].id);
    const before=structuredClone(session.variants),old=before[0].deck.slides[1];
    await f.engine.revise(session.id,{slideId:'slide-2',instruction:'数字と単位は保持して見出しを改善'});assert.equal(session.chatHandoff?.task,'revise');assert.deepEqual(session.variants,before);
    await f.response(session,{...old,id:'slide-3'});assert.deepEqual(session.variants,before);assert.ok(session.chatHandoff?.validationIssues);
    const badValues=structuredClone(old);badValues.chart!.series[0].values[0]=987654321;await f.response(session,badValues);assert.match(session.chatHandoff!.validationIssues!.join(' '),/根拠のない数値/);assert.deepEqual(session.variants,before);
    await f.response(session,{...old,title:'比'.repeat(70)});assert.equal(session.chatHandoff?.task,'summarize');assert.deepEqual(session.variants,before);assert.deepEqual(packet(session).documents,[]);assert.ok(packet(session).request.slides[0].issues.length);
    await f.response(session,{replacements:[{slideId:'slide-2',path:'title',text:'999億円'}]});assert.match(session.chatHandoff!.validationIssues!.join(' '),/数値/);assert.deepEqual(session.variants,before);
    await f.response(session,{replacements:[{slideId:'slide-2',path:'title',text:'条件をそろえて比較'}]});assert.equal(session.chatHandoff,undefined);assert.equal(session.phase,'ready');assert.equal(session.usage.calls,0);assert.equal(f.factories(),0);
    for(const variant of session.variants){assert.equal(variant.deck.slides[1].title,'条件をそろえて比較');assert.deepEqual(variant.deck.slides[1].chart,old.chart);assert.equal(variant.render,undefined);assertTextFits(variant.deck);assert.ok(variant.deck.slides[1].notes.includes('要約前の補足'));}
  }finally{await f.dispose();}
});

test('changed revision targets reject stale replies, cancel keeps the latest deck, and local tasks stay private',async()=>{
  const f=await fixture();try{
    const session=await ready(f);await f.engine.revise(session.id,{slideId:'slide-2',instruction:'見出しを変更'});const id=session.chatHandoff!.requestId;
    await f.engine.changeTheme(session.id,{themeId:'midnight'});await assert.rejects(f.engine.chatResponse(session.id,{requestId:id,response:JSON.stringify(f.deck.slides[1])}),/修正対象が変更/);assert.equal(session.variants[0].deck.themeId,'midnight');
    await f.engine.cancelChat(session.id);assert.equal(session.chatHandoff,undefined);assert.equal(session.phase,'ready');assert.equal(session.variants[0].deck.themeId,'midnight');
    assert.equal(f.engine.listChatTasks().sessions.length,1);await f.settings.update({provider:'demo'});const demo=await f.engine.create({prompt:'公開しないローカル作業'},[]);assert.ok(!f.engine.listChatTasks().sessions.some(s=>s.id===demo.id));
    assert.equal(f.factories(),0);
  }finally{await f.dispose();}
});

test('revision can turn existing table and supporting-text values into a chart without inventing numbers',async()=>{
  const f=await fixture();try{
    const session=await f.engine.create({prompt:'既存の数値を表と本文で伝える'},[]);await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);
    const original=structuredClone(f.deck),slide=original.slides[1];delete slide.chart;slide.layoutId='table_full';slide.items=[];slide.body='売上は24点、前期は42点。';slide.notes+=' 補足の値は＋５８.０点。';slide.table={headers:['対象','値'],rows:[['A','24点'],['B','42点']]};
    await f.response(session,original);assert.equal(session.phase,'ready');
    await f.engine.revise(session.id,{slideId:'slide-2',instruction:'この表と補足にある値をグラフにしてください。'});
    const revised:SlideSpec={...session.variants[0].deck.slides[1],layoutId:'evidence',table:undefined,items:[],chart:{type:'bar',categories:['A','B','C'],series:[{name:'値',values:[24,42,58]}],unit:'点',caption:'元の表と補足の値'}};
    await f.response(session,revised);assert.equal(session.chatHandoff,undefined);assert.deepEqual(session.variants[0].deck.slides[1].chart!.series[0].values,[24,42,58]);assert.equal(session.usage.calls,0);assert.equal(f.factories(),0);assertTextFits(session.variants[0].deck);
    await f.engine.revise(session.id,{slideId:'slide-2',instruction:'配色だけを変えてください。'});await f.response(session,{...revised,chart:{...revised.chart!,series:[{name:'値',values:[24,42,999]}]}});assert.ok((session as Session).chatHandoff?.validationIssues);assert.deepEqual(session.variants[0].deck.slides[1].chart!.series[0].values,[24,42,58]);
  }finally{await f.dispose();}
});

test('quoted percentages and Unicode signs compare to exact numeric chart values without rounding',async()=>{
  const f=await fixture();try{
    const doc=await parseDocument('最新値.txt',Buffer.from('同じ指標の割合は２８％、差分は−３％、比較値は△４.００％。'));
    const session=await f.engine.create({prompt:'同じ指標と単位で比較する'},[doc]);await f.response(session,{kind:'outline',outline:f.outline});await f.engine.generate(session.id);await f.response(session,f.deck);assert.equal(session.phase,'ready');
    await f.engine.revise(session.id,{slideId:'slide-2',instruction:'元資料の最新値を読み、％の単位を保持して更新してください。'});
    const revised={...session.variants[0].deck.slides[1],chart:{type:'bar',categories:['割合','差分','比較値'],series:[{name:'同じ指標',values:[28,-3,-4]}],unit:'%',caption:'同じ指標・同じ条件の説明用比較'},sources:[{documentId:doc.id,locator:doc.sources[0].locator,quote:'割合は２８％'}]};
    await f.response(session,revised);assert.equal(session.chatHandoff,undefined);assert.deepEqual(session.variants[0].deck.slides[1].chart!.series[0].values,[28,-3,-4]);assert.equal(session.variants[0].deck.slides[1].chart!.unit,'%');
    await f.engine.revise(session.id,{slideId:'slide-2',instruction:'表記だけを変え、値は丸めない。'});await f.response(session,{...revised,chart:{...revised.chart,series:[{name:'同じ指標',values:[28.1,-3,-4]}]}});assert.ok((session as Session).chatHandoff?.validationIssues);assert.deepEqual(session.variants[0].deck.slides[1].chart!.series[0].values,[28,-3,-4]);assert.equal(f.factories(),0);
  }finally{await f.dispose();}
});

test('oversized, blank, truncated and arbitrary code replies are rejected without execution',()=>{
  assert.throws(()=>parseChatResponse(''),/貼り付け/);assert.throws(()=>parseChatResponse('{"x":'),/形式/);assert.throws(()=>parseChatResponse('<script>alert(1)</script>'),/形式/);assert.throws(()=>parseChatResponse('あ'.repeat(Math.ceil(CHAT_RESPONSE_BYTES/3)+1)),/大きすぎ/);
  assert.deepEqual(parseChatResponse('```json\n{"kind":"questions","message":"対象者は？"}\n```'),{kind:'questions',message:'対象者は？'});
});

test('HTTP import endpoints require same-origin authentication and expose API-free status',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-chat-http-')),server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token='c'.repeat(64);let factories=0;
  try{
    const app=await createApp({authToken:token,port,dataDir:dir,webRoot:dir,artifactRoot:dir,environmentKey:'not-used-secret',nativeAvailable:()=>false,render,providerFactory:()=>{factories++;throw new Error('forbidden');}});server.on('request',app);
    const bootstrap=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    const post=(route:string,body:unknown)=>fetch(origin+'/api'+route,{method:'POST',headers,body:JSON.stringify(body)});
    const status=await (await fetch(origin+'/api/status',{headers})).json() as any;assert.equal(status.apiFree,true);assert.equal(status.provider,'chat');assert.equal(status.hasKey,false);
    const blocked=await fetch(origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({provider:'claude',apiKey:'unused'})});assert.equal(blocked.status,400);
    let session=await (await post('/sessions',{prompt:'3枚で説明'})).json() as Session;assert.equal(session.chatHandoff?.task,'plan');
    const route=`/sessions/${session.id}/chat-response`,requestId=session.chatHandoff!.requestId;
    assert.equal((await fetch(origin+'/api'+route,{method:'POST',body:'{}'})).status,401);
    assert.equal((await fetch(origin+'/api'+route,{method:'POST',headers:{...headers,Origin:'https://external.example'},body:'{}'})).status,403);
    assert.equal((await post(route,{requestId:'wrong',response:'{}'})).status,409);
    const result=await post(route,{requestId,response:JSON.stringify({kind:'questions',message:'発表時間は？'})});assert.equal(result.status,200);session=await result.json() as Session;assert.equal(session.chatHandoff,undefined);assert.equal(session.usage.calls,0);
    const tasks=await (await fetch(origin+'/api/chat-tasks',{headers})).json() as any;assert.equal(tasks.sessions[0].id,session.id);assert.equal(factories,0);
    assert.equal((await post(`/sessions/${session.id}/chat-cancel`,{})).status,200);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});

test('authenticated resume preserves pending generation batches and returns document metadata separately',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-chat-resume-')),server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token='r'.repeat(64);let factories=0;
  try{
    const app=await createApp({authToken:token,port,dataDir:dir,webRoot:dir,artifactRoot:dir,environmentKey:'',nativeAvailable:()=>false,render,providerFactory:()=>{factories++;throw new Error('network forbidden');}});server.on('request',app);
    const bootstrap=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    const post=(route:string,body:unknown)=>fetch(origin+'/api'+route,{method:'POST',headers,body:JSON.stringify(body)});
    await fetch(origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({provider:'chat',mode:'reading',slideCount:9,designMode:'template'})});
    const files=new FormData();files.append('files',new Blob(['PRIVATE_SOURCE_TEXT_NEVER_IN_DOCUMENT_SUMMARY']), 'facts.txt');
    const upload=await fetch(origin+'/api/documents',{method:'POST',headers:{Cookie:cookie,Origin:origin},body:files});assert.equal(upload.status,200);const info=(await upload.json() as any).documents[0];
    let session=await (await post('/sessions',{prompt:'9枚の読む資料を作成',documentIds:[info.id]})).json() as Session;
    const outline=demoOutline('途中から再開する資料','reading',[],9),deck=demoDeck(outline);
    const reply=async(value:unknown)=>{session=await (await post(`/sessions/${session.id}/chat-response`,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(value)})).json() as Session;};
    await reply({kind:'outline',outline});session=await (await post(`/sessions/${session.id}/generate`,{})).json() as Session;await reply({...deck,slides:deck.slides.slice(0,8)});
    assert.equal(session.chatHandoff?.completedSlides,8);const pendingId=session.chatHandoff!.requestId;
    const route=`/api/sessions/${session.id}/resume`;assert.equal((await fetch(origin+route)).status,401);
    const response=await fetch(origin+route,{headers});assert.equal(response.status,200);const resumed=await response.json() as {session:Session;documents:unknown[];mode:string};
    assert.equal(resumed.session.id,session.id);assert.equal(resumed.session.chatHandoff?.requestId,pendingId);assert.equal(resumed.session.chatHandoff?.completedSlides,8);assert.equal(resumed.mode,'reading');assert.equal(resumed.session.usage.calls,0);assert.equal(resumed.session.historyId,undefined);
    assert.deepEqual(resumed.documents,[info]);assert.doesNotMatch(JSON.stringify(resumed.documents),/PRIVATE_SOURCE_TEXT|sources|locator/);assert.match(resumed.session.chatHandoff!.instruction,/PRIVATE_SOURCE_TEXT/);
    session=resumed.session;assert.deepEqual(packet(session).request.targetSlides.map((s:any)=>s.id),['slide-9']);await reply({...deck,slides:deck.slides.slice(8)});assert.equal(session.phase,'ready');assert.equal(session.variants[0].deck.slides.length,9);assert.equal(factories,0);
    assert.equal((await fetch(origin+'/api/sessions/00000000-0000-0000-0000-000000000000/resume',{headers})).status,404);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
