import type {ChartSpec,DeckSpec,RefreshEntry,RefreshPlace,RefreshPlan,RefreshSummary,RefreshText,SlideSpec,SourceRef} from './contracts';
import {canonicalNumber} from './numbers';

/** Recurring reports: the previous deck keeps its design, structure and wording; only
 * the numbers are taken from the new period's documents. Each number on a slide is
 * found in the previous documents, the item it belongs to is read there (the row and
 * column of a sheet, or the words written before it), and the same item is looked up
 * in the new documents. Everything runs locally; no AI is involved. A number whose
 * item is missing or ambiguous is left unchanged and shown for review. */
export interface RefreshDocument {id:string;name:string;kind?:string;sources:{locator:string;text:string}[]}

// ---- numbers as written, with their position in the text ----
const TOKEN=/[+＋\-−△▲]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?[%％]?/g;
export interface NumberSpan {start:number;end:number;raw:string;value:string}
export function numberSpans(text:string):NumberSpan[]{
  const spans:NumberSpan[]=[];
  for(const match of text.matchAll(TOKEN)){
    let start=match.index!,raw=match[0];
    // A hyphen after a digit or letter is a range or a code ("2026-2027", "A-12"), not a sign.
    if(/^[-−]/.test(raw)&&start>0&&/[0-9０-９A-Za-zＡ-Ｚａ-ｚ)）]/.test(text[start-1])){start++;raw=raw.slice(1);}
    spans.push({start,end:start+raw.length,raw,value:canonicalNumber(raw)});
  }
  return spans;
}
/** Data on a slide: two or more digits, decimals and percentages, and single digits of
 * a period ("第1四半期", "Q2", "6月"). Counts such as "3つの柱" are wording. */
function isData(text:string,span:NumberSpan){
  const plain=span.raw.normalize('NFKC');
  if(plain.replace(/[^0-9]/g,'').length>=2||/[.%]/.test(plain))return true;
  return /(第|Q|Ｑ|FY)$/i.test(text.slice(Math.max(0,span.start-2),span.start))||/^(Q|Ｑ|四半期|半期|月|日|期|年|倍|割)/.test(text.slice(span.end,span.end+3));
}
const sign=(value:string)=>value.startsWith('-')?-1:/^0(\.0*)?$/.test(value)?0:1;

/** A new value written in the style of the old one: grouping commas, explicit plus,
 * the minus mark (△/▲/−), percent sign and full-width digits are kept; the digits and
 * decimals are the new document's, never rounded. */
export function formatLike(before:string,value:string,written?:string){
  const negative=value.startsWith('-'),[integer,fraction]=(()=>{
    const digits=(written??value).normalize('NFKC').replace(/[^0-9.]/g,'');
    const [i='0',f]=digits.split('.');return [i.replace(/^0+(?=\d)/,''),f];
  })();
  const old=before.trim(),oldPlain=old.normalize('NFKC');
  const oldInteger=oldPlain.replace(/^[+−△▲-]/,'').split('.')[0].replace(/[^0-9,]/g,'');
  const group=oldInteger.includes(',')||(oldInteger.length<4&&!!written&&/\d,\d{3}/.test(written.normalize('NFKC')));
  let digits=(group?integer.replace(/\B(?=(\d{3})+(?!\d))/g,','):integer)+(fraction?'.'+fraction:'');
  const oldMark=/^[+＋−△▲-]/.exec(old)?.[0],newMark=written?/^[−△▲-]/.exec(written.trim())?.[0]:undefined;
  const mark=negative?(oldMark&&!/^[+＋]$/.test(oldMark)?oldMark:newMark??'-'):(oldMark&&/^[+＋]$/.test(oldMark)&&value!=='0'?oldMark:'');
  const percent=/[%％]$/.exec(old)?.[0]??'';
  if(/[０-９]/.test(old))digits=digits.replace(/[0-9]/g,d=>String.fromCharCode(d.charCodeAt(0)+0xFEE0)).replace(/,/g,old.includes('，')?'，':',').replace(/\./g,old.includes('．')?'．':'.');
  return mark+digits+percent;
}

