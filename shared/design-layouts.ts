import type {LayoutContext as C,LayoutDefinition} from './layouts';
import type {SlideItem} from './contracts';
import type {LayoutGroup} from './layout-guidance';
import {panelFill,readableColor} from './color';

const label=(item:SlideItem)=>[item.label,item.value].filter(Boolean).join('  ');
const valueSize=(c:C)=>c.mode==='presentation'?42:38;
/** Information relationships and visual hierarchy, inspired by the public Cone article. */
export function registerDesignLayouts(register:(v:LayoutDefinition)=>void){
  const add=(id:string,name:string,group:LayoutGroup,maxItems:number,placement:string,use:string,budget:string,render:(c:C)=>void,options:Partial<LayoutDefinition>={})=>register({id,name,group,maxItems,minItems:1,placement,description:use,whenToUse:use,textBudget:budget,references:['cone'],render,...options});
  add('design_icon_circles','円の中にアイコンと要点','points',3,'同じ大きさの円の中にアイコンと大きな項目名、円の下に説明','発表で独立した短い要点を2〜3つ紹介するとき','項目名12文字、値6文字、説明32文字。長い説明は横帯へ。',c=>{
    const step=872/c.slide.items.length;
    c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24,color=c.itemColor(i),d=Math.min(208,w-8),left=x+(w-d)/2;
      c.shape({x:left,y:165,w:d,h:d},panelFill(c.theme,i),'ellipse',color);
      const hasIcon=c.icon(item,{x:left+d/2-24,y:188,w:48,h:48},color);
      c.text(label(item),{x:left+20,y:hasIcon?247:211,w:d-40,h:hasIcon?80:115},26,color,true,'center','label');
      c.text(item.description||'',{x:x+8,y:389,w:w-16,h:85},19,c.theme.foreground,false,'center');
    });
  });
  add('design_icon_tiles','アイコンと本文を囲む','points',4,'2×2の淡い色面。左に意味を表すアイコン、右に大きな見出しと説明','複数の観点を同じ重さで見せ、説明を短く添えるとき','項目名12文字、説明32文字。値を含む長い項目名は横帯へ。',c=>{
    c.slide.items.forEach((item,i)=>{const x=56+i%2*436,y=159+Math.floor(i/2)*162,color=c.itemColor(i);c.panel({x,y,w:412,h:152},i,'tint');
      c.icon(item,{x:x+18,y:y+35,w:48,h:48},color);const tx=x+86,w=306;
      c.text(label(item),{x:tx,y:y+14,w,h:69},26,color,true,'left','label');
      c.text(item.description||'',{x:tx,y:y+88,w,h:52},18);
    });
  });
  add('design_icon_rows','アイコンと見出しの横帯','points',4,'横長の枠の中にアイコン・太い項目名・説明を同じ位置で配置','長めの箇条書きで、項目名と内容の対応を素早く読み取らせるとき','項目名14文字、説明46文字。4項目では説明32文字。',c=>{
    const step=316/c.slide.items.length;
    c.slide.items.forEach((item,i)=>{const y=159+i*step,color=c.itemColor(i);c.panel({x:56,y,w:848,h:step-10},i,'outline');
      const s=Math.min(42,step-28);c.icon(item,{x:76,y:y+(step-10-s)/2,w:s,h:s},color);
      c.text(label(item),{x:138,y:y+10,w:272,h:step-30},24,color,true,'left','label');
      c.text(item.description||'',{x:438,y:y+11,w:444,h:step-31},18);
    });
  });
  add('design_statement','結論を大きな色面に置く','points',3,'左の大きな色面に結論、右に囲まれた根拠や説明。主張と説明の大きさを分ける','明示された一つの結論を最初に読ませたいとき','結論22文字、本文32文字、項目名14文字、説明30文字。',c=>{
    const color=c.theme.accent,ink=readableColor('#FFFFFF',color);
    c.shape({x:56,y:159,w:370,h:316},color,'roundRect');
    c.text(c.slide.headline||c.slide.body||c.slide.title,{x:80,y:189,w:322,h:190},38,ink,true,'left','heading');
    if(c.slide.body&&c.slide.headline&&c.slide.body!==c.slide.headline)c.text(c.slide.body,{x:80,y:398,w:322,h:59},18,ink);
    const step=316/Math.max(1,c.slide.items.length);
    c.slide.items.forEach((item,i)=>{const y=159+i*step,head=step<130?39:60;c.panel({x:454,y,w:450,h:step-12},i,'tint');c.text(label(item),{x:474,y:y+11,w:407,h:head},26,c.itemColor(i),true,'left','label');c.text(item.description||'',{x:474,y:y+head+20,w:407,h:step-head-34},18);});
  },{minItems:0,autoSelect:false,avoidWhen:'結論が決まっていない列挙には使わない。左の主張は資料・指示で明示された内容だけ。'});
  add('design_metric_grid','一行の大きな値と条件','metrics',4,'2×2の色面に小さめの指標名、大きく一続きの値、その下に条件','同格の金額や指標を2〜4つ見せるとき。数値は途中で改行しない','指標名14文字、値16文字、説明22文字。長い値は横帯へ。',c=>{
    const rows=Math.ceil(c.slide.items.length/2),step=316/rows;
    c.slide.items.forEach((item,i)=>{const x=56+i%2*436,y=159+Math.floor(i/2)*step,w=412,color=c.itemColor(i);c.panel({x,y,w,h:step-10},i,'tint');
      c.text(item.label,{x:x+20,y:y+13,w:w-40,h:36},22,color,true,'left','label');
      c.text(item.value||'',{x:x+20,y:y+54,w:w-40,h:Math.min(73,step-100)},valueSize(c),color,true,'left','number');
      c.text(item.description||'',{x:x+20,y:y+step-40,w:w-40,h:29},18);
    });
  });
  add('design_metric_rows','一続きの数値を横帯で読む','metrics',5,'左に指標名、中央の広い領域に大きな値、右に条件。行ごとに淡い色面','桁数の多い金額や、条件を添えた複数の指標を読むとき','指標名12文字、値20文字、説明22文字。単位を含む値は一行で保持。',c=>{
    const step=316/c.slide.items.length;
    c.slide.items.forEach((item,i)=>{const y=159+i*step,color=c.itemColor(i);c.panel({x:56,y,w:848,h:step-8},i,'tint');
      c.text(item.label,{x:76,y:y+10,w:222,h:step-24},23,color,true,'left','label');
      c.text(item.value||'',{x:318,y:y+7,w:365,h:step-20},c.slide.items.length>=5?32:36,color,true,'left','number');
      c.text(item.description||'',{x:706,y:y+10,w:177,h:step-24},17);
    });
  });
  add('design_comparison','アイコンと色帯で比べる','comparison',3,'対象ごとに同じ大きさの枠、上にアイコン、中央の色帯に名前、下に説明','短い比較を対象名と象徴図形で見分けるとき','対象名12文字、値8文字、説明56文字。比較条件を説明に残す。',c=>{
    const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24,color=c.itemColor(i);c.panel({x,y:159,w,h:316},i,'outline');
      c.icon(item,{x:x+w/2-26,y:175,w:52,h:52},color);c.shape({x,y:246,w,h:77},color);
      c.text(label(item),{x:x+14,y:253,w:w-28,h:64},26,readableColor('#FFFFFF',color),true,'center','label');
      c.text(item.description||'',{x:x+20,y:342,w:w-40,h:114},19);
    });
  });
  add('design_process_badges','丸い番号と工程の図形','sequence',5,'工程ごとに丸い番号と本文の図形。工程間を矢印で接続','順序が明確な短い手順を、段階ごとに理解してもらうとき','工程名10文字、説明24文字。5工程なら工程名8文字・説明18文字。',c=>{
    const step=872/c.slide.items.length;c.slide.items.forEach((item,i)=>{const x=56+i*step,w=step-24,color=c.itemColor(i);c.shape({x:x+w/2-35,y:168,w:70,h:70},color,'ellipse');c.text(String(i+1),{x:x+w/2-27,y:177,w:54,h:48},32,readableColor('#FFFFFF',color),true,'center','number');
      c.shape({x,y:262,w,h:93},panelFill(c.theme,i),'roundRect',color);c.text(label(item),{x:x+12,y:274,w:w-24,h:68},24,color,true,'center','label');
      c.text(item.description||'',{x:x+10,y:379,w:w-20,h:96},18);if(i<c.slide.items.length-1)c.shape({x:x+w+4,y:296,w:16,h:18},c.theme.muted,'arrow');
    });
  });
  add('design_process_rows','縦の工程と大きな段階番号','sequence',5,'左に縦に連なる工程番号、右の枠内に工程名と説明','工程の説明が少し長く、横並びでは読みにくいとき','工程名14文字、説明46文字。5工程なら説明32文字。',c=>{
    const step=316/c.slide.items.length;c.slide.items.forEach((item,i)=>{const y=159+i*step,color=c.itemColor(i),d=Math.min(50,step-12);if(i<c.slide.items.length-1)c.scene.elements.push({kind:'line',x:84,y:y+d,w:0,h:step-d,stroke:c.theme.muted,strokeWidth:2});
      c.shape({x:59,y,w:d,h:d},color,'ellipse');c.text(String(i+1),{x:64,y:y+5,w:d-10,h:d-8},28,readableColor('#FFFFFF',color),true,'center','number');
      c.panel({x:130,y,w:774,h:step-10},i,'outline');c.text(label(item),{x:150,y:y+10,w:238,h:step-30},24,color,true,'left','label');c.text(item.description||'',{x:408,y:y+10,w:475,h:step-30},18);
    });
  });
  add('design_equation','数式と意味を図形で分ける','concept',3,'左の色面に大きな数式と成立条件、右の枠に具体例と説明','数式そのものと、それが意味することを一緒に伝えるとき','数式30文字、成立条件40文字、項目名12文字、説明24文字。',c=>{
    c.shape({x:56,y:159,w:412,h:316},c.theme.pale,'roundRect');c.icon({label:'数式',icon:'calculator'},{x:78,y:179,w:42,h:42});
    c.text(c.slide.equation?.text||c.slide.headline||c.slide.body||'',{x:80,y:245,w:364,h:130},36,c.theme.accent,true,'center',c.slide.equation?'equation':'heading');
    c.text(c.slide.equation?.explanation||'',{x:80,y:395,w:364,h:63},18);
    const step=316/Math.max(1,c.slide.items.length);c.slide.items.forEach((item,i)=>{const y=159+i*step,dense=step<130;c.panel({x:494,y,w:410,h:step-12},i);c.text(label(item),{x:514,y:y+9,w:370,h:dense?35:59},24,c.itemColor(i),true,'left','label');c.text(item.description||'',{x:514,y:y+(dense?49:72),w:370,h:step-(dense?63:87)},17);});
  },{equation:true,minItems:0});
}
