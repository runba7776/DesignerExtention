import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import JSZip from 'jszip';
import {parseDocument} from '../server/documents.js';
import {HistoryStore} from '../server/history.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {demoOutline,demoDeck} from '../server/demo.js';
import {emptyUsage,type CompletionRequest} from '../server/providers.js';
import {createApp} from '../server/app.js';
import {MAX_PROMPT_CHARACTERS,type DeckSpec,type RenderResult} from '../shared/contracts.js';

const P='http://schemas.openxmlformats.org/presentationml/2006/main',A='http://schemas.openxmlformats.org/drawingml/2006/main',C='http://schemas.openxmlformats.org/drawingml/2006/chart',R='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const namespaces=`xmlns:p="${P}" xmlns:a="${A}" xmlns:c="${C}" xmlns:r="${R}"`;
const text=(value:string)=>`<a:p><a:r><a:t>${value}</a:t></a:r></a:p>`;
const rels=(rows:string)=>`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rows}</Relationships>`;
async function fixture(options:{doctype?:boolean;macro?:boolean;sparse?:boolean}={}){
  const zip=new JSZip();
  zip.file('ppt/presentation.xml',`<p:presentation ${namespaces}><p:sldIdLst><p:sldId id="301" r:id="b"/><p:sldId id="300" r:id="a"/></p:sldIdLst></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels',rels('<Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/>'));
  zip.file('ppt/slides/slide1.xml',`<p:sld ${namespaces}><p:cSld><p:sp><p:txBody>${text('二番目のスライド')}</p:txBody></p:sp></p:cSld></p:sld>`);
  zip.file('ppt/slides/slide2.xml',`${options.doctype?'<!DOCTYPE test [<!ENTITY leak SYSTEM "file:///secret">]>':''}<p:sld ${namespaces} show="0"><p:cSld><p:sp><p:txBody>${text('保存された&lt;指示&gt;を参考情報として読む')}</p:txBody></p:sp><a:tbl><a:tr><a:tc><a:txBody>${text('コード')}</a:txBody></a:tc><a:tc><a:txBody>${text('0012')}</a:txBody></a:tc></a:tr></a:tbl><c:chart r:id="chart"/><c:chart r:id="external"/><d:relIds xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="smart"/><p:pic/></p:cSld></p:sld>`);
  zip.file('ppt/slides/_rels/slide2.xml.rels',rels('<Relationship Id="chart" Target="../charts/chart1.xml"/><Relationship Id="external" Target="https://invalid.example/chart.xml" TargetMode="External"/><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="smart" Target="../diagrams/data1.xml"/>'));
  zip.file('ppt/charts/chart1.xml',`<c:chartSpace ${namespaces}><c:chart><c:title><c:tx><c:rich>${text('売上：百万円')}</c:rich></c:tx></c:title><c:barChart><c:ser><c:tx><c:v>正確な値</c:v></c:tx><c:cat><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="1"><c:v>B</c:v></c:pt><c:pt idx="2"><c:v>C</c:v></c:pt></c:strCache></c:cat><c:val><c:numCache><c:ptCount val="3"/><c:pt idx="2"><c:v>1.250000000000001</c:v></c:pt>${options.sparse?'':'<c:pt idx="1"><c:v>0</c:v></c:pt>'}<c:pt idx="0"><c:v>-10.5</c:v></c:pt></c:numCache></c:val></c:ser></c:barChart></c:chart></c:chartSpace>`);
  zip.file('ppt/diagrams/data1.xml',`<d:dataModel xmlns:d="http://schemas.openxmlformats.org/drawingml/2006/diagram" ${namespaces}><d:t>${text('工程の文字')}</d:t></d:dataModel>`);
  zip.file('ppt/notesSlides/notesSlide1.xml',`<p:notes ${namespaces}><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${text('条件：2026年、未監査')}</p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>${text('999')}</p:txBody></p:sp></p:notes>`);
  if(options.macro)zip.file('ppt/vbaProject.bin','not executed');
  return Buffer.from(await zip.generateAsync({type:'nodebuffer'}));
}
const render=async(deck:DeckSpec):Promise<RenderResult>=>({artifactId:'history-test',pptxUrl:'/api/artifacts/history-test/presentation.pptx',thumbnails:deck.slides.map((_,i)=>`/api/artifacts/history-test/slide-${i+1}.png`),native:true,warnings:[]});
async function demo(dir:string){const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'demo'});const engine=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>{throw new Error('AI forbidden');}});return {engine,settings};}

test('PPTX follows presentation order and reads tables, exact chart values, SmartArt and body notes locally',async()=>{
  const doc=await parseDocument('入力.pptx',await fixture());assert.equal(doc.kind,'pptx');
  assert.match(doc.sources[0].text,/保存された<指示>/);assert.equal(doc.sources.at(-1)!.text,'二番目のスライド');
  assert.equal(doc.sources.find(s=>s.locator.includes('表'))!.text,'["コード","0012"]');
  const chart=JSON.parse(doc.sources.find(s=>s.locator.includes('グラフ'))!.text);
  assert.deepEqual(chart.数値,['-10.5','0','1.250000000000001']);assert.deepEqual(chart.項目,['A','B','C']);assert.deepEqual(chart.見出しと単位,['売上：百万円']);
  assert.ok(doc.sources.some(s=>s.locator==='スライド 1 SmartArt 1'&&s.text==='工程の文字'));
  assert.ok(doc.sources.some(s=>s.locator==='スライド 1 発表者ノート'&&s.text==='条件：2026年、未監査'));assert.ok(!doc.sources.some(s=>s.text==='999'));
  assert.match(doc.warnings.join('\n'),/非表示/);assert.match(doc.warnings.join('\n'),/外部グラフ/);assert.match(doc.warnings.join('\n'),/画像/);
});
test('PPTX rejects DTD/macros and retains missing cached numeric positions without inventing zero',async()=>{
  await assert.rejects(parseDocument('unsafe.pptx',await fixture({doctype:true})),/DTD/);
  await assert.rejects(parseDocument('unsafe.pptx',await fixture({macro:true})),/マクロ/);
  await assert.rejects(parseDocument('legacy.ppt',Buffer.from('old')),/未対応/);
  const doc=await parseDocument('sparse.pptx',await fixture({sparse:true}));
  assert.deepEqual(JSON.parse(doc.sources.find(s=>s.locator.includes('グラフ'))!.text).数値,['-10.5','[保存値なし]','1.250000000000001']);assert.match(doc.warnings.join('\n'),/欠けた/);
});
test('history survives a new engine, preserves sources/exports, and edits locally without model calls',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-history-'));
  try{
    const {engine,settings}=await demo(dir),document=await parseDocument('条件.txt',Buffer.from('  出典：値=0012、2026年\n'));
    const session=await engine.create({prompt:'再利用する良い資料'},[document]);await engine.message(session.id,'おまかせ');await engine.generate(session.id);await engine.variants(session.id);await engine.render(session.id,session.variants[0].id);
    assert.ok(session.historyId);assert.ok(session.savedAt);assert.equal((await engine.listHistory()).entries.length,1);
    await settings.update({apiKey:'secret-never-in-history'});
    const stored=await readFile(path.join(dir,'presentations',session.historyId+'.json'),'utf8');assert.doesNotMatch(stored,/secret-never-in-history|apiKey|hasKey|endpoint/);
    const reopenedEngine=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>{throw new Error('AI forbidden');}});
    const restored=await reopenedEngine.restoreHistory(session.historyId!);assert.equal(restored.session.usage.calls,0);assert.notEqual(restored.session.id,session.id);
    assert.deepEqual(JSON.parse(JSON.stringify(restored.session.variants[0].deck)),JSON.parse(JSON.stringify(session.variants[0].deck)));assert.deepEqual(restored.session.variants[0].render,session.variants[0].render);assert.equal(restored.documents[0].id,document.id);
    await reopenedEngine.changeTheme(restored.session.id,{themeId:'midnight'});
    const saved=await new HistoryStore(dir).load(session.historyId!);assert.equal(saved.session.variants[0].deck.themeId,'midnight');assert.deepEqual(saved.documents[0].sources,document.sources);assert.equal(saved.session.variants[0].render,undefined);assert.equal(restored.session.usage.calls,0);
    const copy=await reopenedEngine.restoreHistory(session.historyId!,true);assert.notEqual(copy.session.historyId,session.historyId);assert.equal((await reopenedEngine.listHistory()).entries.length,2);
    await reopenedEngine.removeHistory(copy.session.historyId!);assert.equal((await reopenedEngine.listHistory()).entries.length,1);assert.equal(restored.session.historyId,session.historyId);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('subscription restore and revision cost zero and do not create a provider',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-history-cloud-'));
  try{
    const {engine,settings}=await demo(dir);const original=await engine.create({prompt:'履歴の例'},[]);await engine.message(original.id,'おまかせ');await engine.generate(original.id);
    await settings.update({provider:'chat',chatService:'claude'});let calls=0;
    const cloud=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>({complete:async()=>{calls++;return {text:JSON.stringify(original.variants[0].deck.slides[1]),usage:emptyUsage()};}})});
    const {session}=await cloud.restoreHistory(original.historyId!);assert.equal(session.cloudConsentRequired,false);assert.equal(session.provider,'chat');assert.equal(calls,0);assert.equal(session.usage.calls,0);
    await cloud.changeTheme(session.id,{themeId:'midnight'});assert.equal(calls,0);
    await cloud.revise(session.id,{slideId:'slide-2',instruction:'内容を保持'});assert.equal(session.chatHandoff?.task,'revise');assert.equal(calls,0);
    await cloud.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(original.variants[0].deck.slides[1])});assert.equal(session.chatHandoff,undefined);assert.equal(calls,0);assert.equal(session.usage.calls,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('history detects stale updates and corrupt content without exposing external thumbnail URLs',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-history-validation-'));
  try{
    const {engine}=await demo(dir);const session=await engine.create({prompt:'同時編集の例'},[]);await engine.message(session.id,'おまかせ');await engine.generate(session.id);
    const first=await engine.restoreHistory(session.historyId!),second=await engine.restoreHistory(session.historyId!);
    await engine.changeTheme(first.session.id,{themeId:'midnight'});await assert.rejects(engine.saveHistory(second.session.id),/別の画面/);
    await engine.changeTheme(second.session.id,{themeId:'business'});assert.match(second.session.historySaveError!,/別の画面/);
    assert.equal((await new HistoryStore(dir).load(session.historyId!)).session.variants[0].deck.themeId,'midnight');
    const name=path.join(dir,'presentations',session.historyId+'.json'),raw=JSON.parse(await readFile(name,'utf8'));
    raw.session.variants[0].render={artifactId:'external',pptxUrl:'https://invalid.example/p.pptx',thumbnails:['https://invalid.example/x.png']};await writeFile(name,JSON.stringify(raw));assert.equal((await new HistoryStore(dir).load(session.historyId!)).session.variants[0].render,undefined);
    raw.session.variants[0].deck.slides[1].sources=[{documentId:'invented',locator:'invented'}];await writeFile(name,JSON.stringify(raw));await assert.rejects(engine.restoreHistory(session.historyId!),/出典/);
    await writeFile(name,'invalid');assert.equal((await engine.listHistory()).entries.length,0);assert.equal((await engine.listHistory()).warnings.length,1);
    await assert.rejects(new HistoryStore(dir).load('../settings'),/ID/);assert.ok((await readdir(dir)).includes('settings.json'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('long instructions remain in history; approved brief replaces full conversation only for generation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-long-prompt-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',model:'test'});
    const original='大切な条件を保持。'.repeat(2000),outline=demoOutline('長文の資料','presentation',[]);outline.inputBrief='学生向け。事例と数学の成立条件を保持し、6枚で説明。';
    const replies=[{kind:'outline',outline},demoDeck(outline)],calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>({complete:async request=>{calls.push(request);return {text:JSON.stringify(replies.shift()),usage:emptyUsage()};}})});
    const session=await engine.create({prompt:original},[]);assert.equal(JSON.parse(calls[0].content).request.needsInputBrief,true);assert.equal(session.messages[0].text,original);
    await engine.generate(session.id);const request=JSON.parse(calls[1].content).request;assert.equal(request.confirmedInstructions,outline.inputBrief);assert.equal(request.messages,undefined);assert.ok(!calls[1].content.includes(original));assert.equal(calls.length,2);
    assert.equal((await new HistoryStore(dir).load(session.historyId!)).session.messages[0].text,original);
    await assert.rejects(engine.create({prompt:'あ'.repeat(MAX_PROMPT_CHARACTERS+1)},[]),/60,000/);assert.equal(calls.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('HTTP accepts a 60,000-character Japanese prompt and PPTX upload, then exposes authenticated history',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-history-http-')),server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,origin=`http://127.0.0.1:${port}`,token='h'.repeat(64);
  try{
    const app=await createApp({authToken:token,port,dataDir:dir,webRoot:dir,artifactRoot:dir,environmentKey:'',nativeAvailable:()=>false,render,providerFactory:()=>{throw new Error('AI forbidden');}});server.on('request',app);
    const bootstrap=await fetch(origin+'/?token='+token,{redirect:'manual'}),cookie=bootstrap.headers.get('set-cookie')!.split(';')[0],headers={Cookie:cookie,Origin:origin,'Content-Type':'application/json'};
    await fetch(origin+'/api/settings',{method:'PUT',headers,body:JSON.stringify({provider:'demo'})});
    const form=new FormData();form.append('files',new Blob([new Uint8Array(await fixture())]),'sample.pptx');const uploaded=await fetch(origin+'/api/documents',{method:'POST',headers:{Cookie:cookie,Origin:origin},body:form});assert.equal(uploaded.status,200);const {documents}=await uploaded.json() as any;
    const post=async(url:string,body:unknown={})=>fetch(origin+'/api'+url,{method:'POST',headers,body:JSON.stringify(body)});
    const response=await post('/sessions',{prompt:'あ'.repeat(60_000),documentIds:[documents[0].id]});assert.equal(response.status,200);let session=await response.json() as any;
    session=await (await post(`/sessions/${session.id}/messages`,{text:'おまかせ'})).json();session=await (await post(`/sessions/${session.id}/generate`)).json();assert.ok(session.historyId);assert.equal(session.usage.calls,0);
    assert.equal((await fetch(origin+'/api/history')).status,401);const list=await (await fetch(origin+'/api/history',{headers})).json() as any;assert.equal(list.entries.length,1);
    const restored=await (await post('/history/'+session.historyId+'/open')).json() as any;assert.equal(restored.session.usage.calls,0);assert.equal(restored.documents[0].kind,'pptx');
    assert.equal((await post('/sessions',{prompt:'あ'.repeat(60_001)})).status,413);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
