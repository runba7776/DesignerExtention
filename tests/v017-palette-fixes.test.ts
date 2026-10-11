import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Outline,TextElement} from '../shared/contracts.js';
import {paletteTheme,AI_THEME_ID} from '../shared/ai-theme.js';
import {contrast} from '../shared/color.js';
import {compileDeck} from '../shared/layouts.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {emptyUsage,type CompletionRequest} from '../server/providers.js';
import {validateDeck,validateOutline} from '../server/validation.js';
import type {ParsedDocument} from '../server/document-model.js';

const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string,extra:Record<string,unknown>={})=>({t:'text',x,y,w,h,text,size,...(role?{role}:{}),...extra});
const usage={...emptyUsage(),calls:1};
const palette={name:'夜の任天堂レッド',background:'#14161C',text:'#F4F1EA',muted:'#A9ADB8',accent:'#E4002B',accent2:'#F2B33D'};

test('the AI palette becomes a readable theme that keeps the AI hues',()=>{
  const theme=paletteTheme(palette,'modern');
  assert.equal(theme.background,'#14161C');assert.equal(theme.foreground,'#F4F1EA');assert.equal(theme.secondary,'#F2B33D');
  assert.ok(contrast(theme.accent,theme.background)>=3,'accent readable for large type');
  assert.equal(theme.headingFont,'Yu Gothic UI');
  // Text too faint for its background is darkened only as far as needed.
  const faint=paletteTheme({...palette,background:'#FFFFFF',text:'#C8C8C8',muted:'#E0E0E0',accent:'#FFE680'});
  assert.ok(contrast(faint.foreground,'#FFFFFF')>=4.5&&contrast(faint.muted,'#FFFFFF')>=4.5&&contrast(faint.accent,'#FFFFFF')>=3);
  // A malformed palette is ignored instead of costing another request.
  const outline=(p:unknown)=>validateOutline({title:'x',mode:'presentation',themeId:'business',assumptions:[],palette:p,slides:[{id:'slide-1',title:'表紙',intent:'表紙',layoutId:'cover',keyPoints:[]},{id:'slide-2',title:'本文',intent:'本文',layoutId:'free',keyPoints:[]}]});
  assert.deepEqual(outline(palette).palette,{...palette,background:'#14161C'});
  assert.equal(outline({...palette,accent:'red'}).palette,undefined);
});

