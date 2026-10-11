import {useRef,useState,type ReactNode} from 'react';
import type {DeckSpec,DeckVariant,DocumentInfo,Rect,RefreshEntry,RefreshPlan,RefreshSummary,RefreshText,RenderDocument,RestoredPresentation} from '../shared/contracts';
import {applyToText,numberSpans,refreshValueProblem} from '../shared/refresh';
import {FOOTER_TOP} from '../shared/free-design';
import {api} from './api';
import {Icon} from './ui';

type Filter='attention'|'changed'|'all';
const statusNames:Record<RefreshEntry['status'],string>={changed:'変更',same:'同じ',review:'要確認',missing:'資料にない'};
// In text, the excerpt shows the place better than the words before the number ("月期第"); a sheet keeps its row/column.
const place=(p:{documentName:string;locator:string;label:string;excerpt?:string})=>`${p.documentName} ${p.locator}${p.label&&(!p.excerpt||p.label.includes("番目"))?`「${p.label}」`:""}`;
function highlight(context:string,value:string):ReactNode{const at=context.indexOf(value);return at<0?context:<>{context.slice(0,at)}<mark>{value}</mark>{context.slice(at+value.length)}</>;}

/** Recurring report: compare the numbers of this deck with a new period's documents,
 * review them, and open the refreshed deck as a new presentation. All local. */
