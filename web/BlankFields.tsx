import {useEffect,useState} from 'react';
import type {DeckSpec,OpenFact} from '../shared/contracts';
import {deckBlanks} from '../shared/blanks';

/** Before the pages are made: the facts the deck needs that the request and documents do not give. What the
 * user types is used as written; what is left empty becomes a blank (［実施日］) on the slides. */
export function OpenFactsForm({facts,values,disabled,onChange}:{facts:OpenFact[];values:Record<string,string>;disabled:boolean;onChange:(values:Record<string,string>)=>void}){
  return <section className="open-facts" aria-label="資料にない情報">
    <h3>資料にない情報</h3>
    <p>AIが、この資料に必要なのに依頼や資料にない事実を挙げました。分かるものを入力してから作成すると、そのまま使います。空欄の項目は、スライドに［項目名］の記入欄として残り、あとから入力できます。</p>
    {facts.map(fact=><label className="fact-row" key={fact.label}><span>{fact.label}{fact.hint&&<small>{fact.hint}</small>}</span><input value={values[fact.label]??''} maxLength={80} disabled={disabled} placeholder="未定なら空欄のまま" onChange={event=>onChange({...values,[fact.label]:event.target.value})}/></label>)}
  </section>;
}

/** After the pages are made: the blanks left on the slides, filled across the whole deck at once (no AI). */
export function BlankFields({deck,facts,busy,onFill}:{deck:DeckSpec;facts?:OpenFact[];busy:boolean;onFill:(values:Record<string,string>)=>void}){
  const blanks=deckBlanks(deck),key=blanks.map(b=>b.label).join('|');
  const [values,setValues]=useState<Record<string,string>>({});
  useEffect(()=>{setValues(Object.fromEntries(blanks.map(b=>[b.label,facts?.find(f=>f.label===b.label)?.value??''])));},[key]);
  if(!blanks.length)return null;
  const filled=Object.fromEntries(Object.entries(values).filter(([,v])=>v.trim()));
  return <details className="blank-fields" open>
    <summary>記入欄（まだ決まっていない事実） · {blanks.length}項目</summary>
    <p>スライドに［項目名］の形で色付きで残っている欄です。入力すると、資料のすべてのページに反映します（AIは呼び出しません）。空欄のままでも書き出せます。</p>
    {blanks.map(blank=><label className="fact-row" key={blank.label}><span>{blank.label}<small>{blank.pages.join('・')}枚目</small></span><input value={values[blank.label]??''} maxLength={80} disabled={busy} placeholder="決まったら入力" onChange={event=>setValues({...values,[blank.label]:event.target.value})}/></label>)}
    <div className="blank-actions"><button type="button" className="button secondary small" disabled={busy||!Object.keys(filled).length} onClick={()=>onFill(filled)}>入力した内容を反映</button></div>
  </details>;
}
