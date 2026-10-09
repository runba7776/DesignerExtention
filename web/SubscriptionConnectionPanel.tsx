import {useEffect,useRef,useState} from 'react';
import type {SubscriptionConnection,SubscriptionService,SubscriptionStatus} from '../shared/contracts';
import {api} from './api';
import {Icon,Spinner} from './ui';

export const subscriptionNames:Record<SubscriptionService,string>={chatgpt:'ChatGPT',claude:'Claude'};
const connectionLabels:Record<SubscriptionConnection['state'],string>={disconnected:'未接続',pending:'ブラウザーで認証待ち',connected:'接続済み',permission_required:'利用権限を確認してください',limited:'利用上限に達しています',unavailable:'利用準備が必要です',error:'接続を確認してください'};
function safeDocumentationUrl(value:string|undefined):string|undefined{
  if(!value)return undefined;
  try{const url=new URL(value);if(url.protocol==='https:'&&['chatgpt.com','auth.openai.com','help.openai.com','developers.openai.com','code.claude.com','support.claude.com','docs.anthropic.com'].includes(url.hostname))return url.href;}catch{/* Only official help links are opened from this panel. */}
  return undefined;
}

export function SubscriptionConnectionPanel({service,model,locked,saving,onServiceChange,onModelChange}:{service:SubscriptionService;model:string;locked:boolean;saving:boolean;onServiceChange:(value:SubscriptionService)=>void;onModelChange:(value:string)=>void}){
  const [connections,setConnections]=useState<SubscriptionConnection[]>([]),[loading,setLoading]=useState(true),[working,setWorking]=useState(''),[error,setError]=useState(''),[accountChoice,setAccountChoice]=useState('');
  const operation=useRef<AbortController>(),epoch=useRef(0);
  const current=connections.find(connection=>connection.service===service);
  const disabled=saving||!!working||loading;
  const documentationUrl=safeDocumentationUrl(current?.documentationUrl);

  useEffect(()=>{
    const controller=new AbortController(),generation=++epoch.current;
    setLoading(true);setError('');setAccountChoice('');
    api<SubscriptionStatus>('/subscriptions',{signal:controller.signal}).then(status=>{if(generation===epoch.current){setConnections(status.services);setLoading(false);}}).catch(e=>{if(e.name!=='AbortError'&&generation===epoch.current){setError(e.message);setLoading(false);}});
    return()=>{controller.abort();epoch.current++;};
  },[service]);
  useEffect(()=>()=>{operation.current?.abort();},[]);
  useEffect(()=>{if(current?.state==='connected')setAccountChoice(previous=>previous==='new-account'?'':previous);},[current?.state,current?.account?.id]);
  useEffect(()=>{
    if(service==='claude'){if(model!=='auto')onModelChange('auto');return;}
    if(current?.models.length&&!current.models.some(value=>value.id===model))onModelChange(current.models[0].id);
  },[service,model,current?.models,onModelChange]);
  useEffect(()=>{
    if(current?.state!=='pending'||working||saving)return;
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const controller=new AbortController(),generation=epoch.current;
    async function refresh(){
      try{const status=await api<SubscriptionStatus>('/subscriptions',{signal:controller.signal});if(!stopped&&generation===epoch.current)setConnections(status.services);}
      catch{/* The manual refresh button remains available when a status request fails temporarily. */}
      finally{if(!stopped&&generation===epoch.current)timer=setTimeout(()=>void refresh(),3000);}
    }
    timer=setTimeout(()=>void refresh(),3000);
    return()=>{stopped=true;controller.abort();if(timer!==undefined)clearTimeout(timer);};
  },[service,current?.state,working,saving]);

  async function act(action:'connect'|'refresh'|'disconnect'){
    if(operation.current)return;
    const controller=new AbortController();operation.current=controller;const generation=++epoch.current;
    setWorking(action);setError('');
    try{
      const selected=accountChoice||current?.account?.id;
      const body=action==='connect'?selected==='new-account'?{newAccount:true}:selected?{accountId:selected}:{}:{};
      await api(`/subscriptions/${service}/${action}`,{method:'POST',body:JSON.stringify(body),signal:controller.signal});
      const status=await api<SubscriptionStatus>('/subscriptions',{signal:controller.signal});
      if(generation===epoch.current){setConnections(status.services);if(action==='disconnect')setAccountChoice('');}
    }catch(e){if(e instanceof Error&&e.name!=='AbortError'&&generation===epoch.current)setError(e.message);}
    finally{if(operation.current===controller){operation.current=undefined;setWorking('');}}
  }
  const selectedAccount=accountChoice||current?.account?.id||'';
  const changingSavedAccount=!!selectedAccount&&selectedAccount!=='new-account'&&selectedAccount!==current?.account?.id;
  return <section className="subscription-connect" aria-label="月額版AIとの接続">
    <div className="subscription-choice" role="group" aria-label="自動作成に使うAI">{(['chatgpt','claude'] as const).map(id=><button type="button" key={id} aria-pressed={service===id} className={service===id?'selected':''} disabled={locked||disabled} onClick={()=>onServiceChange(id)}>{subscriptionNames[id]}</button>)}</div>
    <p className="subscription-description">一度接続すると、構成・作成・修正をアドイン内で進められます。APIキーは不要です。ご契約の利用権限と上限が適用されます。指示と資料の抽出内容は選んだサービスのクラウドへ送信します。{service==='chatgpt'&&<> ChatGPT接続はOpenAIが利用を認めたアプリが対象で、すべてのアカウントで使えるとは限りません。</>}</p>
    {loading?<p className="subscription-status" role="status"><Spinner/> 接続を確認しています</p>:current?<div className={`subscription-status ${current.state}`} role="status"><span className="subscription-status-dot"/><div><strong>{connectionLabels[current.state]}</strong><p>{current.message}</p>{current.account&&<small>アカウント：{current.account.label}{current.account.email&&current.account.email!==current.account.label?`（${current.account.email}）`:''}</small>}</div></div>:<p className="subscription-description">接続情報を確認できません。接続の確認をお試しください。</p>}
    {service==='chatgpt'&&!!current?.accounts.length&&<label className="field subscription-account"><span>利用するアカウント</span><select value={selectedAccount} disabled={locked||disabled||current.state==='pending'} onChange={event=>setAccountChoice(event.target.value)}>{!selectedAccount&&<option value="">アカウントを選ぶ</option>}{current.accounts.map(account=><option key={account.id} value={account.id}>{account.label}{account.active?' · 接続中':''}</option>)}<option value="new-account">別のアカウントで接続</option></select></label>}
    <div className="subscription-actions"><button className="button primary small" disabled={disabled||!current?.canConnect||current.state==='pending'} onClick={()=>void act('connect')}>{working==='connect'?<Spinner/>:<Icon name="lock" size={14}/>} {changingSavedAccount?'このアカウントを使う':selectedAccount==='new-account'?'別のアカウントで接続':current?.state==='connected'?'再接続':`${subscriptionNames[service]}に接続`}</button><button className="button secondary small" disabled={disabled} onClick={()=>void act('refresh')}>{working==='refresh'?<Spinner/>:<Icon name="reset" size={13}/>} 接続を確認</button>{current&&(current.state==='connected'||current.state==='pending'||current.account)&&<button className="button ghost small" disabled={disabled} onClick={()=>void act('disconnect')}>{working==='disconnect'?'切断しています':'切断'}</button>}</div>
    {current?.state==='pending'&&<p className="subscription-pending">公式ブラウザーで認証を完了して、この画面に戻ってください。接続状態を自動で確認します。{current.pendingExpiresAt&&Number.isFinite(Date.parse(current.pendingExpiresAt))&&<small>認証待ちの期限：{new Date(current.pendingExpiresAt).toLocaleTimeString('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'})}</small>}</p>}
    {error&&<p className="subscription-error" role="alert">{error}</p>}
    {service==='chatgpt'&&<label className="field subscription-model"><span>作成に使うモデル</span><select aria-label="月額版のモデル" value={current?.models.some(value=>value.id===model)?model:''} disabled={locked||disabled||!current?.models.length} onChange={event=>onModelChange(event.target.value)}>{!current?.models.length&&<option value="">接続後に利用できるモデルを表示します</option>}{current?.models.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select><small>接続したアカウントで利用できる候補を表示します。</small></label>}
    <p className="subscription-help">認証は公式のブラウザー画面で行います。パスワードをこのアドインへ入力する必要はありません。{documentationUrl&&<> <a href={documentationUrl} target="_blank" rel="noopener noreferrer">利用条件・接続方法</a></>}</p>
  </section>;
}