export function RefreshPanel({sessionId,variant,hasSources,busy,run,onOpened}:{sessionId:string;variant:DeckVariant;hasSources:boolean;busy:boolean;run:(label:string,operation:(signal:AbortSignal)=>Promise<void>)=>Promise<void>;onOpened:(restored:RestoredPresentation)=>void}){
  const input=useRef<HTMLInputElement>(null);
  const [plan,setPlan]=useState<RefreshPlan>();
  const [uploaded,setUploaded]=useState<DocumentInfo[]>([]);
  const [values,setValues]=useState<Record<string,string>>({});
  const [texts,setTexts]=useState<Record<string,string>>({});
  const [filter,setFilter]=useState<Filter>('attention');
  function forget(){for(const document of uploaded)void api(`/documents/${document.id}`,{method:'DELETE'}).catch(()=>{});setUploaded([]);setPlan(undefined);setValues({});setTexts({});}
  function choose(files:FileList|null){
    const chosen=Array.from(files??[]);if(input.current)input.current.value='';
    if(!chosen.length||busy)return;
    void run('新しい資料の数値を、前回の資料と照合しています',async signal=>{
      if(chosen.length>8)throw new Error('新しい期の資料は8件までです。');
      if(chosen.some(file=>!/\.(pdf|csv|xlsx|pptx|txt|md)$/i.test(file.name)))throw new Error('PDF、CSV、XLSX、PPTX、TXT、MD ファイルを選んでください。');
      forget();
      const body=new FormData();chosen.forEach(file=>body.append('files',file));
      const data=await api<{documents:DocumentInfo[]}>('/documents',{method:'POST',body,signal});setUploaded(data.documents);
      const next=await api<RefreshPlan>(`/sessions/${sessionId}/refresh`,{method:'POST',body:JSON.stringify({variantId:variant.id,documentIds:data.documents.map(d=>d.id)}),signal});
      setPlan(next);setFilter(next.counts.review+next.counts.missing?'attention':'changed');
    });
  }
  const valueOf=(entry:RefreshEntry)=>values[entry.id]??entry.after;
  const sentence=(text:RefreshText)=>texts[text.id]??applyToText(text.before,(plan?.entries??[]).filter(e=>e.slideId===text.slideId&&e.path===text.path&&valueOf(e)!==e.before&&!refreshValueProblem(valueOf(e))).map(e=>({start:e.start!,end:e.end!,value:valueOf(e)})));
  const invalid=plan?.entries.filter(e=>valueOf(e)!==e.before&&refreshValueProblem(valueOf(e)))??[];
  function apply(){
    if(!plan||invalid.length)return;
    const current=plan;
    void run('更新版の資料を作っています',async signal=>{
      const restored=await api<RestoredPresentation>(`/sessions/${sessionId}/refresh/apply`,{method:'POST',body:JSON.stringify({planId:current.id,values,texts}),signal});
      setPlan(undefined);setUploaded([]);setValues({});setTexts({});onOpened(restored);
    });
  }
  const shown=plan?.entries.filter(e=>filter==='all'||(filter==='changed'?valueOf(e)!==e.before:(e.status==='review'||e.status==='missing')))??[];
  return <section className="refresh-panel" aria-label="定例資料の数値を更新する">
    <div className="combine-head"><h3>定例資料：数値だけ新しい期に更新</h3><p>前回の資料のデザイン・構成・文章はそのままに、新しい期の資料（PDF・Excelなど）から同じ項目の数値を探して差し替えます。項目が見つからない数値や候補が複数ある数値は変えずに、確認に回します。照合はこのPCで行い、AIは呼び出しません。</p></div>
    {!plan&&<div className="combine-alternate">
      <button className="button secondary small" disabled={busy||!hasSources} onClick={()=>input.current?.click()}><Icon name="upload" size={13}/>新しい期の資料を選ぶ</button>
      <input ref={input} type="file" className="sr-only" tabIndex={-1} multiple accept=".pdf,.csv,.xlsx,.pptx,.txt,.md" onChange={event=>choose(event.target.files)}/>
      <small>{hasSources?'前回の根拠資料で各数値の項目（表の行と列、数値の前の語）を確かめ、新しい資料の同じ項目から値を取ります。前回の資料は履歴にそのまま残り、更新版は新しい資料として開きます。':'根拠資料を添付して作った資料で使えます。この資料には根拠資料がないため、数値の項目を照合できません。'}</small>
    </div>}
    {plan&&<>
      <div className="refresh-summary" role="status">
        <span className="refresh-count changed">変更 {plan.counts.changed}</span><span className="refresh-count same">同じ {plan.counts.same}</span><span className="refresh-count review">要確認 {plan.counts.review}</span><span className="refresh-count missing">資料にない {plan.counts.missing}</span>
        <small>新しい資料：{plan.documents.map(d=>d.name).join('、')} ／ 前回：{plan.previousDocuments.join('、')}</small>
      </div>
      <label className="field compact refresh-filter"><span>表示</span><select value={filter} onChange={event=>setFilter(event.target.value as Filter)}><option value="attention">確認が必要な数値（{plan.counts.review+plan.counts.missing}）</option><option value="changed">変える数値</option><option value="all">すべて（{plan.entries.length}）</option></select></label>
      <ul className="refresh-list">{shown.map(entry=>{
        const value=valueOf(entry),edited=values[entry.id]!==undefined&&value!==entry.after,problem=value!==entry.before?refreshValueProblem(value):undefined;
        return <li key={entry.id} className={`refresh-entry ${entry.status}`}>
          <div className="refresh-entry-head"><strong>{String(entry.page).padStart(2,'0')}</strong><span>{entry.where}</span><em className={`refresh-badge ${edited?'edited':entry.status}`}>{edited?'手で変更':statusNames[entry.status]}</em></div>
          {entry.context&&<p className="refresh-context">{highlight(entry.context,entry.before)}</p>}
          <div className="refresh-values"><span>前回 <b>{entry.before}</b></span><span aria-hidden="true">→</span><label>今回 <input value={value} aria-label={`${entry.page}枚目 ${entry.where}の今回の値`} aria-invalid={!!problem} onChange={event=>setValues(previous=>({...previous,[entry.id]:event.target.value}))}/></label>{values[entry.id]!==undefined&&<button className="text-link" onClick={()=>setValues(previous=>{const next={...previous};delete next[entry.id];return next;})}>提案に戻す</button>}</div>
          {problem&&<p className="refresh-problem" role="alert">{problem}</p>}
          {entry.candidates?.length?<div className="refresh-candidates">{entry.candidates.map(c=><button key={c.value} className={`refresh-candidate ${value===c.value?'chosen':''}`} onClick={()=>setValues(previous=>({...previous,[entry.id]:c.value}))}><b>{c.value}</b><small>{place(c.basis)}</small></button>)}</div>:null}
          <p className="refresh-basis">{entry.basis&&value===entry.after?<>根拠：{place(entry.basis)}{entry.basis.excerpt&&<q>{highlight(entry.basis.excerpt,value)}</q>}</>:entry.note??''}{entry.previous&&<span>（前回：{place(entry.previous)}）</span>}</p>
        </li>;})}
        {!shown.length&&<li className="refresh-empty">{filter==='attention'?'確認が必要な数値はありません。':'該当する数値はありません。'}</li>}
      </ul>
      {plan.texts.length>0&&<div className="refresh-texts"><h4>表現の確認（{plan.texts.length}）</h4><p>数値が変わったため、文章の言い回しが今回も正しいか確かめてください。ここで直した文章はそのまま使います。</p>
        {plan.texts.map(text=><div className="refresh-text" key={text.id}><div className="refresh-entry-head"><strong>{String(text.page).padStart(2,'0')}</strong><span>{text.where}</span></div><p className="refresh-reason">{text.reason}</p>
          <textarea value={sentence(text)} rows={2} maxLength={800} aria-label={`${text.page}枚目 ${text.where}の文章`} onChange={event=>setTexts(previous=>({...previous,[text.id]:event.target.value}))}/>
          {texts[text.id]!==undefined&&<button className="text-link" onClick={()=>setTexts(previous=>{const next={...previous};delete next[text.id];return next;})}>数値だけ差し替えた文に戻す</button>}</div>)}
      </div>}
      <div className="combine-actions"><button className="button primary small" disabled={busy||!!invalid.length} onClick={apply}><Icon name="check" size={13}/>この内容で更新版を作る</button><button className="button ghost small" disabled={busy} onClick={forget}>取り消す</button></div>
      <small className="refresh-note">{invalid.length?`${invalid.length}か所の値を直してください。`:''}更新版は新しい資料として開き、履歴に保存します。デザインと文字の位置は変えません。発表者ノートは、スライドで変えた数値と同じ表記のものを置き換えます。</small>
    </>}
  </section>;
}

