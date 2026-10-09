import {useEffect,useState} from 'react';
import type {SourceReport} from '../shared/contracts';
import {api} from './api';
import {Modal,Spinner} from './ui';

const statusLabel={matched:'出典と一致',uncited:'資料の別の位置にあり',unmatched:'要確認'};

/** Citations per slide with the extracted original text, and a local, exact
 * check of each number on the slide against the cited text. No AI call. */
export function SourcesDialog({sessionId,variantId,focusSlideId,onClose}:{sessionId:string;variantId:string;focusSlideId?:string;onClose:()=>void}){
  const [report,setReport]=useState<SourceReport>(),[error,setError]=useState('');
  useEffect(()=>{const controller=new AbortController();api<SourceReport>(`/sessions/${sessionId}/sources?variantId=${encodeURIComponent(variantId)}`,{signal:controller.signal}).then(setReport).catch(e=>{if(e.name!=='AbortError')setError(e.message);});return()=>controller.abort();},[sessionId,variantId]);
  useEffect(()=>{if(report&&focusSlideId)document.getElementById(`sources-${focusSlideId}`)?.scrollIntoView({block:'start'});},[report,focusSlideId]);
  const numbers=report?.slides.flatMap(slide=>slide.numbers)??[];
  const count=(status:keyof typeof statusLabel)=>numbers.filter(n=>n.status===status).length;
  return <Modal title="出典と根拠の確認" wide onClose={onClose}>
    <p className="modal-prose">各スライドの出典の位置と、資料から読み取った原文を表示します。スライド上の数値が、出典の原文に同じ値で書かれているかをこのPCで照合します（丸めや単位換算は一致とみなしません）。一致しても、意味や単位が正しいことまでは保証しません。</p>
    {error&&<p className="error-banner" role="alert">{error}</p>}
    {!report&&!error&&<p className="busy-status"><Spinner/>出典を確認しています</p>}
    {report&&<>
      {report.documents===0&&<p className="settings-note">この資料は添付資料なしで作成されたため、出典はありません。数値は一般的な説明・例として扱われています。</p>}
      {numbers.length>0&&<div className="source-summary"><span className="source-chip matched">{statusLabel.matched} {count('matched')}</span><span className="source-chip uncited">{statusLabel.uncited} {count('uncited')}</span><span className="source-chip unmatched">{statusLabel.unmatched} {count('unmatched')}</span></div>}
      <div className="source-slides">{report.slides.map((slide,index)=><article key={slide.slideId} id={`sources-${slide.slideId}`} className={`source-slide ${slide.slideId===focusSlideId?'focused':''}`}>
        <h3><span>{String(index+1).padStart(2,'0')}</span>{slide.title}</h3>
        {slide.sources.length===0?<p className="source-empty">出典なし{slide.numbers.length?' · スライドの数値は出典で確認できません':''}</p>:<ol className="source-list">{slide.sources.map(source=><li key={source.index}><div><strong>[{source.index}] {source.documentName}</strong><span>{source.locator}</span>{source.missing&&<em>資料に見つかりません</em>}</div>{source.quote&&<blockquote>「{source.quote}」</blockquote>}{source.excerpt&&<details><summary>原文を見る</summary><p>{source.excerpt}</p></details>}</li>)}</ol>}
        {slide.numbers.length>0&&<div className="source-numbers">{slide.numbers.map((n,i)=><span key={i} className={`source-chip ${n.status}`} title={n.locator?`${statusLabel[n.status]}：${n.locator}`:statusLabel[n.status]}>{n.value}<small>{statusLabel[n.status]}</small></span>)}</div>}
      </article>)}</div>
    </>}
  </Modal>;
}
