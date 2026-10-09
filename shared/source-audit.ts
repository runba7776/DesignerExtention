import type {SlideSourceReport,SlideSpec,SourceCheck} from './contracts';
import {canonicalNumber,isCheckedNumber,numberTokens} from './numbers';

export interface AuditDocument {id:string;name:string;sources:{locator:string;text:string}[]}

/** Values written in an extracted unit. Cell addresses ("B2=") and merged-cell
 * references are positions, not data; a percent display format ("0.125
 * (表示形式: 0.0%)") also counts as the value shown in Excel (12.5). */
export function sourceValues(text:string){
  const values=new Set<string>();
  const cleaned=text.replace(/\b[A-Z]{1,3}\d{1,7}=/g,'').replace(/\[結合元 [A-Z]{1,3}\d{1,7}\]/g,'').replace(/"(-?\d+(?:\.\d+)?)\s*\(表示形式: ([^)]*)\)"/g,(_,value:string,format:string)=>{if(format.includes('%'))values.add(canonicalNumber(String(Number((Number(value)*100).toPrecision(12)))));return `"${value}"`;});
  for(const token of numberTokens(cleaned))values.add(canonicalNumber(token));
  return values;
}

/** Numbers shown on the slide (not notes), with chart values as data. */
function slideNumbers(slide:SlideSpec){
  const texts=[slide.title,slide.headline,slide.body,...slide.items.flatMap(item=>[item.label,item.value,item.description]),
    ...(slide.diagram?.items.flatMap(item=>[item.label,item.description])??[]),...(slide.table?.headers??[]),...(slide.table?.rows.flat()??[]),slide.chart?.caption,slide.equation?.text];
  const tokens=texts.filter((value):value is string=>typeof value==='string').flatMap(numberTokens).filter(isCheckedNumber);
  const chart=slide.chart?.series.flatMap(series=>series.values.map(value=>String(value))).filter(isCheckedNumber)??[];
  const seen=new Set<string>(),result:{display:string;value:string}[]=[];
  for(const token of [...tokens,...chart]){const value=canonicalNumber(token);if(!seen.has(value)){seen.add(value);result.push({display:token,value});}}
  return result;
}

/** Shows each citation with the extracted original text, and checks every number
 * on the slide against the cited text. Matching is exact (no rounding); a match
 * does not prove the number is used in the same meaning or unit. */
export function auditSlide(slide:SlideSpec,documents:AuditDocument[]):SlideSourceReport{
  const sources=slide.sources.map((source,index)=>{
    const document=documents.find(item=>item.id===source.documentId),unit=document?.sources.find(item=>item.locator===source.locator);
    return {index:index+1,documentName:document?.name??source.documentName??source.documentId,locator:source.locator,...(source.quote?{quote:source.quote}:{}),excerpt:(unit?.text??'').slice(0,600),...(unit?{}:{missing:true})};
  });
  const unitOf=(s:SlideSpec['sources'][number])=>documents.find(d=>d.id===s.documentId)?.sources.find(u=>u.locator===s.locator);
  const numbers:SourceCheck[]=slideNumbers(slide).map(({display,value})=>{
    const source=slide.sources.find(s=>{const unit=unitOf(s);return unit&&sourceValues(unit.text).has(value);});
    if(source)return {value:display,status:'matched',locator:source.locator};
    for(const document of documents)for(const unit of document.sources)if(sourceValues(unit.text).has(value))return {value:display,status:'uncited',locator:`${document.name} ${unit.locator}`};
    return {value:display,status:'unmatched'};
  });
  return {slideId:slide.id,title:slide.title,sources,numbers};
}
