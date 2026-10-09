import type {LayoutContext as C,LayoutDefinition} from './layouts';
import type {Rect,SlideItem} from './contracts';
import type {LayoutGroup,ResearchSource} from './layout-guidance';

type Helpers={table:(c:C,r:Rect)=>boolean;chart:(c:C,r:Rect)=>boolean;items:(c:C,x:number,y:number,w:number,h:number,numbered?:boolean)=>void;diagram:(c:C,type:'process'|'cycle'|'hierarchy'|'list',r:Rect)=>void};
const label=(i:SlideItem)=>[i.label,i.value].filter(Boolean).join('  ');
const thesis=(c:C)=>c.slide.headline||c.slide.body||'';
const vertical=(c:C,x:number,y:number,h:number)=>c.shape({x,y,w:2,h},c.theme.pale);
function copy(c:C,item:SlideItem,r:Rect){
  if(r.h<91){c.text([label(item),item.description].filter(Boolean).join(' — '),r,18);return;}
  const head=Math.min(61,Math.max(31,r.h*.34));
  c.text(label(item),{...r,h:head},22,c.theme.accent,true);
  if(item.description)c.text(item.description,{x:r.x,y:r.y+head+8,w:r.w,h:r.h-head-8},18,c.theme.muted);
}
function grid(c:C,r:Rect,cols=2){
  const rows=Math.ceil(c.slide.items.length/cols)||1,w=r.w/cols,h=r.h/rows;
  c.slide.items.forEach((item,i)=>{const x=r.x+i%cols*w,y=r.y+Math.floor(i/cols)*h;if(h>=90)c.panel({x:x-6,y:y-3,w:w-18,h:h-10},i);copy({...c,theme:{...c.theme,accent:c.itemColor(i)}},item,{x,y,w:w-24,h:h-16});});
}
function badge(c:C,text:string,x:number,y:number,size=42){c.shape({x,y,w:size,h:size},c.theme.pale,'ellipse');c.text(text,{x:x+4,y:y+4,w:size-8,h:size-6},size<40?17:19,c.theme.accent,true,'center');}

