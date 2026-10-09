import {useMemo,useState} from 'react';
import type {DeckSpec,SlideSpec} from '../shared/contracts';
import {compileDeck,listLayouts} from '../shared/layouts';
import {fittingLayouts} from '../shared/layout-selection';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {groupNames,researchSources} from '../shared/layout-guidance';
import {Modal} from './ui';
import {SlidePreview} from './SlidePreview';

export function LayoutDialog({deck,slide,onSelect,onClose}:{deck?:DeckSpec;slide?:SlideSpec;onSelect?:(id:string)=>void;onClose:()=>void}){
  const [filter,setFilter]=useState('');
  const layouts=useMemo(()=>deck&&slide?fittingLayouts(deck,slide):listLayouts(),[deck,slide]);
  const visible=layouts.filter(l=>[l.name,l.whenToUse,l.placement,groupNames[l.group]].join(' ').includes(filter));
  return <Modal title={slide?'構図を変更':`${listLayouts().length}種類の構図`} wide onClose={onClose}>
    <p className="modal-prose">{slide?'内容の関係と表示中の文章を保ち、文字が収まる候補を表示しています。構図の変更にAI料金はかかりません。':'配置と向いている用途を確認できます。実際の生成では内容・文字量・最近使った構図をもとに選びます。'} 図は配置の概略です。作成後はPowerPointの描画で確認できます。</p>
    <label className="field"><span>構図を検索</span><input value={filter} onChange={e=>setFilter(e.target.value)} placeholder="例：比較、時系列、表、要点"/></label>
    <div className="layout-gallery">{visible.map(l=>{
      const preview=compileDeck(deck&&slide?{...deck,slides:[{...slide,layoutId:l.id}]}:sampleDeck([sampleSlide(l.id)]));
      return <article className={`layout-option ${slide?.layoutId===l.id?'selected':''}`} key={l.id}>
        <div className="layout-image"><SlidePreview document={preview} index={0}/></div>
        <div className="layout-description"><h3>{l.name}</h3><p><b>配置</b> {l.placement}</p><p><b>用途</b> {l.whenToUse}</p><p><b>文字量</b> {l.textBudget}</p><details><summary>使うときの注意・参考</summary><p>{l.avoidWhen}</p>{l.references?.map(key=><a href={researchSources[key].url} target="_blank" rel="noreferrer" key={key}>{researchSources[key].title}</a>)}</details>
        {onSelect&&<button className="button secondary small" disabled={slide?.layoutId===l.id} onClick={()=>onSelect(l.id)}>{slide?.layoutId===l.id?'使用中':'この構図を使う'}</button>}</div>
      </article>;
    })}</div>
    {!visible.length&&<p>該当する構図がありません。文章を短くすると使える候補が増える場合があります。</p>}
  </Modal>;
}
