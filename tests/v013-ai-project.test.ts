import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Session} from '../shared/contracts.js';
import {listLayouts} from '../shared/layouts.js';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {demoDeck,demoOutline} from '../server/demo.js';
import {aiKit,aiKitVersion,systemPrompt} from '../server/prompts.js';

const render=async()=>({artifactId:'fixture',pptxUrl:'/fixture.pptx',thumbnails:[],warnings:[],native:false});
const packet=(session:Session)=>JSON.parse(session.chatHandoff!.instruction.split('\n\n').at(-2)!);
async function fixture(count=4){
  const dir=await mkdtemp(path.join(tmpdir(),'de-ai-project-')),settings=await new SettingsStore(dir,'').load();
  await settings.update({provider:'chat',chatService:'claude',mode:'presentation',slideCount:count,designMode:'template'});
  const engine=new SessionEngine({settings,dataDir:dir,render,providerFactory:()=>{throw new Error('no provider call in manual chat');}});
  const outline=demoOutline('プロジェクト連携の確認','presentation',[],count),deck=demoDeck(outline);
  const response=(session:Session,value:unknown)=>engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(value)});
  return {dir,settings,engine,outline,deck,response,dispose:()=>rm(dir,{recursive:true,force:true})};
}

test('AI kit: the icon list only (no themes, fonts, chart advice or layouts) and a stable version',()=>{
  const kit=aiKit();
  assert.match(kit.version,/^[0-9a-f]{8}$/);assert.equal(aiKitVersion(),kit.version);
  assert.match(kit.instructions,new RegExp(`${kit.fileName}.*版 ${kit.version}`));assert.ok(kit.instructions.length<1500,'fits a project instruction field');
  assert.match(kit.instructions,/デザイン（構図・図形・色・文字の大きさ・配置）はあなたに任せます/);
  for(const layout of listLayouts())assert.ok(!kit.catalog.includes(`"id":"${layout.id}"`),`no layout ${layout.id}`);
  assert.doesNotMatch(kit.catalog,/textBudget|maxItems|"placement"|panelStyle/);
  assert.match(kit.catalog,/"coins"/);assert.doesNotMatch(kit.catalog,/waterfall|BIZ UDPGothic|accessible|"paper"|項目名が長い/);
});

test('project prompts are shorter for AI-designed slides; template prompts are always complete',()=>{
  const full=systemPrompt('generate',undefined,{design:'free'}),project=systemPrompt('generate',undefined,{design:'free',mode:'project'});
  assert.ok(project.length<full.length,`${project.length} vs ${full.length}`);
  for(const rule of ['最優先の制約','出典はdocuments中の実在するdocumentId','Element = Text','すべてあなたに任せます'])assert.ok(project.includes(rule),rule);
  assert.match(project,new RegExp(`版 ${aiKitVersion()}`));assert.doesNotMatch(project,/"coins"/,'icon list lives in the project file');
  assert.equal(systemPrompt('plan',undefined,{mode:'project'}),systemPrompt('plan'),'template prompts ignore project mode');
});

