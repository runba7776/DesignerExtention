import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDeck,listLayouts,registerLayout,wrapText} from '../shared/layouts';
import type {DeckSpec,SlideSpec} from '../shared/contracts';
import {MAX_SLIDES} from '../shared/contracts';
import {themes} from '../shared/themes';

const makeSlide=(layoutId:string):SlideSpec=>({id:layoutId,title:'情報の関係を分かりやすく説明する',layoutId,headline:'問いと根拠をつなぐ',body:'比較や図解を使い、伝えたいことを明確にする。',items:[{label:'問い',description:'何を説明したいかを整理する。'},{label:'根拠',description:'説明を支える情報を選ぶ。'},{label:'解釈',description:'根拠から分かる範囲を示す。'}],notes:'元のノート',sources:[]});
const deck=(slide:SlideSpec):DeckSpec=>({id:'test',title:'検証',mode:'presentation',themeId:'paper',slides:[slide]});

test('registered layouts fit widescreen bounds in both themes',()=>{
  for(const layout of listLayouts())for(const themeId of Object.keys(themes)){
    const slide=makeSlide(layout.id);slide.items=slide.items.slice(0,layout.maxItems);
    const scene=compileDeck({...deck(slide),themeId});
    assert.ok(scene.slides[0].elements.length>0);
    for(const e of scene.slides[0].elements){assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=960&&e.y+e.h<=540,`${layout.id} has an off-slide element`);}
  }
});
test('oversized Japanese content stays complete and requests summarization instead of ellipsis',()=>{
  const slide=makeSlide('concept');
  slide.headline='日本語の長い説明を失わず保持します。'.repeat(50);
  const result=compileDeck(deck(slide)).slides[0];
  assert.ok(result.notes.includes(slide.headline));
  assert.ok(result.notes.includes('元のノート'));
  assert.ok(result.warnings.length>0);
  assert.ok(result.textIssues?.length);
  assert.ok(result.elements.some(e=>e.kind==='text'&&e.text.replace(/\n/g,'')===slide.headline));
  assert.ok(result.elements.every(e=>e.kind!=='text'||!e.text.includes('…')));
});
test('native chart scene preserves negative, zero and decimal numeric evidence',()=>{
  const slide=makeSlide('evidence');
  slide.chart={type:'bar',categories:['項目A','項目B','項目C'],series:[{name:'観測値',values:[-3.5,0,12.125]}],unit:'単位'};
  const result=compileDeck(deck(slide)).slides[0].elements.find(e=>e.kind==='chart');
  assert.ok(result?.kind==='chart');
  assert.deepEqual(result.series[0].values,[-3.5,0,12.125]);
});
test('30-slide limit allows larger decks without silently dropping a slide',()=>{
  assert.equal(compileDeck({...deck(makeSlide('cover')),slides:Array.from({length:MAX_SLIDES},()=>makeSlide('summary'))}).slides.length,MAX_SLIDES);
  assert.throws(()=>compileDeck({...deck(makeSlide('cover')),slides:Array.from({length:MAX_SLIDES+1},()=>makeSlide('summary'))}),/1〜30/);
});
test('extension registry supports a new layout without changing the content contract',()=>{
  registerLayout({id:'test_extension',name:'拡張',description:'登録試験',maxItems:1,render(c){c.text('拡張した構図',{x:60,y:170,w:800,h:60});}});
  assert.ok(compileDeck(deck(makeSlide('test_extension'))).slides[0].elements.some(e=>e.kind==='text'&&e.text==='拡張した構図'));
  assert.throws(()=>registerLayout({id:'test_extension',name:'重複',description:'',maxItems:0,render(){}}),/登録済み/);
});
test('CJK wrapping handles explicit paragraphs and never loses characters',()=>{
  const text='数学のおもしろさを伝える\n12345';
  const lines=wrapText(text,110,20);
  assert.equal(lines.join(''),text.replace('\n',''));
  assert.ok(lines.length>2);
});
