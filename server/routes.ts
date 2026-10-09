import type {SubscriptionService} from '../shared/contracts.js';
import {APP_VERSION} from '../shared/contracts.js';
import {DOCUMENT_LIMITS,type ParsedDocument} from './document-model.js';
import {AppError} from './errors.js';
import type {SessionEngine} from './engine.js';
import type {SettingsStore} from './settings.js';
import type {ProjectStore} from './projects.js';
import type {AssistService} from './assist.js';
import type {SubscriptionManager} from './subscription.js';

/** JSON API shared by the local Express server and the in-browser build. Each
 * handler receives already-authenticated input; transport concerns (cookies,
 * uploads, files, static assets) stay in the adapters. */
export interface RouteContext {
  engine:SessionEngine; settings:SettingsStore; projects:ProjectStore; assist:AssistService;
  documents:Map<string,{document:ParsedDocument;createdAt:number}>;
  nativeAvailable:()=>boolean|Promise<boolean>;
  subscriptions?:Pick<SubscriptionManager,'status'|'connect'|'refresh'|'disconnect'>;
  hosted?:boolean;
}
export interface RouteRequest {params:Record<string,string>;query:Record<string,unknown>;body:any}
export interface Route {method:'GET'|'POST'|'PUT'|'DELETE';path:string;status?:number;headers?:Record<string,string>;handler:(request:RouteRequest)=>unknown}

function subscriptionService(value:unknown):SubscriptionService {if(value!=='chatgpt'&&value!=='claude')throw new AppError(400,'接続する月額サービスを一覧から選んでください。');return value;}
const query=(value:unknown)=>typeof value==='string'?value:undefined;