test('settings accept only https project pages of the chosen service',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-ai-settings-'));
  try{
    const settings=await new SettingsStore(dir,'').load(),version=aiKitVersion();
    const saved=await settings.update({chatProjects:{claude:{url:'https://claude.ai/project/0199abcd#top',kitVersion:version},chatgpt:{url:'https://chatgpt.com/g/g-p-123/project',kitVersion:version}},chatOpenIn:'app'});
    assert.equal(saved.chatProjects!.claude!.url,'https://claude.ai/project/0199abcd');assert.equal(saved.chatOpenIn,'app');
    await assert.rejects(settings.update({chatProjects:{claude:{url:'https://evil.example/claude.ai',kitVersion:version}}}),/claude\.ai/);
    await assert.rejects(settings.update({chatProjects:{chatgpt:{url:'http://chatgpt.com/project',kitVersion:version}}}),/https/);
    await assert.rejects(settings.update({chatProjects:{claude:{url:'https://user:pass@claude.ai/project/1',kitVersion:version}}}),/https/);
    await assert.rejects(settings.update({chatProjects:{claude:{url:'https://claude.ai/project/1',kitVersion:'old'}}}),/版/);
    await assert.rejects(settings.update({chatOpenIn:'popup'}),/開き方/);
    assert.equal((await settings.update({chatProjects:{other:{url:'https://ai.example.co.jp/workspace/1',kitVersion:version}}})).chatProjects!.other!.url,'https://ai.example.co.jp/workspace/1');
    assert.equal((await settings.update({chatProjects:{other:null}})).chatProjects,undefined);
    assert.equal((await new SettingsStore(dir,'').load()).get().chatOpenIn,'app');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a prepared project gets the short instruction and opens the project; a stale kit falls back to the full one',async()=>{
  const f=await fixture();
  try{
    await f.settings.update({designMode:'free'});
    const outline={...f.outline,slides:f.outline.slides.map((slide,i)=>({...slide,layoutId:i?'free':'cover'}))};
    const freeSlides=outline.slides.map(slide=>({id:slide.id,title:slide.title,layoutId:slide.layoutId,notes:'',sources:[],design:{elements:[{t:'text',x:56,y:28,w:848,h:52,text:slide.title,size:28,role:'title'}]}}));
    const plain=await f.engine.create({prompt:'通常の指示'},[]);const fullLength=plain.chatHandoff!.instruction.length;
    assert.equal(plain.chatHandoff!.instructionMode,'full');assert.equal(plain.chatHandoff!.serviceUrl,'https://claude.ai/');
    await f.settings.update({chatProjects:{claude:{url:'https://claude.ai/project/abc',kitVersion:aiKitVersion()}}});
    const session=await f.engine.create({prompt:'短い指示で構成を考える'},[]);
    assert.equal(session.chatHandoff!.instructionMode,'project');assert.equal(session.chatHandoff!.serviceUrl,'https://claude.ai/project/abc');
    assert.ok(session.chatHandoff!.instruction.length<fullLength);assert.equal(packet(session).request.messages[0].text,'短い指示で構成を考える');
    await f.response(session,{kind:'outline',outline});await f.engine.generate(session.id);
    assert.equal(session.chatHandoff!.instructionMode,'project');assert.equal(packet(session).request.targetSlides.length,4,'one paste for a 4-slide deck');
    const projectLength=session.chatHandoff!.instruction.length;
    const switched=await f.engine.useFullInstruction(session.id);assert.equal(switched.chatHandoff!.instructionMode,'full');assert.ok(switched.chatHandoff!.instruction.length>projectLength);
    await f.response(session,{mode:'presentation',themeId:'business',id:'d',title:outline.title,slides:freeSlides});assert.equal(session.phase,'ready');
    await f.settings.update({chatProjects:{claude:{url:'https://claude.ai/project/abc',kitVersion:'00000000'}}});
    const stale=await f.engine.create({prompt:'版が古い'},[]);assert.equal(stale.chatHandoff!.instructionMode,'full');assert.equal(stale.chatHandoff!.projectStale,true);assert.equal(stale.chatHandoff!.serviceUrl,'https://claude.ai/project/abc');
    // The template layouts never use the project file.
    await f.settings.update({designMode:'template',chatProjects:{claude:{url:'https://claude.ai/project/abc',kitVersion:aiKitVersion()}}});
    assert.equal((await f.engine.create({prompt:'型で作る'},[])).chatHandoff!.instructionMode,'full');
  }finally{await f.dispose();}
});

test('one-shot creation accepts outline and all slides from a single reply, with the usual validation',async()=>{
  const f=await fixture(5);
  try{
    const session=await f.engine.create({prompt:'一度に作る',oneShot:true},[]);
    assert.equal(packet(session).request.oneShot,true);assert.match(session.chatHandoff!.instruction,/"kind":"deck"/);
    await f.response(session,{kind:'deck',outline:f.outline,deck:{...f.deck,slides:f.deck.slides.slice(0,4)}});
    assert.match(session.chatHandoff!.validationIssues!.join(' '),/枚数/);assert.equal(session.phase,'clarifying');
    await f.response(session,{kind:'deck',outline:f.outline,deck:f.deck});
    assert.equal(session.phase,'ready');assert.equal(session.chatHandoff,undefined);assert.equal(session.variants[0].deck.slides.length,5);assert.equal(session.usage.calls,0);
    const normal=await f.engine.create({prompt:'通常'},[]);assert.equal(packet(normal).request.oneShot,undefined);
    await f.response(normal,{kind:'deck',outline:f.outline,deck:f.deck});assert.match(normal.chatHandoff!.validationIssues!.join(' '),/構成の確認/);
  }finally{await f.dispose();}
});