test('with おまかせ the deck is coloured with the palette the AI chose; it can be switched away and back, saved as a favorite and restored from history',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-palette-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',model:'mock',slideCount:2,mode:'presentation',themeId:'auto'});
    const outline:Outline={title:'配色のテスト',mode:'presentation',themeId:'midnight',typographyId:'modern',palette,assumptions:[],slides:[{id:'slide-1',title:'表紙',intent:'表紙',layoutId:'cover',keyPoints:[]},{id:'slide-2',title:'本文',intent:'本文',layoutId:'free',keyPoints:[]}]};
    const systems:string[]=[];
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{
      const req=JSON.parse(r.content).request;systems.push(r.system);
      if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      return {text:JSON.stringify({mode:'presentation',themeId:'midnight',id:'d',title:'配色のテスト',slides:[
        {id:'slide-1',title:'表紙',layoutId:'cover',notes:'',sources:[],design:{background:'bg',elements:[t(64,160,832,100,'配色のテスト',40)]}},
        {id:'slide-2',title:'本文',layoutId:'free',notes:'',sources:[],design:{elements:[t(56,28,848,52,'本文',28,'title',{color:'accent'})]}}]}),usage};
    }})});
    const session=await engine.create({prompt:'2枚で'},[]);
    assert.match(systems[0],/outline\.paletteに書きます/);
    await engine.generate(session.id);
    assert.match(systems[1],/accent=#E4002B/,'the pages are designed with the AI colours as names');
    const deck=session.variants[0].deck;assert.equal(deck.themeId,AI_THEME_ID);assert.equal(deck.aiTheme!.background,'#14161C');
    const title=compileDeck(deck).slides[1].elements.find((e):e is TextElement=>e.kind==='text'&&e.text==='本文')!;assert.equal(title.color,'#E4002B');
    await engine.changeTheme(session.id,{themeId:'business'});assert.equal(session.variants[0].deck.themeId,'business');assert.ok(session.variants[0].deck.aiTheme);
    await engine.changeTheme(session.id,{themeId:AI_THEME_ID});assert.equal(session.variants[0].deck.themeId,AI_THEME_ID);
    const favorite=await engine.saveDesign(session.id,{});assert.equal(favorite.themeId,AI_THEME_ID);assert.equal(favorite.palette!.accent,'#E4002B');
    const pack=await engine.exportDesignPack(session.projectId!);assert.equal((pack.designs[0] as any).palette.background,'#14161C');
    const reopened=await engine.restoreHistory(session.historyId!);assert.equal(reopened.session.variants[0].deck.aiTheme!.secondary,'#F2B33D');
    // A theme chosen explicitly in settings wins over the AI palette.
    await settings.update({themeId:'paper'});
    const explicit=await engine.create({prompt:'2枚で'},[]);await engine.generate(explicit.id);
    assert.equal(explicit.variants[0].deck.themeId,'paper');assert.equal(explicit.variants[0].deck.aiTheme,undefined);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('citation markers follow body text, not titles or large numbers',()=>{
  const deck=validateDeck({id:'d',title:'x',mode:'presentation',themeId:'business',slides:[
    {id:'slide-1',title:'表紙',layoutId:'cover',notes:'',sources:[],design:{elements:[t(64,160,832,100,'表紙',40)]}},
    {id:'slide-2',title:'販売台数',layoutId:'free',notes:'',sources:[{documentId:'d1',locator:'p.4'}],design:{elements:[t(56,28,848,52,'販売台数',28,'title',{refs:[1]}),t(56,120,300,80,'1,737',60,'number',{refs:[1]}),t(56,220,600,40,'前年同期比 99.3%増',18,'body',{refs:[1]})]}}]});
  const texts=compileDeck(deck).slides[1].elements.filter((e):e is TextElement=>e.kind==='text').map(e=>e.text);
  assert.ok(texts.includes('1,737')&&texts.includes('販売台数'));assert.ok(texts.some(text=>text.startsWith('前年同期比 99.3%増¹')));
});

test('a quote that differs only in PDF spacing is dropped with a note; an invented one is still refused',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-quote-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',model:'mock',slideCount:2,mode:'presentation',themeId:'business',autoRepair:false});
    const document:ParsedDocument={id:'11111111-1111-4111-8111-111111111111',name:'決算短信.pdf',kind:'pdf',units:1,characters:40,warnings:[],sources:[{id:'d:1',locator:'p.1',text:'売上高 1,905,883 百万円（前年同期比\n99.3 %増）'}]};
    const outline:Outline={title:'x',mode:'presentation',themeId:'business',assumptions:[],slides:[{id:'slide-1',title:'表紙',intent:'表紙',layoutId:'cover',keyPoints:[]},{id:'slide-2',title:'売上高',intent:'本文',layoutId:'free',keyPoints:[]}]};
    let quote='売上高1,905,883百万円(前年同期比99.3%増)';
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{
      if(!JSON.parse(r.content).request.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      return {text:JSON.stringify({mode:'presentation',themeId:'business',id:'d',title:'x',slides:[{id:'slide-1',title:'表紙',layoutId:'cover',notes:'',sources:[],design:{elements:[t(64,160,832,100,'表紙',40)]}},{id:'slide-2',title:'売上高',layoutId:'free',notes:'',sources:[{documentId:document.id,locator:'p.1',quote}],design:{elements:[t(56,28,848,52,'売上高',28,'title')]}}]}),usage};
    }})});
    const ok=await engine.create({prompt:'x'},[document]);await engine.generate(ok.id);
    assert.equal(ok.phase,'ready');assert.equal(ok.variants[0].deck.slides[1].sources[0].quote,quote,'spacing, line breaks and full-width brackets match loosely');
    quote='売上高は1,905,883百万円と過去最高';
    const loose=await engine.create({prompt:'x'},[document]);await engine.generate(loose.id);
    assert.equal(loose.phase,'ready');assert.equal(loose.variants[0].deck.slides[1].sources[0].quote,undefined);assert.ok(loose.warnings.some(w=>w.includes('引用文を外しました')));
    quote='売上高は2,000,000百万円';
    const invented=await engine.create({prompt:'x'},[document]);await assert.rejects(engine.generate(invented.id),/引用が原資料と一致しません/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
