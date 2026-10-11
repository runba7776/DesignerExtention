import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SettingsStore} from '../server/settings';
import {SessionEngine} from '../server/engine';
import {demoDeck,demoOutline} from '../server/demo';
import {applySummaries,assertTextFits,fitProblems} from '../server/text-fit';
import {compileDeck,listLayouts} from '../shared/layouts';
import {themes} from '../shared/themes';
import {emptyUsage,type CompletionRequest} from '../server/providers';
import {validateDeck} from '../server/validation';
import type {RenderResult} from '../shared/contracts';

const rendered:RenderResult={artifactId:'test',pptxUrl:'test.pptx',thumbnails:[],native:false,warnings:[]};
test('122 grammars and twelve themes compile complete 30-page demos in both modes',()=>{
  assert.equal(listLayouts().length,122);
  for(const mode of ['presentation','reading'] as const)for(const themeId of Object.keys(themes)){
    const d=demoDeck(demoOutline('図形文法の確認',mode,[],30));d.themeId=themeId;
    assert.equal(validateDeck(d).slides.length,30);
    assert.deepEqual(fitProblems(d),[],`${mode}/${themeId}`);
    const scene=compileDeck(d);
    assert.equal(scene.slides.length,30);
    assert.ok(scene.slides.every(s=>s.elements.every(e=>e.x>=0&&e.y>=0&&e.x+e.w<=960&&e.y+e.h<=540)));
  }
});

test('summary changes prose only, retains originals and rejects invented numbers or writable paths',()=>{
  const deck=demoDeck(demoOutline('検証','presentation',[]));
  deck.slides[1].items[0].description='売上は24点で、前期の数字と同じ条件を使用して比較しているという事実を示します。'.repeat(3);
  assert.ok(fitProblems(deck).length);
  const before=structuredClone(deck), path='items.0.description';
  const revised=applySummaries(deck,{replacements:[{slideId:'slide-2',path,text:'売上は24点。'}]},['slide-2']);
  assertTextFits(revised);
  assert.deepEqual(revised.slides[1].chart,before.slides[1].chart);
  assert.ok(revised.slides[1].notes.includes(before.slides[1].items[0].description!));
  assert.deepEqual(deck,before);
  for(const [badPath,text] of [[path,'売上は25点。'],['chart.series.0.values.0','999'],['__proto__.bad','x'],[path,'売上は…']])assert.throws(()=>applySummaries(deck,{replacements:[{slideId:'slide-2',path:badPath,text}]},['slide-2']));
});

test('settings persist slide count/theme and reject out-of-range or unknown values',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-settings-'));
  try{
    const s=await new SettingsStore(dir,'').load();await s.update({slideCount:30,themeId:'business'});
    const loaded=(await new SettingsStore(dir,'').load()).get();assert.equal(loaded.slideCount,30);assert.equal(loaded.themeId,'business');
    for(const bad of [1,31,2.5,'9'])await assert.rejects(s.update({slideCount:bad}));
    await assert.rejects(s.update({themeId:'__proto__'}));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('9 slides use two generation calls; explicit theme wins and changing theme uses no LLM',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-batches-'));
  try{
    const s=await new SettingsStore(dir,'').load();await s.update({provider:'local',designMode:'template',model:'test',slideCount:9,themeId:'warm'});
    const outline=demoOutline('9枚の確認','presentation',[],9);outline.themeId='business';const deck=demoDeck(outline);
    const calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings:s,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async request=>{
      calls.push(request);const body=JSON.parse(request.content), targets=body.request.targetSlides;
      return {usage:{...emptyUsage(),calls:1},text:JSON.stringify(targets?{...deck,slides:targets.map((t:any)=>deck.slides.find(s=>s.id===t.id))}:{kind:'outline',outline})};
    }})});
    const session=await engine.create({prompt:'9枚で説明してください'},[]);await engine.generate(session.id);
    assert.equal(calls.length,3);assert.equal(session.variants[0].deck.slides.length,9);assert.equal(session.variants[0].deck.themeId,'warm');
    assert.equal(JSON.parse(calls[1].content).request.targetSlides.length,6);assert.equal(JSON.parse(calls[2].content).request.targetSlides.length,3);
    await engine.render(session.id,session.variants[0].id);
    await engine.changeTheme(session.id,{variantId:session.variants[0].id,themeId:'studio'});
    assert.equal(session.variants[0].deck.themeId,'studio');assert.equal(session.variants[0].render,undefined);assert.equal(calls.length,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('failed later batch reuses completed pages on retry',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-resume-'));
  try{
    const s=await new SettingsStore(dir,'').load();await s.update({provider:'local',designMode:'template',model:'test',slideCount:9});
    const outline=demoOutline('再開確認','presentation',[],9), deck=demoDeck(outline);const batches:string[]=[];let fail=true;
    const engine=new SessionEngine({settings:s,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{
      const target=JSON.parse(r.content).request.targetSlides;if(!target)return {text:JSON.stringify({kind:'outline',outline}),usage:emptyUsage()};
      batches.push(target[0].id);if(target[0].id==='slide-7'&&fail){fail=false;throw new Error('temporary test error');}
      return {text:JSON.stringify({...deck,slides:target.map((t:any)=>deck.slides.find(s=>s.id===t.id))}),usage:emptyUsage()};
    }})});
    const session=await engine.create({prompt:'9枚'},[]);await assert.rejects(engine.generate(session.id));await engine.generate(session.id);
    assert.deepEqual(batches,['slide-1','slide-7','slide-7']);assert.equal(session.variants[0].deck.slides.length,9);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('overflow triggers one grouped summarization call without resending documents',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-summary-'));
  try{
    const s=await new SettingsStore(dir,'').load();await s.update({provider:'local',designMode:'template',model:'test',themeId:'midnight'});
    const outline=demoOutline('要約確認','presentation',[]), deck=demoDeck(outline);deck.slides[0].headline='同じ単位と期間で比較し、値の違いを慎重に確かめます。'.repeat(5);
    const responses=[{kind:'outline',outline},deck,{replacements:[{slideId:'slide-1',path:'headline',text:'単位と期間をそろえて比較。'}]}];const calls:CompletionRequest[]=[];
    const engine=new SessionEngine({settings:s,dataDir:dir,render:async()=>rendered,providerFactory:()=>({complete:async r=>{calls.push(r);return {text:JSON.stringify(responses.shift()),usage:emptyUsage()};}})});
    const session=await engine.create({prompt:'要約してください'},[]);await engine.generate(session.id);
    assert.equal(calls.length,3);assert.deepEqual(JSON.parse(calls[2].content).documents,[]);assertTextFits(session.variants[0].deck);
    assert.ok(session.variants[0].deck.slides[0].notes.includes('慎重に'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
