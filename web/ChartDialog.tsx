import {useState} from 'react';
import type {ChartType,DeckSpec,SlideSpec} from '../shared/contracts';
import {compatibleChartTypes,chartCatalog} from '../shared/charts';
import {compileDeck} from '../shared/layouts';
import {Modal} from './ui';
import {SlidePreview} from './SlidePreview';

export function ChartDialog({deck,slide,onSelect,onClose}:{deck:DeckSpec;slide:SlideSpec;onSelect:(type:ChartType)=>void;onClose:()=>void}){
  const [type,setType]=useState<ChartType>(slide.chart!.type),options=compatibleChartTypes(slide.chart!);
  const scene=compileDeck({...deck,slides:[{...slide,chart:{...slide.chart!,type}}]});
  return <Modal title="グラフを変更" wide onClose={onClose}>
    <p className="modal-prose">同じ数値・単位・出典を使います。種類の変更にAIの追加料金はかかりません。</p>
    <label className="field"><span>グラフの種類</span><select value={type} onChange={e=>setType(e.target.value as ChartType)}>{options.map(id=><option key={id} value={id}>{chartCatalog[id].name}</option>)}</select></label>
    <p className="modal-prose">{chartCatalog[type].use} {chartCatalog[type].avoid}</p>
    <div className="chart-dialog-preview"><SlidePreview document={scene} index={0}/></div>
    <p className="modal-prose">図は配置の概略です。変更後にPowerPointで実際の描画を確認します。円・ドーナツの割合表示は小数第1位に丸めます。元の数値は保持します。</p>
    <button className="button primary" disabled={type===slide.chart!.type} onClick={()=>onSelect(type)}>このグラフに変更</button>
  </Modal>;
}
