import type { Settings, Usage } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { validateLocalEndpoint } from './settings.js';

export interface CompletionRequest { system: string; content: string; maxTokens: number }
export interface Completion { text: string; usage: Usage }
export interface Provider { complete(request: CompletionRequest): Promise<Completion> }
export const emptyUsage = (): Usage => ({ calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
export class OutputLimitError extends AppError {
  constructor(public usage:Usage,public partialText:string){super(422,'LLMの返答が出力上限で途中終了しました。入力の文字数制限とは別の上限です。','OUTPUT_LIMIT');}
}

/** This factory only calls a private/local inference server. Subscription clients
 * are created by SubscriptionManager after an explicit account connection. */
export function createProvider(settings: Settings, apiKey?: string, fetcher: typeof fetch = fetch): Provider {
  if(settings.provider==='claude')throw new AppError(400,'有料APIは無効です。月額版との連携、またはローカルLLMを選んでください。','PAID_API_DISABLED');
  if(settings.provider==='chat')throw new AppError(400,'月額版との連携は、指示をコピーして返答を取り込みます。自動のAPI呼び出しは行いません。','CHAT_HANDOFF_REQUIRED');
  if(settings.provider==='subscription')throw new AppError(409,'設定から月額サービスに接続してください。有料APIへの切り替えは行いません。','SUBSCRIPTION_CONNECTION_REQUIRED');
  if(settings.provider!=='local')throw new AppError(400,'デモモードはAIを呼び出しません。');
  const base=validateLocalEndpoint(settings.endpoint??'');
  return {
    async complete(request) {
      const url=`${base.replace(/\/chat\/completions$/,'')}/chat/completions`;
      let response:Response;
      try {
        response=await fetcher(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(180_000),headers:{'Content-Type':'application/json',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})},body:JSON.stringify({model:settings.model,temperature:0.25,max_tokens:request.maxTokens,messages:[{role:'system',content:request.system},{role:'user',content:request.content}]})});
      }catch{throw new AppError(502,'ローカルLLMに接続できません。起動状態・接続先・モデル名を確認してください。外部APIへの切り替えは行っていません。','PROVIDER_CONNECTION');}
      if(!response.ok){await response.body?.cancel();const reason=response.status===401||response.status===403?'認証情報を確認してください。':response.status===429?'利用上限または混雑です。少し時間をおいて再操作してください。':response.status===404?'モデル名と接続先を確認してください。':'入力サイズ・モデルの対応状況・サービス状態を確認してください。';throw new AppError(502,`ローカルLLMがエラーを返しました（HTTP ${response.status}）。${reason}`,'PROVIDER_RESPONSE');}
      const raw=await boundedResponse(response);
      let data:any;try{data=JSON.parse(raw);}catch{throw new AppError(502,'LLMの応答がJSONではありません。接続先を確認してください。');}
      const usage=emptyUsage();usage.calls=1;usage.inputTokens=number(data.usage?.prompt_tokens);usage.outputTokens=number(data.usage?.completion_tokens);
      const text=data.choices?.[0]?.message?.content;
      if(typeof text!=='string')throw new AppError(502,'LLMから文章の応答を取得できませんでした。モデルの対応状況を確認してください。');
      if(data.choices?.[0]?.finish_reason==='length')throw new OutputLimitError(usage,text);
      if(data.choices?.[0]?.finish_reason==='model_context_window_exceeded'||data.stop_reason==='model_context_window_exceeded')throw Object.assign(new AppError(422,'資料と会話がモデルの入力枠を使い切りました。対象の章やページを分けてください。','CONTEXT_LIMIT'),{usage});
      return {text,usage};
    }
  };
}

/** The reply's JSON. A model sometimes adds a sentence before or after it, or a
 * fenced block in the middle; the complete JSON object inside is accepted as is
 * (nothing is added or closed). An unreadable reply keeps its text privately so
 * the caller can recover finished pages from it. */
export function parseJsonResponse(text:string):unknown {
  const cleaned=text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  try{return JSON.parse(cleaned);}catch{/* Look for the JSON inside the reply. */}
  const fenced=/```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1],start=text.indexOf('{'),end=text.lastIndexOf('}');
  for(const candidate of [fenced,start>=0&&end>start?text.slice(start,end+1):undefined]){
    if(!candidate)continue;
    try{const value=JSON.parse(candidate);if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{/* Try the next form. */}
  }
  throw Object.assign(new AppError(422,'AIの出力形式が正しくありません。最後まで閉じたJSONを返すよう指示してください。','INVALID_MODEL_JSON'),{partialText:text});
}
const number=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
async function boundedResponse(response:Response){
  if(!response.body)throw new AppError(502,'LLMの応答が空です。');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>4*1024*1024){await reader.cancel();throw new AppError(502,'LLMの応答が大きすぎます。');}chunks.push(value);}
  return Buffer.concat(chunks).toString('utf8');
}
