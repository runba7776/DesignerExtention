import type {LayoutContext as C,LayoutDefinition} from './layouts';
import type {Rect,SlideItem} from './contracts';
import type {LayoutGroup} from './layout-guidance';
import {panelFill,readableColor} from './color';
const label=(item:SlideItem)=>[item.label,item.value].filter(Boolean).join('  ');
function copy(c:C,item:SlideItem,r:Rect,color=c.theme.foreground){
  const head=Math.min(68,Math.max(34,r.h*.34));
  c.text(label(item),{...r,h:item.description?head:r.h},22,color,true);
  if(item.description)c.text(item.description,{x:r.x,y:r.y+head+10,w:r.w,h:r.h-head-10},18,c.theme.foreground);
}
/** Rebuilt from public Microsoft preview composition principles, with native objects. */
export function registerMicrosoftLayouts(register:(v:LayoutDefinition)=>void){
  const add=(id:string,name:string,group:LayoutGroup,maxItems:number,placement:string,use:string,render:(c:C)=>void,options:Partial<LayoutDefinition>={})=>register({id,name,group,maxItems,minItems:1,placement,description:use,whenToUse:use,textBudget:'項目名12文字、説明36文字。狭い枠は要約し、全文をノートに残す。',references:['microsoft'],render,...options});
  add('ms_color_columns','色面で分ける本文列','points',4,'同じ幅の長方形に見出し・本文を入れ、上端の帯を別色にする','独立した2〜4の要点を、まとまりごとに拾って読ませるとき',c=>{
    const step=872/c.slide.items.length;
    c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24;c.panel({x,y:159,w,h:316},i,'header');copy(c,item,{x:x+17,y:184,w:w-34,h:267},c.itemColor(i));});
  });
  add('ms_frame_columns','枠線でまとめる本文列','points',3,'等幅の枠内に項目名と説明。線と見出しを同じ色にそろえる','読む資料で、長めの説明を2〜3観点に分けるとき',c=>{
    const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24;c.panel({x,y:159,w,h:316},i,'outline');copy(c,item,{x:x+18,y:181,w:w-36,h:271},c.itemColor(i));});
  },{textBudget:'項目名18文字、説明90文字。3列なら説明60文字を目安。'});
  add('ms_color_rows','色面で分ける横の説明','points',4,'横長の長方形ごとに、左へ項目名、右へ説明を配置','各項目の説明が少し長い箇条書きを整理するとき',c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.panel({x:56,y,w:848,h:step-10},i,'tint');c.text(label(item),{x:75,y:y+12,w:237,h:step-34},21,c.itemColor(i),true);c.text(item.description||'',{x:339,y:y+12,w:544,h:step-34},18);});
  },{textBudget:'項目名14文字、説明56文字。4項目なら説明40文字。'});
  add('ms_index_rows','番号の色帯と本文','points',5,'左に同じ幅の番号帯、右の枠に見出しと説明。番号は参照用','確認観点や短い要点を、順序を付けずに一覧で示すとき',c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step,color=c.itemColor(i);c.shape({x:56,y,w:57,h:step-10},color);c.text(String(i+1).padStart(2,'0'),{x:62,y:y+9,w:45,h:step-28},21,readableColor('#FFFFFF',color),true,'center','number');c.panel({x:122,y,w:782,h:step-10},i,'outline');c.text(label(item),{x:139,y:y+9,w:232,h:step-28},20,color,true);c.text(item.description||'',{x:395,y:y+9,w:490,h:step-28},17);});
  },{textBudget:'項目名12文字、説明30文字。番号は優先度・手順を表さない。'});
  add('ms_offset_panels','色枠を段違いに並べる','points',3,'3つの同じ大きさの本文枠を、少しずつ上下にずらす','短い独立した観点を、リズムを付けて紹介するとき',c=>{
    const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,y=159+(i%2)*42,w=step-24;c.panel({x,y,w,h:274},i,'tint');copy(c,item,{x:x+18,y:y+19,w:w-36,h:236},c.itemColor(i));});
  });
  add('ms_banner_comparison','色の見出しと囲まれた比較','comparison',3,'各対象の名前を色帯に置き、その下の枠に同じ高さで説明をそろえる','対象名と説明の対応をはっきりさせたい比較',c=>{
    const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24,color=c.itemColor(i);c.panel({x,y:159,w,h:316},i,'outline');c.shape({x,y:159,w,h:83},color);c.text(label(item),{x:x+16,y:175,w:w-32,h:57},22,readableColor('#FFFFFF',color),true);c.text(item.description||'',{x:x+18,y:262,w:w-36,h:193},19);});
  },{textBudget:'対象名18文字、説明75文字。値を示す場合は単位と条件を残す。'});
  add('ms_metric_tiles','色面に置く同格の数値','metrics',4,'2×2の色面に指標名・大きな数値・説明を配置','2〜4の同格の数値に条件や説明を添えるとき',c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i%2*436,y=159+Math.floor(i/2)*162;c.panel({x,y,w:412,h:152},i);c.text(item.label,{x:x+16,y:y+12,w:378,h:33},20,c.itemColor(i),true);c.text(item.value||'',{x:x+16,y:y+57,w:171,h:77},35,c.itemColor(i),true,'left','number');c.text(item.description||'',{x:x+205,y:y+55,w:191,h:80},17);});
  },{textBudget:'指標名12文字、値8文字、説明28文字。色と面積は優劣や数量を表さない。'});
  add('ms_focus_panel','大きな結論と色で分けた根拠','points',3,'上に広い結論帯、下に等幅の色枠で根拠を並べる','一つの結論と独立した説明をセットで伝えるとき',c=>{
    c.shape({x:56,y:159,w:848,h:104},c.theme.pale);c.text(c.slide.headline||c.slide.body||'',{x:78,y:175,w:804,h:75},28,c.theme.accent,true);const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24;c.panel({x,y:286,w,h:189},i);copy(c,item,{x:x+15,y:302,w:w-30,h:156},c.itemColor(i));});
  },{textBudget:'結論32文字、項目名12文字、説明30文字。'});
}
