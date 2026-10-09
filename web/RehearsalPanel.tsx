import {useState} from 'react';
import type {AssistState,OutputMode,ProviderKind,RehearsalPlan,RehearsalSlide} from '../shared/contracts';
import {formatDuration,localRehearsal,REHEARSAL_LIMITS} from '../shared/rehearsal';
import {api} from './api';
import {ChatHandoffPanel} from './ChatHandoffPanel';
import {Icon} from './ui';
import type {Runner} from './SlideActionsPanel';

/** Presentation preparation: time per slide (computed locally), speaking notes
 * and likely questions (AI, through the chosen processing). For a generated
 * deck the notes can be written into the PowerPoint speaker notes. */
export function RehearsalPanel({title,loadSlides,busy,run,provider,mode,onApply,onNotice}:{title:string;loadSlides:(signal:AbortSignal)=>Promise<RehearsalSlide[]>;busy:boolean;run:Runner;provider:ProviderKind;mode:OutputMode;onApply?:(notes:{slideId:string;notes:string}[])=>Promise<void>;onNotice:(text:string)=>void}){
  const [minutes,setMinutes]=useState(mode==='reading'?15:10),[plan,setPlan]=useState<RehearsalPlan>(),[state,setState]=useState<AssistState>(),[consent,setConsent]=useState(false);
  const validMinutes=Number.isFinite(minutes)&&minutes>=REHEARSAL_LIMITS.minMinutes&&minutes<=REHEARSAL_LIMITS.maxMinutes;
  function local(){void run('時間配分を計算しています',async signal=>{setState(undefined);setPlan(localRehearsal(await loadSlides(signal),Math.round(minutes*60)));});}
  function withAi(){
    if(provider==='subscription'&&!consent){onNotice('スライドの文章を月額版のAIへ送ることを確認し、チェックを入れてください。');return;}
    void run('発表の原稿と想定質問を準備しています',async signal=>{
      const slides=await loadSlides(signal);setPlan(undefined);
      const next=await api<AssistState>('/assist',{method:'POST',body:JSON.stringify({task:'rehearsal',minutes,slides,mode,cloudConsent:consent}),signal});
      setState(next);if(next.status==='done'&&next.result?.kind==='rehearsal')setPlan(next.result.plan);
    });
  }
  async function respond(requestId:string,response:string){await run('AIの返答を検証しています',async signal=>{const next=await api<AssistState>(`/assist/${requestId}/response`,{method:'POST',body:JSON.stringify({response}),signal});setState(next);if(next.status==='done'&&next.result?.kind==='rehearsal')setPlan(next.result.plan);});}
  async function copy(){
    if(!plan)return;
    const text=[...plan.slides.map((s,i)=>`${i+1}. ${s.title}（${formatDuration(s.seconds)}）\n${s.notes}`),...(plan.questions.length?['想定質問',...plan.questions.map(q=>`Q. ${q.question}\nA. ${q.answer}`)]:[])].join('\n\n');
    try{await navigator.clipboard.writeText(text);onNotice('原稿と想定質問をコピーしました。');}catch{onNotice('コピーできませんでした。表から選択してコピーしてください。');}
  }
  let elapsed=0;
  return <section className="rehearsal" aria-label="発表準備">
    <div className="slide-actions-heading"><h2>{title}</h2><span>時間配分・原稿・想定質問</span></div>
    <div className="rehearsal-controls">
      <label>持ち時間<input type="number" min={REHEARSAL_LIMITS.minMinutes} max={REHEARSAL_LIMITS.maxMinutes} value={minutes} disabled={busy} onChange={event=>setMinutes(Number(event.target.value))}/>分</label>
      <button className="button secondary small" disabled={busy||!validMinutes} onClick={local}>時間配分だけ作る（AIなし）</button>
      <button className="button primary small" disabled={busy||!validMinutes} onClick={withAi}><Icon name="message" size={13}/>原稿と想定質問を作る</button>
    </div>
    {provider==='subscription'&&<label className="slide-actions-option"><input type="checkbox" checked={consent} disabled={busy} onChange={event=>setConsent(event.target.checked)}/>スライドの文章を月額版のAIへ送ることに同意します</label>}
    {state?.status==='handoff'&&state.handoff&&<ChatHandoffPanel handoff={state.handoff} busy={busy} onApply={respond} onCancel={()=>setState(undefined)}/>}
    {plan&&<>
      <p className="slide-actions-note">合計 {formatDuration(plan.totalSeconds)} · {plan.generated==='ai'?'AIの原稿は資料の数値だけを使うよう検証済み。時間は合計に合わせて調整しています。':'文章量から計算した目安です。原稿はスライドの要点の一覧です。'}</p>
      <ol className="rehearsal-plan">{plan.slides.map((slide,index)=>{elapsed+=slide.seconds;return <li key={slide.id}><div className="rehearsal-row"><span className="rehearsal-index">{String(index+1).padStart(2,'0')}</span><strong>{slide.title}</strong><span className="rehearsal-time">{formatDuration(slide.seconds)}<small>〜{formatDuration(elapsed)}</small></span></div><details><summary>話す内容</summary><p>{slide.notes}</p></details></li>;})}</ol>
      {plan.questions.length>0&&<div className="rehearsal-questions"><h3>想定質問</h3>{plan.questions.map((q,i)=><details key={i}><summary>{q.question}</summary><p>{q.answer}</p></details>)}</div>}
      <div className="preview-actions"><button className="button secondary small" disabled={busy} onClick={()=>void copy()}><Icon name="file" size={13}/>原稿をコピー</button>{onApply&&<button className="button primary small" disabled={busy} onClick={()=>void run('発表者ノートに反映しています',async()=>{await onApply(plan.slides.map(s=>({slideId:s.id,notes:`（目安 ${formatDuration(s.seconds)}）\n${s.notes}`})));})}><Icon name="check" size={13}/>発表者ノートに反映</button>}</div>
    </>}
  </section>;
}