// ---- where numbers sit in a slide ----
interface Field {path:string;text:string;where:string;hidden?:boolean}
interface ValueSite {path:string;value:number;where:string;labels:string[]}
const roleNames:Record<string,string>={title:'見出し',heading:'小見出し',body:'本文',number:'数値',caption:'注記'};
function slideSites(slide:SlideSpec){
  const fields:Field[]=[],values:ValueSite[]=[];
  const add=(path:string,text:unknown,where:string,hidden=false)=>{if(typeof text==='string'&&text)fields.push({path,text,where,...(hidden?{hidden}:{})});};
  const chart=(prefix:string,spec:ChartSpec)=>{
    spec.categories.forEach((c,k)=>add(`${prefix}.categories.${k}`,c,'グラフの項目名'));
    spec.series.forEach((s,j)=>{add(`${prefix}.series.${j}.name`,s.name,'グラフの系列名');s.values.forEach((v,k)=>values.push({path:`${prefix}.series.${j}.values.${k}`,value:v,where:`グラフ「${s.name}」の${spec.categories[k]??k+1}`,labels:[s.name,spec.categories[k]??'']}));});
    add(`${prefix}.caption`,spec.caption,'グラフの注記');
  };
  // An AI-designed slide draws its title from a text element; slide.title then only names the page.
  add('title',slide.title,'見出し',!!slide.design);
  add('headline',slide.headline,'要旨');add('body',slide.body,'本文');
  slide.items.forEach((item,i)=>{add(`items.${i}.label`,item.label,`項目${i+1}`);add(`items.${i}.value`,item.value,`項目${i+1}の値`);add(`items.${i}.description`,item.description,`項目${i+1}の説明`);});
  slide.diagram?.items.forEach((item,i)=>{add(`diagram.items.${i}.label`,item.label,`図の項目${i+1}`);add(`diagram.items.${i}.description`,item.description,`図の項目${i+1}の説明`);});
  slide.table?.headers.forEach((v,j)=>add(`table.headers.${j}`,v,'表の列名'));
  slide.table?.rows.forEach((row,r)=>row.forEach((v,j)=>add(`table.rows.${r}.${j}`,v,`表（${r+1}行${j+1}列）`)));
  if(slide.chart)chart('chart',slide.chart);
  add('equation.explanation',slide.equation?.explanation,'数式の説明');
  slide.design?.elements.forEach((e,i)=>{
    if(e.t==='text')add(`design.elements.${i}.text`,e.text,roleNames[e.role??'body']??'本文');
    if(e.t==='table'){e.headers.forEach((v,j)=>add(`design.elements.${i}.headers.${j}`,v,'表の列名'));e.rows.forEach((row,r)=>row.forEach((v,j)=>add(`design.elements.${i}.rows.${r}.${j}`,v,`表（${r+1}行${j+1}列）`)));}
    if(e.t==='chart')chart(`design.elements.${i}.chart`,e.chart);
  });
  add('notes',slide.notes,'発表者ノート',true);
  return {fields,values};
}
const getPath=(target:any,path:string)=>path.split('.').reduce((value,key)=>value?.[key],target);
function setPath(target:any,path:string,value:unknown){const keys=path.split('.');let node=target;for(const key of keys.slice(0,-1))node=node[key];node[keys.at(-1)!]=value;}

