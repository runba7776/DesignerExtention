import type { DeckSpec, RenderDocument, SceneSlide, SceneElement, SlideSpec, Theme, TextElement, Rect, SlideItem, ShapeElement } from './contracts';
import { MAX_SLIDES } from './contracts';
import { themes } from './themes';
import { registerExtraLayouts } from './extra-layouts';
import { registerTemplateLayouts } from './template-layouts';
import { registerPremiumLayouts } from './premium-layouts';
import { registerMicrosoftLayouts } from './microsoft-layouts';
import { registerDesignLayouts } from './design-layouts';
import {iconElements,resolveItemIcon} from './icons';
import {chartColors,chartGridColor,isShareChart} from './charts';
import {withTypography,fontFor} from './typography';
import {itemColor,panelFill} from './color';
import { legacyGuidance, groupCautions, type LayoutGroup, type ResearchSource } from './layout-guidance';
import {TEMPLATE_THEME_ID} from './themes';
export { themes } from './themes';

export interface LayoutDefinition { id: string; name: string; description: string; maxItems: number; minItems?:number; textBudget?:string; chart?:boolean; table?:boolean; equation?:boolean; diagram?:boolean; diagramType?:'list'|'process'|'cycle'|'hierarchy'; group?:LayoutGroup; placement?:string; whenToUse?:string; avoidWhen?:string; references?:ResearchSource[]; tableMaxRows?:number; autoSelect?:boolean; render: (ctx: LayoutContext) => void }
export interface LayoutContext {
  slide: SlideSpec; scene: SceneSlide; theme: Theme; mode: DeckSpec['mode'];
  text: (text: string, rect: Rect, size?: number, color?: string, bold?: boolean, align?: TextElement['align'],role?:TextElement['role']) => void;
  itemColor: (index:number)=>string;
  panel: (rect:Rect,index:number,style?:'tint'|'outline'|'header')=>void;
  shape: (rect: Rect, fill: string, shape?: ShapeElement['shape'],stroke?:string) => void;
  icon: (item:SlideItem,rect:Rect,color?:string)=>boolean;
  line: (x: number, y: number, w: number, color?: string) => void;
}

const registry = new Map<string, LayoutDefinition>();
export function registerLayout(layout: LayoutDefinition): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(layout.id)) throw new Error('構図のIDが不正です。');
  if (registry.has(layout.id)) throw new Error(`構図 ${layout.id} は登録済みです。`);
  registry.set(layout.id, layout);
}
export function listLayouts() {
  return [...registry.values()].map(({render, ...definition}) => {
    const guidance=legacyGuidance[definition.id], group=definition.group??guidance?.group??'points';
    const diagramTypes:Record<string,'process'|'hierarchy'|'cycle'|'list'>={process:'process',hierarchy:'hierarchy',cycle:'cycle',grouped_list:'list'};
    return {...definition,group,minItems:definition.minItems??0,placement:definition.placement??guidance?.placement??definition.description,whenToUse:definition.whenToUse??definition.description,avoidWhen:definition.avoidWhen??groupCautions[group],textBudget:definition.textBudget??'項目名12文字、説明36文字を目安にする。枠の実測を優先する。',equation:definition.equation??definition.id==='concept',diagramType:definition.diagramType??diagramTypes[definition.id]};
  });
}
export const layoutCatalog = listLayouts;

