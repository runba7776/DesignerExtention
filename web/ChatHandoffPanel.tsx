import {useCallback,useEffect,useRef,useState} from 'react';
import type {ChatHandoff,ChatService} from '../shared/contracts';
import {Icon} from './ui';
import {appUrlFor,openExternal} from './office';

export const chatServices:Record<ChatService,{name:string;url?:string;projectsUrl?:string}>={
  chatgpt:{name:'ChatGPT',url:'https://chatgpt.com/',projectsUrl:'https://chatgpt.com/'},
  claude:{name:'Claude',url:'https://claude.ai/',projectsUrl:'https://claude.ai/projects'},
  gemini:{name:'Gemini',url:'https://gemini.google.com/'},
  copilot:{name:'Microsoft Copilot',url:'https://copilot.microsoft.com/'},
  other:{name:'その他のAI'},
};
const taskLabels:Record<ChatHandoff['task'],string>={design:'デザインだけを作る（内容は送りません）',plan:'構成を考える',generate:'スライドを作成する',revise:'選んだスライドを修正する',summarize:'文字量を整える','slide-visualize':'選択中のスライドを図解にする','slide-chart':'選択中のスライドをグラフにする','slide-summarize':'選択中のスライドを要約する',rehearsal:'発表の準備をする'};

/** A reply copied from the chat: JSON (optionally in a ```json block). Our own
 * instruction starts with Japanese text, so it is never mistaken for a reply. */
export function looksLikeReply(text:string){
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  if(!cleaned.startsWith('{')||cleaned.length>500_000)return false;
  try{const value=JSON.parse(cleaned);return !!value&&typeof value==='object'&&!Array.isArray(value);}catch{return false;}
}

