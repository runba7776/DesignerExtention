import type {LayoutContext as C,LayoutDefinition} from './layouts';
import type {Rect,SlideItem} from './contracts';
import type {LayoutGroup,ResearchSource} from './layout-guidance';
import {readableColor} from './color';

type Helpers={table:(c:C,r:Rect)=>boolean;chart:(c:C,r:Rect)=>boolean;items:(c:C,x:number,y:number,w:number,h:number,numbered?:boolean)=>void;diagram:(c:C,type:'process'|'cycle'|'hierarchy'|'list',r:Rect)=>void};
const titleOf=(item:SlideItem)=>[item.label,item.value].filter(Boolean).join('  ');
const thesis=(c:C)=>c.slide.headline||c.slide.body||'';
const vertical=(c:C,x:number,y:number,h:number,color=c.theme.pale)=>c.shape({x,y,w:1,h},color);
function block(c:C,item:SlideItem,r:Rect,accent=false){
  if(r.h<75&&item.description){c.text(`${titleOf(item)} — ${item.description}`,r,18,accent?c.theme.accent:c.theme.foreground);return;}
  const labelH=item.description?Math.min(59,Math.max(29,r.h*.36)):r.h;
  c.text(titleOf(item),{...r,h:labelH},21,accent?c.theme.accent:c.theme.foreground,true);
  if(item.description)c.text(item.description,{x:r.x,y:r.y+labelH+7,w:r.w,h:r.h-labelH-7},18,c.theme.muted);
}
function columns(c:C,r:Rect){const step=r.w/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=r.x+i*step;c.panel({x:x-7,y:r.y-6,w:step-17,h:r.h+6},i);block({...c,theme:{...c.theme,accent:c.itemColor(i)}},item,{x,y:r.y,w:step-24,h:r.h},true);});}
function rows(c:C,r:Rect){const step=r.h/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const y=r.y+i*step;c.text(titleOf(item),{x:r.x,y,w:r.w*.3,h:step-13},20,c.theme.accent,true);c.text(item.description||'',{x:r.x+r.w*.34,y,w:r.w*.66,h:step-13},18,c.theme.muted);if(i<c.slide.items.length-1)c.line(r.x,y+step-7,r.w);});}

/** Original editable layouts, informed by the general composition patterns in the research links.
 * No third-party PPTX, artwork, icons, fonts or branded theme is redistributed. */