/** Conservative line measurement shared by SVG preview and native PowerPoint. */
export function textUnits(text:string){return Array.from(text).reduce((sum,char)=>sum+(/[\u0000-\u007f]/.test(char)?(/[MW@%]/.test(char)?0.85:0.56):1),0);}
const textTokens=(text:string)=>text.match(/[+−△▲-]?\d+(?:[,.]\d+)*(?:(?:兆|億|万|千)\d+(?:[,.]\d+)*)*(?:兆|億|万|千)?(?:円|ドル|点|%|％|倍|人|社|件|年|月|日|時間|分|秒)?|[A-Za-z]+(?:[-_][A-Za-z0-9]+)*|./gu)??[];
export function wrapText(text: string, width: number, fontSize: number): string[] {
  const limit = Math.max(1, width / fontSize);
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    const first=lines.length;
    let line = '', units = 0;
    // A number with magnitude/currency/unit, or an English word, is indivisible.
    const tokens=textTokens(paragraph);
    for (const token of tokens) {
      const weight=textUnits(token);
      if (units + weight > limit && line) { lines.push(line); line = ''; units = 0; }
      line += token; units += weight;
    }
    lines.push(line);
    // Avoid a lone trailing character. Rebalance only the last two automatic
    // lines, preferring punctuation/particles and keeping numeric tokens whole.
    if(lines.length-first>=2&&textUnits(line)<limit*.3){
      const index=lines.length-2,combined=textTokens(lines[index]+line);let best: {left:string;right:string;cost:number}|undefined;
      for(let i=1;i<combined.length;i++){
        const left=combined.slice(0,i).join(''),right=combined.slice(i).join(''),a=textUnits(left),b=textUnits(right);
        if(a>limit||b>limit||/^[、。，．！？!?:;）〉》」』]/u.test(right)||/[（「『]$/u.test(left))continue;
        const cost=Math.abs(a-b)-(/[、。]$/u.test(left)?4:/[をがはとでにへの]$/u.test(left)?2:0);
        if(!best||cost<best.cost)best={left,right,cost};
      }
      if(best){lines[index]=best.left;lines[index+1]=best.right;}
    }
  }
  return lines;
}

export function measureText(text:string, rect:Rect, requested:number,noWrap=false) {
  const minimum = requested >= 27 ? Math.max(24, requested*.8) : requested >= 17 ? 17 : requested;
  let size=requested;
  const lines=()=>noWrap?text.replace(/\r/g,'').split('\n'):wrapText(text,Math.max(1,rect.w-8),size);
  const fits=()=>lines().length*size*1.35 <= rect.h-3 && lines().every(line=>textUnits(line)*size<=rect.w-8+0.01);
  while(!fits() && size>minimum) size=Math.max(minimum,size-1);
  const maxCharacters=Math.max(1,Math.floor((rect.w-8)/size)*Math.floor((rect.h-3)/(size*1.35)));
  return {text:lines().join('\n'),fontSize:size,overflow:!fits(),maxCharacters};
}

function baseContext(slide: SlideSpec, theme: Theme, mode: DeckSpec['mode']): LayoutContext {
  const scene: SceneSlide = { id: slide.id, title: slide.title, notes: slide.notes || '', elements: [], warnings: [] };
  const ctx: LayoutContext = {
    slide, scene, theme, mode,
    text(text, rect, size = 21, color = theme.foreground, bold = false, align = 'left', role) {
      if (!text) return;
      const clean=(s:string)=>s.replace(/\s/g,'');
      role??=slide.equation&&clean(text)===clean(slide.equation.text)?'equation':slide.items.some(it=>it.value&&clean(text)===clean(it.value))?'number':bold&&size>=27?'heading':bold?'label':'body';
      const noWrap=role==='number' && slide.items.some(it=>it.value&&clean(text)===clean(it.value));
      const fitted = measureText(text, rect, size,noWrap);
      if (fitted.overflow) {
        (scene.textIssues ??= []).push({text,maxCharacters:fitted.maxCharacters});
        scene.warnings.push(`「${slide.title}」に要約が必要な文章があります。書き出し前に調整します。`);
      }
      // Never cut a sentence or a number. The server must resolve textIssues
      // before exporting; previews retain the full text while adjustments run.
      scene.elements.push({ kind: 'text', ...rect, text: fitted.text, fontSize: fitted.fontSize, color, bold, align,role,noWrap,...fontFor(theme,role) });
    },
    itemColor(index){return itemColor(theme,index);},
    panel(rect,index,style=theme.panelStyle??'tint') {
      const color=itemColor(theme,index),fill=panelFill(theme,index);
      if(style==='outline')scene.elements.push({kind:'shape',...rect,shape:'rect',fill:theme.background,stroke:color});
      else scene.elements.push({kind:'shape',...rect,shape:'rect',fill});
      scene.elements.push({kind:'shape',x:rect.x,y:rect.y,w:style==='header'?rect.w:3,h:style==='header'?5:rect.h,shape:'rect',fill:color});
    },
    shape(rect, fill, shape = 'rect',stroke) { scene.elements.push({ kind: 'shape', ...rect, fill, shape,stroke }); },
    icon(item,rect,color=theme.accent){const id=resolveItemIcon(item);if(!id)return false;scene.elements.push(...iconElements(id,rect,color));return true;},
    line(x, y, w, color = theme.pale) { scene.elements.push({ kind: 'line', x, y, w, h: 0, stroke: color, strokeWidth: 1 }); },
  };
  return ctx;
}