/** The changes of a refreshed deck, with marks in the preview (never exported). */
export function RefreshResult({summary,marks,onMarks}:{summary:RefreshSummary;marks:boolean;onMarks:(value:boolean)=>void}){
  const pages=new Set(summary.changes.map(c=>c.slideId)).size;
  return <section className="refresh-result" role="status" aria-label="前回からの変更">
    <strong>前回「{summary.from}」から更新した資料です</strong>
    <p>{pages}枚・{summary.changes.length}か所の数値を変更{summary.edited?`、${summary.edited}か所の文章を見直し`:''}しました。{summary.unresolved?`${summary.unresolved}か所は確認できなかったため、前回の値のままです。`:''}新しい資料：{summary.documents.join('、')}</p>
    <label className="refresh-toggle"><input type="checkbox" checked={marks} onChange={event=>onMarks(event.target.checked)}/>変更した場所に印を付けて表示（書き出すファイルには付きません）</label>
    {summary.changes.length>0&&<details><summary>変更の一覧</summary><ul>{summary.changes.map((c,i)=><li key={i}><strong>{String(c.page).padStart(2,'0')}</strong> {c.where}：{c.before} → <b>{c.after}</b></li>)}</ul></details>}
  </section>;
}

/** Places on a slide whose numbers changed: text boxes holding a new number, charts holding a new value. */
export function refreshMarks(scene:RenderDocument,deck:DeckSpec,summary:RefreshSummary,index:number):Rect[]{
  const slide=deck.slides[index],page=scene.slides[index];if(!slide||!page)return [];
  const changes=summary.changes.filter(c=>c.slideId===slide.id);if(!changes.length)return [];
  const texts=new Set(changes.filter(c=>c.kind==='text').map(c=>c.after)),values=new Set(changes.filter(c=>c.kind==='value').map(c=>c.after));
  return page.elements.flatMap(e=>{
    if(e.y>=FOOTER_TOP-6)return [];// the citation footer and page number
    if(e.kind==='text'&&numberSpans(e.text).some(s=>texts.has(s.raw)))return [{x:e.x,y:e.y,w:e.w,h:e.h}];
    if(e.kind==='chart'&&e.series.some(s=>s.values.some(v=>values.has(String(v)))))return [{x:e.x,y:e.y,w:e.w,h:e.h}];
    if(e.kind==='smartart'&&e.items.some(item=>[item.label,item.description,item.value].some(t=>t&&numberSpans(t).some(s=>texts.has(s.raw)))))return [{x:e.x,y:e.y,w:e.w,h:e.h}];
    return [];
  });
}