export function registerTemplateLayouts(register:(v:LayoutDefinition)=>void,h:Helpers){
  function add(id:string,name:string,group:LayoutGroup,placement:string,use:string,maxItems:number,render:(c:C)=>void,options:Partial<LayoutDefinition>={}){
    const refs:ResearchSource[]=group==='timeline'?['timeline','vertical','planning']:group==='sequence'?['swimlane','planning']:group==='comparison'||group==='table'?['comparison','options']:['editorial'];
    register({id,name,group,placement,description:use,whenToUse:use,maxItems,minItems:0,textBudget:'項目名12文字、説明32文字。要旨は36文字以内を目安。長文は要約する。',references:refs,render,...options});
  }
  // Eight genuinely different ways to organize unordered points.
  add('editorial_columns','見出し帯と本文列','points','上部の広い要旨と、下部の2〜4列の説明','大きな主張を複数の観点で説明するとき',4,c=>{
    c.text(thesis(c),{x:56,y:159,w:848,h:85},28,c.theme.accent,true);c.line(56,260,848);columns(c,{x:56,y:282,w:872,h:190});
  });
  add('horizontal_bands','交互の横帯','points','各行の左に題名、右に説明。交互に背景を敷く','文章の長さが違う要点を読み比べるとき',4,c=>{
    const step=316/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const y=160+i*step;if(i%2===0)c.shape({x:56,y,w:848,h:step-8},c.theme.pale);c.text(titleOf(item),{x:73,y:y+12,w:232,h:step-32},21,c.theme.accent,true);c.text(item.description||'',{x:340,y:y+12,w:545,h:step-32},18);});
  });
  add('numbered_grid','番号付きの格子','points','2列の格子。左の小さな番号と、右の見出し・説明','4〜6の独立した要点や確認観点を一覧にするとき',6,c=>{
    const rowCount=Math.ceil(c.slide.items.length/2)||1,step=316/rowCount;c.slide.items.forEach((item,i)=>{const x=56+(i%2)*436,y=159+Math.floor(i/2)*step;c.text(String(i+1).padStart(2,'0'),{x,y,w:42,h:43},25,c.theme.accent,true);block(c,item,{x:x+57,y,w:352,h:step-16});});
  },{textBudget:'6項目なら項目名10文字、説明24文字。番号は参照用で順位ではない。'});
  add('offset_blocks','段違いの要点','points','奇数列は上寄せ、偶数列は下寄せにした3〜4列','短い独立した考えをリズムをつけて提示するとき',4,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step,y=i%2?234:162;block(c,item,{x,y:y+8,w:step-24,h:226},true);});
  });
  add('central_thesis','中央の結論と下の根拠','points','上半分に中央揃えの結論、下半分に横並びの根拠','一つの結論と複数の独立した根拠を伝えるとき',4,c=>{
    c.text(thesis(c),{x:96,y:166,w:768,h:108},32,c.theme.accent,true,'center');c.line(56,302,848);columns(c,{x:56,y:325,w:872,h:148});
  });
  add('takeaway_banner','下部の結論帯','points','上に観点を並べ、下の全幅の帯に結論を置く','根拠を見た後に結論を読んでもらうとき',4,c=>{
    columns(c,{x:56,y:166,w:872,h:192});c.shape({x:56,y:387,w:848,h:88},c.theme.pale);c.text(thesis(c),{x:77,y:402,w:806,h:58},26,c.theme.accent,true);
  });
  add('sidebar_notes','縦見出し欄と要点','points','左に細い主張欄、右の広い領域に説明を縦積み','結論を見失わずに補足説明を読みたいとき',4,c=>{
    c.shape({x:56,y:158,w:241,h:317},c.theme.pale);c.text(thesis(c),{x:76,y:179,w:199,h:274},26,c.theme.accent,true);h.items(c,333,164,566,311);
  });
  add('editorial_rows','見出しと本文の対照','points','細い罫線だけの一覧。左の短い見出しと右の広い文章欄','読む資料で条件や補足も載せたいとき',4,c=>rows(c,{x:56,y:164,w:848,h:310}),{textBudget:'項目名16文字、説明65文字を目安。'});
  // Comparison preserves order and every supplied value; no invented scores.
  add('comparison_rows','対象を縦に比較','comparison','各対象を1行として、左に対象名、右に特徴を配置','2〜3社・製品などの説明文を比較するとき',3,c=>rows(c,{x:56,y:166,w:848,h:309}));
  add('comparison_split','左右の面で比較','comparison','左の色面と右の余白に2対象を対置','2対象を同じ重さで比較したいとき',2,c=>{
    c.shape({x:56,y:158,w:404,h:317},c.theme.pale);c.slide.items.forEach((item,i)=>block(c,item,{x:i?516:79,y:183,w:365,h:268},true));
  },{textBudget:'対象名18文字、説明110文字。'});
  add('comparison_spotlight','上の比較名と広い説明','comparison','横並びの対象名を色帯にし、その真下に説明を置く','対象名を見失いやすい比較資料',3,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step,color=c.itemColor(i);c.panel({x,y:160,w:step-24,h:315},i);c.shape({x,y:160,w:step-24,h:78},color);c.text(titleOf(item),{x:x+13,y:173,w:step-50,h:56},22,readableColor('#FFFFFF',color),true);c.text(item.description||'',{x:x+3,y:263,w:step-30,h:208},20);});
  });
  add('comparison_scorecards','対象名・値・説明の比較','comparison','上に対象名、中央に値、下に条件をそろえて並べる','値と定性的な説明を同時に比較するとき。値がない場合も使える',3,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step;c.text(item.label,{x,y:167,w:step-27,h:65},25,c.theme.foreground,true);c.line(x,245,step-27,c.theme.accent);if(item.value)c.text(item.value,{x,y:264,w:step-27,h:80},37,c.theme.accent,true);c.text(item.description||'',{x,y:item.value?362:268,w:step-27,h:item.value?110:202},19,c.theme.muted);});
  });
  add('before_after_bands','上下で見る変化','change','変更前を上段、変更後を下段にし、左に短い見出し','横長の説明を使って前後の変化を示すとき',2,c=>{
    c.slide.items.forEach((item,i)=>{const y=160+i*163;c.shape({x:56,y,w:848,h:151},i?c.theme.pale:c.theme.background);c.text(titleOf(item),{x:75,y:y+24,w:214,h:105},25,c.theme.accent,true);c.text(item.description||'',{x:329,y:y+23,w:550,h:106},21);});
  });
  add('before_after_bridge','変化を結ぶ中央の橋','change','左右の前後を上部の細い矢印で結び、下に説明','何がどう変化したかを一方向で伝えるとき',2,c=>{
    c.shape({x:376,y:166,w:204,h:43},c.theme.pale,'arrow');c.slide.items.forEach((item,i)=>block(c,item,{x:56+i*459,y:228,w:386,h:246},true));
  });
  // Processes are ordinal. Equal spacing is intentionally not a duration/quantity scale.
  add('chevron_chain','矢印の工程と説明','sequence','上段に横向き矢印、下段に各工程の説明','2〜4段階の短い工程を示すとき',4,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step;c.shape({x,y:171,w:step-18,h:83},c.theme.pale,'arrow');c.text(titleOf(item),{x:x+12,y:187,w:step-52,h:61},22,c.theme.accent,true);c.text(item.description||'',{x:x+3,y:289,w:step-29,h:182},19);});
  });
  add('snake_steps','折り返す工程','sequence','上段を左から右へ進み、下段を右から左へ折り返す','4〜6段階を文字が読める幅で載せるとき',6,c=>{
    const n=c.slide.items.length,cols=Math.ceil(n/2)||1,step=872/cols;
    c.slide.items.forEach((item,i)=>{const row=Math.floor(i/cols),col=row?cols-1-i%cols:i%cols,x=56+col*step,y=159+row*166;c.text(`${i+1}`,{x,y,w:35,h:36},23,c.theme.accent,true);block(c,item,{x:x+41,y,w:step-65,h:141});});
    c.line(70,314,810,c.theme.accent);vertical(c,888,217,190,c.theme.accent);
  },{textBudget:'項目名10文字、説明28文字。順序は番号で明示。'});
  add('staircase_steps','階段状の段階','sequence','左下から右上へ段階を上げ、その上に短い説明','進展や成熟段階が明示されたとき',4,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step,y=357-i*43;c.shape({x,y,w:step-16,h:118+i*43},c.theme.pale);c.text(titleOf(item),{x:x+12,y:y+15,w:step-42,h:82},21,c.theme.accent,true);c.text(item.description||'',{x,y:159,w:step-25,h:Math.max(52,y-177)},18,c.theme.muted);});
  },{autoSelect:false,avoidWhen:'順序や進展がない分類には使わない。段の高さは数値を表さない。'});
  add('alternating_steps','左右交互の工程','sequence','中央の縦軸と番号から左右へ交互に説明を配置','3〜5段階の手順に説明文を添えるとき',5,c=>{
    const step=314/Math.max(1,c.slide.items.length);vertical(c,478,169,291,c.theme.accent);c.slide.items.forEach((item,i)=>{const y=160+i*step,left=i%2===0;c.shape({x:461,y:y+6,w:36,h:36},c.theme.accent,'ellipse');c.text(String(i+1),{x:467,y:y+9,w:24,h:30},18,c.theme.background,true,'center');block(c,item,{x:left?56:527,y,w:377,h:step-8},true);});
  },{textBudget:'項目名12文字、説明20文字。5段階では短い名詞句を使う。'});
  add('timeline_alternating','上下交互の年表','timeline','中央の横軸の上下に、時点と出来事を交互に配置','4〜5の時点を時系列で示すとき',5,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.line(66,317,824,c.theme.accent);c.slide.items.forEach((item,i)=>{const x=56+i*step,top=i%2===0;vertical(c,x+12,top?287:317,29,c.theme.accent);c.shape({x:x+6,y:311,w:12,h:12},c.theme.accent,'ellipse');block(c,item,{x,y:top?159:353,w:step-22,h:121},true);});
  },{textBudget:'時点10文字、出来事24文字。'});
  add('timeline_vertical','余白のある縦年表','timeline','左の縦軸に時点、右の幅広い欄に出来事','各時点の説明が長い年表',5,c=>{
    const step=312/Math.max(1,c.slide.items.length);vertical(c,79,168,296,c.theme.accent);c.slide.items.forEach((item,i)=>{const y=163+i*step;c.shape({x:73,y:y+7,w:13,h:13},c.theme.accent,'ellipse');c.text(titleOf(item),{x:112,y,w:219,h:step-12},20,c.theme.accent,true);c.text(item.description||'',{x:366,y,w:533,h:step-12},18);});
  },{textBudget:'時点14文字、説明40文字。'});
  add('timeline_zigzag','左右に広がる年表','timeline','中央の縦軸から左右交互へ出来事を並べる','3〜4のマイルストーンを一画面で見せるとき',4,c=>{
    const step=312/Math.max(1,c.slide.items.length);vertical(c,479,164,300,c.theme.accent);c.slide.items.forEach((item,i)=>{const y=162+i*step,x=i%2?523:56;c.line(i%2?480:438,y+20,41,c.theme.accent);block(c,item,{x,y,w:382,h:step-10},true);});
  },{textBudget:'時点12文字、説明28文字。'});
  add('roadmap_columns','時点別の計画列','timeline','列の上に時点、下に予定や達成事項を配置','時間順の計画と内容を読み比べるとき',4,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step;c.text(titleOf(item),{x,y:164,w:step-25,h:65},24,c.theme.accent,true);c.text(item.description||'',{x,y:275,w:step-25,h:197},20);});
  });
  // Tables retain the supplied rows/columns; no generated checkmarks, scores or colors based on guesses.
  add('table_column_panels','列ごとの比較パネル','table','表の各列を縦のまとまりにし、同じ行を同じ高さに配置','対象やプランを列で比べるとき',3,c=>{
    const t=c.slide.table;if(!t){columns(c,{x:56,y:166,w:872,h:303});return;}const cw=872/t.headers.length,step=236/Math.max(1,t.rows.length);
    t.headers.forEach((header,j)=>{const x=56+j*cw;c.shape({x,y:160,w:cw-20,h:315},c.theme.pale);c.text(header,{x:x+12,y:173,w:cw-44,h:56},20,c.theme.accent,true);t.rows.forEach((row,i)=>c.text(row[j],{x:x+12,y:238+i*step,w:cw-44,h:step-10},18));});
  },{table:true,textBudget:'列名12文字、セル18文字。行の対応を崩さない。'});
  add('table_spotlight','表と下の読み取り','table','上に全幅の表、下の細い帯に要旨','数値を見てから読み取りを確認する資料',3,c=>{
    if(!h.table(c,{x:56,y:158,w:848,h:235}))rows(c,{x:56,y:158,w:848,h:235});c.shape({x:56,y:409,w:848,h:67},c.theme.pale);c.text(thesis(c),{x:71,y:422,w:818,h:45},22,c.theme.accent,true);
  },{table:true});
  add('table_transposed','行列を入れ替えた比較','table','元の列名を左端に縦並びにし、元の各行を横方向の対象にする','元の表に対象が少なく、項目が多いとき',3,c=>{
    const t=c.slide.table;if(!t){rows(c,{x:56,y:166,w:848,h:300});return;}
    const data={headers:['項目',...t.rows.map(row=>row[0])],rows:t.headers.slice(1).map((header,i)=>[header,...t.rows.map(row=>row[i+1])])};
    // Keep the original first-column header visible as well.
    data.headers[0]=t.headers[0];h.table({...c,slide:{...c.slide,table:data}},{x:56,y:163,w:848,h:312});
  },{table:true,tableMaxRows:3});
  add('table_side_caption','表と左の解説','table','左の約1/4に要旨、右の約3/4に表を置く','表の見方や比較条件を先に説明するとき',3,c=>{
    c.text(thesis(c),{x:56,y:171,w:212,h:301},24,c.theme.accent,true);vertical(c,291,164,309);if(!h.table(c,{x:318,y:162,w:586,h:313}))h.items(c,318,162,586,313);
  },{table:true,textBudget:'要旨28文字、列名10文字、セル14文字。長いセルではtable_fullを使う。'});
  // Four chart compositions with full native chart data.
  add('chart_full','大きなグラフ','chart','グラフを全幅にし、短い読み取りを最下段に添える','細かな系列やラベルを大きく見せたいとき',3,c=>{
    if(!h.chart(c,{x:56,y:160,w:848,h:244}))h.items(c,56,160,848,244);
    rows(c,{x:56,y:449,w:848,h:40});
  },{chart:true,textBudget:'読み取りは1項目。項目名12文字、説明24文字。',maxItems:1});
  add('chart_left_notes','左の読み取りと右のグラフ','chart','左に広めの読み取り、右にグラフ','結論を読んでから数値を見る構成',3,c=>{
    h.items(c,56,165,253,310);if(!h.chart(c,{x:347,y:164,w:555,h:264}))c.text(thesis(c),{x:347,y:171,w:555,h:296},29,c.theme.accent,true);
  },{chart:true,textBudget:'項目名10文字、説明24文字。'});
  add('chart_top_takeaways','上の要点と下のグラフ','chart','上に短い要点を横並び、下に全幅のグラフ','結論を先に提示し、その根拠をグラフで示すとき',3,c=>{
    columns(c,{x:56,y:157,w:872,h:85});if(!h.chart(c,{x:56,y:265,w:848,h:165}))c.text(thesis(c),{x:56,y:272,w:848,h:166},28);
  },{chart:true,textBudget:'項目名10文字、説明18文字。グラフは少ない系列に向く。'});
  add('chart_bottom_takeaways','グラフの下に並ぶ要点','chart','上に全幅のグラフ、下に2〜3個の読み取りを並べる','見た数値から何が言えるかを整理するとき',3,c=>{
    if(!h.chart(c,{x:56,y:159,w:848,h:170}))c.text(thesis(c),{x:56,y:159,w:848,h:170},28);columns(c,{x:56,y:386,w:872,h:90});
  },{chart:true,textBudget:'項目名10文字、説明18文字。'});
  add('kpi_hero','主指標と補助指標','metrics','最初の指標を左半分で大きく、残りを右の一覧にする','主指標の重要性が明示され、補助指標も示すとき',4,c=>{
    const first=c.slide.items[0];if(first){c.text(first.label,{x:56,y:167,w:373,h:69},25,c.theme.foreground,true);c.text(first.value||'',{x:56,y:257,w:373,h:102},52,c.theme.accent,true);c.text(first.description||'',{x:56,y:380,w:373,h:94},20,c.theme.muted);}vertical(c,468,166,308);rows({...c,slide:{...c.slide,items:c.slide.items.slice(1)}},{x:503,y:166,w:401,h:308});
  },{autoSelect:false,avoidWhen:'同格の指標を根拠なく主・従に分けない。最初の指標が主指標と明示されている場合のみ。'});
  add('kpi_rows','横長の指標行','metrics','左に指標名、中央に大きな値、右に条件を縦積み','単位や条件が長い指標を比較するとき',4,c=>{
    const step=312/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const y=164+i*step;c.text(item.label,{x:56,y,w:235,h:step-13},21,c.theme.foreground,true);c.text(item.value||'',{x:319,y,w:231,h:step-13},31,c.theme.accent,true);c.text(item.description||'',{x:584,y,w:320,h:step-13},18,c.theme.muted);if(i<c.slide.items.length-1)c.line(56,y+step-8,848);});
  });
  add('kpi_grid','数値の4分割','metrics','2×2に指標名・値・条件を配置','最大4つの同格の指標を大きく見せるとき',4,c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i%2*440,y=160+Math.floor(i/2)*163;c.text(item.label,{x,y,w:398,h:35},21,c.theme.foreground,true);c.text(item.value||'',{x,y:y+44,w:177,h:83},36,c.theme.accent,true);c.text(item.description||'',{x:x+196,y:y+50,w:205,h:88},18,c.theme.muted);});
  });
  add('hub_orbit','中心を囲む4要素','hub','中央の概念を囲み、上・右・下・左に関連要素を置く','短い関連語と中心概念を一画面で理解するとき',4,c=>{
    c.shape({x:357,y:269,w:246,h:108},c.theme.pale,'ellipse');c.text(thesis(c),{x:381,y:286,w:198,h:77},25,c.theme.accent,true,'center');
    const pos=[{x:331,y:155,w:298,h:98},{x:640,y:267,w:264,h:133},{x:331,y:391,w:298,h:85},{x:56,y:267,w:264,h:133}];
    c.slide.items.forEach((item,i)=>block(c,item,pos[i],true));
  },{textBudget:'中心12文字、項目名10文字、説明18文字。'});
  add('hub_columns','中心と左右の関連一覧','hub','中央の縦長の概念欄、左右に関連要素を縦積み','中心との関係を文章でも説明したいとき',4,c=>{
    c.shape({x:366,y:181,w:228,h:276},c.theme.pale);c.text(thesis(c),{x:389,y:228,w:181,h:182},26,c.theme.accent,true,'center');c.slide.items.forEach((item,i)=>block(c,item,{x:i%2?633:56,y:163+Math.floor(i/2)*161,w:270,h:143},true));
  });
  add('pyramid_side_notes','階層と横の説明','pyramid','左に幅を広げた段、右に各段の解説をそろえる','上位と下位の関係に説明を添えるとき',4,c=>{
    const n=c.slide.items.length||1,step=312/n;c.slide.items.forEach((item,i)=>{const w=214+65*i,x=282-w/2,y=162+i*step;c.shape({x,y,w,h:step-9},c.theme.pale);c.text(titleOf(item),{x:x+12,y:y+12,w:w-24,h:step-33},21,c.theme.accent,true);c.text(item.description||'',{x:545,y:y+11,w:359,h:step-31},18,c.theme.muted);});
  });
  add('funnel_horizontal','横に絞る段階','funnel','左から右へ高さの小さくなる段階、下に条件','候補を段階的に絞り込むことが明示されているとき',4,c=>{
    const step=872/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const x=56+i*step,height=176-i*28,y=159+(176-height)/2;c.shape({x,y,w:step-21,h:height},c.theme.pale);c.text(titleOf(item),{x:x+12,y:y+14,w:step-47,h:height-28},22,c.theme.accent,true,'center');c.text(item.description||'',{x,y:361,w:step-25,h:112},19,c.theme.muted);});
  });
  function formula(c:C,r:Rect){c.text(c.slide.equation?.text||thesis(c)||c.slide.title,r,32,c.theme.accent,true,'center');}
  add('concept_full','中央の式と下の具体例','concept','上部中央に広い数式・概念、下部に具体例を横並び','横に長い式や短い概念を見せたいとき',3,c=>{
    formula(c,{x:76,y:160,w:808,h:102});c.text(c.slide.equation?.explanation||'',{x:76,y:277,w:808,h:60},18,c.theme.muted);columns(c,{x:56,y:356,w:872,h:120});
  },{equation:true});
  add('concept_top','式の帯と説明一覧','concept','上に背景付きの式、下に項目名と説明の対照表','数式の各要素や条件を説明するとき',3,c=>{
    c.shape({x:56,y:158,w:848,h:100},c.theme.pale);formula(c,{x:75,y:172,w:810,h:73});c.text(c.slide.equation?.explanation||'',{x:56,y:270,w:848,h:49},18,c.theme.muted);rows(c,{x:56,y:338,w:848,h:138});
  },{equation:true,textBudget:'項目名10文字、説明28文字。式は省略しない。'});
  add('concept_split','説明の右に概念','concept','左の説明一覧と、右の大きな式・概念を対置','具体例を読んでから一般的な式を確認するとき',4,c=>{
    h.items(c,56,165,376,310);c.shape({x:471,y:159,w:433,h:317},c.theme.pale);formula(c,{x:491,y:181,w:393,h:180});c.text(c.slide.equation?.explanation||'',{x:490,y:386,w:394,h:71},18,c.theme.muted);
  },{equation:true});
  add('cycle_full','全幅の循環図','cycle','中央の大きな循環SmartArtと、下部の補足','循環の各段階を大きく見せたいとき',5,c=>{
    h.diagram(c,'cycle',{x:117,y:153,w:726,h:260});c.text(c.slide.body||c.slide.headline||'',{x:56,y:436,w:848,h:43},19,c.theme.muted);
  },{diagram:true,diagramType:'cycle',textBudget:'項目名8文字、説明8文字。補足36文字。'});
  add('hierarchy_wide','親子図と下の説明','hierarchy','全幅の階層SmartArtに下部の説明帯を加える','親子関係と図全体の読み方を示すとき',7,c=>{
    h.diagram(c,'hierarchy',{x:56,y:156,w:848,h:245});c.text(c.slide.body||c.slide.headline||'',{x:56,y:430,w:848,h:48},19,c.theme.muted);
  },{diagram:true,diagramType:'hierarchy',textBudget:'項目名8文字。本文40文字。各ノードの長い説明はノートへ。'});
}