export function apiRoutes(ctx:RouteContext):Route[]{
  const {engine,settings,projects,assist}=ctx;
  const subscriptions=()=>{if(!ctx.subscriptions)throw new AppError(501,'このブラウザ版では月額版の自動作成を使えません。PCにローカルアプリを導入すると利用できます。','LOCAL_APP_REQUIRED');return ctx.subscriptions;};
  return [
    {method:'GET',path:'/status',handler:async()=>{const current=settings.get();return {provider:current.provider,model:current.model,hasKey:current.hasKey,nativeAvailable:await ctx.nativeAvailable(),version:APP_VERSION,apiFree:true,...(ctx.hosted?{hosted:true}:{})};}},
    {method:'GET',path:'/projects',handler:()=>({projects:engine.listProjects()})},
    {method:'POST',path:'/projects',status:201,handler:({body})=>engine.createProject(body)},
    {method:'PUT',path:'/projects/:id',handler:({params,body})=>engine.updateProject(params.id,body)},
    {method:'PUT',path:'/projects/:id/template',handler:({params,body})=>engine.setProjectTemplate(params.id,body?.template)},
    {method:'DELETE',path:'/projects/:id/template',handler:({params})=>engine.setProjectTemplate(params.id,null)},
    {method:'GET',path:'/projects/:id/design-pack',headers:{'Content-Disposition':'attachment; filename="Designer-Extention-design-set.json"'},handler:({params})=>engine.exportDesignPack(params.id)},
    {method:'POST',path:'/projects/:id/design-pack',handler:({params,body})=>{if(new TextEncoder().encode(JSON.stringify(body??{})).length>256*1024)throw new AppError(413,'共有用デザイン設定は256 KB以内です。');return engine.importDesignPack(params.id,body);}},
    {method:'GET',path:'/settings',handler:()=>settings.get()},
    {method:'PUT',path:'/settings',handler:({body})=>{if(body?.activeProjectId!==undefined)projects.get(body.activeProjectId);if(ctx.hosted&&body?.provider==='subscription')throw new AppError(501,'このブラウザ版では月額版の自動作成を使えません。手動チャット連携かローカルLLMを選んでください。','LOCAL_APP_REQUIRED');return settings.update(body);}},
    {method:'GET',path:'/subscriptions',handler:()=>ctx.subscriptions?ctx.subscriptions.status():{services:(['chatgpt','claude'] as const).map(service=>({service,state:'unavailable',message:'ブラウザ版では使えません。PCにローカルアプリを導入すると、ログイン済みの月額版で自動作成できます。',accounts:[],models:[],canGenerate:false,canConnect:false}))}},
    {method:'POST',path:'/subscriptions/:service/connect',handler:({params,body})=>subscriptions().connect(subscriptionService(params.service),{accountId:body?.accountId,newAccount:body?.newAccount})},
    {method:'POST',path:'/subscriptions/:service/refresh',handler:({params})=>subscriptions().refresh(subscriptionService(params.service))},
    {method:'POST',path:'/subscriptions/:service/disconnect',handler:({params})=>subscriptions().disconnect(subscriptionService(params.service))},
    {method:'GET',path:'/chat-tasks',handler:()=>engine.listChatTasks()},
    {method:'DELETE',path:'/documents/:id',handler:({params})=>{ctx.documents.delete(params.id);return {ok:true};}},
    {method:'POST',path:'/sessions',handler:({body})=>{
      const ids=body?.documentIds??[];
      if(!Array.isArray(ids)||ids.length>DOCUMENT_LIMITS.files||ids.some((id:unknown)=>typeof id!=='string')||new Set(ids).size!==ids.length)throw new AppError(400,'資料は重複なしで8件まで選択してください。');
      const selected=ids.map((id:string)=>{const item=ctx.documents.get(id);if(!item)throw new AppError(404,'資料が見つかりません。もう一度読み込んでください。');return item.document;});
      return engine.create(body??{},selected);
    }},
    {method:'GET',path:'/sessions/:id',handler:({params})=>engine.get(params.id)},
    {method:'GET',path:'/sessions/:id/resume',handler:({params})=>engine.resume(params.id)},
    {method:'DELETE',path:'/sessions/:id',handler:({params})=>{engine.delete(params.id);return {ok:true};}},
    {method:'GET',path:'/history',handler:({query:q})=>engine.listHistory(query(q.projectId))},
    {method:'GET',path:'/history/:id/versions',handler:({params})=>engine.historyVersions(params.id)},
    {method:'POST',path:'/history/:id/versions/:revision/open',handler:({params})=>engine.restoreHistory(params.id,true,Number(params.revision))},
    {method:'POST',path:'/history/:id/open',handler:({params,body})=>engine.restoreHistory(params.id,body?.duplicate===true)},
    {method:'DELETE',path:'/history/:id',handler:({params})=>engine.removeHistory(params.id)},
    {method:'GET',path:'/designs',handler:({query:q})=>engine.listDesigns(query(q.projectId))},
    {method:'POST',path:'/designs/:id/vote',handler:({params,body})=>engine.voteDesign(params.id,body?.delta??1)},
    {method:'DELETE',path:'/designs/:id',handler:({params})=>engine.removeDesign(params.id)},
    {method:'POST',path:'/sessions/:id/designs',handler:({params,body})=>engine.saveDesign(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/apply-design',handler:({params,body})=>engine.applyDesign(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/save',handler:({params})=>engine.saveHistory(params.id)},
    {method:'POST',path:'/sessions/:id/cloud-consent',handler:({params,body})=>{if(body?.cloudConsent!==true)throw new AppError(400,'送信の同意を確認してください。');return engine.cloudConsent(params.id);}},
    {method:'POST',path:'/sessions/:id/messages',handler:({params,body})=>engine.message(params.id,body?.text)},
    {method:'POST',path:'/sessions/:id/retry-plan',handler:({params})=>engine.retryPlan(params.id)},
    {method:'POST',path:'/sessions/:id/generate',handler:({params,body})=>engine.generate(params.id,body?.outline)},
    {method:'POST',path:'/sessions/:id/revise',handler:({params,body})=>engine.revise(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/retry-revision',handler:({params})=>engine.retryRevision(params.id)},
    {method:'POST',path:'/sessions/:id/chat-response',handler:({params,body})=>engine.chatResponse(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/chat-cancel',handler:({params})=>engine.cancelChat(params.id)},
    {method:'POST',path:'/sessions/:id/variants',handler:({params})=>engine.variants(params.id)},
    {method:'POST',path:'/sessions/:id/theme',handler:({params,body})=>engine.changeTheme(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/layout',handler:({params,body})=>engine.changeLayout(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/chart',handler:({params,body})=>engine.changeChart(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/render',handler:({params,body})=>engine.render(params.id,body?.variantId)},
    {method:'POST',path:'/sessions/:id/open',handler:({params,body})=>engine.open(params.id,body?.variantId)},
    {method:'GET',path:'/sessions/:id/sources',handler:({params,query:q})=>engine.sourceReport(params.id,query(q.variantId))},
    {method:'POST',path:'/sessions/:id/notes',handler:({params,body})=>engine.applyNotes(params.id,body??{})},
    {method:'POST',path:'/sessions/:id/references',handler:({params,body})=>engine.setReferencesSlide(params.id,body??{})},
    {method:'POST',path:'/assist',handler:({body})=>assist.start(body)},
    {method:'POST',path:'/assist/:id/response',handler:({params,body})=>assist.respond(params.id,body?.response)},
    {method:'POST',path:'/assist/:id/render',handler:({params})=>assist.render(params.id)},
    {method:'POST',path:'/feedback',handler:({body})=>{if(!body||typeof body.sessionId!=='string')throw new AppError(400,'評価対象がありません。');return engine.feedback(body);}},
  ];
}

/** Matches "/sessions/:id/open"-style paths. */
export function matchRoute(routes:Route[],method:string,path:string){
  const parts=path.split('/').filter(Boolean);
  for(const route of routes){
    if(route.method!==method)continue;
    const pattern=route.path.split('/').filter(Boolean);
    if(pattern.length!==parts.length)continue;
    const params:Record<string,string>={};
    if(pattern.every((segment,i)=>{if(segment.startsWith(':')){try{params[segment.slice(1)]=decodeURIComponent(parts[i]);}catch{return false;}return true;}return segment===parts[i];}))return {route,params};
  }
  return undefined;
}
