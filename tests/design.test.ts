import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDeck,wrapText,measureText} from '../shared/layouts';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {improveTextFit,diversifyDeck,visualHierarchyScore} from '../shared/layout-selection';
import {iconCatalog,iconElements,resolveItemIcon} from '../shared/icons';
import {validateSlide} from '../server/validation';
import {themes} from '../shared/themes';
import type {IconId,TextElement} from '../shared/contracts';

test('wrapping preserves whole numbers, magnitude, sign and units; oversized values request a wider box',()=>{
  for(const value of ['13兆5,254億円','102兆6,351億円','△4兆3,391億円','+10.4%','−1,026億円','120.69円']){
    const source=`値は${value}です。`,lines=wrapText(source,160,24);
    assert.equal(lines.join(''),source);assert.ok(lines.some(line=>line.includes(value)),value);
    const tiny=measureText(value,{x:0,y:0,w:100,h:100},40,true);
    assert.equal(tiny.text,value);assert.equal(tiny.overflow,true);
  }
  assert.ok(wrapText('PowerPoint IFRSの説明',150,24).some(line=>line.includes('PowerPoint')));
  const headline=wrapText('要点と根拠を伝える',314,38);assert.equal(headline.join(''),'要点と根拠を伝える');assert.ok(headline.every(line=>line.length>=3));
});
test('long currency values choose a roomier layout locally and remain a single editable line',()=>{
  const values=['13兆5,254億円','1兆634億円','1兆9,638億円','1兆4,770億円'];
  const slide={...sampleSlide('kpi',4),items:values.map((value,i)=>({label:`指標${i+1}`,value,description:'同じ期間の数値。'}))};
  const deck=sampleDeck([slide]),original=structuredClone(deck);
  assert.ok(compileDeck(deck).slides[0].textIssues?.length);
  const fitted=improveTextFit(deck),scene=compileDeck(fitted).slides[0];
  assert.deepEqual(scene.textIssues??[],[]);assert.deepEqual(fitted.slides[0].items,original.slides[0].items);assert.deepEqual(deck,original);
  for(const value of values){const element=scene.elements.find(e=>e.kind==='text'&&e.text===value) as TextElement;assert.ok(element);assert.ok(element.noWrap);assert.ok(element.fontSize>=28);}
});
test('pictograms are bounded editable objects and unknown labels do not invent a status or brand',()=>{
  for(const id of Object.keys(iconCatalog) as IconId[]){
    const r={x:40,y:50,w:48,h:48},elements=iconElements(id,r,'#123456');
    assert.ok(elements.length>=2);assert.ok(elements.every(e=>e.x>=r.x&&e.y>=r.y&&e.x+e.w<=r.x+r.w&&e.y+e.h<=r.y+r.h));
    assert.ok(elements.every(e=>e.kind==='shape'||e.kind==='line'));
  }
  assert.equal(resolveItemIcon({label:'為替の影響'}),'globe');assert.equal(resolveItemIcon({label:'営業利益'}),'coins');
  assert.equal(resolveItemIcon({label:'営業利益',icon:'none'}),undefined);assert.equal(resolveItemIcon({label:'項目 A'}),undefined);
  assert.equal(resolveItemIcon({label:'Toyota'}),undefined);
  assert.equal(validateSlide({...sampleSlide('design_icon_tiles',1),items:[{label:'計算',icon:'calculator'}]}).items[0].icon,'calculator');
  for(const icon of ['__proto__','https://example.com/image.svg','approved'])assert.throws(()=>validateSlide({...sampleSlide('design_icon_tiles',1),items:[{label:'例',icon}]}));
});
test('large values and explanatory text have visible hierarchy in every palette and both modes',()=>{
  for(const themeId of Object.keys(themes))for(const mode of ['presentation','reading'] as const){
    const deck={...sampleDeck([sampleSlide('design_metric_grid',4)],themeId),mode},scene=compileDeck(deck).slides[0];
    const texts=scene.elements.filter((e):e is TextElement=>e.kind==='text');
    const value=texts.find(e=>e.role==='number')!,body=texts.find(e=>e.role==='body')!;
    assert.ok(value.fontSize/body.fontSize>=1.8,`${themeId}/${mode}`);assert.deepEqual(scene.textIssues??[],[]);
  }
  const strong=compileDeck(sampleDeck([sampleSlide('design_metric_grid',4)])).slides[0];
  const plain={...strong,elements:strong.elements.map(e=>e.kind==='text'&&e.y>=150?{...e,fontSize:18}:e)};assert.ok(visualHierarchyScore(strong)>visualHierarchyScore(plain));
});
test('a declared primary message keeps its composition while ordinary points can vary',()=>{
  const slide=sampleSlide('design_statement',2),deck=sampleDeck([sampleSlide('cover'),slide]);
  assert.equal(diversifyDeck(deck,'new-seed').slides[1].layoutId,'design_statement');
});
