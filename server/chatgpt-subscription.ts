import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createLocalJWKSet, jwtVerify } from 'jose';
import type { SubscriptionAccount, SubscriptionConnection, SubscriptionModel } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { emptyUsage, OutputLimitError, type Completion, type Provider } from './providers.js';
import { ProtectedCredentialStorage, type CredentialStorage } from './subscription-storage.js';

const ISSUER='https://auth.openai.com';
const RESOURCE='https://api.openai.com/v1';
const SCOPE='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const DOCS='https://developers.openai.com/siwc/token-sharing-open-source';
interface AccountRecord {
  id:string;clientId:string;subject:string;email?:string;name?:string;
  accessToken?:string;refreshToken?:string;idToken?:string;scopes:string[];expiresAt:number;earliestRefreshAt?:number;models:SubscriptionModel[];
}
interface Vault {version:1;hostId:string;accounts:AccountRecord[];activeId?:string}
interface Discovery {issuer:string;authorization_endpoint:string;token_endpoint:string;jwks_uri:string;revocation_endpoint?:string}
interface Attempt {state:string;nonce:string;verifier:string;redirectUri:string;clientId?:string;subject?:string;accountId?:string;expiresAt:number;server:Server;timer:ReturnType<typeof setTimeout>;consumed:boolean;epoch:number}
export interface ChatGptSubscriptionOptions { storage?:CredentialStorage; fetcher?:typeof fetch; openBrowser?:(url:string)=>Promise<void>; now?:()=>number }

/** Official SIWC public-client flow for a locally hosted app. API keys and
 * ChatGPT's private backend endpoints are deliberately not supported. */
