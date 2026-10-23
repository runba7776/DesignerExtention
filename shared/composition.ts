import type {FreeElement,SlideSpec} from './contracts';
import {SLIDE_H,SLIDE_W} from './free-design';

/** The rough kind of composition of an AI-designed page, read from its elements: used to tell the AI what
 * the earlier pages look like and to find the same kind repeated page after page. Not a design rule. */
export type CompositionKind='cover'|'chart'|'table'|'cards'|'flow'|'figure'|'text';
const near=(a:number,b:number,tolerance=6)=>Math.abs(a-b)<=tolerance;
/** Values that fall into groups of nearly the same value, with how many fell into each. */
function groups(values:number[]){const out:{at:number;count:number}[]=[];for(const v of [...values].sort((a,b)=>a-b)){const g=out.find(o=>near(o.at,v));if(g)g.count++;else out.push({at:v,count:1});}return out;}

export function compositionOf(slide:SlideSpec):CompositionKind{
  if(slide.layoutId==='cover')return 'cover';
  const elements=slide.design?.elements;
  if(!elements)return slide.chart?'chart':slide.table?'table':slide.diagram?'flow':'text';
  const area=(e:{w:number;h:number})=>e.w*e.h/(SLIDE_W*SLIDE_H);
  if(elements.some(e=>e.t==='chart'&&area(e)>=0.08))return 'chart';
  if(elements.some(e=>e.t==='table'))return 'table';
  const texts=elements.filter((e):e is Extract<FreeElement,{t:'text'}>=>e.t==='text'&&e.role!=='title');
  const inside=(b:{x:number;y:number;w:number;h:number},t:{x:number;y:number;w:number;h:number})=>t.x+t.w/2>b.x&&t.x+t.w/2<b.x+b.w&&t.y+t.h/2>b.y&&t.y+t.h/2<b.y+b.h;
  // Cards: three or more panels of about the same size, side by side, each holding a heading and words.
  const panels=elements.filter((e):e is Extract<FreeElement,{t:'box'}>=>e.t==='box'&&(e.fill!=='none'||!!e.line)&&area(e)>=0.03&&area(e)<=0.4&&texts.filter(t=>inside(e,t)).length>=2);
  const sameSize=groups(panels.map(p=>Math.round(p.w))).some(g=>g.count>=3);
  if(panels.length>=3&&sameSize&&groups(panels.map(p=>p.y)).some(g=>g.count>=2))return 'cards';
  // A table, drawn by any means: words in two or more columns of three or more, and three or more rows of two or more.
  const columns=groups(texts.map(t=>t.x)).filter(g=>g.count>=3).length,rows=groups(texts.map(t=>t.y)).filter(g=>g.count>=2).length;
  if(columns>=2&&rows>=3)return 'table';
  const arrows=elements.filter(e=>(e.t==='line'&&e.arrow&&e.arrow!=='none')||(e.t==='box'&&['arrow','chevron','pentagon'].includes(e.shape??''))).length;
  if(arrows>=2)return 'flow';
  if(elements.some(e=>e.t==='svg'&&area(e)>=0.12))return 'figure';
  return 'text';
}

/** Pages to make again because the same kind (a table, a row of cards) runs three pages or more: the second of
 * every three in a run, so no three in a row are left alike. */
export function repeatedPages(slides:SlideSpec[]):{slideId:string;kind:'table'|'cards'}[]{
  const kinds=slides.map(compositionOf),out:{slideId:string;kind:'table'|'cards'}[]=[];
  for(let start=0;start<kinds.length;){
    let end=start;while(end+1<kinds.length&&kinds[end+1]===kinds[start])end++;
    const kind=kinds[start];
    if((kind==='table'||kind==='cards')&&end-start+1>=3)for(let i=start+1;i<=end;i+=3)out.push({slideId:slides[i].id,kind});
    start=end+1;
  }
  return out;
}