function itemsColumn(c: LayoutContext, x: number, y: number, w: number, h: number, numbered = false) {
  const allItems = c.slide.items ?? [];
  const items = allItems.slice(0, 5);
  if (allItems.length > 5) {
    c.scene.warnings.push(`「${c.slide.title}」の6項目目以降はノートへ移しました。`);
    c.scene.notes += '\n\n補足項目:\n' + allItems.slice(5).map(i => `${i.label}: ${i.description ?? ''}`).join('\n');
  }
  if (!items.length) { c.text(c.slide.body || c.slide.headline || '', {x,y,w,h}, c.mode === 'reading' ? 19 : 24); return; }
  const step = h / items.length;
  items.forEach((item, i) => {
    const left = numbered ? x + 42 : x;
    c.panel({x:x-8,y:y+i*step-3,w:w+8,h:step-10},i);
    if (numbered) c.text(String(i + 1).padStart(2, '0'), { x, y:y+i*step, w:32, h:32 }, 19, c.theme.accent, true);
    const label = item.value ? `${item.value}  ${item.label}` : item.label;
    if(step<85&&item.description){
      const available=w-(left-x);
      c.text(label,{x:left,y:y+i*step,w:available*.34,h:step-13},20,c.itemColor(i),true);
      c.text(item.description,{x:left+available*.38,y:y+i*step,w:available*.62,h:step-13},17,c.theme.muted);
      if(i<items.length-1)c.line(left,y+(i+1)*step-7,available);
      return;
    }
    const labelHeight = item.description ? Math.min(step*.48, Math.max(29,wrapText(label,w-(left-x)-8,21).length*28.5)) : step-9;
    c.text(label, { x:left, y:y+i*step, w:w-(left-x), h:labelHeight }, 21, c.itemColor(i), true);
    if (item.description) c.text(item.description, { x:left, y:y+i*step+labelHeight+6, w:w-(left-x), h:Math.max(24,step-labelHeight-21) }, c.mode === 'reading' ? 17 : 18, c.theme.muted);
    if (i < items.length - 1) c.line(left, y+(i+1)*step-12, w-(left-x));
  });
}

function chart(c: LayoutContext, rect: Rect) {
  const data = c.slide.chart;
  if (!data) return false;
  c.scene.elements.push({kind:'chart',...rect,chartType:data.type,categories:data.categories,series:data.series,colors:chartColors(c.theme),unit:data.unit,background:c.theme.background,gridColor:chartGridColor(c.theme),labelSize:rect.w>=700?16:14,showValues:rect.h>=200&&data.categories.length*data.series.length<=12,categoryOrder:'input'});
  const unitWidth=isShareChart(data.type)&&data.unit?Math.min(rect.w*.45,Math.max(80,textUnits(data.unit)*12+42)):0;
  if (unitWidth) c.text(`単位：${data.unit}`,{x:rect.x+rect.w-unitWidth,y:rect.y+rect.h+6,w:unitWidth,h:36},12,c.theme.muted,false,'right');
  if (data.caption) c.text(data.caption,{x:rect.x,y:rect.y+rect.h+6,w:rect.w-(unitWidth?unitWidth+16:0),h:36},12,c.theme.muted);
  return true;
}
function table(c: LayoutContext, rect: Rect) {
  const data = c.slide.table;
  if (!data?.headers.length) return false;
  const columns = data.headers.length;
  const rows = data.rows;
  const rowH = rect.h/(rows.length+1);
  const colW = rect.w/columns;
  const strong=c.theme.tableStyle==='contrast';
  c.shape({x:rect.x,y:rect.y,w:rect.w,h:rowH}, strong?c.theme.accent:c.theme.pale);
  data.headers.forEach((header,i)=>c.text(header,{x:rect.x+i*colW+10,y:rect.y+9,w:colW-20,h:rowH-18},17,strong?c.theme.background:c.theme.foreground,true));
  rows.forEach((row,r)=> {
    if(c.theme.tableStyle==='striped' && r%2===1)c.shape({x:rect.x,y:rect.y+(r+1)*rowH,w:rect.w,h:rowH},c.theme.pale);
    c.line(rect.x,rect.y+(r+2)*rowH,rect.w);
    row.forEach((cell,i)=>c.text(cell,{x:rect.x+i*colW+10,y:rect.y+(r+1)*rowH+9,w:colW-20,h:rowH-18},17));
  });
  return true;
}
function diagram(c: LayoutContext, layout: 'process'|'cycle'|'hierarchy'|'list', rect: Rect) {
  const items = c.slide.diagram?.items ?? c.slide.items;
  const fontSize=items.length>4?17:19;
  const itemWidth=layout==='process'?rect.w/(Math.max(1,items.length)*1.35):layout==='hierarchy'?Math.min(180,rect.w/3):150;
  for(const item of items){const text=[item.label,item.description].filter(Boolean).join('\n');const fit=measureText(text,{x:0,y:0,w:itemWidth-12,h:layout==='hierarchy'?66:100},fontSize);if(fit.overflow)(c.scene.textIssues??=[]).push({text,maxCharacters:fit.maxCharacters});}
  c.scene.elements.push({kind:'smartart',...rect,layout:c.slide.diagram?.type ?? layout,items,accent:c.theme.accent,color:c.theme.background,fontSize});
}

