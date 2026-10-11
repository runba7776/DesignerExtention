import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Session,SlideSpec} from '../shared/contracts.js';
import {slideContent,transplant} from '../shared/slots.js';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {demoOutline} from '../server/demo.js';
import {validateSlide} from '../server/validation.js';

const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string,extra:Record<string,unknown>={})=>({t:'text',x,y,w,h,text,size,...(role?{role}:{}),...extra});
const title=(text:string)=>t(56,28,848,52,text,28,'title');
/** Draft A: two cards side by side. */
const cardsA=(id:string,heading:string,words:[string,string,string,string])=>validateSlide({id,title:heading,layoutId:id==='slide-1'?'cover':'free',notes:'A のノート',sources:[],design:{elements:[
  title(heading),{t:'box',x:56,y:120,w:400,h:300,shape:'roundRect',fill:'surface'},t(76,140,360,32,words[0],20,'heading'),t(76,184,360,60,words[1],16,'body'),
  {t:'box',x:504,y:120,w:400,h:300,shape:'roundRect',fill:'surface'},t(524,140,360,32,words[2],20,'heading'),t(524,184,360,60,words[3],16,'body')]}},id);
/** Draft B: the same places stacked, on a dark background with different sizes. */
const rowsB=(id:string,heading:string,words:[string,string,string,string])=>validateSlide({id,title:heading,layoutId:id==='slide-1'?'cover':'free',notes:'B のノート',sources:[],design:{background:'ink',elements:[
  t(64,40,832,56,heading,32,'title',{color:'white'}),t(64,140,300,36,words[0],22,'heading',{color:'white'}),t(400,140,496,60,words[1],17,'body',{color:'white'}),
  {t:'line',x1:64,y1:230,x2:896,y2:230,color:'rule'},t(64,250,300,36,words[2],22,'heading',{color:'white'}),t(400,250,496,60,words[3],17,'body',{color:'white'})]}},id);

test('a slide splits into content and design; content of one design is set into another by role',()=>{
  const a=cardsA('slide-2','Aの題名',['Aの見出し1','Aの本文1','Aの見出し2','Aの本文2']);
  const b=rowsB('slide-2','Bの題名',['Bの見出し1','Bの本文1','Bの見出し2','Bの本文2']);
  assert.deepEqual(slideContent(a).texts.map(x=>x.text),['Aの見出し1','Aの本文1','Aの見出し2','Aの本文2']);
  const result=transplant(a,b);assert.ok(result.slide);assert.equal(result.slide.design!.background,'ink');
  const texts=result.slide.design!.elements.filter(e=>e.t==='text').map(e=>(e as any).text);
  assert.deepEqual(texts,['Aの題名','Aの見出し1','Aの本文1','Aの見出し2','Aの本文2']);
  assert.equal(result.slide.notes,'A のノート');assert.equal(result.method,'role');
  // B's positions and sizes are kept.
  assert.deepEqual(result.slide.design!.elements.map(e=>e.t),b.design!.elements.map(e=>e.t));
  assert.equal((result.slide.design!.elements[1] as any).size,22);
});

test('nothing is invented or dropped: a mismatch is reported instead of a slide',()=>{
  const a=cardsA('slide-2','A',['1','2','3','4']);
  const fewer=validateSlide({id:'slide-2',title:'B',layoutId:'free',notes:'',sources:[],design:{elements:[title('B'),t(56,120,400,40,'x',20,'heading')]}},'slide-2');
  assert.match(transplant(a,fewer).reason!,/文章の数/);
  const chart=validateSlide({id:'slide-2',title:'B',layoutId:'free',notes:'',sources:[],design:{elements:[title('B'),{t:'chart',x:56,y:120,w:400,h:300,chart:{type:'column',categories:['x'],series:[{name:'s',values:[1]}]}}]}},'slide-2');
  assert.match(transplant(a,chart).reason!,/グラフの数/);
  // A template slide's items become content too.
  const template:SlideSpec={id:'slide-2',title:'型の題名',layoutId:'summary',items:[{label:'項目1',description:'説明1'},{label:'項目2',description:'説明2'}],notes:'',sources:[]};
  const set=transplant(template,cardsA('slide-2','A',['1','2','3','4']));assert.ok(set.slide);
  assert.deepEqual(set.slide.design!.elements.filter(e=>e.t==='text').map(e=>(e as any).text),['型の題名','項目1','説明1','項目2','説明2']);
  assert.match(transplant(cardsA('slide-2','A',['1','2','3','4']),template).reason!,/型/);
});

