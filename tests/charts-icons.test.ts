import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {iconCatalog,iconGroups,resolveItemIcon} from '../shared/icons';
import {chartCatalog,compatibleChartTypes,chartColors} from '../shared/charts';
import {themes} from '../shared/themes';
import {contrast} from '../shared/color';
import {sampleSlide,sampleDeck} from '../shared/layout-samples';
import {compileDeck} from '../shared/layouts';
import {validateSlide} from '../server/validation';
import {SessionEngine} from '../server/engine';
import {SettingsStore} from '../server/settings';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';
import {SlidePreview} from '../web/SlidePreview';

test('75 offline icons cover technology, study, nature, care, industry, daily life, notices and safety without invented brands',()=>{
  assert.equal(Object.keys(iconCatalog).length,75);
  assert.deepEqual(new Set(Object.values(iconGroups).flat()),new Set(Object.keys(iconCatalog)));
  for(const [label,id] of Object.entries({'データベース':'database','生成AI':'chip','数学の証明':'calculator','幾何の図形':'geometry','大学への進学':'graduation','化学実験':'flask','水資源':'water','医療支援':'medical','工場の製造':'factory','物流の配送':'truck','メール連絡':'mail','法律の比較':'balance'}))assert.equal(resolveItemIcon({label}),id,label);
  assert.equal(resolveItemIcon({label:'OpenAI'}),undefined);
  assert.equal(resolveItemIcon({label:'項目A',description:'クラウドは利用しません。'}),undefined);
  assert.equal(resolveItemIcon({label:'医療支援',icon:'leaf'}),'leaf');
});
test('eight chart types keep the same values and reject misleading/incompatible data',()=>{
  const single={type:'column' as const,categories:['A','B','C'],series:[{name:'内訳',values:[24,0,36]}],unit:'件'};
  const negative={...single,series:[{name:'実績',values:[-3.5,0,12.125]}]};
  assert.deepEqual(compatibleChartTypes(negative),['bar','column','line']);
  assert.deepEqual(compatibleChartTypes(single),['bar','column','line','pie','doughnut']);
  for(const type of Object.keys(chartCatalog).filter(type=>type!=='waterfall')){
    const series=type.startsWith('stacked')?[...single.series,{name:'別の内訳',values:[10,20,30]}]:single.series;
    const slide=validateSlide({...sampleSlide('chart_spacious',0),chart:{...single,type,series}});
    const scene=compileDeck(sampleDeck([slide])),chart=scene.slides[0].elements.find(e=>e.kind==='chart');
    assert.equal(chart?.kind,'chart');if(chart?.kind==='chart'){assert.equal(chart.chartType,type);assert.deepEqual(chart.series,series);}
    const svg=renderToStaticMarkup(React.createElement(SlidePreview,{document:scene,index:0}));assert.doesNotMatch(svg,/NaN|Infinity|undefined/);
  }
  for(const type of ['pie','doughnut','stackedBar','stackedColumn'])assert.throws(()=>validateSlide({...sampleSlide('chart_spacious',0),chart:{...negative,type}}),/非負/);
  assert.throws(()=>validateSlide({...sampleSlide('chart_spacious',0),chart:{...single,type:'doughnut',series:[{name:'空',values:[0,0,0]}]}}),/合計/);
  assert.throws(()=>validateSlide({...sampleSlide('chart_spacious',0),chart:{...single,type:'doughnut',series:[{name:'巨大値',values:[1e308,1e308,0]}]}}),/合計/);
});
test('chart category colours remain distinct and legible in every theme',()=>{
  for(const [id,theme] of Object.entries(themes)){const colors=chartColors(theme);assert.equal(new Set(colors).size,8,id);assert.ok(colors.every(c=>contrast(c,theme.background)>=3),id);}
});
test('local chart changes preserve numbers, sources, other slides and alternative variants with no AI calls',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'designer-charts-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'demo',themeId:'business'});
    const engine=new SessionEngine({settings,dataDir:dir,providerFactory:()=>{throw new Error('No AI allowed');},render:async()=>({artifactId:'test',pptxUrl:'test.pptx',thumbnails:[],warnings:[],native:true})});
    const session=await engine.create({prompt:'グラフの操作'},[]);await engine.message(session.id,'おまかせ');await engine.generate(session.id);await engine.variants(session.id);
    const variant=session.variants[0],other=structuredClone(session.variants[1]),slide=variant.deck.slides.find(s=>s.chart)!,before=structuredClone(variant.deck);
    await engine.render(session.id,variant.id);assert.ok(variant.render);
    await engine.changeChart(session.id,{variantId:variant.id,slideId:slide.id,type:'doughnut'});
    assert.equal(variant.render,undefined);assert.equal(session.usage.calls,0);
    const changed=variant.deck.slides.find(s=>s.id===slide.id)!;
    assert.deepEqual(changed.chart,{...slide.chart,type:'doughnut'});assert.deepEqual(changed.sources,slide.sources);assert.equal(changed.notes,slide.notes);
    assert.deepEqual(variant.deck.slides.filter(s=>s.id!==slide.id),before.slides.filter(s=>s.id!==slide.id));assert.deepEqual(session.variants[1],other);
    const snapshot=structuredClone(variant);await assert.rejects(engine.changeChart(session.id,{variantId:variant.id,slideId:slide.id,type:'stackedBar'}),/条件/);assert.deepEqual(variant,snapshot);
    await assert.rejects(engine.changeChart(session.id,{variantId:variant.id,slideId:slide.id,type:'__proto__'}),/条件/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
