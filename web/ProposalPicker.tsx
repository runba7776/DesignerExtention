import type {AiPalette,ProposalSet} from '../shared/contracts';
import {Icon} from './ui';

const percent=(value:number)=>`${Math.round(value*100)}%`;
const swatches=(palette:AiPalette)=>[palette.background,palette.surface,palette.text,palette.accent,palette.accent2].filter((color):color is string=>!!color);

/** The directions the AI offered for the first outline. Shown in full until one is picked;
 * afterwards folded, so another direction can still be taken until slides are made. */
export function ProposalPicker({set,busy,folded,onChoose}:{set:ProposalSet;busy:boolean;folded:boolean;onChoose:(index:number)=>void}){
  const cards=<div className="proposal-grid">{set.items.map((item,index)=>{
    const outline=item.outline,palette=outline.palette,chosen=set.chosen===index;
    return <article className={`proposal-card${chosen?' chosen':''}`} key={index} aria-label={`${String.fromCharCode(65+index)}案：${item.direction}`}>
      <div className="proposal-title"><span className="proposal-letter">{String.fromCharCode(65+index)}</span><h3>{item.direction}</h3></div>
      <p className="proposal-typicality" title="同じ依頼を受けた作り手が、この方向を選ぶ割合のAIによる見積もり">ありがちさ {percent(item.typicality)}</p>
      {item.difference&&<p className="proposal-difference">{item.difference}</p>}
      {palette&&<div className="proposal-palette"><span className="proposal-swatches" aria-hidden="true">{swatches(palette).map((color,i)=><i key={i} style={{background:color}}/>)}</span><small>{palette.name}{palette.headingFont?` · ${palette.headingFont}`:''}{palette.bodyFont&&palette.bodyFont!==palette.headingFont?` / ${palette.bodyFont}`:''}</small></div>}
      {outline.visualStyle&&<p className="proposal-style">{outline.visualStyle}</p>}
      <ol className="proposal-slides">{outline.slides.map(slide=><li key={slide.id}>{slide.title}</li>)}</ol>
      <button className={`button small ${chosen?'secondary':'primary'}`} disabled={busy||chosen} onClick={()=>onChoose(index)}>{chosen?<><Icon name="check" size={12}/>選択中</>:'この案で進める'}</button>
    </article>;
  })}</div>;
  const compared=set.candidates.length>0&&<p className="proposal-candidates">AIが比べた方向：{set.candidates.map(c=>`${c.direction}（${percent(c.typicality)}）`).join('、')}</p>;
  if(folded)return <details className="proposals folded"><summary>ほかの構成案に切り替える（{set.items.length}案）</summary>{cards}{compared}</details>;
  return <section className="proposals" aria-label="構成案の候補">
    <div className="outline-heading"><h2>方向の違う構成案</h2><span>{set.items.length} 案</span></div>
    <p className="outline-description">「ありがちさ」は、同じ依頼を受けた作り手がその方向を選ぶ割合を、AIが見積もった値です。選んだ案は、次の画面で見出しや順番を直せます。</p>
    {cards}{compared}
  </section>;
}
