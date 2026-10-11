import type {AiTarget,SendScope,Settings,SubscriptionStatus} from '../shared/contracts';

export const targetNames:Record<AiTarget,string>={claude:'Claude',chatgpt:'ChatGPT',local:'ローカルLLM'};
const scopeNames:Record<SendScope,string>={full:'資料と指示をそのまま送る',masked:'社名・数値などを伏せ字にして送る',design:'内容は送らない（内容はローカルLLM、外部のAIにはデザインだけ頼む）'};
export interface AiChoice {targets:AiTarget[];scope:SendScope}

/** Which AIs write this deck and what may leave this PC. AIs are signed in beforehand in
 * settings; several can be chosen to get one draft from each, side by side. */
export function availableTargets(settings:Settings,connections?:SubscriptionStatus){
  const connected=(service:'claude'|'chatgpt')=>connections?.services.some(s=>s.service===service&&s.canGenerate)??false;
  const local=!!(settings.localModel??(settings.provider==='local'?settings.model:''));
  return {claude:connected('claude'),chatgpt:connected('chatgpt'),local} as Record<AiTarget,boolean>;
}
export function defaultChoice(settings:Settings,available:Record<AiTarget,boolean>,masked:boolean):AiChoice{
  const saved=(settings.targets??[]).filter(t=>available[t]);
  const primary:AiTarget=settings.provider==='local'?'local':settings.subscriptionService??'chatgpt';
  return {targets:saved.length?saved:available[primary]?[primary]:(Object.keys(available) as AiTarget[]).filter(t=>available[t]).slice(0,1),scope:masked?'masked':'full'};
}

export function AiPicker({choice,available,disabled,onChange,onSetup}:{choice:AiChoice;available:Record<AiTarget,boolean>;disabled:boolean;onChange:(value:AiChoice)=>void;onSetup:()=>void}){
  const toggle=(target:AiTarget)=>{
    const targets=choice.targets.includes(target)?choice.targets.filter(t=>t!==target):[...choice.targets,target];
    if(targets.length&&targets.length<=3)onChange({...choice,targets});
  };
  const design=choice.scope==='design',missing=(Object.keys(available) as AiTarget[]).filter(t=>!available[t]);
  const designProblem=design&&(!choice.targets.includes('local')?'内容を書くローカルLLMを選んでください。':!choice.targets.some(t=>t!=='local')?'デザインを頼むClaudeかChatGPTを選んでください。':'');
  return <div className="ai-picker" role="group" aria-label="作成するAIと送る内容">
    <div className="section-label">{design?'内容とデザインを作るAI':'作成するAI'}<span className="optional">複数選べます</span></div>
    <div className="ai-picker-targets">{(Object.keys(targetNames) as AiTarget[]).map(target=><button key={target} type="button" className={`ai-chip ${choice.targets.includes(target)?'selected':''}`} aria-pressed={choice.targets.includes(target)} disabled={disabled||!available[target]} onClick={()=>toggle(target)}>
      <span className="ai-chip-check" aria-hidden="true">{choice.targets.includes(target)?'✓':''}</span>{targetNames[target]}<small>{available[target]?target==='local'?'このPCで処理':'接続済み':target==='local'?'未設定':'未接続'}</small></button>)}</div>
    <label className="field compact ai-scope"><span>外部のAIに送る内容</span><select value={choice.scope} disabled={disabled} onChange={event=>onChange({...choice,scope:event.target.value as SendScope})}>{(Object.keys(scopeNames) as SendScope[]).map(scope=><option key={scope} value={scope}>{scopeNames[scope]}</option>)}</select></label>
    <small className="ai-picker-note">{design?'内容（文章・数値）はこのPCのローカルLLMで作り、選んだClaude・ChatGPTには文字の枠の役割と文字数・グラフと表の形だけを直接送ってデザインを頼みます。':choice.targets.length>1?'選んだAIごとに、同じ構成の案を同時に作ります。並べて比べたり、ページごとに組み合わせたりできます。':'ほかのAIも選ぶと、AIごとの案を並べて比べられます。'}
      {missing.length>0&&<> {missing.map(t=>targetNames[t]).join('・')}は<button type="button" className="text-link" onClick={onSetup}>設定</button>で{missing.includes('local')&&missing.length===1?'登録':'接続・登録'}すると選べます。Geminiなどは手動チャット連携で使えます。</>}</small>
    {designProblem&&<p className="ai-picker-problem" role="alert">{designProblem}</p>}
  </div>;
}