test('another AI builds the same outline as a second draft; drafts combine page by page without an AI call',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-combine-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'chat',chatService:'chatgpt',mode:'presentation',slideCount:3});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'/x.pptx',thumbnails:[],warnings:[],native:false}),providerFactory:()=>{throw new Error('no provider');}});
    const outline=demoOutline('組み合わせの確認','presentation',[],3);outline.slides=outline.slides.map((s,i)=>({...s,layoutId:i?'free':'cover'}));
    const reply=(session:Session,value:unknown)=>engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(value)});
    const deckOf=(make:typeof cardsA,prefix:string)=>({mode:'presentation',themeId:'business',id:'d',title:outline.title,slides:outline.slides.map((s,i)=>i===0?{id:s.id,title:s.title,layoutId:'cover',notes:'',sources:[],design:{elements:[t(64,160,800,120,s.title,40)]}}:i===1?make(s.id,s.title,[`${prefix}見出し1`,`${prefix}本文1`,`${prefix}見出し2`,`${prefix}本文2`]):{id:s.id,title:s.title,layoutId:'free',notes:'',sources:[],design:{elements:[title(s.title),t(56,120,400,40,`${prefix}だけの文`,18,'body'),...(prefix==='B'?[t(56,200,400,40,'Bの追加の文',18,'body')]:[])]}})});
    const session=await engine.create({prompt:'組み合わせ'},[]);
    await reply(session,{kind:'outline',outline});await engine.generate(session.id);await reply(session,deckOf(cardsA,'A'));
    assert.equal(session.variants.length,1);assert.equal(session.variants[0].label,'ChatGPT');assert.equal(session.variants[0].origin?.ai,'ChatGPT');
    await assert.rejects(engine.alternate(session.id,{service:'unknown'}),/一覧/);
    await engine.alternate(session.id,{service:'claude'});
    assert.equal(session.chatHandoff?.service,'claude');assert.equal(session.chatHandoff?.task,'generate');assert.equal(session.phase,'ready');
    await reply(session,deckOf(rowsB,'B'));
    assert.equal(session.variants.length,2);assert.equal(session.variants[1].label,'Claude');assert.equal(session.chatHandoff,undefined);
    const [a,b]=session.variants;
    // Page 2: A's content in B's design; page 3: places do not match, so A's design stays.
    await engine.combine(session.id,{picks:[{content:a.id,design:a.id},{content:a.id,design:b.id},{content:a.id,design:b.id}],themeFrom:b.id});
    const combined=session.variants[2];assert.equal(combined.origin?.kind,'combined');assert.equal(combined.deck.themeId,'business');
    assert.equal(combined.deck.slides[1].design!.background,'ink');
    assert.ok(combined.deck.slides[1].design!.elements.some(e=>e.t==='text'&&(e as any).text==='A見出し1'));
    assert.deepEqual(combined.deck.slides[2],a.deck.slides[2]);assert.match(combined.origin!.notes!.join(),/3枚目.*文章の数/);
    const stats=await engine.choiceStats();assert.equal(stats.decisions,1);assert.equal(stats.content.ChatGPT,3);assert.equal(stats.design.Claude,2);
    // Combining again replaces the previous combination; at most three drafts.
    await engine.combine(session.id,{picks:[{content:b.id,design:b.id},{content:b.id,design:b.id},{content:b.id,design:b.id}]});
    assert.equal(session.variants.length,3);await assert.rejects(engine.alternate(session.id,{service:'gemini'}),/3つまで/);
    await engine.removeVariant(session.id,session.variants[2].id);assert.equal(session.variants.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
