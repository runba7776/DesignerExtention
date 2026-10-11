import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDeck,wrapText,isNegativeValue} from '../shared/layouts';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {themes} from '../shared/themes';
import {itemColor,panelFill,negativeColor,contrast} from '../shared/color';
import {validateSlide} from '../server/validation';
import type {ShapeElement,SlideSpec,TextElement} from '../shared/contracts';

const word=/[\p{Script=Han}\p{Script=Katakana}ー]/u;
test('Japanese lines never break inside a kanji/katakana word or a number with its unit',()=>{
  for(const [text,width,size] of [['営業収益は増加、営業利益は減少、最終利益は大きく増加',290,24],['通期は増収、営業利益以下は減益の予想',200,24],['社内向けか投資家向けかを決める',180,18],['13兆5,254億円、前年同期比+10.4%',190,17],['第1四半期は為替影響が+3,450億円',300,17],['キャッシュ・フローと自己株式取得',230,22]] as const){
    const lines=wrapText(text,width,size);
    assert.equal(lines.join(''),text);
    for(let i=1;i<lines.length;i++){
      const before=lines[i-1].at(-1)!,after=lines[i][0];
      assert.ok(!(word.test(before)&&word.test(after)),`${text}: ${lines.join(' / ')}`);
      assert.ok(!(/\d/.test(before)&&/[\d,.兆億万円%]/u.test(after)),`${text}: ${lines.join(' / ')}`);
      assert.doesNotMatch(lines[i],/^[、。）」％%]/u);
    }
  }
});
test('no title band, underline, footer rule or card edge stripes; one brand colour for items',()=>{
  for(const [themeId,theme] of Object.entries(themes)){
    for(const id of ['summary','design_metric_rows','central_thesis','comparison_tiles','ms_focus_panel','milestone_flags','offset_blocks']){
      const scene=compileDeck(sampleDeck([sampleSlide(id,3)],themeId)).slides[0];
      const shapes=scene.elements.filter((e):e is ShapeElement=>e.kind==='shape');
      assert.ok(!shapes.some(s=>s.x===0&&s.y===0&&s.w===960&&s.h<200),`${themeId}/${id}: heading band`);
      assert.ok(!scene.elements.some(e=>e.kind==='line'&&(e.y===139||e.y===496)&&e.w===848),`${themeId}/${id}: title/footer rule`);
      assert.ok(!shapes.some(s=>Math.min(s.w,s.h)<=7&&Math.max(s.w,s.h)>=40&&s.fill===itemColor(theme)),`${themeId}/${id}: accent stripe`);
    }
    assert.equal(itemColor(theme,0),itemColor(theme,3));assert.equal(panelFill(theme,0),panelFill(theme,2));
    assert.ok(contrast(negativeColor(theme),panelFill(theme))>=4.5,themeId);assert.ok(contrast(itemColor(theme),panelFill(theme))>=4.5,themeId);
  }
});
test('stand-alone decreases are coloured as decreases; prose is not',()=>{
  for(const value of ['△8.8%','▲1,900億円','-3.2pt','△4兆3,390億円','△3,656,884百万円'])assert.ok(isNegativeValue(value),value);
  for(const value of ['+10.4%','前年同期比△8.8%','△211億円から1,854億円へ黒字転換','2026年'])assert.ok(!isNegativeValue(value),value);
  const slide=sampleSlide('design_metric_rows',2);slide.items[0]={label:'営業利益',value:'1兆634億円',description:'△8.8%'};slide.items[1]={label:'営業収益',value:'13兆5,254億円',description:'+10.4%'};
  const texts=compileDeck(sampleDeck([slide],'business')).slides[0].elements.filter((e):e is TextElement=>e.kind==='text');
  assert.equal(texts.find(t=>t.text==='△8.8%')?.color,negativeColor(themes.business));
  assert.notEqual(texts.find(t=>t.text==='+10.4%')?.color,negativeColor(themes.business));
});
test('waterfall bridges start to end with the real values and rejects a bridge that does not add up',()=>{
  const chart={type:'waterfall' as const,categories:['前年同期','営業面の努力','為替変動の影響','原価改善の努力','諸経費','その他','当期'],series:[{name:'営業利益',values:[11661,700,3450,-850,-1900,-2426,10634]}],unit:'億円'};
  const slide=validateSlide({...sampleSlide('chart_spacious',0),chart}) as SlideSpec;
  const scene=compileDeck(sampleDeck([slide],'business')).slides[0];
  assert.ok(!scene.elements.some(e=>e.kind==='chart'));
  const texts=scene.elements.filter((e):e is TextElement=>e.kind==='text').map(e=>e.text.replace(/\n/g,''));
  for(const label of ['11,661億円','+700億円','+3,450億円','△850億円','△1,900億円','△2,426億円','10,634億円'])assert.ok(texts.includes(label),label);
  const bars=scene.elements.filter((e):e is ShapeElement=>e.kind==='shape'&&e.y>=150);
  assert.equal(bars.length,7);assert.equal(bars.filter(b=>b.fill===negativeColor(themes.business)).length,3);
  assert.deepEqual(scene.textIssues??[],[]);
  assert.throws(()=>validateSlide({...sampleSlide('chart_spacious',0),chart:{...chart,series:[{name:'営業利益',values:[11661,700,3450,-850,-1900,-2426,12000]}]}}),/終点/);
});
test('big-number layout keeps values whole and large in one row or a 2×2 grid',()=>{
  for(const count of [2,3,4]){
    const slide=sampleSlide('design_stat_hero',count);
    slide.items=[{label:'営業収益',value:'13兆5,254億円',description:'前年同期比+10.4%'},{label:'営業利益',value:'1兆634億円',description:'前年同期比△8.8%'},{label:'税引前利益',value:'1兆9,638億円',description:'前年同期比+56.8%'},{label:'親会社帰属利益',value:'1兆4,770億円',description:'前年同期比+75.6%'}].slice(0,count);
    const scene=compileDeck(sampleDeck([slide],'business')).slides[0],numbers=scene.elements.filter((e):e is TextElement=>e.kind==='text'&&e.role==='number');
    // Three long amounts share one row, so they get a smaller (still headline) size.
    assert.equal(numbers.length,count);assert.ok(numbers.every(n=>n.fontSize>=(count===3?32:40)&&!n.text.includes('\n')),`${count}: ${numbers.map(n=>n.fontSize)}`);
    assert.deepEqual(scene.textIssues??[],[]);
    const decrease=scene.elements.find((e):e is TextElement=>e.kind==='text'&&e.text==='前年同期比△8.8%');
    assert.equal(decrease?.color,negativeColor(themes.business));
  }
});
