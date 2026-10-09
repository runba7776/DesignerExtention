import type { LayoutContext as C, LayoutDefinition } from './layouts';
import type { Rect } from './contracts';

/** Each grammar expresses a different relationship, not a random decoration. */
export function registerExtraLayouts(register:(layout:LayoutDefinition)=>void, helpers:{table:(c:C,r:Rect)=>boolean;items:(c:C,x:number,y:number,w:number,h:number,numbered?:boolean)=>void;diagram:(c:C,type:'list',r:Rect)=>void}) {
  register({id:'table_full',name:'表を大きく',description:'列の多い比較表を全面に配置。数値と単位を省かない',maxItems:3,table:true,textBudget:'列名14文字、セル24文字程度。',render(c){
    if(!helpers.table(c,{x:56,y:164,w:848,h:306}))helpers.items(c,64,165,832,300);
  }});
  register({id:'table_insight',name:'結論と表',description:'短い読み取りを上段、根拠の表を下段に配置',maxItems:3,table:true,textBudget:'要旨38文字。列名12文字、セル20文字程度。',render(c){
    c.text(c.slide.headline||c.slide.body||'比較のポイント',{x:60,y:161,w:836,h:61},25,c.theme.accent,true);
    if(!helpers.table(c,{x:56,y:239,w:848,h:233}))helpers.items(c,64,239,832,233);
  }});
  register({id:'table_bands',name:'対象別の比較帯',description:'表の各行を横の帯に展開。2〜3対象の特徴・条件の比較',maxItems:3,table:true,textBudget:'表は3データ行まで。対象名12文字、セル22文字程度。',render(c){
    const t=c.slide.table;if(!t||t.rows.length>3){if(!helpers.table(c,{x:56,y:164,w:848,h:306}))helpers.items(c,64,165,832,300);return;}
    const step=306/t.rows.length, width=620/Math.max(1,t.headers.length-1);
    t.rows.forEach((row,i)=>{const y=163+i*step;c.shape({x:56,y,w:195,h:step-10},c.theme.pale);c.text(row[0],{x:69,y:y+17,w:168,h:step-37},22,c.theme.accent,true);
      row.slice(1).forEach((cell,j)=>{const x=278+j*width;c.text(t.headers[j+1],{x,y:y+5,w:width-22,h:28},17,c.theme.muted);c.text(cell,{x,y:y+39,w:width-22,h:step-49},20);});c.line(270,y+step-10,632);});
  }});
  register({id:'pillars',name:'柱でまとめる',description:'順序のない3〜4の要点を横に並べる。最後のまとめや方針',maxItems:4,textBudget:'項目名12文字、説明42文字。',render(c){
    const count=Math.max(1,c.slide.items.length),step=848/count;
    c.slide.items.forEach((item,i)=>{const x=56+i*step;c.text(String(i+1).padStart(2,'0'),{x,y:171,w:60,h:64},38,c.theme.accent,true);c.line(x,248,step-28,c.theme.accent);c.text(item.label,{x,y:269,w:step-27,h:67},24,c.theme.foreground,true);c.text(item.description||'',{x,y:351,w:step-27,h:122},19,c.theme.muted);});
  }});
  register({id:'matrix',name:'4象限',description:'4つの独立した観点や分類を2×2で整理。項目間に因果や順位を作らない',maxItems:4,textBudget:'項目名16文字、説明50文字。',render(c){
    c.line(56,317,848);c.shape({x:478,y:165,w:1,h:302},c.theme.pale);
    c.slide.items.forEach((item,i)=>{const x=65+(i%2)*430,y=163+Math.floor(i/2)*162;c.text(item.label,{x,y,w:382,h:40},24,c.theme.accent,true);c.text(item.description||'',{x,y:y+53,w:382,h:94},20);});
  }});
  register({id:'pyramid',name:'階層ピラミッド',description:'上位概念・中位・具体例の階層。重要度の順位が明示された場合にも使う',maxItems:5,textBudget:'上段の項目名8文字、各説明12文字。項目は上段から。',render(c){
    const n=Math.max(1,c.slide.items.length),step=294/n;
    c.slide.items.forEach((item,i)=>{const w=260+490*(i/Math.max(1,n-1)),x=480-w/2,y=168+i*step;c.shape({x,y,w,h:step-8},i===0?c.theme.accent:c.theme.pale);c.text(item.label,{x:x+15,y:y+9,w:w-30,h:step-23},21,i===0?c.theme.background:c.theme.foreground,true,'center');});
  }});
  register({id:'funnel',name:'絞り込み',description:'候補から条件を通して絞る段階。数値の面積比較には使わない',maxItems:5,textBudget:'項目名12文字、説明24文字。上流から並べる。',render(c){
    const n=Math.max(1,c.slide.items.length),step=294/n;
    c.slide.items.forEach((item,i)=>{const w=460-i*60,x=65+(460-w)/2,y=167+i*step;c.shape({x,y,w,h:step-9},i===n-1?c.theme.accent:c.theme.pale);c.text(item.label,{x:x+12,y:y+9,w:w-24,h:step-23},21,i===n-1?c.theme.background:c.theme.foreground,true,'center');c.text(item.description||'',{x:566,y:y+8,w:327,h:step-21},18,c.theme.muted);});
  }});
  register({id:'hub',name:'中心とつながり',description:'中心の概念と4つまでの関連要素。循環や上下関係を意味しない',maxItems:4,textBudget:'中心の要旨12文字、項目名12文字、説明28文字。',render(c){
    const pos=[{x:56,y:166},{x:654,y:166},{x:56,y:346},{x:654,y:346}];
    c.line(280,292,380,c.theme.accent);c.shape({x:357,y:203,w:245,h:218},c.theme.pale,'ellipse');c.text(c.slide.headline||c.slide.body||'中心の考え',{x:381,y:257,w:198,h:107},25,c.theme.accent,true,'center');
    c.slide.items.forEach((item,i)=>{const {x,y}=pos[i];c.text(item.label,{x,y,w:250,h:40},22,c.theme.foreground,true);c.text(item.description||'',{x,y:y+48,w:250,h:76},18,c.theme.muted);});
  }});
  register({id:'steps_vertical',name:'縦のステップ',description:'説明の長い手順を縦方向に並べる。順序がある情報に使う',maxItems:5,textBudget:'項目名18文字、説明55文字。',render(c){
    const step=306/Math.max(1,c.slide.items.length);c.shape({x:82,y:177,w:2,h:276},c.theme.pale);
    c.slide.items.forEach((item,i)=>{const y=165+i*step;c.shape({x:64,y:y+5,w:38,h:38},c.theme.accent,'ellipse');c.text(String(i+1),{x:69,y:y+8,w:28,h:32},19,c.theme.background,true,'center');c.text(item.label,{x:128,y:y+3,w:248,h:step-12},21,c.theme.foreground,true);c.text(item.description||'',{x:408,y:y+3,w:488,h:step-12},18,c.theme.muted);});
  }});
  register({id:'kpi',name:'数値を強調',description:'3〜4個の重要な数値と単位を大きく表示。出典と比較条件を残す',maxItems:4,textBudget:'値は単位付き12文字、項目名12文字、説明30文字。',render(c){
    const step=848/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step;c.panel({x:x-6,y:159,w:step-15,h:316},i);c.text(item.label,{x,y:177,w:step-27,h:71},22,c.itemColor(i),true);c.text(item.value||'',{x,y:268,w:step-27,h:80},38,c.itemColor(i),true);c.line(x,369,step-27);c.text(item.description||'',{x,y:391,w:step-27,h:80},18,c.theme.muted);});
  }});
  register({id:'before_after',name:'変化の前後',description:'同じ対象の変更前と変更後を対置する。異なる2社の比較には使わない',maxItems:2,textBudget:'項目名16文字、説明100文字。',render(c){
    c.slide.items.forEach((item,i)=>{const x=56+i*455;c.line(x,170,389,i===0?c.theme.secondary:c.theme.accent);c.text(item.label,{x,y:192,w:384,h:77},28,c.theme.foreground,true);c.text(item.description||'',{x,y:288,w:384,h:172},21,c.theme.muted);});c.shape({x:455,y:288,w:41,h:45},c.theme.accent,'arrow');
  }});
  register({id:'conclusion',name:'結論と次の行動',description:'大きな結論とそれを受けた最大3つの要点・提案',maxItems:3,textBudget:'要旨45文字、項目名16文字、説明35文字。',render(c){
    c.text(c.slide.headline||c.slide.body||c.slide.title,{x:58,y:197,w:350,h:225},32,c.theme.accent,true);c.shape({x:447,y:166,w:3,h:302},c.theme.pale);helpers.items(c,492,166,409,306,true);
  }});
  register({id:'grouped_list',name:'図形の一覧',description:'関連項目をSmartArtのブロック一覧で整理する',maxItems:6,diagram:true,textBudget:'項目名8文字、説明12文字。',render(c){helpers.diagram(c,'list',{x:56,y:164,w:848,h:303});}});
}
