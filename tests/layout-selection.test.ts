import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {listLayouts,compileDeck} from '../shared/layouts';
import {themes} from '../shared/themes';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {diversifyDeck,fittingLayouts,improveTextFit} from '../shared/layout-selection';
import {fitProblems} from '../server/text-fit';
import {SettingsStore} from '../server/settings';
import {SessionEngine} from '../server/engine';
import type {DeckSpec} from '../shared/contracts';
import {validateSlide} from '../server/validation';
const content=(deck:DeckSpec)=>deck.slides.map(({layoutId,...slide})=>slide);

test('all 122 grammars document placement/use/limits and fit min/max sample counts in all themes',()=>{
  for(const l of listLayouts()){
    for(const field of ['placement','whenToUse','avoidWhen','textBudget'] as const)assert.ok(l[field].length>5,`${l.id}/${field}`);
    for(const count of [1,l.maxItems])for(const themeId of Object.keys(themes))for(const mode of ['presentation','reading'] as const){
      const deck={...sampleDeck([sampleSlide(l.id,count)],themeId),mode};
      assert.deepEqual(fitProblems(deck),[],`${l.id}/${themeId}/${count}`);
      const scene=compileDeck(deck).slides[0];
      assert.ok(scene.elements.every(e=>e.x>=0&&e.y>=0&&e.w>=0&&e.h>=0&&e.x+e.w<=960&&e.y+e.h<=540),l.id);
      const texts=scene.elements.filter(e=>e.kind==='text');
      for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
        const a=texts[i],b=texts[j],w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x),h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        assert.ok(w<=2||h<=2,`${l.id}: text regions overlap (${a.text}/${b.text})`);
      }
    }
  }
});
test('repeated summaries gain distinct compositions, retain content, and rotate after history',()=>{
  const deck=sampleDeck([sampleSlide('cover'),...Array.from({length:9},(_,i)=>({...sampleSlide('summary',3),id:`slide-${i+2}`}))]);
  const first=diversifyDeck(deck,'first');assert.ok(new Set(first.slides.map(s=>s.layoutId)).size>=7);
  assert.deepEqual(content(first),content(deck));assert.deepEqual(first,diversifyDeck(deck,'first'));
  const next=diversifyDeck(deck,'next',first.slides.map(s=>s.layoutId));assert.notDeepEqual(next.slides.map(s=>s.layoutId),first.slides.map(s=>s.layoutId));
  assert.deepEqual(fitProblems(next),[]);
});
test('layout candidates retain all data and semantic relationships',()=>{
  for(const id of ['comparison','before_after','pyramid','funnel','hierarchy','cycle','concept','table_full','chart_left_notes']){
    const slide=sampleSlide(id),deck=sampleDeck([slide]),current=listLayouts().find(l=>l.id===id)!;
    for(const l of fittingLayouts(deck,slide)){
      if(slide.table)assert.ok(l.table);else if(slide.chart)assert.ok(l.chart);else assert.equal(l.group,current.group,id);
      const next={...slide,layoutId:l.id};assert.deepEqual({...next,layoutId:slide.layoutId},slide);
      if(slide.equation)assert.ok(l.equation);if(slide.diagram)assert.equal(l.diagramType,slide.diagram.type);
    }
  }
  const priority=sampleDeck([sampleSlide('cover'),sampleSlide('kpi_hero')]);
  assert.equal(diversifyDeck(priority,'test').slides[1].layoutId,'kpi_hero');
});
test('roomier layouts resolve overflow before summary and preserve exact prose',()=>{
  const slide=sampleSlide('evidence',3);delete slide.table;
  slide.headline='要点';// Long enough to overflow the narrow column; phrase-aware wrapping needs a few more characters of room.
  slide.items[0].description='期間と条件をそろえて比較し、差がどこから生じるかを確認してから説明します。'.repeat(2).slice(0,66)+'。';
  const deck=sampleDeck([slide]);assert.ok(fitProblems(deck).length);
  const next=improveTextFit(deck);assert.deepEqual(fitProblems(next),[]);assert.deepEqual(content(deck),content(next));
});

test('cause diagrams cannot replace ordinary summaries or omit the outcome',()=>{
  const summary=sampleSlide('summary',3),deck=sampleDeck([summary]);
  assert.ok(fittingLayouts(deck,summary).every(l=>l.group!=='cause'));
  const cause=sampleSlide('cause_fishbone');assert.equal(validateSlide(cause).layoutId,'cause_fishbone');
  assert.deepEqual(fittingLayouts(sampleDeck([cause]),cause).map(l=>l.id).sort(),['cause_convergence','cause_fishbone']);
  assert.throws(()=>validateSlide({...cause,headline:undefined,body:undefined}));
  assert.throws(()=>validateSlide({...cause,items:[]}));
});
test('manual layout change is local, invalidates only its export, and saves no content in layout history',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-layout-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'demo',slideCount:9});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'fake',pptxUrl:'fake',thumbnails:[],native:false,warnings:[]})});
    const session=await engine.create({prompt:'PRIVATE PROMPT'},[]);await engine.message(session.id,'PRIVATE ANSWER');await engine.generate(session.id);
    const v=session.variants[0];const index=v.deck.slides.findIndex(s=>s.layoutId!=='cover'&&fittingLayouts(v.deck,s).some(l=>l.id!==s.layoutId));assert.ok(index>0);
    const prior=structuredClone(v.deck),slide=v.deck.slides[index],candidate=fittingLayouts(v.deck,slide).find(l=>l.id!==slide.layoutId)!;
    await engine.render(session.id,v.id);await engine.changeLayout(session.id,{variantId:v.id,slideId:slide.id,layoutId:candidate.id});
    assert.equal(v.render,undefined);assert.equal(session.usage.calls,0);assert.deepEqual(content(v.deck),content(prior));
    await assert.rejects(engine.changeLayout(session.id,{variantId:v.id,slideId:slide.id,layoutId:'cover'}));
    const history=await readFile(path.join(dir,'layout-history.jsonl'),'utf8');assert.ok(!history.includes('PRIVATE'));assert.deepEqual(Object.keys(JSON.parse(history.trim())),['layouts']);
  }finally{await rm(dir,{recursive:true,force:true});}
});