registerLayout({ id:'cover', name:'表紙', description:'題名と導入を大きく見せる表紙', maxItems:3, render(c) {
  if(c.theme.coverStyle==='block') {
    c.shape({x:0,y:0,w:240,h:540},c.theme.accent);
    c.shape({x:240,y:0,w:720,h:20},c.theme.pale);
    c.text(c.slide.title,{x:284,y:108,w:620,h:221},42,c.theme.foreground,true);
    c.text(c.slide.headline||c.slide.body||'',{x:286,y:373,w:604,h:93},23,c.theme.muted);
    return;
  }
  if(c.theme.coverStyle==='split') {
    c.shape({x:0,y:0,w:310,h:540},c.theme.pale);
    c.shape({x:304,y:0,w:8,h:540},c.theme.accent);
    c.text(c.slide.title,{x:353,y:104,w:550,h:230},40,c.theme.foreground,true);
    c.text(c.slide.headline||c.slide.body||'',{x:355,y:368,w:540,h:102},22,c.theme.muted);
    return;
  }
  if(c.theme.coverStyle==='band') {
    c.shape({x:0,y:70,w:960,h:270},c.theme.pale);
    c.shape({x:56,y:70,w:94,h:6},c.theme.accent);
    c.text(c.slide.title,{x:62,y:113,w:836,h:196},42,c.theme.foreground,true);
    c.text(c.slide.headline||c.slide.body||'',{x:65,y:385,w:828,h:84},23,c.theme.muted);
    return;
  }
  c.shape({x:0,y:0,w:14,h:540},c.theme.accent);
  c.text(c.slide.title,{x:66,y:132,w:790,h:178},42,c.theme.foreground,true);
  c.line(68,329,72,c.theme.accent);
  c.text(c.slide.headline || c.slide.body || '',{x:68,y:358,w:768,h:93},23,c.theme.muted);
}});
registerLayout({ id:'evidence', name:'主張と根拠', description:'図表の横に短い読み取り。長い表はtable_fullを使う', maxItems:3, chart:true,table:true,textBudget:'右欄の項目名8文字、説明18文字以内。表は短い数値中心。', render(c) {
  if (c.slide.chart || c.slide.table) {
    if (!chart(c,{x:54,y:162,w:574,h:272})) table(c,{x:54,y:162,w:574,h:292});
    c.shape({x:661,y:157,w:3,h:289},c.theme.accent);
    itemsColumn(c,685,158,218,291);
  } else {
    c.text(c.slide.headline || c.slide.body || '',{x:56,y:163,w:398,h:242},32,c.theme.accent,true);
    itemsColumn(c,503,158,400,297,true);
  }
}});
registerLayout({ id:'comparison', name:'比較', description:'同じ基準で2〜3の対象を比較する', maxItems:3, chart:true,table:true,textBudget:'項目名18文字、説明70文字以内。', render(c) {
  if (c.slide.table) {table(c,{x:56,y:160,w:848,h:295}); return;}
  if (c.slide.chart) {chart(c,{x:56,y:170,w:848,h:265}); return;}
  const items = c.slide.items.slice(0,3);
  const count=Math.max(items.length,1), cw=848/count;
  items.forEach((it,i)=> {
    const x=56+i*cw;
    c.panel({x:x-8,y:157,w:cw-18,h:318},i);
    c.text(it.label,{x,y:181,w:cw-32,h:68},26,c.itemColor(i),true);
    if(it.value)c.text(it.value,{x,y:270,w:cw-32,h:66},38,c.theme.accent,true);
    c.text(it.description??'',{x,y:it.value?345:274,w:cw-32,h:it.value?100:170},20,c.theme.muted);
  });
  if(c.slide.items.length>3){c.scene.warnings.push('比較の4項目目以降はノートに保存しました。');c.scene.notes+='\n'+c.slide.items.slice(3).map(i=>`${i.label}: ${i.description??''}`).join('\n');}
}});
registerLayout({ id:'process', name:'手順', description:'3〜5段階の工程や説明の順序', maxItems:5,diagram:true,textBudget:'項目名8文字、説明8文字以内。本文40文字。', render(c) {
  diagram(c,'process',{x:56,y:166,w:848,h:235});
  c.text(c.slide.body || '',{x:58,y:425,w:844,h:48},18,c.theme.muted);
}});
registerLayout({ id:'hierarchy', name:'構造', description:'分類や全体と部分の関係を示す', maxItems:7,diagram:true,textBudget:'項目名8文字。詳しい説明はノート。', render(c) {
  diagram(c,'hierarchy',{x:56,y:147,w:848,h:306});
}});
registerLayout({ id:'cycle', name:'循環', description:'繰り返しや循環の関係を示す', maxItems:5,diagram:true,textBudget:'項目名8文字、説明8文字。本文70文字。', render(c) {
  diagram(c,'cycle',{x:68,y:146,w:534,h:321});
  c.text(c.slide.body || c.slide.headline || '',{x:648,y:216,w:242,h:202},24,c.theme.accent,true);
}});
registerLayout({ id:'timeline', name:'時間の流れ', description:'時点ごとの出来事や段階を示す', maxItems:5, render(c) {
  const items=c.slide.items.slice(0,5), n=Math.max(items.length,1), step=828/n;
  c.line(66,285,800,c.theme.accent);
  items.forEach((it,i)=> {
    const x=68+i*step;
    c.shape({x,y:278,w:14,h:14},c.theme.accent,'ellipse');
    c.text(it.label,{x,y:199,w:step-22,h:64},22,c.theme.foreground,true);
    c.text(it.description || '',{x,y:318,w:step-22,h:130},18,c.theme.muted);
  });
}});
registerLayout({ id:'concept', name:'問いと図解', description:'概念、数式、具体例を読みやすく示す', maxItems:4, render(c) {
  if(c.slide.chart){chart(c,{x:56,y:163,w:548,h:290});itemsColumn(c,665,166,239,289);return;}
  if(c.slide.diagram){diagram(c,c.slide.diagram.type,{x:56,y:159,w:530,h:291});itemsColumn(c,640,167,264,282);return;}
  c.shape({x:56,y:170,w:472,h:276},c.theme.pale);
  let mainText=c.slide.equation?.text || c.slide.headline || c.slide.body || c.slide.title;
  let mainSize=c.slide.equation?34:30;
  if(c.slide.equation) {
    // Prefer readable lines and an equality break over splitting a parenthesis.
    while(mainSize>24 && wrapText(mainText,400,mainSize).length>1) mainSize-=2;
    if(wrapText(mainText,400,mainSize).length>1 && mainText.includes(' = ')) mainText=mainText.replace(' = ','\n= ');
  }
  c.text(mainText,{x:85,y:230,w:414,h:143},mainSize,c.theme.accent,true,'center');
  itemsColumn(c,576,173,326,271,true);
  if(c.slide.equation?.explanation)c.text(c.slide.equation.explanation,{x:77,y:399,w:430,h:36},15,c.theme.muted,false, 'center');
}});
registerLayout({ id:'summary', name:'要点', description:'要点と必要な説明を整理する', maxItems:5, render(c) {
  if(c.slide.chart){chart(c,{x:56,y:162,w:560,h:280});itemsColumn(c,664,163,240,290);return;}
  itemsColumn(c,66,164,826,302,true);
}});

