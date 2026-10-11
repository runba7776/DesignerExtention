import type {DeckSpec,SlideSpec,SceneSlide,TextElement} from './contracts';
import {citationMarker,compileDeck,listLayouts,measureText,wrapText} from './layouts';
import {designMarkedText,designTextBox} from './free-design';

const clean=(s:string)=>s.replace(/\s/g,'');
function fields(slide:SlideSpec):string[]{return [slide.title,slide.headline,slide.body,...slide.items.flatMap(i=>[i.label,i.description,i.value]),...(slide.diagram?.items.flatMap(i=>[i.label,i.description,i.value])??[]),...(slide.table?.headers??[]),...(slide.table?.rows.flat()??[]),slide.equation?.text,slide.equation?.explanation,slide.chart?.caption].filter((s):s is string=>!!s);}
function visible(scene:SceneSlide){return clean(scene.elements.flatMap(e=>e.kind==='text'?[e.text]:e.kind==='smartart'?e.items.flatMap(i=>[i.label,i.description??'']):[]).join('\n'));}
export function inspectSlide(deck:DeckSpec,slide:SlideSpec){return compileDeck({...deck,slides:[slide]}).slides[0];}
export function fittingLayouts(deck:DeckSpec,slide:SlideSpec,includeOverflow=false){
  const current=listLayouts().find(l=>l.id===slide.layoutId);
  if(!current)return [];
  const sourceScene=inspectSlide(deck,slide),sourceText=visible(sourceScene);
  const required=fields(slide).filter(text=>sourceText.includes(clean(text)));
  return listLayouts().filter(candidate=>{
    if(candidate.id!==slide.layoutId && candidate.autoSelect===false)return false;
    const group=slide.table?'table':slide.chart?'chart':slide.equation?'concept':current.group;
    if(group==='table'?!candidate.table:group==='chart'?!candidate.chart:candidate.group!==group)return false;
    if(slide.items.length>candidate.maxItems||slide.items.length<candidate.minItems)return false;
    if(slide.diagram&&(!candidate.diagram||candidate.diagramType!==slide.diagram.type||slide.diagram.items.length>candidate.maxItems))return false;
    if(slide.table&&candidate.tableMaxRows&&slide.table.rows.length>candidate.tableMaxRows)return false;
    if(slide.equation&&!candidate.equation)return false;
    const scene=inspectSlide(deck,{...slide,layoutId:candidate.id});
    if(!includeOverflow&&scene.textIssues?.length)return false;
    const text=visible(scene);
    // A local layout switch may not quietly move previously visible facts to notes.
    if(!required.every(value=>text.includes(clean(value))))return false;
    if(slide.chart&&!scene.elements.some(e=>e.kind==='chart'))return false;
    if(slide.diagram&&!scene.elements.some(e=>e.kind==='smartart'))return false;
    return true;
  });
}
function tie(seed:string,id:string){let h=2166136261;for(const ch of seed+id){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return (h>>>0)/4294967296;}
/** Prefer a visible hierarchy, without creating an unsupported ranking of items. */
export function visualHierarchyScore(scene:SceneSlide){
  const texts=scene.elements.filter((e):e is TextElement=>e.kind==='text'&&e.y>=150&&e.y<490);
  const bodies=texts.filter(e=>e.role==='body').map(e=>e.fontSize).sort((a,b)=>a-b);
  const body=bodies[Math.floor(bodies.length/2)]??18;
  const labels=texts.filter(e=>e.role==='label'),values=texts.filter(e=>e.role==='number'&&e.noWrap);
  const label=labels.length?Math.min(...labels.map(e=>e.fontSize)):body;
  const value=values.length?Math.min(...values.map(e=>e.fontSize)):body;
  const containers=scene.elements.filter(e=>e.kind==='shape'&&e.y>=150&&e.w>=140&&e.h>=55).length;
  return Math.max(0,Math.min(4,(label/body-1)*12))+(values.length?Math.max(0,Math.min(7,(value/body-1)*8)):0)+Math.min(2,containers*.5);
}
/** Stable within a generation/retry; a new generation uses a new seed. */
export function diversifyDeck(deck:DeckSpec,seed:string,recent:string[]=[]):DeckSpec{
  const used=new Map<string,number>(),history=new Map<string,number>();recent.slice(-128).forEach(id=>history.set(id,(history.get(id)??0)+1));
  const slides=deck.slides.map((slide,index)=>{
    if(index===0||slide.layoutId==='cover')return structuredClone(slide);
    const options=fittingLayouts(deck,slide);
    if(!options.length)return structuredClone(slide);
    // Explicitly selected priority/relationship grammars are not generalized.
    if(listLayouts().find(l=>l.id===slide.layoutId)?.autoSelect===false)return structuredClone(slide);
    const scores=new Map(options.map(({id})=>[id,(used.get(id)??0)*100+(history.get(id)??0)*2+tie(`${seed}:${index}`,id)*6-visualHierarchyScore(inspectSlide(deck,{...slide,layoutId:id}))]));
    options.sort((a,b)=>scores.get(a.id)!-scores.get(b.id)!);
    const id=options[0].id;used.set(id,(used.get(id)??0)+1);return {...structuredClone(slide),layoutId:id};
  });
  return {...deck,slides};
}

/** Prefer a roomier compatible layout before paying for summarization. */
/** An AI-designed text a little long for its box is set smaller (to 75%, never below
 * 10pt) here, so a few extra characters never cost an AI call to shorten the wording.
 * Boxes, positions and the words stay as the AI wrote them. */
function shrinkDesignText(slide:SlideSpec):SlideSpec{
  if(!slide.design)return slide;
  const elements=slide.design.elements.map(e=>{
    if(e.t!=='text'||e.exact)return e;
    // Measured exactly as the renderer will draw it, including the room a box may grow.
    const text=designMarkedText(e,citationMarker),fits=(size:number)=>!measureText(text,designTextBox({...e,size},slide.design!,text,wrapText),size).overflow;
    if(fits(e.size))return e;
    const floor=Math.max(10,Math.floor(e.size*.75));let size=e.size;
    while(size>floor&&!fits(size))size--;
    return fits(size)?{...e,size}:e;
  });
  return {...slide,design:{...slide.design,elements}};
}
export function improveTextFit(deck:DeckSpec):DeckSpec{
  return {...deck,slides:deck.slides.map(slide=>{
    if(!inspectSlide(deck,slide).textIssues?.length)return slide;
    if(slide.design)return shrinkDesignText(slide);
    const candidate=fittingLayouts(deck,slide)[0];
    return candidate?{...slide,layoutId:candidate.id}:slide;
  })};
}
export function candidateLayoutIds(ids:string[]){
  const all=listLayouts(),groups=new Set(ids.map(id=>all.find(l=>l.id===id)?.group));
  return all.filter(l=>ids.includes(l.id)||groups.has(l.group)).map(l=>l.id);
}