export class ChatGptSubscription {
  private vault:Vault={version:1,hostId:`urn:uuid:${randomUUID()}`,accounts:[]};
  private storage:CredentialStorage;private fetcher:typeof fetch;private now:()=>number;
  private pending?:Attempt;private discovery?:Discovery;private refreshPromise?:Promise<void>;
  private message?:string;private failure?:SubscriptionConnection['state'];private generation=randomUUID();private epoch=0;
  private transitioning=false;private vaultQueue:Promise<unknown>=Promise.resolve();
  constructor(directory:string,private options:ChatGptSubscriptionOptions={}){
    this.storage=options.storage??new ProtectedCredentialStorage(directory);this.fetcher=options.fetcher??fetch;this.now=options.now??Date.now;
  }
  async load(){
    try{
      const saved=await this.storage.read();
      if(saved!==undefined){if(!validVault(saved))throw new Error('invalid');this.vault=saved;}
      else await this.storage.write(this.vault);
    }catch{this.failure='error';this.message='保存したログイン情報を読み取れませんでした。新しくログインしてください。';}
    return this;
  }
  private active(){return this.vault.accounts.find(a=>a.id===this.vault.activeId);}
  binding(){const account=this.active();return !this.transitioning&&!this.pending&&account?.accessToken&&account.scopes.includes('chatgpt.tokens.use.direct')?`chatgpt:${account.id}:${this.generation}`:undefined;}
  private atomic<T>(operation:()=>Promise<T>):Promise<T>{const next=this.vaultQueue.then(operation,operation);this.vaultQueue=next.catch(()=>{});return next;}
  async status():Promise<SubscriptionConnection>{
    const active=this.active();
    const permitted=Boolean(active?.accessToken&&active.scopes.includes('chatgpt.tokens.use.direct'));
    const state=this.pending||this.transitioning?'pending':this.failure??(permitted?'connected':active?.accessToken?'permission_required':'disconnected');
    return {service:'chatgpt',state,message:this.pending||this.transitioning?'公式ブラウザーでログインと利用許可を完了してください。完了するとこの画面に反映します。':this.message??(permitted?'ChatGPTに接続しました。選択したアカウントの利用枠で作成します。':active?.accessToken?'ログイン済みですが、ChatGPTプランでAIを利用する許可がありません。もう一度接続して許可してください。':'ChatGPTにログインすると、構成・生成・修正をこの画面から行えます。'),
      ...(active?{account:this.publicAccount(active)}:{}),accounts:this.vault.accounts.map(a=>this.publicAccount(a)),models:active?.models??[],canGenerate:permitted&&!this.pending&&!this.transitioning&&!this.failure,canConnect:true,
      ...(this.pending?{pendingExpiresAt:new Date(this.pending.expiresAt).toISOString()}:{}),documentationUrl:DOCS};
  }
  private publicAccount(a:AccountRecord):SubscriptionAccount{return {id:a.id,label:a.name??a.email??`ChatGPT ${this.vault.accounts.indexOf(a)+1}`,...(a.email?{email:a.email}:{}),active:this.vault.activeId===a.id};}
  async connect(input:{accountId?:unknown;newAccount?:unknown}={}):Promise<SubscriptionConnection>{
    if(input.newAccount!==undefined&&typeof input.newAccount!=='boolean')throw new AppError(400,'アカウントの選び方が正しくありません。');
    if(input.accountId!==undefined&&typeof input.accountId!=='string')throw new AppError(400,'アカウントの識別子が正しくありません。');
    const account=input.newAccount?undefined:input.accountId?this.vault.accounts.find(a=>a.id===input.accountId):this.active();
    if(input.accountId&&!account&&!input.newAccount)throw new AppError(404,'保存したChatGPTアカウントが見つかりません。');
    if(!account&&this.vault.accounts.length>=50)throw new AppError(429,'保存できるChatGPTアカウント数の上限に達しました。保存済みのアカウントを選んでください。','AUTH_ACCOUNT_LIMIT');
    const epoch=++this.epoch;this.cancelPending();this.transitioning=true;
    let discovery:Discovery;try{discovery=await this.getDiscovery();}catch(error){if(epoch===this.epoch){this.transitioning=false;this.setError(error);}return this.status();}
    if(epoch!==this.epoch)return this.status();
    const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
    const server=createServer((req,res)=>{if(req.method!=='GET'){res.writeHead(405);res.end();return;}void this.callback(req.url??'',req.headers.host??'',res);});
    try{await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});}catch(error){server.close();if(epoch===this.epoch){this.transitioning=false;this.setError(error);}return this.status();}
    if(epoch!==this.epoch){server.close();return this.status();}
    const port=(server.address() as {port:number}).port,redirectUri=`http://127.0.0.1:${port}/auth/callback`;
    const timer=setTimeout(()=>{if(this.pending?.state===state){this.cancelPending();this.failure='error';this.message='ログインの待機時間が過ぎました。もう一度接続してください。';}},5*60*1000);timer.unref();
    this.pending={state,nonce,verifier,redirectUri,...(account?{clientId:account.clientId,subject:account.subject,accountId:account.id}:{}),expiresAt:this.now()+5*60*1000,server,timer,consumed:false,epoch:this.epoch};
    this.transitioning=false;
    const url=new URL(discovery.authorization_endpoint);
    for(const [key,value] of Object.entries({client_id:account?.clientId??'dynamic_agent_client',response_type:'code',redirect_uri:redirectUri,scope:SCOPE,resource:RESOURCE,state,nonce,ext_agent_host_id:this.vault.hostId,code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url')}))url.searchParams.set(key,value);
    if(!account)url.searchParams.set('agent_name_hint','Designer Extention');
    else if(account.email)url.searchParams.set('login_hint',account.email);
    // No id_token_hint is put on the command line or exposed to the browser UI.
    if(account?.accessToken&&!account.scopes.includes('chatgpt.tokens.use.direct'))url.searchParams.set('prompt','consent');
    try{await (this.options.openBrowser??openOfficialBrowser)(url.toString());}catch{if(epoch===this.epoch){this.cancelPending();this.failure='error';this.message='公式ログイン画面を開けませんでした。既定のブラウザーを確認して、もう一度接続してください。';}}
    return this.status();
  }
  private async callback(rawUrl:string,host:string,res:import('node:http').ServerResponse){
    const attempt=this.pending;
    const finish=(status:number,message:string)=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"});res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Designer Extention</title><body style="font-family:system-ui;margin:3rem"><h1>Designer Extention</h1><p>${message}</p><p>このタブを閉じて、アドインの画面に戻ってください。</p></body></html>`);};
    if(!attempt){finish(400,'有効なログイン操作がありません。');return;}
    let url:URL;try{url=new URL(rawUrl,attempt.redirectUri);}catch{finish(400,'ログインの応答を確認できません。');return;}
    if(host!==new URL(attempt.redirectUri).host||url.pathname!=='/auth/callback'||url.searchParams.getAll('state').length!==1||!constantEqual(url.searchParams.get('state')??'',attempt.state)||attempt.consumed||attempt.expiresAt<this.now()){finish(400,'ログインの応答が今回の操作と一致しません。もう一度アドインから接続してください。');return;}
    attempt.consumed=true;
    try{
      if(url.searchParams.has('error'))throw new AppError(400,'ログインまたは利用許可が取り消されました。','AUTH_DENIED');
      const clientId=attempt.clientId??url.searchParams.get('client_id');
      if(!clientId||!/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId)||url.searchParams.getAll('client_id').length>1||(attempt.clientId&&url.searchParams.has('client_id')&&url.searchParams.get('client_id')!==attempt.clientId))throw new AppError(400,'アプリの登録情報を確認できません。もう一度接続してください。','AUTH_CLIENT');
      const code=url.searchParams.get('code');if(!code||code.length>10000||url.searchParams.getAll('code').length!==1)throw new AppError(400,'ログインの認証コードを取得できません。','AUTH_CODE');
      const data=await this.exchange({grant_type:'authorization_code',client_id:clientId,code,code_verifier:attempt.verifier,redirect_uri:attempt.redirectUri,resource:RESOURCE});
      if(typeof data.id_token!=='string')throw new AppError(400,'ChatGPTのアカウント情報を検証できません。','AUTH_IDENTITY');
      const discovery=await this.getDiscovery(),jwks=await this.json(discovery.jwks_uri);
      const {payload}=await jwtVerify(data.id_token,createLocalJWKSet(jwks),{issuer:ISSUER,audience:clientId,algorithms:['RS256','ES256'],requiredClaims:['iss','sub','aud','exp','iat'],currentDate:new Date(this.now()),clockTolerance:10});
      if(typeof payload.sub!=='string'||payload.sub.length>500||payload.nonce!==attempt.nonce||(attempt.subject&&payload.sub!==attempt.subject))throw new AppError(400,'選択したアカウントとログイン結果が一致しません。','AUTH_IDENTITY');
      if(payload.azp!==undefined&&payload.azp!==clientId||Array.isArray(payload.aud)&&payload.aud.length>1&&payload.azp!==clientId)throw new AppError(400,'ログイン結果の対象アプリを確認できません。','AUTH_IDENTITY');
      if(this.pending!==attempt||this.epoch!==attempt.epoch)throw new AppError(409,'このログイン操作は取り消されています。','AUTH_CANCELLED');
      const existing=attempt.accountId?this.vault.accounts.find(a=>a.id===attempt.accountId):this.vault.accounts.find(a=>a.clientId===clientId&&a.subject===payload.sub);
      const account:AccountRecord={id:existing?.id??randomUUID(),clientId,subject:payload.sub,...(typeof payload.email==='string'?{email:payload.email.slice(0,300)}:{}),...(typeof payload.name==='string'?{name:payload.name.slice(0,150)}:{}),...tokenFields(data,this.now()),models:[]};
      const next:Vault={...this.vault,activeId:account.id,accounts:[...this.vault.accounts.filter(a=>a.id!==account.id),account]};
      await this.atomic(async()=>{
        if(this.pending!==attempt||this.epoch!==attempt.epoch)throw new AppError(409,'このログイン操作は取り消されています。','AUTH_CANCELLED');
        await this.storage.write(next);
        if(this.pending!==attempt||this.epoch!==attempt.epoch)throw new AppError(409,'このログイン操作は取り消されています。','AUTH_CANCELLED');
        this.vault=next;this.generation=randomUUID();this.failure=undefined;this.message=undefined;
      });
      if(account.scopes.includes('chatgpt.tokens.use.direct')){try{await this.loadModels(account);}catch(error){this.setError(error);}}
      finish(200,account.scopes.includes('chatgpt.tokens.use.direct')?'ChatGPTとの接続が完了しました。':'ログインは完了しました。AIの利用にはChatGPTプランを使う許可が必要です。');
    }catch(error){if(this.epoch===attempt.epoch)this.setError(error);finish(400,'ログインを完了できませんでした。アドインの接続欄で状況を確認してください。');}
    finally{if(this.pending===attempt)this.cancelPending();else{clearTimeout(attempt.timer);attempt.server.close();}}
  }
  async refresh():Promise<SubscriptionConnection>{
    if(this.pending||this.transitioning)return this.status();
    const account=this.active();if(!account?.accessToken)return this.status();
    this.failure=undefined;this.message=undefined;
    try{await this.ensureAccess(account);if(account.scopes.includes('chatgpt.tokens.use.direct'))await this.loadModels(account);}catch(error){this.setError(error);}
    return this.status();
  }
  async disconnect():Promise<SubscriptionConnection>{
    this.epoch++;this.cancelPending();this.transitioning=false;const account=this.active();this.generation=randomUUID();
    const refreshToken=account?.refreshToken,clientId=account?.clientId;
    if(account){delete account.accessToken;delete account.refreshToken;delete account.idToken;account.scopes=[];account.expiresAt=0;account.models=[];}
    this.failure=undefined;this.message='このPCのChatGPT接続を解除しています。';
    await this.atomic(()=>this.storage.write(this.vault));
    let revoked=true;
    if(refreshToken&&clientId){try{const discovery=await this.getDiscovery();if(!discovery.revocation_endpoint)throw new Error('missing');const response=await this.fetcher(discovery.revocation_endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:refreshToken,token_type_hint:'refresh_token',client_id:clientId})});revoked=response.ok;await response.body?.cancel();}catch{revoked=false;}}
    this.failure=undefined;this.message=revoked?'ChatGPTとの接続を解除しました。':'このPCの接続を解除しました。サービス側の解除を確認できなかったため、ChatGPTの設定からも接続を解除してください。';
    return this.status();
  }
  provider(model:string):Provider{
    const binding=this.binding();
    return {complete:async request=>{
      const account=this.active();
      if(!binding||!account||this.binding()!==binding||this.pending)throw new AppError(409,'ChatGPTの接続が変更されています。接続を確認して、新しく作成するか履歴を開き直してください。','SUBSCRIPTION_CONNECTION_CHANGED');
      try{
        await this.ensureAccess(account);
        if(!account.scopes.includes('chatgpt.tokens.use.direct'))throw new AppError(403,'ChatGPTプランでAIを利用する許可が必要です。接続欄から許可してください。','SUBSCRIPTION_PERMISSION');
        if(!account.models.length)await this.loadModels(account);
        const selected=model==='auto'?account.models[0]?.id:model;
        if(!selected||!account.models.some(m=>m.id===selected))throw new AppError(400,'選択したモデルをこのChatGPTアカウントで利用できません。接続欄でモデルを更新してください。','SUBSCRIPTION_MODEL');
        if(this.binding()!==binding)throw new AppError(409,'ChatGPTの接続が変更されています。','SUBSCRIPTION_CONNECTION_CHANGED');
        const response=await this.fetcher(`${RESOURCE}/responses`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),headers:{'Content-Type':'application/json',Authorization:`Bearer ${account.accessToken}`},body:JSON.stringify({model:selected,instructions:request.system,input:[{role:'user',content:request.content}],store:false,stream:true})});
        if(!response.ok)throw await this.remoteError(response);
        const completed=await readCompletion(response);
        if(this.binding()!==binding)throw new AppError(409,'接続を変更したため、前のアカウントの返答は反映していません。','SUBSCRIPTION_CONNECTION_CHANGED');
        return completed;
      }catch(error){if(!(error instanceof OutputLimitError))this.setError(error);throw safeError(error);}
    }};
  }
  private async ensureAccess(account:AccountRecord){
    if(account.expiresAt>this.now()+60000)return;
    if(account.earliestRefreshAt&&this.now()<account.earliestRefreshAt){if(account.expiresAt>this.now())return;throw new AppError(503,'ChatGPTの認証をまだ更新できません。少し時間をおいて接続を確認してください。','AUTH_REFRESH_WAIT');}
    if(!account.refreshToken)throw new AppError(401,'ChatGPTにもう一度ログインしてください。','SUBSCRIPTION_AUTH_REQUIRED');
    if(this.refreshPromise){await this.refreshPromise;return;}
    const epoch=this.epoch;
    this.refreshPromise=(async()=>{
      try{
        const data=await this.exchange({grant_type:'refresh_token',client_id:account.clientId,refresh_token:account.refreshToken!,resource:RESOURCE});
        if(epoch!==this.epoch||this.active()!==account)throw new AppError(409,'接続が変更されたため認証の更新を取り消しました。','SUBSCRIPTION_CONNECTION_CHANGED');
        const fields=tokenFields({...data,scope:data.scope??account.scopes.join(' ')},this.now());
        if(!data.refresh_token)fields.refreshToken=account.refreshToken;
        if(!data.id_token)fields.idToken=account.idToken;
        await this.atomic(async()=>{if(epoch!==this.epoch||this.active()!==account)throw new AppError(409,'接続が変更されています。','SUBSCRIPTION_CONNECTION_CHANGED');Object.assign(account,fields);await this.storage.write(this.vault);});
      }catch(error){if(error instanceof AppError&&error.code==='AUTH_TOKEN_EXPIRED'&&epoch===this.epoch){await this.atomic(async()=>{if(epoch!==this.epoch)return;delete account.accessToken;delete account.refreshToken;delete account.idToken;account.scopes=[];await this.storage.write(this.vault);});}throw error;}
    })();
    try{await this.refreshPromise;}finally{this.refreshPromise=undefined;}
  }
  private async loadModels(account:AccountRecord){
    const epoch=this.epoch;
    const response=await this.fetcher(`${RESOURCE}/models`,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${account.accessToken}`}});
    if(!response.ok)throw await this.remoteError(response);
    const data=await boundedJson(response);
    if(!Array.isArray(data.models))throw new AppError(502,'ChatGPTから利用できるモデルの一覧を取得できませんでした。','SUBSCRIPTION_MODELS');
    const models=data.models.filter((m:any)=>m.visibility==='list'&&typeof m.slug==='string'&&/^[\w.\-/:]{1,140}$/.test(m.slug)&&typeof m.display_name==='string').slice(0,100).map((m:any)=>({id:m.slug,name:m.display_name.slice(0,150)}));
    if(epoch!==this.epoch||this.active()!==account)throw new AppError(409,'モデル取得中に接続が変更されました。','SUBSCRIPTION_CONNECTION_CHANGED');
    if(!models.length)throw new AppError(403,'このChatGPTアカウントで利用できるモデルがありません。プランとアプリの利用許可を確認してください。','SUBSCRIPTION_PERMISSION');
    await this.atomic(async()=>{if(epoch!==this.epoch||this.active()!==account)throw new AppError(409,'接続が変更されています。','SUBSCRIPTION_CONNECTION_CHANGED');account.models=models;await this.storage.write(this.vault);});
  }
  private async getDiscovery():Promise<Discovery>{
    if(this.discovery)return this.discovery;
    const value=await this.json(`${ISSUER}/.well-known/openid-configuration`);
    if(value.issuer!==ISSUER||value.authorization_endpoint!==`${ISSUER}/api/accounts/authorize`||value.token_endpoint!==`${ISSUER}/api/accounts/oauth/token`||!officialEndpoint(value.jwks_uri)||value.revocation_endpoint&&!officialEndpoint(value.revocation_endpoint))throw new AppError(502,'公式ログインの接続情報を確認できませんでした。','AUTH_DISCOVERY');
    return this.discovery=value;
  }
  private async json(url:string){const response=await this.fetcher(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok){await response.body?.cancel();throw new AppError(502,'公式ログインサービスに接続できませんでした。','AUTH_CONNECTION');}return boundedJson(response);}
  private async exchange(parameters:Record<string,string>){
    const discovery=await this.getDiscovery();
    const response=await this.fetcher(discovery.token_endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(parameters)});
    if(!response.ok){let code='';try{const data=await boundedJson(response);code=typeof data.error==='string'?data.error:data.error?.code??'';}catch{}
      const expired=['invalid_grant','invalid_refresh_token','token_expired','refresh_token_expired','refresh_token_invalidated','refresh_token_reused'].includes(code);
      throw new AppError(401,'ChatGPTの認証を更新できませんでした。もう一度ログインしてください。',expired?'AUTH_TOKEN_EXPIRED':'AUTH_EXCHANGE');}
    return boundedJson(response);
  }
  private async remoteError(response:Response){let code='';try{const data=await boundedJson(response);code=typeof data.error?.code==='string'?data.error.code:'';}catch{}
    return providerError(response.status,code);
  }
  private setError(error:unknown){const e=safeError(error);this.message=e.message;this.failure=e.code==='SUBSCRIPTION_LIMIT'?'limited':e.code==='SUBSCRIPTION_PERMISSION'?'permission_required':'error';}
  private cancelPending(){if(this.pending){clearTimeout(this.pending.timer);this.pending.server.close();this.pending=undefined;}}
  dispose(){this.epoch++;this.cancelPending();}
}

function tokenFields(data:any,now:number){
  if(typeof data.access_token!=='string'||data.access_token.length>100000||!data.access_token||typeof data.scope!=='string'||typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0||data.expires_in>86400||data.token_type?.toLowerCase()!=='bearer')throw new AppError(502,'ChatGPTの認証結果を確認できませんでした。','AUTH_TOKEN');
  return {accessToken:data.access_token,...(typeof data.refresh_token==='string'?{refreshToken:data.refresh_token}:{}),...(typeof data.id_token==='string'?{idToken:data.id_token}:{}),scopes:data.scope.split(/\s+/).filter(Boolean),expiresAt:now+data.expires_in*1000,...(typeof data.earliest_refresh_at==='number'&&Number.isFinite(data.earliest_refresh_at)?{earliestRefreshAt:data.earliest_refresh_at<1e12?data.earliest_refresh_at*1000:data.earliest_refresh_at}: {})};
}
function officialEndpoint(value:unknown){try{const url=new URL(String(value));return url.origin===ISSUER&&!url.username&&!url.password&&!url.hash&&!url.search;}catch{return false;}}
function validVault(value:any):value is Vault{
  return value?.version===1&&/^urn:uuid:[a-f0-9-]{36}$/.test(value.hostId)&&Array.isArray(value.accounts)&&value.accounts.length<=50&&value.accounts.every((a:any)=>typeof a.id==='string'&&typeof a.subject==='string'&&typeof a.clientId==='string'&&a.clientId.startsWith('oaiapp_')&&Array.isArray(a.scopes)&&a.scopes.every((s:any)=>typeof s==='string')&&Number.isFinite(a.expiresAt)&&Array.isArray(a.models)&&a.models.every((m:any)=>typeof m.id==='string'&&typeof m.name==='string')&&[a.accessToken,a.refreshToken,a.idToken,a.email,a.name].every(v=>v===undefined||typeof v==='string'));
}
function constantEqual(a:string,b:string){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
function safeError(error:unknown){return error instanceof AppError?error:new AppError(502,'ChatGPTとの通信を完了できませんでした。接続を確認してください。有料APIへの切り替えは行っていません。','SUBSCRIPTION_CONNECTION');}
function providerError(status:number,code:string){
  if(status===429||code==='subscription_sharing_usage_limit_exceeded')return new AppError(429,'ChatGPTのアプリ利用枠に達しました。ChatGPTの設定で利用状況を確認してください。自動再試行や有料APIへの切り替えは行っていません。','SUBSCRIPTION_LIMIT');
  if(status===401)return new AppError(401,'ChatGPTの接続を確認し、もう一度ログインしてください。','SUBSCRIPTION_AUTH_REQUIRED');
  if(status===403)return new AppError(403,'このアカウント・プラン・地域では、アプリからChatGPTを利用する許可が確認できませんでした。接続設定を確認してください。','SUBSCRIPTION_PERMISSION');
  return new AppError(502,`ChatGPTとの通信を完了できませんでした（HTTP ${status}）。少し時間をおいて接続を確認してください。`,'SUBSCRIPTION_RESPONSE');
}
async function boundedJson(response:Response){const text=await boundedText(response,1024*1024);try{return JSON.parse(text);}catch{throw new AppError(502,'公式サービスの応答を読み取れませんでした。','SUBSCRIPTION_RESPONSE');}}
async function boundedText(response:Response,max:number){
  if(!response.body)throw new AppError(502,'応答が空です。','SUBSCRIPTION_RESPONSE');
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>max)throw new AppError(502,'公式サービスの応答が大きすぎます。','SUBSCRIPTION_RESPONSE');chunks.push(value);}return Buffer.concat(chunks).toString('utf8');}catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export async function readCompletion(response:Response):Promise<Completion>{
  if(!response.body)throw new AppError(502,'ChatGPTの応答が空です。','SUBSCRIPTION_STREAM');
  const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',text='',bytes=0,done=false;const usage=emptyUsage();usage.calls=1;
  const processEvent=(frame:string)=>{
    const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data||data==='[DONE]')return;
    let event:any;try{event=JSON.parse(data);}catch{throw new AppError(502,'ChatGPTの途中応答を読み取れませんでした。','SUBSCRIPTION_STREAM');}
    if(event.type==='response.output_text.delta'&&typeof event.delta==='string')text+=event.delta;
    if(event.response?.usage){usage.inputTokens=nonnegative(event.response.usage.input_tokens);usage.outputTokens=nonnegative(event.response.usage.output_tokens);usage.cacheReadTokens=nonnegative(event.response.usage.input_tokens_details?.cached_tokens);}
    if(event.type==='response.failed'||event.type==='error'){const code=event.response?.error?.code??event.error?.code??event.code;throw Object.assign(providerError(code==='subscription_sharing_usage_limit_exceeded'?429:code==='subscription_sharing_user_not_eligible'?403:502,code),{usage});}
    if(event.type==='response.incomplete'){if(event.response?.incomplete_details?.reason==='max_output_tokens')throw new OutputLimitError(usage,text);throw Object.assign(new AppError(422,'ChatGPTの返答が途中終了しました。完成した返答としては取り込んでいません。','SUBSCRIPTION_INCOMPLETE'),{usage});}
    if(event.type==='response.completed'){
      if(event.response?.status&&event.response.status!=='completed')throw new AppError(502,'ChatGPTの完了状態を確認できませんでした。','SUBSCRIPTION_STREAM');
      const finalText=event.response?.output?.filter((o:any)=>o.type==='message').flatMap((o:any)=>o.content??[]).filter((c:any)=>c.type==='output_text').map((c:any)=>c.text).join('');
      if(typeof finalText==='string'&&finalText)text=finalText;done=true;
    }
    if(text.length>500000)throw new AppError(502,'ChatGPTの返答が大きすぎます。','SUBSCRIPTION_STREAM');
  };
  try{
    while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>4*1024*1024)throw new AppError(502,'ChatGPTの途中応答が大きすぎます。','SUBSCRIPTION_STREAM');pending=(pending+decoder.decode(chunk.value,{stream:true})).replace(/\r\n/g,'\n');let boundary:number;while((boundary=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,boundary);pending=pending.slice(boundary+2);processEvent(frame);}if(done){await reader.cancel();break;}}
    pending+=decoder.decode();if(pending.trim())processEvent(pending);
    if(!done)throw Object.assign(new AppError(502,'ChatGPTの通信が完了前に切れました。途中の返答は取り込んでいません。','SUBSCRIPTION_STREAM'),{usage});
    if(!text.trim())throw Object.assign(new AppError(422,'ChatGPTから文章を取得できませんでした。','SUBSCRIPTION_EMPTY'),{usage});
    return {text,usage};
  }catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
const nonnegative=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0?v:0;
export async function openOfficialBrowser(url:string){
  const parsed=new URL(url);if(parsed.origin!==ISSUER)throw new AppError(400,'公式ログイン先以外は開けません。');
  if(process.platform!=='win32')throw new AppError(400,'Windowsの既定ブラウザーでログインしてください。');
  await new Promise<void>((resolve,reject)=>{const child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
}