/** The deck's theme: a built-in theme, or the company template copied into the deck. */
export function deckTheme(deck:Pick<DeckSpec,'themeId'|'typographyId'|'customTheme'>):Theme{
  if(deck.themeId===TEMPLATE_THEME_ID&&deck.customTheme)return deck.typographyId?withTypography(deck.customTheme,deck.typographyId):deck.customTheme;
  return withTypography(themes[deck.themeId] ?? themes.paper,deck.typographyId);
}
const superscripts='⁰¹²³⁴⁵⁶⁷⁸⁹';
/** Citation marker for an item, e.g. refs [1,3] -> ¹˒³. */
export function citationMarker(refs:number[]|undefined){return refs?.length?refs.map(n=>String(n).split('').map(d=>superscripts[Number(d)]).join('')).join('˒'):'';}
function citedSlide(slide:SlideSpec):SlideSpec{
  if(!slide.items.some(item=>item.refs?.length))return slide;
  const mark=(item:SlideItem)=>item.refs?.length?{...item,label:item.label+citationMarker(item.refs)}:item;
  // A diagram usually repeats the items; carry the same markers to its nodes.
  const diagramItems=slide.diagram?.items.map((item,i)=>mark(item.refs?.length||slide.items[i]?.label!==item.label?item:{...item,refs:slide.items[i].refs}));
  return {...slide,items:slide.items.map(mark),...(slide.diagram&&diagramItems?{diagram:{...slide.diagram,items:diagramItems}}:{})};
}
const sourceLine=(s:SlideSpec['sources'][number],index:number,numbered:boolean)=>`${numbered?`[${index+1}] `:''}${s.documentName ?? s.documentId} ${s.locator}`;