// ---- where numbers sit in the documents ----
interface DocNumber {excerpt?:string;documentId:string;documentName:string;locator:string;value:string;raw:string;percent?:{value:string;decimals:number};label:string;ordinal:number;after:string;occurrence:number;cell?:{sheet:string;column:string;row:number;rowLabel:string;header:string}}
const squash=(text:string)=>text.normalize('NFKC').replace(/[\s()（）\[\]［］「」『』【】、。,，:：;；/／|｜・~〜"'“”‘’]/g,'');
const noDigits=(text:string)=>squash(text).replace(/[0-9]/g,'');
/** The words around a number, without other numbers or their marks. */
const words=(text:string)=>squash(text).replace(/[0-9.,%+\-−△▲]/g,'');
const CELL=/([A-Z]{1,3})(\d{1,7})=("(?:[^"\\]|\\.)*")/g;
const NUMERIC_CELL=/^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?: \(表示形式: (.*)\))?$/;
const isLabelCell=(text:string)=>!NUMERIC_CELL.test(text)&&!/^\[/.test(text)&&/[^\d\s.,%+\-−△▲]/.test(text.normalize('NFKC'));

/** The item each number belongs to. In a sheet: the nearest label cell to its left and
 * the nearest label above its column. In text: the words written before it, and its
 * position in a run of numbers ("営業利益 4,812 12.5" → 営業利益, 1st and 2nd). */
function indexDocuments(documents:RefreshDocument[]){
  const out:DocNumber[]=[];
  for(const document of documents){
    const seen=new Map<string,number>(),headers=new Map<string,Map<string,string>>();
    for(const unit of document.sources){
      const push=(item:Omit<DocNumber,'occurrence'|'documentId'|'documentName'|'locator'>)=>{
        const key=item.cell?`${item.cell.sheet}|${item.cell.rowLabel}|${item.cell.column}`:`${item.label}|${item.ordinal}`,count=seen.get(key)??0;seen.set(key,count+1);
        out.push({...item,occurrence:count,documentId:document.id,documentName:document.name,locator:unit.locator});
      };
      const text=(content:string,fallback='')=>{
        const spans=numberSpans(content);let previous:{label:string;ordinal:number}|undefined,end=0;
        spans.forEach((span,i)=>{
          const before=words(content.slice(end,span.start)),label=before?before.slice(-16):previous?.label??words(fallback).slice(-16),ordinal=before?0:previous?previous.ordinal+1:0;
          push({value:span.value,raw:span.raw,label,ordinal,after:words(content.slice(span.end,span.end+40)).slice(0,8),excerpt:snippet(content,span.start,span.end)});
          previous={label,ordinal};end=span.end;
        });
      };
      if(!/^[A-Z]{1,3}\d{1,7}="/.test(unit.text)){text(unit.text);continue;}
      const sheet=unit.locator.includes('!')?unit.locator.slice(0,unit.locator.lastIndexOf('!')):'';
      const columns=headers.get(sheet)??new Map<string,string>();headers.set(sheet,columns);
      const cells=[...unit.text.matchAll(CELL)].map(m=>{let value='';try{value=JSON.parse(m[3]);}catch{/* Not a cell value. */}return {column:m[1],row:Number(m[2]),value};});
      cells.forEach((cell,i)=>{
        const rowLabel=squash(cells.slice(0,i).reverse().find(c=>isLabelCell(c.value))?.value??cells.find(c=>isLabelCell(c.value))?.value??'');
        const numeric=NUMERIC_CELL.exec(cell.value);
        if(!numeric){
          // CSV cells and text-formatted cells hold the number as shown ("1,520", "35.6%", "△3.2").
          const spans=numberSpans(cell.value.trim());
          if(spans.length===1&&spans[0].raw===cell.value.trim())push({value:spans[0].value,raw:spans[0].raw,label:rowLabel,ordinal:0,after:'',cell:{sheet,column:cell.column,row:cell.row,rowLabel,header:columns.get(cell.column)??''}});
          else if(isLabelCell(cell.value))text(cell.value,rowLabel);
          return;
        }
        const format=numeric[2]??'',percent=format.includes('%')?{value:canonicalNumber(String(Number((Number(numeric[1])*100).toPrecision(12)))),decimals:/\.(0+)/.exec(format)?.[1].length??0}:undefined;
        push({value:canonicalNumber(numeric[1]),raw:numeric[1],...(percent?{percent}:{}),label:rowLabel,ordinal:0,after:'',cell:{sheet,column:cell.column,row:cell.row,rowLabel,header:columns.get(cell.column)??''}});
      });
      for(const cell of cells)if(isLabelCell(cell.value))columns.set(cell.column,squash(cell.value));
    }
  }
  return out;
}

const commonSuffix=(a:string,b:string)=>{let n=0;while(n<a.length&&n<b.length&&a[a.length-1-n]===b[b.length-1-n])n++;return n;};
const commonPrefix=(a:string,b:string)=>{let n=0;while(n<a.length&&n<b.length&&a[n]===b[n])n++;return n;};
/** Previous document → its counterpart among the new ones (same kind, same name without digits). */
function pairDocuments(previous:RefreshDocument[],next:RefreshDocument[]){
  const pairs=new Map<string,string>();
  for(const old of previous){
    const ranked=next.map(doc=>({doc,score:(doc.kind&&doc.kind===old.kind?2:0)+(noDigits(doc.name)===noDigits(old.name)?4:commonPrefix(noDigits(doc.name),noDigits(old.name))>=3?2:0)})).sort((a,b)=>b.score-a.score);
    if(ranked[0]&&(ranked[0].score>=4||next.length===1||(ranked[0].score>=2&&ranked.filter(r=>r.score===ranked[0].score).length===1)))pairs.set(old.id,ranked[0].doc.id);
  }
  return pairs;
}
interface Match {item:DocNumber;score:number;strong:boolean;note?:string}
function matcher(next:DocNumber[],pairs:Map<string,string>){
  const byText=new Map<string,DocNumber[]>(),byRow=new Map<string,DocNumber[]>();
  const put=(map:Map<string,DocNumber[]>,key:string,item:DocNumber)=>{const list=map.get(key);if(list)list.push(item);else map.set(key,[item]);};
  for(const item of next){
    if(item.cell){put(byRow,`${noDigits(item.cell.sheet)}|${item.cell.rowLabel}`,item);put(byRow,`${noDigits(item.cell.sheet)}|@${item.cell.column}${item.cell.row}`,item);}
    else put(byText,item.label?`${item.ordinal}|${item.label.at(-1)}`:`${item.ordinal}|^${item.after.slice(0,1)}`,item);
  }
  return (old:DocNumber):Match[]=>{
    const same=(item:DocNumber)=>pairs.get(old.documentId)===item.documentId?2:0;
    if(old.cell){
      const sheet=noDigits(old.cell.sheet),header=noDigits(old.cell.header),results:Match[]=[];
      for(const item of old.cell.rowLabel?byRow.get(`${sheet}|${old.cell.rowLabel}`)??[]:[]){
        const column=item.cell!.column===old.cell.column,heading=!!header&&noDigits(item.cell!.header)===header;
        if(column)results.push({item,score:20+(heading?2:0)+same(item),strong:true});
        else if(heading)results.push({item,score:16+same(item),strong:true});
      }
      if(!results.length)for(const item of byRow.get(`${sheet}|@${old.cell.column}${old.cell.row}`)??[])results.push({item,score:4+same(item),strong:false,note:'同じセルの位置にある値です。項目名が一致しないため確かめてください。'});
      return results;
    }
    const near=(item:DocNumber)=>(old.locator===item.locator?2:0)+(old.occurrence===item.occurrence?2:0)+same(item);
    // A number at the start of a text (no words before it) is known by the words after it.
    if(!old.label)return old.after?(byText.get(`${old.ordinal}|^${old.after.slice(0,1)}`)??[]).flatMap(item=>{
      const after=commonPrefix(old.after,item.after);
      return item.label||after<Math.min(3,old.after.length)?[]:[{item,score:Math.min(after,8)*2+near(item),strong:after>=3,note:'前後の語の一致が少ないため確かめてください。'}];
    }):[];
    return (byText.get(`${old.ordinal}|${old.label.at(-1)}`)??[]).flatMap(item=>{
      const label=commonSuffix(old.label,item.label),after=commonPrefix(old.after,item.after);
      if(label<Math.min(4,old.label.length))return [];
      // The same item name scores above a longer name that merely ends with it ("営業利益" vs "セグメント別営業利益").
      return [{item,score:Math.min(label,12)*2+(label===old.label.length&&label===item.label.length?6:0)+Math.min(after,6)+near(item),strong:label>=4||(label===old.label.length&&after>=2),note:'項目名の一致が少ないため確かめてください。'}];
    });
  };
}
const place=(item:DocNumber):RefreshPlace=>({documentId:item.documentId,documentName:item.documentName,locator:item.locator,...(item.excerpt?{excerpt:item.excerpt}:{}),
  label:item.cell?`${item.cell.rowLabel||item.cell.column+item.cell.row}${item.cell.header?` / ${item.cell.header}`:''}（${item.cell.column}${item.cell.row}）`:`${item.label||'（見出しなし）'}${item.ordinal?`の${item.ordinal+1}番目の数値`:''}`});

const DIRECTION=/増加|減少|増収|減収|増益|減益|増大|減退|上回|下回|上昇|下落|低下|改善|悪化|拡大|縮小|伸長|伸び|黒字|赤字|過去最高|最高|最低|好調|不調|回復|鈍化|加速|減速|プラス|マイナス|達成|未達|横ばい/g;
const snippet=(text:string,start:number,end:number)=>`${start>14?'…':''}${text.slice(Math.max(0,start-14),end+14)}${end+14<text.length?'…':''}`.replace(/\s+/g,' ');

/** Compares the previous deck's numbers with the new documents. */
export function planRefresh(deck:DeckSpec,previous:RefreshDocument[],next:RefreshDocument[]):Omit<RefreshPlan,'id'|'variantId'>{
  const before=indexDocuments(previous),pairs=pairDocuments(previous,next),find=matcher(indexDocuments(next),pairs);
  const byValue=new Map<string,{item:DocNumber;percent:boolean}[]>();
  const put=(value:string,entry:{item:DocNumber;percent:boolean})=>{const list=byValue.get(value);if(list)list.push(entry);else byValue.set(value,[entry]);};
  for(const item of before){put(item.value,{item,percent:false});if(item.percent&&item.percent.value!==item.value)put(item.percent.value,{item,percent:true});}
  const entries:RefreshEntry[]=[],texts:RefreshText[]=[];
  deck.slides.forEach((slide,index)=>{
    const page=index+1,cited=new Set(slide.sources.map(s=>`${s.documentId}\u0000${s.locator}`)),{fields,values}=slideSites(slide);
    const resolve=(site:{path:string;start?:number;end?:number;raw:string;value:string;where:string;context:string;number:boolean;labels:string[];after:string}):RefreshEntry=>{
      const base={id:`${slide.id}|${site.path}|${site.start??''}`,slideId:slide.id,page,path:site.path,...(site.start!==undefined?{start:site.start,end:site.end}:{}),where:site.where,context:site.context,before:site.raw};
      const all=byValue.get(site.value)??[],citedOnes=all.filter(o=>cited.has(`${o.item.documentId}\u0000${o.item.locator}`));
      // The same value can be written in many places; keep those whose surroundings read like the slide's.
      let pool=citedOnes.length?citedOnes:all;
      if(pool.length>1){
        const likeness=(item:DocNumber)=>site.labels.reduce((sum,label)=>sum+Math.max(commonSuffix(label,item.label),item.cell?commonSuffix(label,item.cell.header):0),0)*2+commonPrefix(site.after,item.after);
        const top=Math.max(...pool.map(o=>likeness(o.item)));if(top>0)pool=pool.filter(o=>likeness(o.item)===top);
      }
      const olds=pool.slice(0,12);
      if(!olds.length)return {...base,after:site.raw,status:'missing',note:'前回の資料に見つからない数値です。自動では変えません。'};
      const write=(old:{percent:boolean},item:DocNumber)=>{
        const form=old.percent?item.percent:{value:item.value,decimals:-1};
        if(!form)return undefined;
        const written=old.percent?Number(form.value).toFixed(form.decimals):item.raw;
        return site.number?String(Number(canonicalNumber(written))):formatLike(site.raw,canonicalNumber(written),written);
      };
      const candidates=new Map<string,{value:string;basis:RefreshPlace;score:number;strong:boolean;note?:string}>();
      let found=false;
      for(const old of olds){
        const matches=find(old.item);if(!matches.length)continue;
        const top=Math.max(...matches.map(m=>m.score));
        for(const match of matches.filter(m=>m.score===top)){
          const value=write(old,match.item);if(value===undefined)continue;found=true;
          const known=candidates.get(canonicalNumber(value));
          if(!known||known.score<match.score)candidates.set(canonicalNumber(value),{value,basis:place(match.item),score:match.score,strong:match.strong,...(match.note?{note:match.note}:{})});
        }
      }
      const previousPlace=place(olds[0].item);
      if(!found)return {...base,after:site.raw,status:'review',previous:previousPlace,note:'新しい資料で同じ項目が見つかりません。'};
      const list=[...candidates.values()].sort((a,b)=>b.score-a.score);
      if(list.length>1)return {...base,after:site.raw,status:'review',previous:previousPlace,candidates:list.slice(0,4).map(({value,basis})=>({value,basis})),note:'新しい資料に候補が複数あります。正しい値を選んでください。'};
      const [only]=list;
      if(!only.strong)return {...base,after:site.raw,status:'review',previous:previousPlace,candidates:[{value:only.value,basis:only.basis}],note:only.note??'項目名の一致が少ないため確かめてください。'};
      const same=canonicalNumber(only.value)===site.value;
      return {...base,after:same?site.raw:only.value,status:same?'same':'changed',basis:only.basis,previous:previousPlace};
    };
    for(const field of fields)if(!field.hidden)for(const span of numberSpans(field.text))if(isData(field.text,span))
      entries.push(resolve({path:field.path,start:span.start,end:span.end,raw:span.raw,value:span.value,where:field.where,context:snippet(field.text,span.start,span.end),number:false,
        labels:[words(field.text.slice(0,span.start).replace(/[\s\S]*[0-9０-９]/,'')).slice(-16)],after:words(field.text.slice(span.end,span.end+40)).slice(0,8)}));
    for(const site of values)entries.push(resolve({path:site.path,raw:String(site.value),value:canonicalNumber(String(site.value)),where:site.where,context:'',number:true,labels:site.labels.map(squash),after:''}));
    for(const field of fields){
      if(field.hidden)continue;
      const changed=entries.filter(e=>e.slideId===slide.id&&e.path===field.path&&e.status==='changed');
      if(!changed.length)continue;
      const flipped=changed.find(e=>sign(canonicalNumber(e.before))*sign(canonicalNumber(e.after))<0),words=[...new Set(field.text.match(DIRECTION)??[])];
      if(!flipped&&!words.length)continue;
      texts.push({id:`${slide.id}|${field.path}`,slideId:slide.id,page,path:field.path,where:field.where,before:field.text,
        reason:flipped?`増減の向きが変わりました（${flipped.before} → ${flipped.after}）。${words.length?`「${words.join('」「')}」の表現を`:'文章の表現を'}確かめてください。`:`数値が変わりました。「${words.join('」「')}」が今回も正しいか確かめてください。`});
    }
  });
  const count=(status:RefreshEntry['status'])=>entries.filter(e=>e.status===status).length;
  return {title:deck.title,documents:next.map(d=>({id:d.id,name:d.name})),previousDocuments:previous.map(d=>d.name),entries,texts,counts:{changed:count('changed'),same:count('same'),review:count('review'),missing:count('missing')}};
}

/** Replaces numbers inside one text, from the end so earlier positions stay valid. */
export function applyToText(text:string,edits:{start:number;end:number;value:string}[]){
  let result=text;for(const edit of [...edits].sort((a,b)=>b.start-a.start))result=result.slice(0,edit.start)+edit.value+result.slice(edit.end);return result;
}
/** The value a user may type for a number: one number, without its unit. */
export function refreshValueProblem(value:string){
  const text=value.trim(),spans=numberSpans(text);
  if(!text||text.length>40||spans.length!==1||spans[0].raw!==text)return '数値だけを入力してください（単位や文章は元のまま残ります）。';
  return undefined;
}
export class RefreshInputError extends Error {}

export interface RefreshChoice {values:Record<string,string>;texts:Record<string,string>}
/** Builds the refreshed deck. Values chosen in the review replace the proposals; a
 * reviewed sentence replaces its whole text. Speaker notes and the page names follow
 * the numbers changed on the same slide. Citations move to the new documents. */
export function applyRefresh(deck:DeckSpec,plan:Pick<RefreshPlan,'entries'|'texts'>,choice:RefreshChoice,next:RefreshDocument[],previous:RefreshDocument[]){
  const result=structuredClone(deck),pairs=pairDocuments(previous,next),changes:RefreshSummary['changes']=[];
  let edited=0,unresolved=0;
  const valueOf=(entry:RefreshEntry)=>{const chosen=choice.values[entry.id];return chosen===undefined?entry.after:chosen.trim();};
  const basisOf=(entry:RefreshEntry,value:string)=>entry.candidates?.find(c=>canonicalNumber(c.value)===canonicalNumber(value))?.basis??(value===entry.after?entry.basis:undefined);
  const mirrorText=(text:string,map:Map<string,string>)=>applyToText(text,numberSpans(text).filter(s=>map.has(s.raw)).map(s=>({start:s.start,end:s.end,value:map.get(s.raw)!})));
  const deckMap=new Map<string,string>();
  result.slides.forEach((slide,index)=>{
    const original=deck.slides[index],entries=plan.entries.filter(e=>e.slideId===slide.id),mirror=new Map<string,string>(),used:RefreshEntry[]=[];
    const paths=[...new Set(entries.map(e=>e.path))];
    for(const path of paths){
      const list=entries.filter(e=>e.path===path),override=choice.texts[`${slide.id}|${path}`];
      if(list[0].start===undefined){
        const entry=list[0],value=valueOf(entry);
        if(canonicalNumber(value)!==canonicalNumber(entry.before)){
          const number=Number(canonicalNumber(value));
          if(refreshValueProblem(value)||!Number.isFinite(number))throw new RefreshInputError(`${index+1}枚目の${entry.where}：${refreshValueProblem(value)??'数値を入力してください。'}`);
          setPath(slide,path,number);used.push(entry);changes.push({slideId:slide.id,page:index+1,where:entry.where,before:entry.before,after:String(number),kind:'value'});
        }else if(entry.status==='review'||entry.status==='missing')unresolved++;
        continue;
      }
      const text=getPath(original,path) as string;
      if(override!==undefined){
        if(typeof override!=='string'||!override.trim())throw new RefreshInputError(`${index+1}枚目の${list[0].where}：文章が空です。`);
        if(override!==text){setPath(slide,path,override);edited++;}
      }
      const edits=list.flatMap(entry=>{
        const value=valueOf(entry);
        if(value===entry.before){if(entry.status==='review'||entry.status==='missing')unresolved++;return [];}
        const problem=refreshValueProblem(value);if(problem)throw new RefreshInputError(`${index+1}枚目の${entry.where}：${problem}`);
        mirror.set(entry.before,value);used.push(entry);
        changes.push({slideId:slide.id,page:index+1,where:entry.where,before:entry.before,after:value,kind:'text'});
        return [{start:entry.start!,end:entry.end!,value}];
      });
      if(override===undefined&&edits.length)setPath(slide,path,applyToText(text,edits));
    }
    // Page names and speaker notes follow the numbers changed on the slide.
    const title=original.design?.elements.find(e=>e.t==='text'&&e.role==='title'),newTitle=slide.design?.elements.find(e=>e.t==='text'&&e.role==='title');
    if(original.design)slide.title=(title&&title.t==='text'&&newTitle&&newTitle.t==='text'&&title.text===original.title?newTitle.text:mirrorText(original.title,mirror)).slice(0,70);
    slide.notes=mirrorText(original.notes,mirror);
    if(index===0)for(const [k,v] of mirror)deckMap.set(k,v);
    // Citations point to the new documents: where this slide's numbers were found now.
    const unitText=(documentId:string,locator:string)=>next.find(d=>d.id===documentId)?.sources.find(u=>u.locator===locator)?.text;
    const mapped=original.sources.map(source=>{
      const votes=new Map<string,{place:RefreshPlace;count:number}>();
      for(const entry of entries){
        const value=valueOf(entry),basis=basisOf(entry,value);
        if(!basis||!entry.previous||entry.previous.documentId!==source.documentId||entry.previous.locator!==source.locator)continue;
        const key=`${basis.documentId}\u0000${basis.locator}`,vote=votes.get(key);if(vote)vote.count++;else votes.set(key,{place:basis,count:1});
      }
      const best=[...votes.values()].sort((a,b)=>b.count-a.count)[0];
      if(best)return {documentId:best.place.documentId,documentName:best.place.documentName,locator:best.place.locator};
      const pair=pairs.get(source.documentId);
      if(pair&&unitText(pair,source.locator)!==undefined)return {documentId:pair,documentName:next.find(d=>d.id===pair)!.name,locator:source.locator};
      return undefined;
    });
    const sources:SourceRef[]=[],index1=new Map<number,number>();
    mapped.forEach((target,i)=>{
      if(!target)return;
      let at=sources.findIndex(s=>s.documentId===target.documentId&&s.locator===target.locator);
      if(at<0){const quote=original.sources[i].quote,text=unitText(target.documentId,target.locator)??'';sources.push({...target,...(quote&&text.replace(/\s+/g,'').includes(quote.replace(/\s+/g,''))?{quote}:{})});at=sources.length-1;}
      index1.set(i+1,at+1);
    });
    // A page without citations (a cover) stays without; adding a footer would change its design.
    if(original.sources.length)for(const entry of used){const basis=basisOf(entry,valueOf(entry));if(basis&&sources.length<10&&!sources.some(s=>s.documentId===basis.documentId&&s.locator===basis.locator))sources.push({documentId:basis.documentId,documentName:basis.documentName,locator:basis.locator});}
    slide.sources=sources;
    const remap=(refs?:number[])=>{const list=[...new Set((refs??[]).map(n=>index1.get(n)).filter((n):n is number=>!!n))];return list.length?list:undefined;};
    for(const item of [...slide.items,...(slide.diagram?.items??[])]){const refs=remap(item.refs);if(refs)item.refs=refs;else delete item.refs;}
    for(const element of slide.design?.elements??[])if(element.t==='text'){const refs=remap(element.refs);if(refs)element.refs=refs;else delete element.refs;}
  });
  result.title=(deck.title===deck.slides[0]?.title?result.slides[0].title:mirrorText(deck.title,deckMap)).slice(0,100);
  return {deck:result,changes,edited,unresolved};
}
