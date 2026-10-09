import {useEffect,useRef,useState} from 'react';
import type {ChatHandoff,ChatService} from '../shared/contracts';
import {Icon} from './ui';

export const chatServices:Record<ChatService,{name:string;url?:string}>={
  chatgpt:{name:'ChatGPT',url:'https://chatgpt.com/'},
  claude:{name:'Claude',url:'https://claude.ai/'},
  gemini:{name:'Gemini',url:'https://gemini.google.com/'},
  copilot:{name:'Microsoft Copilot',url:'https://copilot.microsoft.com/'},
  other:{name:'その他のAI'},
};
const taskLabels:Record<ChatHandoff['task'],string>={plan:'構成を考える',generate:'スライドを作成する',revise:'選んだスライドを修正する',summarize:'文字量を整える','slide-visualize':'選択中のスライドを図解にする','slide-chart':'選択中のスライドをグラフにする','slide-summarize':'選択中のスライドを要約する',rehearsal:'発表の準備をする'};

export function ChatHandoffPanel({handoff,busy,onApply,onCancel}:{handoff:ChatHandoff;busy:boolean;onApply:(requestId:string,response:string)=>Promise<void>;onCancel:()=>void}){
  const [response,setResponse]=useState(''),[notice,setNotice]=useState(''),[fileError,setFileError]=useState('');
  const instructionRef=useRef<HTMLTextAreaElement>(null),instructionDetails=useRef<HTMLDetailsElement>(null),fileRef=useRef<HTMLInputElement>(null),panelRef=useRef<HTMLElement>(null),previousId=useRef(handoff.requestId);
  const service=chatServices[handoff.service]??chatServices.other;
  const responseTooLarge=response.length>500_000||new TextEncoder().encode(response).length>800_000;
  useEffect(()=>{
    if(previousId.current!==handoff.requestId){
      if(!handoff.validationIssues?.length)setResponse('');
      setNotice('');setFileError('');previousId.current=handoff.requestId;
    }
    panelRef.current?.scrollIntoView({block:'center',behavior:'auto'});
  },[handoff.requestId,handoff.validationIssues]);
  async function copy(){
    try{await navigator.clipboard.writeText(handoff.instruction);setNotice('指示をコピーしました。AIのチャットに貼り付けてください。');}
    catch{if(instructionDetails.current)instructionDetails.current.open=true;instructionRef.current?.focus();instructionRef.current?.select();setNotice('下の「AIに渡す指示」を選択しました。Ctrl+Cでコピーしてください。');}
  }
  function download(){
    const url=URL.createObjectURL(new Blob([handoff.instruction],{type:'text/plain;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download=`Designer-Extention-${handoff.task}.txt`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice('指示を保存しました。長い場合はAIのチャットにこのTXTファイルを添付してください。');
  }
  async function readFile(file:File|undefined){
    if(!file)return;setFileError('');
    if(!/\.(json|txt)$/i.test(file.name)){setFileError('JSON または TXT ファイルを選んでください。');return;}
    if(file.size>800_000){setFileError('返答ファイルは800KB以下にしてください。');return;}
    try{const text=await file.text();if(text.length>500_000){setFileError('返答は500,000文字以下にしてください。');return;}setResponse(text);setNotice(`「${file.name}」を読み込みました。取り込む前に内容を確認してください。`);}
    catch{setFileError('ファイルを読み込めませんでした。返答を直接貼り付けてください。');}
    finally{if(fileRef.current)fileRef.current.value='';}
  }
  return <section ref={panelRef} className="chat-handoff" aria-label="AIチャットとの連携">
    <div className="handoff-heading"><span className="handoff-symbol"><Icon name="message" size={19}/></span><div><h2>{service.name}で{taskLabels[handoff.task]}</h2><p>有料APIの呼び出し：0回</p></div></div>
    <p className="handoff-description">コピー → AIのチャットで実行 → 返答を取り込む、の順で進めます。月額契約への自動ログインや送信は行いません。利用するAIの契約・上限が適用されます。</p>
    {handoff.totalSlides!==undefined&&<p className="handoff-progress">検証済みの本文：{handoff.completedSlides??0} / {handoff.totalSlides} 枚{handoff.task==='summarize'?' · はみ出す箇所を調整中':''}</p>}
    {!!handoff.validationIssues?.length&&<div className="handoff-validation" role="alert"><strong>返答を確認し、修正用の指示を用意しました</strong><ul>{handoff.validationIssues.map((issue,index)=><li key={index}>{issue}</li>)}</ul><p>入力した返答と、完成済みのページは保持しています。下の指示をAIへ渡し、修正された返答に置き換えてください。</p></div>}
    <div className="handoff-step"><span className="handoff-number">1</span><div><h3>指示をAIへ渡す</h3><div className="handoff-actions"><button className="button primary small" disabled={busy} onClick={()=>void copy()}><Icon name="file" size={13}/>指示をコピー</button><button className="button secondary small" disabled={busy} onClick={download}><Icon name="download" size={13}/>TXTで保存</button>{service.url&&<a className="button secondary small" href={service.url} target="_blank" rel="noopener noreferrer">{service.name}を開く<Icon name="arrow" size={12}/></a>}</div><details ref={instructionDetails} className="handoff-instruction"><summary>AIに渡す指示を確認（{handoff.instruction.length.toLocaleString()}文字）</summary><textarea ref={instructionRef} aria-label="AIに渡す指示" readOnly value={handoff.instruction}/></details><small>指示には資料から抽出した文章・数値が含まれることがあります。機密資料にはローカルLLMを選んでください。</small></div></div>
    <div className="handoff-step"><span className="handoff-number">2</span><div><label htmlFor="chat-response"><h3>AIの返答を取り込む</h3></label><textarea id="chat-response" className="handoff-response" value={response} onChange={event=>{setResponse(event.target.value);setNotice('');}} disabled={busy} placeholder="AIから返ったJSONを、コードブロックごと貼り付けられます。" spellCheck={false}/>{responseTooLarge&&<p className="error-inline" role="alert">返答は500,000文字・800KBまでです。全文は保持しています。今回の指定した範囲のJSONだけを取り込んでください。</p>}<div className="handoff-actions"><button className="button secondary small" disabled={busy} onClick={()=>fileRef.current?.click()}><Icon name="upload" size={13}/>返答ファイルを選ぶ</button><input ref={fileRef} type="file" accept=".json,.txt" className="sr-only" tabIndex={-1} onChange={event=>void readFile(event.target.files?.[0])}/><button className="button primary small" disabled={busy||!response.trim()||responseTooLarge} onClick={()=>void onApply(handoff.requestId,response)}><Icon name="check" size={13}/>返答を取り込む</button></div><small>文章・図形・グラフのデータを検証してから反映します。AI側で生成した画像やPPTXの見た目をそのまま移す機能ではありません。</small></div></div>
    {notice&&<p className="handoff-notice" role="status">{notice}</p>}{fileError&&<p className="error-inline" role="alert">{fileError}</p>}
    <button className="text-link handoff-cancel" disabled={busy} onClick={onCancel}>この連携を取り消す（完成済みの資料は残します）</button>
  </section>;
}