export function ChatHandoffPanel({handoff,busy,onApply,onCancel,openIn='browser',onUseFull,onSetup,projectReady=false}:{handoff:ChatHandoff;busy:boolean;onApply:(requestId:string,response:string)=>Promise<void>;onCancel:()=>void;openIn?:'browser'|'app';onUseFull?:()=>void;onSetup?:()=>void;projectReady?:boolean}){
  const [response,setResponse]=useState(''),[notice,setNotice]=useState(''),[fileError,setFileError]=useState(''),[clipboardReply,setClipboardReply]=useState('');
  const instructionRef=useRef<HTMLTextAreaElement>(null),instructionDetails=useRef<HTMLDetailsElement>(null),fileRef=useRef<HTMLInputElement>(null),panelRef=useRef<HTMLElement>(null),previousId=useRef(handoff.requestId),awaitingReply=useRef(false);
  const service=chatServices[handoff.service]??chatServices.other;
  const target=handoff.serviceUrl??service.url,inApp=openIn==='app'&&!!target&&!!appUrlFor(target);
  const responseTooLarge=response.length>500_000||new TextEncoder().encode(response).length>800_000;
  useEffect(()=>{
    if(previousId.current!==handoff.requestId){
      if(!handoff.validationIssues?.length)setResponse('');
      setNotice('');setFileError('');setClipboardReply('');previousId.current=handoff.requestId;
    }
    panelRef.current?.scrollIntoView({block:'center',behavior:'auto'});
  },[handoff.requestId,handoff.validationIssues]);

  // Returning to the pane after copying the AI's reply: offer it for import when
  // the browser already allows reading the clipboard (never prompts by itself).
  const checkClipboard=useCallback(async()=>{
    if(!awaitingReply.current||busy)return;
    try{
      const state=await navigator.permissions?.query({name:'clipboard-read' as PermissionName});
      if(state?.state!=='granted')return;
      const text=await navigator.clipboard.readText();
      if(looksLikeReply(text)&&text!==response)setClipboardReply(text);
    }catch{/* Clipboard access is optional; the paste box always works. */}
  },[busy,response]);
  useEffect(()=>{window.addEventListener('focus',checkClipboard);return()=>window.removeEventListener('focus',checkClipboard);},[checkClipboard]);

  async function copy(){
    try{await navigator.clipboard.writeText(handoff.instruction);awaitingReply.current=true;return true;}
    catch{if(instructionDetails.current)instructionDetails.current.open=true;instructionRef.current?.focus();instructionRef.current?.select();setNotice('下の「AIに渡す指示」を選択しました。Ctrl+Cでコピーしてください。');return false;}
  }
  async function copyAndOpen(){
    const copied=await copy();
    if(target){const opened=openExternal(target,inApp);if(copied)setNotice(`指示をコピーし、${service.name}を${opened==='app'?'アプリ':'ブラウザー'}で開きました。チャットに貼り付けて送信し、返答をコピーしてこの画面に戻ってください。`);}
    else if(copied)setNotice('指示をコピーしました。AIのチャットに貼り付けてください。');
  }
  function download(){
    const url=URL.createObjectURL(new Blob([handoff.instruction],{type:'text/plain;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=`Designer-Extention-${handoff.task}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice('指示を保存しました。長い場合はAIのチャットにこのTXTファイルを添付してください。');awaitingReply.current=true;
  }
  async function fromClipboard(){
    setFileError('');
    try{
      const text=await navigator.clipboard.readText();
      if(!text.trim()){setFileError('クリップボードが空です。AIの返答をコピーしてから押してください。');return;}
      if(text===handoff.instruction){setFileError('クリップボードにあるのはAIに渡す指示です。AIの返答をコピーしてから押してください。');return;}
      setResponse(text);setClipboardReply('');
      if(looksLikeReply(text)&&!busy)await onApply(handoff.requestId,text);
      else setNotice('クリップボードの内容を貼り付けました。JSONの形になっているか確認して「返答を取り込む」を押してください。');
    }catch{setFileError('クリップボードを読み取れませんでした。返答を下の欄に貼り付けてください（Ctrl+V）。');}
  }
  async function readFile(file:File|undefined){
    if(!file)return;setFileError('');
    if(!/\.(json|txt)$/i.test(file.name)){setFileError('JSON または TXT ファイルを選んでください。');return;}
    if(file.size>800_000){setFileError('返答ファイルは800KB以下にしてください。');return;}
    try{const text=await file.text();if(text.length>500_000){setFileError('返答は500,000文字以下にしてください。');return;}setResponse(text);setNotice(`「${file.name}」を読み込みました。取り込む前に内容を確認してください。`);}
    catch{setFileError('ファイルを読み込めませんでした。返答を直接貼り付けてください。');}
    finally{if(fileRef.current)fileRef.current.value='';}
  }
  const characters=handoff.instruction.length.toLocaleString();
  return <section ref={panelRef} className="chat-handoff" aria-label="AIチャットとの連携">
    <div className="handoff-heading"><span className="handoff-symbol"><Icon name="message" size={19}/></span><div><h2>{service.name}で{taskLabels[handoff.task]}</h2><p>有料APIの呼び出し：0回</p></div></div>
    <p className="handoff-description">コピーしてAIのチャットに貼る → 返答をコピーしてこの画面に戻る、の1往復です。ログインや送信はご自身のブラウザー（またはアプリ）で行い、利用するAIの契約・上限が適用されます。</p>
    {handoff.privacy?.level==='masked'&&<div className="privacy-check" role="status"><strong>送る内容の確認（伏せ字にして送ります）</strong><ul><li>社名・指定した語・連絡先・数値を、【社名1】【数値1】のような伏せ字に置き換えました：{handoff.privacy.masked??0}件</li><li>伏せた元の語が指示に残っていないことを照合済み：残り <strong>{handoff.privacy.hits}件</strong></li><li>指示の文字数 {handoff.privacy.characters.toLocaleString()}文字 ／ 記録（SHA-256）<code>{handoff.privacy.sha256.slice(0,16)}…</code></li></ul><small>文章の流れや一般的な言葉は送られます。返答の伏せ字は、このPCで元の語と数値に戻します。</small>{!!handoff.privacy.items?.length&&<details className="masked-items"><summary>伏せた語を確認（このPCにだけ表示）</summary><ul>{handoff.privacy.items.map(item=><li key={item.token}><code>{item.token}</code> {item.original}</li>)}</ul></details>}</div>}
    {handoff.privacy&&handoff.privacy.level!=='masked'&&<div className="privacy-check" role="status"><strong>送る内容の確認（内容は送りません）</strong><ul><li>送るもの：文字の枠の役割と文字数（〇・0・xで伏せた見本）、グラフと表の形、色の名前{handoff.privacy.level==='topic'&&handoff.privacy.topic?<>、許可した話題名「{handoff.privacy.topic}」</>:''}</li><li>資料・本文・会話との照合：一致 <strong>{handoff.privacy.hits}件</strong>（照合した文字 {handoff.privacy.checkedCharacters.toLocaleString()}文字）</li><li>指示の文字数 {handoff.privacy.characters.toLocaleString()}文字 ／ 記録（SHA-256）<code>{handoff.privacy.sha256.slice(0,16)}…</code></li></ul><small>送る内容は、下の「AIに渡す指示を確認」に全文が表示されています。資料・文章・数値・ノートは含まれません。返ってきたデザインに、このPCで内容を入れます。</small></div>}
    {handoff.totalSlides!==undefined&&<p className="handoff-progress">検証済みの本文：{handoff.completedSlides??0} / {handoff.totalSlides} 枚{handoff.task==='summarize'?' · はみ出す箇所を調整中':''}</p>}
    {!!handoff.validationIssues?.length&&<div className="handoff-validation" role="alert"><strong>返答を確認し、修正用の指示を用意しました</strong><ul>{handoff.validationIssues.map((issue,index)=><li key={index}>{issue}</li>)}</ul><p>入力した返答と、完成済みのページは保持しています。下の指示をAIへ渡し、修正された返答に置き換えてください。</p></div>}
    <div className="handoff-step"><span className="handoff-number">1</span><div><h3>指示をAIへ渡す</h3>
      <div className="handoff-actions"><button className="button primary small" disabled={busy} onClick={()=>void copyAndOpen()}><Icon name="file" size={13}/>{target?`指示をコピーして${service.name}を開く`:'指示をコピー'}</button><button className="button secondary small" disabled={busy} onClick={()=>void copy().then(ok=>ok&&setNotice('指示をコピーしました。AIのチャットに貼り付けてください。'))}>コピーだけ</button><button className="button secondary small" disabled={busy} onClick={download}><Icon name="download" size={13}/>TXTで保存</button></div>
      {inApp&&target&&<small>アプリが開かない場合は <button className="text-link" onClick={()=>openExternal(target,false)}>ブラウザーで開く</button></small>}
      <p className={`handoff-mode ${handoff.instructionMode==='project'?'project':''}`}>{handoff.instructionMode==='project'?<>AI用プロジェクト向けの短い指示（{characters}文字）。{service.name}のプロジェクト内のチャットに貼ってください。{onUseFull&&<> <button className="text-link" disabled={busy} onClick={onUseFull}>AIがファイルを読めないときは完全版の指示に切り替える</button></>}</>:handoff.projectStale?<>AI用プロジェクトの説明が更新されたため、今回は完全版の指示（{characters}文字）です。{onSetup&&<> <button className="text-link" onClick={onSetup}>AIの準備で説明を貼り直す</button></>}</>:projectReady?<>完全版の指示（{characters}文字）。プロジェクトの外の新しいチャットに貼っても使えます。</>:<>完全版の指示（{characters}文字）。{onSetup&&<><button className="text-link" onClick={onSetup}>AIの準備</button>を一度行うと、指示が短くなります。</>}</>}</p>
      <details ref={instructionDetails} className="handoff-instruction"><summary>AIに渡す指示を確認（{characters}文字）</summary><textarea ref={instructionRef} aria-label="AIに渡す指示" readOnly value={handoff.instruction}/></details><small>{handoff.privacy?.level==='masked'?'この指示の社名・指定した語・連絡先・数値は伏せ字です。':handoff.privacy?'この指示には、資料・文章・数値は含まれません。':'指示には資料から抽出した文章・数値が含まれることがあります。機密資料はローカルLLMで作り、デザインだけを「内容を送らずにデザインだけ頼む」で依頼できます。'}</small></div></div>
    <div className="handoff-step"><span className="handoff-number">2</span><div><label htmlFor="chat-response"><h3>AIの返答を取り込む</h3></label>
      {clipboardReply&&<div className="clipboard-offer" role="status"><span>クリップボードにAIの返答があります。</span><button className="button primary small" disabled={busy} onClick={()=>{const text=clipboardReply;setClipboardReply('');setResponse(text);void onApply(handoff.requestId,text);}}><Icon name="check" size={13}/>取り込む</button></div>}
      <div className="handoff-actions"><button className="button primary small" disabled={busy} onClick={()=>void fromClipboard()}><Icon name="upload" size={13}/>コピーした返答を取り込む</button></div>
      <textarea id="chat-response" className="handoff-response" value={response} onChange={event=>{setResponse(event.target.value);setNotice('');}} disabled={busy} placeholder="または、AIから返ったJSONをここに貼り付けます（コードブロックごと可）。" spellCheck={false}/>{responseTooLarge&&<p className="error-inline" role="alert">返答は500,000文字・800KBまでです。全文は保持しています。今回の指定した範囲のJSONだけを取り込んでください。</p>}
      <div className="handoff-actions"><button className="button secondary small" disabled={busy} onClick={()=>fileRef.current?.click()}><Icon name="upload" size={13}/>返答ファイルを選ぶ</button><input ref={fileRef} type="file" accept=".json,.txt" className="sr-only" tabIndex={-1} onChange={event=>void readFile(event.target.files?.[0])}/><button className="button secondary small" disabled={busy||!response.trim()||responseTooLarge} onClick={()=>void onApply(handoff.requestId,response)}><Icon name="check" size={13}/>返答を取り込む</button></div><small>文章・図形・グラフのデータを検証してから反映します。AI側で生成した画像やPPTXの見た目をそのまま移す機能ではありません。</small></div></div>
    {notice&&<p className="handoff-notice" role="status">{notice}</p>}{fileError&&<p className="error-inline" role="alert">{fileError}</p>}
    <button className="text-link handoff-cancel" disabled={busy} onClick={onCancel}>この連携を取り消す（完成済みの資料は残します）</button>
  </section>;
}
