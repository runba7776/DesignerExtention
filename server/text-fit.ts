import type { DeckSpec, SlideSpec } from '../shared/contracts';
import { compileDeck, listLayouts } from '../shared/layouts';
import { AppError } from './errors';

export function textFields(slide:SlideSpec) {
  const fields:Record<string,string>={title:slide.title};
  for(const key of ['headline','body'] as const) if(slide[key])fields[key]=slide[key]!;
  slide.items.forEach((item,i)=>{fields[`items.${i}.label`]=item.label;if(item.description)fields[`items.${i}.description`]=item.description;});
  slide.diagram?.items.forEach((item,i)=>{fields[`diagram.items.${i}.label`]=item.label;if(item.description)fields[`diagram.items.${i}.description`]=item.description;});
  slide.table?.headers.forEach((value,i)=>fields[`table.headers.${i}`]=value);
  slide.table?.rows.forEach((row,r)=>row.forEach((value,c)=>fields[`table.rows.${r}.${c}`]=value));
  if(slide.chart?.caption)fields['chart.caption']=slide.chart.caption;
  if(slide.equation?.explanation)fields['equation.explanation']=slide.equation.explanation;
  return fields;
}

export function fitProblems(deck:DeckSpec) {
  return compileDeck(deck).slides.flatMap((scene,i)=>scene.textIssues?.length?[{
    slideId:scene.id, layoutId:deck.slides[i].layoutId,
    guidance:listLayouts().find(item=>item.id===deck.slides[i].layoutId)?.textBudget,
    issues:scene.textIssues.map(issue=>({...issue,maxCharacters:Math.max(4,Math.floor(issue.maxCharacters*.85))})),
    fields:textFields(deck.slides[i]),
  }]:[]);
}

export function applySummaries(deck:DeckSpec, response:unknown, allowedSlideIds:string[]):DeckSpec {
  const replacements=(response as any)?.replacements;
  if(!Array.isArray(replacements)||!replacements.length||replacements.length>300)throw new AppError(422,'文章の要約形式を確認できませんでした。','INVALID_SUMMARY');
  const result=structuredClone(deck), seen=new Set<string>();
  for(const entry of replacements) {
    const slide=result.slides.find(item=>item.id===entry?.slideId);
    if(!slide||!allowedSlideIds.includes(slide.id)||typeof entry.path!=='string'||typeof entry.text!=='string'||!entry.text.trim()||entry.text.length>800||/…|\.{3}/.test(entry.text))throw new AppError(422,'要約に省略記号、空欄、または対象外の項目があります。','INVALID_SUMMARY');
    const fields=textFields(slide), original=fields[entry.path], key=slide.id+'/'+entry.path;
    if(!Object.hasOwn(fields,entry.path)||seen.has(key))throw new AppError(422,'要約で変更できない項目が指定されました。','INVALID_SUMMARY');
    // Summarization cannot invent a value. Exact chart data, formulae, item values,
    // sources, layout and node relationships are not writable through this endpoint.
    const numbers=(text:string):string[]=>Array.from(text.normalize('NFKC').match(/[+−△-]?\d[\d,]*(?:\.\d+)?%?/g)??[]);
    const oldNumbers=numbers(original);
    if(numbers(entry.text).some(value=>!oldNumbers.includes(value)))throw new AppError(422,'要約によって数値が変更されました。元の数値を保持して作り直してください。','INVALID_SUMMARY');
    if(entry.text.length>original.length)throw new AppError(422,'要約後の文章が長くなっています。','INVALID_SUMMARY');
    seen.add(key);
    let target:any=slide;const keys=entry.path.split('.');for(const field of keys.slice(0,-1))target=target[field];
    target[keys.at(-1)!]=entry.text;
    slide.notes+=`\n\n要約前の補足（${entry.path}）:\n${original}`;
  }
  return result;
}

export function assertTextFits(deck:DeckSpec) {
  const problems=fitProblems(deck);
  if(problems.length)throw new AppError(422,`「${deck.slides.find(s=>s.id===problems[0].slideId)?.title}」の文章が枠に収まりません。構成で情報を分けるか、短くする指示を追加してください。途中を省略した資料は書き出していません。`,'TEXT_FIT_REQUIRED');
}