/** Public product previews inform composition principles only. No paid assets are bundled. */
export function registerPremiumLayouts(register:(v:LayoutDefinition)=>void,h:Helpers){
  function add(id:string,name:string,group:LayoutGroup,placement:string,use:string,maxItems:number,render:(c:C)=>void,options:Partial<LayoutDefinition>={}){
    const refs:ResearchSource[]=group==='cause'?['fishbone']:group==='sequence'?['valuechain','massive']:['simplicity','massive'];
    register({id,name,group,placement,description:use,whenToUse:use,maxItems,minItems:options.chart||options.table||options.diagram?0:1,textBudget:'項目名12文字、説明30文字、要旨28文字が目安。実際の枠に合わせて要約する。',references:refs,render,...options});
  }
  add('margin_memo','余白インデックスのメモ','points','左の細い索引と、右の2列の本文。下に要旨の帯','読む資料の要点を2〜4項目に整理するとき',4,c=>{
    c.text('要点',{x:56,y:160,w:124,h:92},24,c.theme.accent,true);vertical(c,201,159,246);grid(c,{x:237,y:159,w:690,h:246});c.line(56,419,848);c.text(thesis(c),{x:56,y:437,w:848,h:43},22,c.theme.accent,true);
  });
  add('capsule_columns','円ラベルと本文列','points','上部の同じ大きさの円に参照番号、下に項目名と説明','独立した3〜4観点を短い発表で紹介するとき',4,c=>{
    const w=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*w;badge(c,String(i+1).padStart(2,'0'),x,161,64);copy(c,item,{x,y:251,w:w-26,h:221});});
  },{avoidWhen:'円の大きさは数量ではない。番号を順位として説明しない。'});
  add('bracket_pairs','括弧で囲む2つの要点','points','左右の幅広い説明を、上下の開いた括弧でまとめる','2つの観点を余白を取って説明するとき',2,c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i*440;c.line(x,170,405,c.theme.accent);c.shape({x,y:170,w:3,h:37},c.theme.accent);copy(c,item,{x:x+20,y:220,w:365,h:200});c.line(x,467,405,c.theme.accent);c.shape({x:x+402,y:430,w:3,h:37},c.theme.accent);});
  },{textBudget:'項目名18文字、説明100文字。'});
  add('horizontal_tabs','タブ付きの要点棚','points','短いラベルを左のタブに、右の長い欄に説明を入れる','説明量が多い3〜4項目を拾い読みしてほしいとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.shape({x:56,y,w:236,h:step-12},c.theme.pale);c.text(label(item),{x:70,y:y+10,w:207,h:step-32},20,c.theme.accent,true);c.text(item.description||'',{x:319,y:y+10,w:584,h:step-30},19);});
  },{textBudget:'項目名14文字、説明50文字。'});
  add('quadrant_badges','丸番号付き4分割','points','中央を十字に区切り、各領域の外端に小さな丸番号','同格の4観点を一画面で確認するとき',4,c=>{
    vertical(c,478,159,316);c.line(56,315,848);c.slide.items.forEach((item,i)=>{const x=56+i%2*441,y=161+Math.floor(i/2)*165;badge(c,String(i+1),x,y);copy(c,item,{x:x+60,y,w:345,h:138});});
  });
  add('bottom_statement','根拠の棚と大きな結論','points','上半分に根拠を2列、下半分の広い帯に主張を置く','根拠を示した後に一言の結論を強く残すとき',4,c=>{
    grid(c,{x:56,y:158,w:872,h:185});c.shape({x:56,y:365,w:848,h:112},c.theme.pale);c.text(thesis(c),{x:79,y:386,w:802,h:72},29,c.theme.accent,true);
  },{textBudget:'項目名10文字、説明18文字。結論36文字。'});
  add('comparison_badges','円の対象名と左右の説明','comparison','左右の円に対象名を置き、その下に同じ高さで説明する','2対象を同じ扱いで対比するとき',2,c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i*460;c.shape({x:x+78,y:160,w:230,h:106},c.theme.pale,'ellipse');c.text(label(item),{x:x+112,y:183,w:162,h:60},23,c.theme.accent,true,'center');c.text(item.description||'',{x,y:295,w:387,h:178},21);});vertical(c,479,160,316);
  },{textBudget:'対象名12文字、説明90文字。円の面積は値を表さない。'});
  add('comparison_tiles','比較対象の4タイル','comparison','2×2の同じ大きさの面に対象ごとの説明を置く','対象が3〜4個あり、文章で特徴を比較するとき',4,c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i%2*440,y=159+Math.floor(i/2)*165;c.shape({x,y,w:408,h:150},c.theme.pale);copy(c,item,{x:x+19,y:y+14,w:370,h:123});});
  });
  add('comparison_lanes','対象名を左に固定した比較','comparison','各行の左に対象、中央に値、右に説明をそろえる','比較対象の名前・値・条件を読み違えずに確認するとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.text(item.label,{x:56,y:y+7,w:201,h:step-20},22,c.theme.accent,true);c.text(item.value||'—',{x:286,y:y+7,w:165,h:step-20},24,c.theme.foreground,true);c.text(item.description||'',{x:492,y:y+7,w:412,h:step-20},18);if(i<c.slide.items.length-1)c.line(56,y+step-4,848);});
  });
  add('process_gate','番号の関門と手順','sequence','中央の縦軸に番号、左に工程名、右に説明','3〜5段階を順序と説明に分けて示すとき',5,c=>{
    vertical(c,358,163,302);const step=314/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;badge(c,String(i+1),338,y+5,42);c.text(label(item),{x:56,y:y+6,w:247,h:step-16},21,c.theme.accent,true);c.text(item.description||'',{x:414,y:y+6,w:490,h:step-16},18);});
  });
  add('process_stack','工程の積み重ね','sequence','全幅の工程ボックスを縦に並べ、左の矢印で次へ進む','長い説明を持つ3〜4段階の手順',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.shape({x:130,y,w:774,h:step-12},c.theme.pale);c.text(String(i+1),{x:64,y:y+10,w:46,h:40},27,c.theme.accent,true);c.text(label(item),{x:148,y:y+10,w:216,h:step-31},21,c.theme.accent,true);c.text(item.description||'',{x:388,y:y+10,w:497,h:step-31},18);if(i<c.slide.items.length-1)c.shape({x:80,y:y+step-23,w:8,h:18},c.theme.accent);});
  });
  add('process_interleave','段違いの工程リボン','sequence','番号順に上下へずらした縦列を、下の共通軸でつなぐ','短い工程を直線的な箱の列とは別の配置で見せたいとき',4,c=>{
    const w=872/c.slide.items.length;c.line(76,458,809,c.theme.accent);c.slide.items.forEach((item,i)=>{const x=56+i*w,y=i%2?213:160;badge(c,String(i+1),x,y);copy(c,item,{x,y:y+61,w:w-25,h:380-y});c.shape({x:x+20,y:439,w:2,h:19},c.theme.accent);});
  });
  add('milestone_flags','旗型のマイルストーン','timeline','下の横軸から各時点の縦線を立て、上に説明を掲げる','各出来事を同じ重さで順に紹介するとき',4,c=>{
    const w=872/c.slide.items.length;c.line(56,463,848,c.theme.accent);c.slide.items.forEach((item,i)=>{const x=56+i*w;c.shape({x,y:165,w:3,h:298},c.theme.accent);c.shape({x:x+12,y:165,w:w-39,h:74},c.theme.pale);c.text(label(item),{x:x+24,y:181,w:w-63,h:48},22,c.theme.accent,true);c.text(item.description||'',{x:x+15,y:266,w:w-40,h:157},19);});
  });
  add('timeline_two_rows','二段に折り返す年表','timeline','上段を左から右、下段も左から右へ番号付きで続ける','4〜6の時点を広い説明枠に分けるとき',6,c=>{
    const cols=Math.ceil(c.slide.items.length/2),w=872/cols;c.slide.items.forEach((item,i)=>{const x=56+i%cols*w,y=159+Math.floor(i/cols)*165;c.text(String(i+1).padStart(2,'0'),{x,y,w:37,h:32},18,c.theme.muted);c.line(x+43,y+16,w-68,c.theme.accent);copy(c,item,{x,y:y+43,w:w-24,h:109});});
  },{textBudget:'時点12文字、説明24文字。番号は読む順番。間隔は経過時間ではない。'});
  add('timeline_index','時点の索引と出来事','timeline','左1/3の縦帯に時点、右の広い欄に出来事を置く','4〜5時点の経緯を読む資料で整理するとき',5,c=>{
    c.shape({x:56,y:158,w:268,h:317},c.theme.pale);const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.text(label(item),{x:76,y:y+8,w:228,h:step-20},22,c.theme.accent,true);c.text(item.description||'',{x:358,y:y+8,w:546,h:step-20},19);if(i<c.slide.items.length-1)c.line(358,y+step-2,546);});
  });
  add('table_ledger','項目欄が広い台帳','table','左端の項目欄に全幅の34%、残りを等幅にする','項目名が長い表や、条件付きの数値比較',3,c=>{
    const t=c.slide.table;if(!t){grid(c,{x:56,y:160,w:872,h:316});return;}const n=t.headers.length,rh=316/(t.rows.length+1),first=n===1?848:288,rest=n>1?(848-first)/(n-1):0;
    [t.headers,...t.rows].forEach((row,i)=>row.forEach((value,j)=>{const x=56+(j?first+(j-1)*rest:0),w=j?rest:first,y=159+i*rh;if(i===0||j===0)c.shape({x,y,w,h:rh},c.theme.pale);c.text(value,{x:x+11,y:y+9,w:w-22,h:rh-18},18,i===0?c.theme.accent:c.theme.foreground,i===0||j===0);if(j===0)c.line(56,y+rh,848);}));
  },{table:true,textBudget:'項目名22文字、他のセル14文字。表の幅と行数に合わせる。'});
  add('table_split','左右に分けた続き表','table','前半の行を左、後半を右に置き、それぞれ見出しを繰り返す','列数が少なく行が多い表を、行順を保って載せるとき',3,c=>{
    const t=c.slide.table;if(!t){grid(c,{x:56,y:160,w:872,h:316});return;}const split=Math.ceil(t.rows.length/2);[t.rows.slice(0,split),t.rows.slice(split)].forEach((rows,i)=>{if(!rows.length)return;h.table({...c,slide:{...c.slide,table:{...t,rows}}},{x:56+i*443,y:160,w:405,h:314});});
  },{table:true,textBudget:'列数3までを推奨。列名10文字、セル12文字。左上から下、次に右上から下へ読む。'});
  add('table_row_cards','対象ごとの見出し付き表','table','各行を横長のカードとし、セルごとに列名を再掲する','少数対象を比較し、各値の意味を読み違えないようにするとき',3,c=>{
    const t=c.slide.table;if(!t){grid(c,{x:56,y:160,w:872,h:316});return;}const rh=316/Math.max(1,t.rows.length),cw=848/t.headers.length;
    t.rows.forEach((row,i)=>{const y=159+i*rh;c.shape({x:56,y,w:848,h:rh-12},c.theme.pale);row.forEach((value,j)=>{const x=56+j*cw;c.text(t.headers[j],{x:x+13,y:y+8,w:cw-26,h:28},17,c.theme.muted);c.text(value,{x:x+13,y:y+42,w:cw-26,h:rh-60},21,c.theme.accent,true);});});
  },{table:true,tableMaxRows:3,textBudget:'3行まで。列名10文字、セル18文字。'});
  add('metric_circles','数値を囲む円と条件','metrics','同じ大きさの円に数値、下に指標名と条件を並べる','最大3つの値を大きく提示するとき',3,c=>{
    const w=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*w;c.shape({x:x+(w-224)/2,y:160,w:200,h:147},c.theme.pale,'ellipse');c.text(item.value||'',{x:x+(w-224)/2+18,y:199,w:164,h:67},38,c.theme.accent,true,'center');copy(c,{...item,value:undefined},{x,y:337,w:w-24,h:136});});
  },{textBudget:'値8文字、指標名14文字、説明30文字。円の面積は数量を表さない。'});
  add('metric_ruler','数字の帯と説明の列','metrics','上段の共通帯に大きな値、下に各指標の説明をそろえる','同格の指標を一覧し、条件も読ませるとき',4,c=>{
    c.shape({x:56,y:160,w:848,h:108},c.theme.pale);const w=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*w;c.text(item.value||'',{x:x+12,y:178,w:w-44,h:70},35,c.theme.accent,true);copy(c,{...item,value:undefined},{x,y:299,w:w-24,h:174});});
  });
  add('metric_side_numbers','外側の数値と内側の説明','metrics','2列の各段に大きな値の欄と説明の欄を対置する','最大4指標を、値と条件を近づけて見せるとき',4,c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i%2*440,y=160+Math.floor(i/2)*165;c.text(item.value||'',{x,y:y+18,w:140,h:98},38,c.theme.accent,true);copy(c,{...item,value:undefined},{x:x+166,y,w:241,h:144});});
  });
  add('hub_satellites','中央の問いと4つの衛星','hub','中央の縦長の問いの左右に、上下2つずつ関連要素を置く','中心概念を複数の観点で囲んで説明するとき',4,c=>{
    c.shape({x:375,y:233,w:210,h:162},c.theme.pale,'ellipse');c.text(thesis(c),{x:405,y:265,w:150,h:100},24,c.theme.accent,true,'center');c.slide.items.forEach((item,i)=>{const x=i%2?633:56,y=159+Math.floor(i/2)*174;copy(c,item,{x,y,w:271,h:143});c.line(i%2?594:339,y+69,27,c.theme.accent);});
  });
  add('hub_left_root','左の中心と右の関連枝','hub','左の概念欄から、右の縦積みの関連要素へ線を伸ばす','中心と関連の関係を文章付きで説明するとき',4,c=>{
    c.shape({x:56,y:213,w:254,h:209},c.theme.pale);c.text(thesis(c),{x:78,y:241,w:210,h:152},26,c.theme.accent,true);vertical(c,348,183,267);c.line(310,317,39,c.theme.accent);const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;c.line(348,y+step/2,34,c.theme.accent);copy(c,item,{x:404,y:y+5,w:500,h:step-13});});
  });
  add('cause_fishbone','要因を整理する魚骨図','cause','中央の横軸の上下に要因、右端に結果・問題を置く','原因や原因仮説と結果の関係が資料に明示されているとき',4,c=>{
    c.line(65,317,626,c.theme.accent);c.shape({x:704,y:250,w:200,h:134},c.theme.pale);c.text(thesis(c),{x:724,y:268,w:160,h:99},24,c.theme.accent,true);
    c.slide.items.forEach((item,i)=>{const x=56+Math.floor(i/2)*324,top=i%2===0;copy(c,item,{x,y:top?158:360,w:282,h:112});c.shape({x:x+137,y:top?284:317,w:2,h:29},c.theme.accent);});
  },{textBudget:'結果18文字、要因名12文字、説明24文字。仮説ならラベルに仮説と記載する。'});
  add('cause_convergence','要因から結果への合流','cause','左に要因を縦に並べ、中央の線で右の結果に集める','複数の原因を一つの問題に結び付けて説明するとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step;copy(c,item,{x:56,y:y+4,w:480,h:step-13});c.line(552,y+step/2,34,c.theme.accent);});vertical(c,586,189,260);c.shape({x:605,y:295,w:70,h:36},c.theme.pale,'arrow');c.shape({x:699,y:204,w:205,h:232},c.theme.pale);c.text(thesis(c),{x:719,y:228,w:165,h:182},25,c.theme.accent,true);
  });
  add('pyramid_steps_right','右にそろえた階層の段','pyramid','左の帯を下ほど広くし右端をそろえ、右側に各段の説明','上位から具体へという階層関係を示すとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step,w=214+i*55;c.shape({x:471-w,y,w,h:step-12},c.theme.pale);c.text(label(item),{x:485-w,y:y+10,w:w-28,h:step-32},21,c.theme.accent,true);c.text(item.description||'',{x:515,y:y+10,w:389,h:step-30},19);});
  });
  add('pyramid_nested','階層の入れ子一覧','pyramid','上位から下位へ左の余白を増やし、段のつながりを示す','抽象から具体への段階を長い文章で説明するとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*50,y=159+i*step;c.shape({x,y,w:848-i*50,h:step-12},c.theme.pale);c.text(label(item),{x:x+16,y:y+10,w:217,h:step-32},21,c.theme.accent,true);c.text(item.description||'',{x:x+261,y:y+10,w:571-i*50,h:step-32},18);});
  });
  add('funnel_gates','中央へ狭まる関門','funnel','中央に幅が狭まる各段階、左に段番号、右に絞り込み条件','候補を段階的に絞る過程と、その条件を示すとき',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step,w=366-i*46;badge(c,String(i+1),56,y+11);c.shape({x:327-w/2,y,w,h:step-12},c.theme.pale);c.text(label(item),{x:343-w/2,y:y+10,w:w-32,h:step-32},21,c.theme.accent,true,'center');c.text(item.description||'',{x:569,y:y+10,w:335,h:step-31},18);});
  });
  add('funnel_stages','絞り込みの列と説明','funnel','左の段を下ほど短くし、右の説明欄は同じ幅を保つ','絞り込む理由の説明が重要な資料',4,c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step,w=341-i*44;c.shape({x:56,y,w,h:step-12},c.theme.pale);c.text(label(item),{x:70,y:y+10,w:w-28,h:step-32},21,c.theme.accent,true);c.text(item.description||'',{x:456,y:y+10,w:448,h:step-31},19);});
  });
  add('equation_bottom','説明から式へ','concept','上半分に具体例の列、下半分に全幅の式と成立条件','具体例を見せてから共通する式を提示するとき',3,c=>{
    grid(c,{x:56,y:159,w:872,h:155},Math.max(1,c.slide.items.length));c.shape({x:56,y:335,w:848,h:94},c.theme.pale);c.text(c.slide.equation?.text||thesis(c),{x:75,y:349,w:810,h:68},32,c.theme.accent,true,'center');c.text(c.slide.equation?.explanation||'',{x:56,y:445,w:848,h:37},18,c.theme.muted);
  },{equation:true,textBudget:'具体例は見出し10文字、説明28文字。数式を省略しない。'});
  add('equation_spotlight','式の中央面と左右の説明','concept','中央の広い面に式、左右の細い欄に具体例・条件を並べる','短い式を中心に、関連する説明を対照するとき',4,c=>{
    c.shape({x:313,y:158,w:334,h:318},c.theme.pale);c.text(c.slide.equation?.text||thesis(c),{x:335,y:184,w:290,h:134},29,c.theme.accent,true,'center');c.text(c.slide.equation?.explanation||'',{x:335,y:353,w:290,h:99},18,c.theme.muted);c.slide.items.forEach((item,i)=>copy(c,item,{x:i%2?681:56,y:159+Math.floor(i/2)*165,w:223,h:143}));
  },{equation:true,textBudget:'短い式と成立条件45文字。項目名10文字、説明24文字。'});
  add('chart_caption_rail','右の主張と左のグラフ','chart','左約2/3にグラフ、右に要旨、下段に読み取りの列','グラフと主張を並べて読み、その下で根拠を補足するとき',3,c=>{
    if(!h.chart(c,{x:56,y:159,w:564,h:194}))c.text(thesis(c),{x:56,y:164,w:564,h:190},27);c.shape({x:656,y:159,w:248,h:235},c.theme.pale);c.text(thesis(c),{x:676,y:180,w:208,h:193},25,c.theme.accent,true);grid(c,{x:56,y:418,w:872,h:60},Math.max(1,c.slide.items.length));
  },{chart:true,textBudget:'要旨28文字。読み取りは項目名8文字、説明14文字。'});
  add('chart_panel','中央のグラフと左右のメモ','chart','中央のグラフを左右の説明欄ではさむ','系列が少ないグラフを、短い観点とともに示すとき',4,c=>{
    if(!h.chart(c,{x:278,y:174,w:404,h:251}))c.text(thesis(c),{x:278,y:174,w:404,h:251},28);c.slide.items.forEach((item,i)=>copy(c,item,{x:i%2?719:56,y:162+Math.floor(i/2)*164,w:185,h:140}));
  },{chart:true,textBudget:'項目名8文字、説明20文字。多数の系列・長い軸ラベルでは大きなグラフを使う。'});
  add('hierarchy_right','左の読み方と右の親子図','hierarchy','左1/4に図の読み方、右3/4に階層SmartArt','親子関係と、その前提条件を同時に説明するとき',7,c=>{
    c.text(c.slide.body||thesis(c),{x:56,y:178,w:207,h:274},24,c.theme.accent,true);vertical(c,292,162,310);h.diagram(c,'hierarchy',{x:321,y:161,w:583,h:311});
  },{diagram:true,diagramType:'hierarchy',textBudget:'ノード名6文字。読み方40文字。長い説明は本文の別ページに分ける。'});
  add('cycle_right','左の説明と右の循環図','cycle','左の主張欄と、右の大きな循環SmartArtを組み合わせる','繰り返す仕組みとその目的を同時に示すとき',5,c=>{
    c.shape({x:56,y:159,w:242,h:316},c.theme.pale);c.text(c.slide.body||thesis(c),{x:77,y:184,w:200,h:263},24,c.theme.accent,true);h.diagram(c,'cycle',{x:332,y:158,w:572,h:316});
  },{diagram:true,diagramType:'cycle',textBudget:'ノード名8文字、説明8文字。左の主張36文字。'});
  add('change_vertical_arrow','上から下へ変わる状態','change','変更前を上、変更後を下に置き、左の縦線で順序を明示','文章が長い変更前後を同じ幅で読むとき',2,c=>{
    c.shape({x:71,y:211,w:3,h:222},c.theme.accent);c.slide.items.forEach((item,i)=>{const y=159+i*166;badge(c,String(i+1),56,y+10,33);c.shape({x:119,y,w:785,h:151},c.theme.pale);c.text(label(item),{x:138,y:y+14,w:241,h:119},23,c.theme.accent,true);c.text(item.description||'',{x:414,y:y+14,w:469,h:119},20);});
  },{textBudget:'状態名18文字、説明90文字。変更の前後が明確なときのみ。'});
}