export function compileDeck(deck: DeckSpec): RenderDocument {
  if (!deck.slides.length || deck.slides.length > MAX_SLIDES) throw new Error(`スライドは表紙を含めて1〜${MAX_SLIDES}枚にしてください。`);
  const theme=deckTheme(deck);
  const result:RenderDocument={title:deck.title,mode:deck.mode,theme,width:960,height:540,slides:[]};
  for(const [i,source] of deck.slides.entries()) {
    const slide=citedSlide(source);
    const numbered=slide.sources.length>1||slide.items.some(item=>item.refs?.length);
    const c=baseContext(slide,theme,deck.mode);
    const layout=registry.get(slide.layoutId) ?? registry.get('summary')!;
    if(!registry.has(slide.layoutId)) c.scene.warnings.push(`未登録の構図「${slide.layoutId}」は要点の配置で表示しました。`);
    if(layout.id!=='cover') {
      if(theme.headingStyle==='band') c.shape({x:0,y:0,w:960,h:135},theme.pale);
      if(theme.headingStyle==='accent') c.shape({x:24,y:46,w:6,h:73},theme.accent);
      c.text(slide.title,{x:56,y:34,w:848,h:96},deck.mode==='presentation'?34:32,theme.foreground,true,'left','heading');
      c.line(56,139,848);
    }
    layout.render(c);
    const footer=slide.sources.map((s,index)=>sourceLine(s,index,numbered)).join(' / ');
    c.line(56,496,848);
    const footerWidth=deck.pageNumbers===false?848:774;
    if(footer){const rect={x:56,y:505,w:footerWidth,h:22};c.text(measureText('出典 '+footer,rect,10).overflow?`出典 ${slide.sources.map((_,i)=>`[${i+1}]`).join(' ')}　資料名・位置・引用は発表者ノートに記載`:'出典 '+footer,rect,10,theme.muted);}
    if(deck.pageNumbers!==false)c.text(`${i+1} / ${deck.slides.length}`,{x:837,y:505,w:67,h:22},10,theme.muted,false,'right');
    if(slide.sources.length)c.scene.notes+='\n\n出典:\n'+slide.sources.map((s,index)=>`${sourceLine(s,index,true)}${s.quote?'\n「'+s.quote+'」':''}`).join('\n');
    // Retain structured content in notes when a chosen layout has no dedicated field.
    c.scene.notes+='\n\n内容:\n'+[slide.headline,slide.body,...slide.items.map(it=>[it.label,it.value,it.description].filter(Boolean).join(' — ')),slide.equation?.text,slide.equation?.explanation].filter(Boolean).join('\n');
    const unknown:SceneElement[]=c.scene.elements.filter(el=>el.x<0||el.y<0||el.x+el.w>961||el.y+el.h>541);
    if(unknown.length)throw new Error(`「${slide.title}」の配置がスライドの範囲外です。`);
    c.scene.warnings=[...new Set(c.scene.warnings)];
    result.slides.push(c.scene);
  }
  if(deck.referencesSlide)result.slides.push(...referenceSlides(deck,theme));
  return result;
}

/** Appended "出典一覧" pages: every cited document location, in slide order. */
function referenceSlides(deck:DeckSpec,theme:Theme):SceneSlide[]{
  const entries:{text:string;quote?:string}[]=[];
  for(const [i,slide] of deck.slides.entries())for(const [index,source] of slide.sources.entries())entries.push({text:`スライド${i+1} [${index+1}]  ${source.documentName??source.documentId} ${source.locator}`,quote:source.quote});
  if(!entries.length)return [];
  const pages:SceneSlide[]=[],perPage=7;
  for(let start=0;start<entries.length&&pages.length<3;start+=perPage){
    const scene:SceneSlide={id:`references-${pages.length+1}`,title:'出典一覧',notes:'資料の該当位置と引用の一覧です。数値・単位・期間は原資料で確認してください。',elements:[],warnings:[]};
    const add=(text:string,rect:Rect,size:number,color:string,bold=false,role:TextElement['role']='body')=>{const fitted=measureText(text,rect,size);if(fitted.overflow)(scene.textIssues??=[]).push({text,maxCharacters:fitted.maxCharacters});scene.elements.push({kind:'text',...rect,text:fitted.text,fontSize:fitted.fontSize,color,bold,align:'left',role,...fontFor(theme,role)});};
    add(pages.length?`出典一覧（${pages.length+1}）`:'出典一覧',{x:56,y:34,w:848,h:96},deck.mode==='presentation'?34:32,theme.foreground,true,'heading');
    scene.elements.push({kind:'line',x:56,y:139,w:848,h:0,stroke:theme.pale,strokeWidth:1});
    entries.slice(start,start+perPage).forEach((entry,row)=>{
      const y=158+row*48;
      add(entry.text,{x:56,y,w:848,h:24},14,theme.foreground,true,'label');
      if(entry.quote)add(`「${entry.quote}」`,{x:72,y:y+22,w:832,h:22},11,theme.muted);
    });
    if(entries.length>perPage*3&&pages.length===2)scene.warnings.push('出典一覧は3ページまでです。残りは各スライドの発表者ノートに記載しています。');
    pages.push(scene);
  }
  return pages;
}

registerExtraLayouts(registerLayout,{table,items:itemsColumn,diagram});
registerTemplateLayouts(registerLayout,{table,chart,items:itemsColumn,diagram});
registerPremiumLayouts(registerLayout,{table,chart,items:itemsColumn,diagram});
registerMicrosoftLayouts(registerLayout);
registerDesignLayouts(registerLayout);
registerLayout({id:'chart_spacious',name:'図を大きく見せるグラフ',group:'chart',description:'文字の読みやすさを優先してグラフを大きく置く',maxItems:0,chart:true,placement:'本文領域全体をグラフに使い、下に単位・条件の注釈',whenToUse:'項目名や凡例が長い場合。数値そのものを大きく見せたいとき',avoidWhen:'複数の文章を同じページで説明したい場合は読み取り付きの構図を使う。',textBudget:'項目名16文字程度、注釈55文字。本文はノートへ。',render(c){chart(c,{x:56,y:158,w:848,h:288});}});
registerLayout({id:'chart_icon_notes',name:'グラフとアイコン付きの読み取り',group:'chart',description:'左のグラフと右の囲まれた短い読み取りを対応させる',maxItems:3,chart:true,placement:'左に約2/3幅のグラフ、右にアイコン・太い項目名・説明を縦に配置',whenToUse:'比較や内訳の数値を見せ、2〜3個の観点で解説するとき',avoidWhen:'多い系列や長い軸ラベルには大きなグラフを使う。',textBudget:'項目名10文字、説明24文字。注釈35文字。',render(c){
  chart(c,{x:56,y:161,w:555,h:264});const step=316/Math.max(1,c.slide.items.length);
  c.slide.items.forEach((item,i)=>{const y=159+i*step,color=c.itemColor(i);c.panel({x:643,y,w:261,h:step-12},i,'tint');const icon=c.icon(item,{x:654,y:y+14,w:30,h:30},color);c.text(item.label,{x:icon?695:661,y:y+12,w:icon?193:227,h:38},23,color,true,'left','label');c.text([item.value,item.description].filter(Boolean).join('  '),{x:661,y:y+57,w:227,h:step-76},18);});
}});
