import { randomUUID } from 'node:crypto';
import { access,appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AiTarget,SendScope,ChartType,ChatService,ChoiceStats,SendRecord,DeckSpec, DeckVariant, DesignEntry, Feedback, Outline, RenderResult, RestoredPresentation, Session, Settings, SlideSpec, SubscriptionService, Usage } from '../shared/contracts.js';
import { documentContext, documentSummary, type ParsedDocument } from './document-model.js';
import { HistoryStore } from './history.js';
import { AppError, requireText } from './errors.js';
import { createProvider, emptyUsage, OutputLimitError,parseJsonResponse, type Provider } from './providers.js';
import { SettingsStore } from './settings.js';
import { aiKitVersion, systemPrompt, type ModelTask } from './prompts.js';
import { validateDeck, validateDesignReply, validateOutline, validatePlanResponse, validateSlide, validateTheme, validateTypography } from './validation.js';
import type {HtmlLayout,HtmlPageLayout} from './html-layout.js';
import { demoDeck, demoOutline, DEMO_WARNING } from './demo.js';
import { FREE_CHAT_BATCH_SIZE, FREE_GENERATION_BATCH_SIZE, CHAT_GENERATION_BATCH_SIZE, CHAT_READING_BATCH_SIZE, GENERATION_BATCH_SIZE, READING_BATCH_SIZE, GENERATION_OUTPUT_TOKENS, MAX_SLIDES, MAX_PROMPT_CHARACTERS, PLAN_OUTPUT_TOKENS,PLAN_RETRY_OUTPUT_TOKENS,OUTLINE_PROPOSALS,MIN_TEXT_SIZE } from '../shared/contracts.js';
import {completeSlidePrefix} from './partial-generation.js';
import {repairReason,repairInstruction} from './repair-policy.js';
import { themes } from '../shared/themes.js';
import { fitProblems, applySummaries, assertTextFits } from './text-fit.js';
import {candidateLayoutIds,diversifyDeck,fittingLayouts,improveTextFit} from '../shared/layout-selection.js';
import {designTexts} from '../shared/free-design.js';
import {slideContent,transplant} from '../shared/slots.js';
import {designRequest,leakCheck,Masker,phraseLeak,sha256,type DesignPacket,type ShareLevel,type SlotContent} from '../shared/confidential.js';
import {designOnlyPrompt} from './free-prompts.js';
import {deckTheme} from '../shared/layouts.js';
import {listLayouts} from '../shared/layouts.js';
import {compatibleChartTypes} from '../shared/charts.js';
import {prepareChatHandoff,parseChatResponse} from './chat-handoff.js';
import {DesignLibraryStore} from './design-library.js';
import {applySavedDesign} from './design-application.js';
import {ProjectStore} from './projects.js';
import type {ProjectProfile,SourceReport,Theme} from '../shared/contracts.js';
import {TEMPLATE_THEME_ID} from '../shared/themes.js';
import {AI_THEME_ID,paletteTheme} from '../shared/ai-theme.js';
import {templateToTheme} from '../shared/template-style.js';
import {auditSlide,sourceValues} from '../shared/source-audit.js';
import {numbersIn} from '../shared/numbers.js';
/** Text compared without spacing, line breaks and punctuation, which PDF extraction changes. */
const looseText=(text:string)=>text.normalize('NFKC').replace(/[\s、。,.・「」『』()（）［］\[\]:：;；\-－―〜~]/g,'');
import {applyRefresh,planRefresh,RefreshInputError} from '../shared/refresh.js';
import type {RefreshPlan,RefreshSummary} from '../shared/contracts.js';
import {DOCUMENT_LIMITS} from './document-model.js';

/** force: the user chose to finish with smaller text (no AI). */
interface FitDraft {deck:DeckSpec;batchSize:number;singleFailures:number;force?:boolean}
/** ceiling: after a reply was cut or broken, the batch size that failed is not tried again. */
interface GenerationDraft {key:string;slides:SlideSpec[];themeId:string;batchSize:number;ceiling?:number;singleFailures:number;compact:boolean;fit?:FitDraft;
  /** Valid pages that came after a rejected page; they join the deck once the gap before them is filled. */
  pending?:Record<string,SlideSpec>}
interface RevisionDraft {variantId:string;slideId:string;instruction:string;title:string;base:string;failures:number;compact:boolean;result?:SlideSpec;fit?:FitDraft}
interface RepairOperation {remaining:number;startedCalls:number;next?:{task:ModelTask;code:string;detail?:string}}
/** full: the user chose the self-contained instruction for this request. */
interface DesignDraft {variantId:string;level:ShareLevel;topic?:string;ids:string[];done:SlideSpec[];contents:Record<string,SlotContent>;base:string}
interface ChatDraft {design?:DesignDraft;full?:boolean;task:ModelTask|'design';payload:any;messages?:Session['messages'];purpose?:'generate'|'revise'|'alternate'|'design';service?:ChatService;summaryDeck?:DeckSpec;variantBase?:string;variantId?:string;instruction?:string;targetIds?:string[]}
/** A refresh compared with new documents, waiting for the user's review. base pins the deck it was made from. */
interface RefreshDraft {plan:RefreshPlan;documents:ParsedDocument[];base:string}
/** One AI writing for this session besides (or instead of) its own provider: the AI
 * chosen at creation, another draft, or a design-only request. Each keeps its own
 * call count and retry budget, so AIs can work at the same time. */
interface AiRun {target:AiTarget;label:string;repair:RepairOperation;calls:number;notes:string[]}
/** targets: the AIs chosen at creation (the first writes the main draft); bindings: the
 * monthly accounts connected at that moment; extras: other drafts written alongside. */
interface SessionState { targets?:AiTarget[]; sendScope?:SendScope; bindings?:Partial<Record<SubscriptionService,string>>; extras?:{started:boolean;ready:DeckVariant[];failed:string[]}; refresh?:RefreshDraft; masker?:Masker; oneShot?:boolean; session: Session; documents: ParsedDocument[]; settings: Settings; project:ProjectProfile; createdAt: number; busy: boolean; subscriptionBinding?:string; historyRevision?:number; design?:DesignEntry; pendingPlan?:{messages:Session['messages'];failures:number}; draft?:GenerationDraft;revision?:RevisionDraft;repairOperation?:RepairOperation;chat?:ChatDraft }
const MAX_VARIANTS=3;
/** AI calls: per operation (creating a deck, one revision) and per presentation. */
const OPERATION_CALL_LIMIT=12,SESSION_CALL_LIMIT=40;
const chatServiceNames:Record<string,string>={chatgpt:'ChatGPT',claude:'Claude',gemini:'Gemini',copilot:'Microsoft Copilot',other:'その他のAI'};
const chatServiceName=(service:string)=>chatServiceNames[service]??'AI';
const targetLabel=(target:AiTarget)=>target==='local'?'ローカルLLM':chatServiceName(target);
/** Whether two versions of a page say the same: the same words (spacing aside), numbers, charts and tables. */
function sameContent(a:SlideSpec,b:SlideSpec){
  const squash=(text:string)=>text.replace(/\s+/g,'');
  const key=(s:SlideSpec)=>{const c=slideContent(s),title=s.design?.elements.find(e=>e.t==='text'&&e.role==='title');
    return JSON.stringify({title:title&&title.t==='text'?squash(title.text):squash(s.title),texts:c.texts.map(t=>squash(t.text)).sort(),charts:c.charts.map(x=>[x.categories,x.series.map(v=>[v.name,v.values])]),tables:c.tables});};
  return key(a)===key(b);
}
/** The settings of one AI chosen for a session. */
function settingsFor(base:Settings,target:AiTarget):Settings{
  if(target==='local')return {...base,provider:'local',model:base.localModel??(base.provider==='local'?base.model:'')};
  return {...base,provider:'subscription',subscriptionService:target,model:base.provider==='subscription'&&base.subscriptionService===target?base.model:'auto'};
}
/** A design reply filled with the real content. A text a little long for its box is
 * set smaller first; a real overflow is reported by slot name only (never the wording). */
function fillDesign(raw:unknown,packet:DesignPacket,contents:Record<string,SlotContent>,deck:DeckSpec){
  const slides=improveTextFit({...deck,slides:validateDesignReply(raw,packet,contents,deck)}).slides;
  const fit=fitProblems({...deck,slides});
  if(fit.length){
    const problems=fit.flatMap(p=>p.issues.map(issue=>{const slot=Object.entries(contents[p.slideId].texts).find(([,v])=>issue.text.startsWith(v.text))?.[0];return `${p.slideId}の${slot??'文字の枠'}は、その大きさでは文字が収まりません。枠を広げるか、文字を小さくしてください。`;}));
    throw new AppError(422,[...new Set(problems)].join(' '),'TEXT_FIT_REQUIRED');
  }
  return slides;
}
/** A built-in theme id; anything else an AI writes ("ai", a made-up name) is ignored, not an error. */
function knownTheme(value:unknown):value is string{return typeof value==='string'&&Object.hasOwn(themes,value);}
/** What a later batch needs to keep the deck consistent without re-reading earlier pages. */
function continued(slide:SlideSpec){
  if(!slide.design)return {title:slide.title,headline:slide.headline,layoutId:slide.layoutId};
  const kinds=new Map<string,number>();for(const e of slide.design.elements){const key=e.t==='box'?e.shape??'rect':e.t;kinds.set(key,(kinds.get(key)??0)+1);}
  const title=slide.design.elements.find(e=>e.t==='text'&&e.role==='title');
  return {title:slide.title,layoutId:slide.layoutId,composition:[...kinds].map(([k,n])=>`${k}×${n}`).join(' '),...(slide.design.background?{background:slide.design.background}:{}),...(title&&title.t==='text'?{titleBox:[title.x,title.y,title.w,title.h,title.size]}:{})};
}
export interface EngineOptions {
  settings: SettingsStore; projects?:ProjectStore; dataDir: string;
  render: (deck: DeckSpec, variantId: string) => Promise<RenderResult>;
  open?: (artifactId: string) => Promise<void>;
  providerFactory?: (settings: Settings, key?: string) => Provider;
  /** HTML method (trial): draws AI-written HTML pages in a browser and reads their layout. */
  htmlLayout?: HtmlLayout;
  subscriptionBinding?: (service: SubscriptionService) => string | undefined;
  artifactRoot?:string;
}

export class SessionEngine {
  private states = new Map<string, SessionState>();
  private preferredTheme = 'paper';
  private recentLayouts:string[]=[];
  private history:HistoryStore;
  private designs:DesignLibraryStore;
  private projects:ProjectStore;
  constructor(private options: EngineOptions) {this.history=new HistoryStore(options.dataDir);this.designs=new DesignLibraryStore(options.dataDir);this.projects=options.projects??new ProjectStore(options.dataDir);}
  listProjects(){return this.projects.list();}
  createProject(input:unknown){return this.projects.create(input);}
  updateProject(id:string,input:unknown){return this.projects.update(id,input);}
  listHistory(projectId?:string){if(projectId)this.projects.get(projectId);return this.history.list(projectId);}
  async historyVersions(id:string){return {versions:await this.history.versions(id)};}
  listDesigns(projectId?:string){const selected=projectId??this.options.settings.get().activeProjectId;this.projects.get(selected);return this.designs.list(selected);}
  voteDesign(id:string,delta:unknown=1){if(delta!==1&&delta!==-1)throw new AppError(400,'投票は1回ずつ変更してください。');return this.designs.vote(id,delta);}
  async removeDesign(id:string){const design=await this.designs.load(id);if(design.projectId!==this.options.settings.get().activeProjectId)throw new AppError(403,'別のプロジェクトのお気に入りは削除できません。','PROJECT_MISMATCH');await this.designs.remove(id);if(this.options.settings.get().preferredDesignId===id)await this.options.settings.update({preferredDesignId:''});return {ok:true};}
  async exportDesignPack(projectId:string){const project=this.projects.get(projectId);const pack=await this.designs.exportPack(projectId);return project.template?{...pack,template:project.template}:pack;}
  async importDesignPack(projectId:string,input:unknown){
    this.projects.get(projectId);
    const pack=input as Record<string,unknown>|null;
    const hasTemplate=!!pack&&typeof pack==='object'&&pack.template!==undefined&&pack.format==='designer-extension-design-set';
    const designsOnly=hasTemplate?{...pack,template:undefined}:input;
    const imported=hasTemplate&&Array.isArray(pack!.designs)&&!pack!.designs.length?{imported:0}:await this.designs.importPack(projectId,designsOnly);
    if(hasTemplate)await this.projects.setTemplate(projectId,pack!.template);
    return {...imported,template:hasTemplate};
  }
  async saveDesign(id:string,input:{variantId?:unknown;slideId?:unknown;name?:unknown}){
    return this.lock(id,async state=>{
      if(state.session.phase!=='ready')throw new AppError(409,'完成したスライドからデザインを保存してください。');
      const variant=this.variant(state,input.variantId);
      const slideId=input.slideId===undefined?undefined:requireText(input.slideId,'スライドID',100);
      const name=input.name===undefined?undefined:requireText(input.name,'デザイン名',100);
      const index=slideId?variant.deck.slides.findIndex(s=>s.id===slideId):0;
      if(index<0)throw new AppError(404,'保存するスライドが見つかりません。');
      return this.designs.save(variant.deck,{name,slideId,thumbnail:variant.render?.thumbnails[index],projectId:state.session.projectId});
    },false);
  }
  async applyDesign(id:string,input:{variantId?:unknown;designId?:unknown}){
    return this.lock(id,async state=>{
      if(state.chat)throw new AppError(409,'AIの返答を取り込むか連携を取り消してから、デザインを適用してください。');
      const variant=this.variant(state,input.variantId),design=await this.designs.load(requireText(input.designId,'デザインID',100));
      if(design.projectId!==state.session.projectId)throw new AppError(403,'別のプロジェクトのお気に入りは適用できません。デザイン設定を共有用ファイルで取り込んでください。','PROJECT_MISMATCH');
      const styled=applySavedDesign(variant.deck,design,true,this.templateTheme(state));this.verifySources(state,styled.deck.slides);
      variant.deck=styled.deck;delete variant.render;
      state.session.messages.push({role:'assistant',text:`保存したデザイン「${design.name}」の配色・書体を適用し、${styled.changed}枚の構図を変更しました。${styled.skipped?`${styled.skipped}枚は内容の関係・文字量を保つため元の構図を使いました。`:''}文章・図表の数値・出典を保持し、AIは呼び出していません。`});
      return state.session;
    });
  }
  private async preferredDesign(settings:Settings,projectId:string,warnings:string[]){
    try{if(settings.preferredDesignId){const explicit=await this.designs.load(settings.preferredDesignId);if(explicit.projectId===projectId)return explicit;warnings.push('指定されたお気に入りは別のプロジェクトにあるため、このプロジェクトのデザインを使います。');}return (await this.designs.list(projectId)).entries.find(entry=>entry.mode===settings.mode);}
    catch{warnings.push('お気に入りデザインを読み取れませんでした。通常のデザイン候補で作成します。');return undefined;}
  }
  /** In free design a saved design is sent only when the user chose it; votes alone do not steer the AI. */
  private designGuidance(state:SessionState){const design=state.design;if(this.freeDesign(state)&&!state.settings.preferredDesignId)return undefined;return design?{themeId:design.themeId,typographyId:design.typographyId,...(this.freeDesign(state)?{}:{layoutIds:design.layoutIds}),explicit:Boolean(state.settings.preferredDesignId)}:undefined;}
  async removeHistory(id:string){
    const affected=[...this.states.values()].filter(s=>s.session.historyId===id);
    if(affected.some(s=>s.busy))throw new AppError(409,'この資料は処理中です。完了してから削除してください。');
    affected.forEach(s=>s.busy=true);
    try{await this.history.remove(id);for(const state of affected){delete state.session.historyId;delete state.session.savedAt;state.historyRevision=0;}}finally{affected.forEach(s=>s.busy=false);}
    return {ok:true};
  }
  async restoreHistory(id:string,duplicate=false,revision?:number){
    const record=revision===undefined?await this.history.load(id):await this.history.loadVersion(id,revision);this.reserveSession();
    if(revision!==undefined)duplicate=true;
    const project=this.projects.get(record.session.projectId),priorSettings=this.options.settings.get();await this.options.settings.update({activeProjectId:project.id,...(priorSettings.activeProjectId!==project.id?{preferredDesignId:''}:{})});
    const settings=this.options.settings.get(),deck=record.session.variants[0].deck;settings.mode=deck.mode;settings.slideCount=deck.slides.length;settings.themeId=deck.themeId;settings.typographyId=deck.typographyId??'auto';
    const session:Session={...record.session,id:randomUUID(),provider:settings.provider,usage:emptyUsage(),cloudConsentRequired:settings.provider==='subscription',...(duplicate?{}:{historyId:record.id,savedAt:record.updatedAt})};
    if(settings.provider==='subscription')session.subscriptionService=settings.subscriptionService??'chatgpt';else delete session.subscriptionService;
    delete session.chatHandoff;
    const state:SessionState={session,documents:record.documents,settings,project,createdAt:Date.now(),busy:false,subscriptionBinding:settings.provider==='subscription'?this.options.subscriptionBinding?.(settings.subscriptionService??'chatgpt'):undefined,historyRevision:duplicate?0:record.revision,design:await this.preferredDesign(settings,project.id,session.warnings)};
    for(const variant of session.variants){this.verifySources(state,variant.deck.slides);assertTextFits(variant.deck);}
    if(duplicate)await this.persist(state,true);
    this.states.set(session.id,state);
    return {session,documents:state.documents.map(documentSummary),mode:settings.mode};
  }
  async saveHistory(id:string){return this.lock(id,async state=>{if(state.session.phase!=='ready')throw new AppError(409,'スライドを作成してから保存してください。');await this.persist(state,true);return state.session;},false);}
  async cloudConsent(id:string){return this.lock(id,async state=>{if(state.settings.provider==='subscription')this.checkSubscriptionBinding(state);state.session.cloudConsentRequired=false;return state.session;},false);}
  private reserveSession(){
    for(const [id,state] of this.states)if(!state.busy&&Date.now()-state.createdAt>2*60*60*1000)this.states.delete(id);
    if(this.states.size>=25)throw new AppError(429,'この起動中の作業数が上限に達しました。不要な作業を閉じるか、保存後に再起動してください。');
  }
  private async persist(state:SessionState,strict=false){
    try{const saved=await this.history.save(state.session,state.documents,state.session.historyId,state.historyRevision??0);state.session.historyId=saved.id;state.session.savedAt=saved.updatedAt;state.historyRevision=saved.revision;delete state.session.historySaveError;}
    catch(error){const message=error instanceof AppError?error.message:'履歴を保存できませんでした。PowerPointファイルを保存し、空き容量を確認してください。';state.session.historySaveError=message;if(strict)throw error;state.session.warnings=[...new Set([...state.session.warnings,message])];}
  }
  async loadPreferences() {
    try { const rows=(await readFile(path.join(this.options.dataDir,'layout-history.jsonl'),'utf8')).split('\n').filter(Boolean).slice(-64);this.recentLayouts=rows.flatMap(row=>{const ids=JSON.parse(row).layouts;return Array.isArray(ids)?ids.filter((id:unknown)=>typeof id==='string'&&listLayouts().some(l=>l.id===id)):[];}).slice(-128); } catch { /* No layout history yet. */ }
    try {
      const raw = await readFile(path.join(this.options.dataDir, 'preferences.jsonl'), 'utf8');
      const recent = raw.split('\n').filter(Boolean).slice(-500);
      const scores = Object.fromEntries(Object.keys(themes).map(id=>[id,{sum:0,count:0}]));
      for (const line of recent) {
        const item = JSON.parse(line);
        if (Object.hasOwn(scores,item.theme) && typeof item.rating === 'number') { scores[item.theme].sum += item.rating; scores[item.theme].count++; }
      }
      const average = (entry: { sum: number; count: number }) => (entry.sum + 9) / (entry.count + 3);
      this.preferredTheme = Object.keys(scores).sort((a,b)=>average(scores[b])-average(scores[a]))[0];
    } catch { /* No preference history on first launch. */ }
  }
  get(id: string): Session { return this.state(id).session; }
  resume(id:string):RestoredPresentation{const state=this.state(id);return {session:state.session,documents:state.documents.map(documentSummary),mode:state.settings.mode};}
  listChatTasks(){return {sessions:[...this.states.values()].filter(s=>s.settings.provider==='chat').map(s=>({id:s.session.id,title:s.session.outline?.title??'作成中の資料',phase:s.session.phase,...(s.session.chatHandoff?{task:s.session.chatHandoff.task}:{})}))};}
  delete(id: string) { this.states.delete(id); }

  async create(input: { prompt: unknown; mode?: unknown; cloudConsent?: unknown; oneShot?: unknown; targets?: unknown; sendScope?: unknown }, documents: ParsedDocument[]) {
    const prompt = requireText(input.prompt, '指示',MAX_PROMPT_CHARACTERS);
    const settings = this.options.settings.get();
    const project=this.projects.get(settings.activeProjectId);
    if (input.mode !== undefined) {
      if (!['presentation', 'reading'].includes(String(input.mode))) throw new AppError(400, '表示モードが正しくありません。');
      settings.mode = input.mode as Settings['mode'];
    }
    const choice=this.creationTargets(settings,input,project);
    if(choice){Object.assign(settings,settingsFor(settings,choice.targets[0]));if(choice.scope==='design')settings.designMode='template';}
    else if (settings.provider === 'subscription' && input.cloudConsent !== true) throw new AppError(400, `${settings.subscriptionService==='claude'?'Claude':'ChatGPT'}へ指示・資料・会話を送ることを確認してください。`, 'CLOUD_CONSENT_REQUIRED');
    const subscriptionBinding=settings.provider==='subscription'?choice?.bindings[settings.subscriptionService??'chatgpt']??this.options.subscriptionBinding?.(settings.subscriptionService??'chatgpt'):undefined;
    if(settings.provider==='subscription'&&!subscriptionBinding)throw new AppError(409,'設定から月額サービスのアカウントに接続してから作成してください。','SUBSCRIPTION_CONNECTION_REQUIRED');
    documentContext(documents);
    this.reserveSession();
    const session: Session = { id: randomUUID(),provider:settings.provider,projectId:project.id,...(choice?{targets:choice.targets,sendScope:choice.scope}:{}),...(settings.provider==='subscription'?{subscriptionService:settings.subscriptionService??'chatgpt'}:{}), phase: 'clarifying', messages: [{ role: 'user', text: prompt }], variants: [], usage: emptyUsage(), warnings: documents.flatMap((document) => document.warnings.map((warning) => `${document.name}: ${warning}`)) };
    const state: SessionState = { ...(choice?{targets:choice.targets,sendScope:choice.scope,bindings:choice.bindings}:{}), ...(settings.provider==='chat'&&input.oneShot===true?{oneShot:true}:{}), session, documents, settings, project, subscriptionBinding, busy: false, createdAt: Date.now(),design:await this.preferredDesign(settings,project.id,session.warnings) };
    this.states.set(session.id, state);
    try {
      if (settings.provider === 'demo') {
        session.warnings.unshift(DEMO_WARNING);
        session.messages.push({ role: 'assistant', text: 'デモとして構成と図形配置を確認します。読み手や説明時間、特に伝えたいことを教えてください。「おまかせ」でも進められます。' });
      } else if(settings.provider==='chat')this.prepareChatPlan(state,session.messages);
      else await this.withRepairs(state,()=>this.plan(state, session.messages));
      return session;
    } catch (error) { this.states.delete(session.id); throw error; }
  }

  /** The AIs chosen for one creation, checked: connected accounts, a configured local
   * LLM, and consent for what each may receive. Undefined when none were chosen. */
  private creationTargets(settings:Settings,input:{targets?:unknown;sendScope?:unknown;cloudConsent?:unknown},project:ProjectProfile){
    if(input.targets===undefined)return undefined;
    if(settings.provider!=='subscription'&&settings.provider!=='local')throw new AppError(400,'作成するAIを選べるのは、月額版での自動作成かローカルLLMを使う設定のときです。');
    const targets=input.targets;
    if(!Array.isArray(targets)||!targets.length||targets.length>MAX_VARIANTS||targets.some(t=>t!=='claude'&&t!=='chatgpt'&&t!=='local')||new Set(targets).size!==targets.length)throw new AppError(400,`作成するAIを1〜${MAX_VARIANTS}つ選んでください。`);
    const scope=input.sendScope??(project.privacy?.mode==='masked'?'masked':'full');
    if(scope!=='full'&&scope!=='masked'&&scope!=='design')throw new AppError(400,'外部のAIに送る内容を選んでください。');
    const cloud=targets.filter((t):t is SubscriptionService=>t!=='local');
    if(targets.includes('local')&&!settingsFor(settings,'local').model)throw new AppError(400,'設定でローカルLLMの接続先とモデル名を登録してください。','LOCAL_MODEL_REQUIRED');
    if(scope==='design'&&(!targets.includes('local')||!cloud.length))throw new AppError(400,'内容を送らない作成では、内容を書くローカルLLMと、デザインを頼むAI（ClaudeかChatGPT）を選んでください。','DESIGN_TARGETS_REQUIRED');
    const bindings:Partial<Record<SubscriptionService,string>>={};
    for(const service of cloud){
      const binding=this.options.subscriptionBinding?.(service);
      if(!binding)throw new AppError(409,`設定から${chatServiceName(service)}のアカウントに接続してから作成してください。`,'SUBSCRIPTION_CONNECTION_REQUIRED');
      bindings[service]=binding;
    }
    if(scope!=='design'&&cloud.length&&input.cloudConsent!==true)throw new AppError(400,`${cloud.map(chatServiceName).join('・')}へ指示・資料・会話を送ることを確認してください。`,'CLOUD_CONSENT_REQUIRED');
    return {targets:scope==='design'?['local' as AiTarget,...cloud]:targets as AiTarget[],scope:scope as SendScope,bindings};
  }
  async message(id: string, text: unknown) {
    return this.lock(id, async (state) => {
      const messages = [...state.session.messages, { role: 'user' as const, text: requireText(text, 'メッセージ',MAX_PROMPT_CHARACTERS) }];
      this.checkConversation(messages);
      if(state.settings.provider==='chat'){this.prepareChatPlan(state,messages);return state.session;}
      if (state.settings.provider === 'demo') {
        state.session.messages = messages;
        state.session.outline = demoOutline(messages[0].text, state.settings.mode, state.documents, state.settings.slideCount);
        // The company template is applied after generation (styleDeck); the outline keeps a built-in theme.
        state.session.outline.themeId = state.settings.themeId==='auto'||state.settings.themeId===TEMPLATE_THEME_ID ? this.preferredTheme : state.settings.themeId;
        state.session.phase = 'outline';
        state.session.messages.push({ role: 'assistant', text: 'デモの構成案を用意しました。内容は分析結果ではなく配置確認用です。「この構成で作成」でスライドを作れます。' });
      } else await this.plan(state, messages);
      return state.session;
    },true,true);
  }

  async retryPlan(id:string){
    return this.lock(id,async state=>{
      if(!state.pendingPlan||state.session.recovery?.task!=='plan')throw new AppError(409,'再試行する構成の指示がありません。');
      if(state.pendingPlan.failures>=2)throw new AppError(429,'同じ指示での出力上限が繰り返されました。追加の呼び出しは行っていません。プロンプト欄で優先する条件を整理してから送信してください。');
      await this.plan(state,state.pendingPlan.messages,true);
      return state.session;
    },false,true);
  }

  async generate(id: string, inputOutline?: unknown, force=false) {
    return this.lock(id, async (state) => {
      const outline = inputOutline ? validateOutline(inputOutline) : state.session.outline;
      if (!outline || state.session.phase === 'clarifying') throw new AppError(409, '先に構成案を確認してください。');
      if (outline.mode !== state.settings.mode) throw new AppError(422, '構成案のモードが作成時の設定と異なります。新しく作成してください。');
      this.checkSlideCount(state,outline);
      if(state.session.recovery?.task==='generate'&&!state.session.recovery.retryAvailable&&!force)throw new AppError(429,'再開の上限に達しました。追加の呼び出しは行っていません。構成から情報を分けるか、優先条件を整理してください。');
      state.session.outline=outline;
      if(state.settings.provider==='chat'){this.prepareChatGeneration(state,outline);return state.session;}
      let value:unknown,extras:Promise<void>=Promise.resolve();
      if(state.settings.provider==='demo')value=demoDeck(outline);
      else {
        const key=JSON.stringify({outline,messages:state.session.messages,settings:state.settings});
        if(state.draft?.key!==key)state.draft={key,slides:[],themeId:outline.themeId??this.preferredTheme,batchSize:this.baseBatch(state,outline),singleFailures:0,compact:false};
        const draft=state.draft;
        // Other AIs chosen at creation write their drafts of the same outline at the same time.
        extras=this.startExtras(state,outline);
        const stopped=await this.writePages(state,outline,draft);
        if(stopped){await extras;return this.generationRecovery(state,outline,'content',stopped.canRetry);}
        value={id:'draft',title:outline.title,mode:outline.mode,themeId:draft.themeId,slides:draft.slides};
      }
      let deck = validateDeck(value, outline);
      if (deck.mode !== outline.mode) throw new AppError(422, '生成された資料のモードが構成案と異なります。');
      deck.title = outline.title;
      deck.id = randomUUID();
      this.verifySources(state, deck.slides);
      this.styleDeck(state,deck,outline);
      const typography=state.settings.typographyId;
      deck.typographyId=typography&&typography!=='auto'?typography:outline.typographyId??deck.typographyId;
      if(state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,false,this.templateTheme(state)).deck;
      const draft=state.draft;
      if(draft&&!draft.fit)draft.fit={deck:improveTextFit(deck),batchSize:READING_BATCH_SIZE,singleFailures:0};
      if(force&&draft?.fit)draft.fit.force=true;
      try{deck=await this.fitText(state,draft?.fit?.deck??improveTextFit(deck),draft?.fit);}
      catch(error){if(!draft?.fit||(!repairReason(error)&&!(error instanceof AppError&&error.code==='CALL_LIMIT')))throw error;await extras;return this.generationRecovery(state,outline,'text-fit',error instanceof AppError&&error.code==='CALL_LIMIT'?state.session.usage.calls<SESSION_CALL_LIMIT:!!repairReason(error)&&draft.fit.singleFailures<2);}
      deck = diversifyDeck(deck,state.session.id,this.recentLayouts);
      if(state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,true,this.templateTheme(state)).deck;
      assertTextFits(deck);
      state.session.outline = outline;
      const ai=state.settings.provider==='local'?'ローカルLLM':state.settings.provider==='demo'?'サンプル':state.settings.provider==='subscription'?(state.settings.subscriptionService==='claude'?'Claude':'ChatGPT'):'AI';
      const main:DeckVariant={ id: randomUUID(), label: state.sendScope==='design'?'内容（ローカルLLM）':ai, deck, origin:{kind:'ai',ai} };
      state.session.variants = [main];
      await extras;
      for(const variant of state.extras?.ready??[])if(state.session.variants.length<MAX_VARIANTS)state.session.variants.push(variant);
      for(const failure of state.extras?.failed??[])state.session.warnings.push(failure);
      // Content written on this PC; each chosen cloud AI receives only the skeleton for its design.
      if(state.sendScope==='design')await Promise.all((state.targets??[]).filter((t):t is SubscriptionService=>t!=='local').map(async target=>{
        const run=this.newRun(state,target);
        try{
          const designed=await this.designPages(state,main.deck,'structure',undefined,run);
          state.session.variants.push({id:randomUUID(),label:`デザイン：${run.label}`,deck:designed,origin:{kind:'ai',ai:run.label,parents:[main.id],notes:[`${run.label}には内容を送らず、文字の枠の役割・文字数・グラフと表の形だけを渡しました。`]}});
        }catch(error){state.session.warnings.push(`${run.label}のデザインは作成できませんでした（${error instanceof AppError?error.message:'接続または応答の不備'}）。内容の案はこのPCで作成済みです。`);}
      }));
      state.session.phase = 'ready';
      delete state.session.recovery;delete state.draft;delete state.extras;
      await this.rememberLayouts(deck,state.session);
      const others=state.session.variants.slice(1).map(v=>v.label);
      state.session.messages.push({ role: 'assistant', text: `${deck.slides.length}枚を作成しました。${others.length?`${others.join('・')}の案も同じ構成で作りました。並べて比べたり、ページごとに組み合わせたりできます。`:''}サムネイルで確認し、必要なら対象のスライドに修正を指示してください。` });
      return state.session;
    },true,true);
  }

  private baseBatch(state:SessionState,outline:Outline){return this.freeDesign(state)?FREE_GENERATION_BATCH_SIZE:outline.mode==='reading'?READING_BATCH_SIZE:GENERATION_BATCH_SIZE;}
  /** Writes the outline's pages into draft.slides batch by batch, keeping every page that
   * passes. Returns why it stopped, or undefined when all pages are written. The session's
   * own provider writes unless run names another AI chosen for this session. */
  private async writePages(state:SessionState,outline:Outline,draft:GenerationDraft,run?:AiRun):Promise<{canRetry:boolean}|undefined>{
    const free=this.freeDesign(state),html=this.htmlFor(state,run),baseBatch=this.baseBatch(state,outline);
    if(state.settings.designMode==='html'&&!html&&!state.session.warnings.some(w=>w.startsWith('HTML方式')))state.session.warnings.push('HTML方式（試験）は、月額版の自動作成でインストール版を使うときだけ使えます。この資料は座標の方式で作成しました。');
    /** One returned page, checked on its own: a later page's problem never discards an earlier valid page. */
    const accept=(raw:any,expected:string,keep:(slide:SlideSpec)=>void=slide=>draft.slides.push(slide))=>{
      if(!raw||raw.id!==expected)throw new AppError(422,`${expected}がありません。生成したページの識別子・順序を構成と一致させてください。`,'INVALID_CONTENT');
      const warnings=[...state.session.warnings];
      try{
        if(typeof raw.htmlProblem==='string')throw new AppError(422,raw.htmlProblem,'INVALID_CONTENT');
        const slide=validateSlide(raw,expected);
        if((slide.id==='slide-1')!==(slide.layoutId==='cover'))throw new AppError(422,'表紙と本文の役割が構成と一致しません。','INVALID_CONTENT');
        this.verifySources(state,[slide]);keep(slide);
      }catch(error){state.session.warnings=warnings;if(error instanceof AppError)error.message=`${expected}：${error.message.replace(/^生成内容を確認できません: /,'')}`;throw error;}
    };
    const pending=draft.pending??={};
    while(draft.slides.length<outline.slides.length) {
      while(draft.slides.length<outline.slides.length&&pending[outline.slides[draft.slides.length].id]){const id=outline.slides[draft.slides.length].id;draft.slides.push(pending[id]);delete pending[id];}
      if(draft.slides.length>=outline.slides.length)break;
      const start=draft.slides.length,targetSlides:Outline["slides"]=[];
      for(const slide of outline.slides.slice(start)){if(pending[slide.id]||targetSlides.length>=draft.batchSize)break;targetSlides.push(slide);}
      let response:any;
      try{
        // AI-designed pages carry every element's position, so each page needs a larger answer
        // budget. The budget is a ceiling, not usage; a cut reply costs a whole extra call.
        response=await this.complete(state,'generate',{outline,targetSlides,messages:state.session.messages,compactOutput:draft.compact,continuedFrom:draft.slides.map(continued)},draft.compact?GENERATION_OUTPUT_TOKENS:Math.min(GENERATION_OUTPUT_TOKENS,free?3000+targetSlides.length*(html?5500:4000):4000+targetSlides.length*2500),run);
        if(!response||response.mode!==outline.mode||!Array.isArray(response.slides))throw new AppError(422,'指定したページ数・モードで応答されませんでした。','INVALID_CONTENT');
        if(start===0&&knownTheme(response.themeId))draft.themeId=response.themeId;
        if(html)await this.layoutPages(state,outline,response.slides.slice(0,targetSlides.length),run);
        targetSlides.forEach((target,i)=>accept(response.slides[i],target.id));
        draft.singleFailures=0;
        // After a failure the batch was made smaller; each success restores it step by step,
        // up to a size below one whose reply was cut or broken.
        const cap=Math.min(baseBatch,draft.ceiling??baseBatch);
        if(draft.batchSize<cap)draft.batchSize=Math.min(cap,draft.batchSize*2);
      }
      catch(error){
        // An operation's 12 calls are used up: the next operation may continue, until the presentation's 40.
        if(error instanceof AppError&&error.code==='CALL_LIMIT')return {canRetry:!run&&state.session.usage.calls<SESSION_CALL_LIMIT};
        if(!repairReason(error)||(this.options.settings.get().autoRepair===false&&!(error instanceof OutputLimitError)))throw error;
        // A reply cut off or broken partway still holds finished pages; keep those that pass.
        const partial=error instanceof OutputLimitError?error.partialText:error instanceof AppError&&error.code==='INVALID_MODEL_JSON'?(error as AppError&{partialText?:string}).partialText:undefined;
        const prefix=partial?completeSlidePrefix(partial):undefined;
        if(prefix?.mode===outline.mode){
          const from=draft.slides.length-start,pages=prefix.slides.slice(from,targetSlides.length).map((s:unknown)=>this.unmask(state,s));
          if(html)await this.layoutPages(state,outline,pages,run);
          for(let i=from;i<Math.min(prefix.slides.length,targetSlides.length);i++){
            try{
              if(start===0&&i===0&&knownTheme(prefix.themeId))draft.themeId=prefix.themeId;
              accept(pages[i-from],targetSlides[i].id);
            }catch{break;}
          }
        }
        // The pages after the rejected one in the same reply are checked and kept for later.
        if(response&&Array.isArray(response.slides))for(let i=draft.slides.length-start+1;i<targetSlides.length;i++){
          try{accept(response.slides[i],targetSlides[i].id,slide=>{pending[targetSlides[i].id]=slide;});}catch{/* asked again with the rejected page */}
        }
        const gained=draft.slides.length-start+targetSlides.filter(s=>pending[s.id]).length;
        draft.singleFailures=targetSlides.length===1&&!gained?draft.singleFailures+1:0;
        draft.batchSize=Math.max(1,Math.floor(targetSlides.length/2));draft.compact=true;
        if(error instanceof OutputLimitError||(error instanceof AppError&&error.code==='INVALID_MODEL_JSON'))draft.ceiling=Math.max(1,Math.min(draft.ceiling??baseBatch,targetSlides.length-1));
        if(draft.slides.length===outline.slides.length&&this.options.settings.get().autoRepair!==false){
          if(!run)this.recordRepair(state,error,'最後まで返された全ページを検証し、追加の本文生成なしで仕上げへ進めました。',false);continue;
        }
        if(draft.singleFailures<2&&this.tryRepair(state,'generate',error,`検証できた${draft.slides.length}枚を再利用し、残りを最大${draft.batchSize}枚ずつ、回答枠16,000トークンで再生成。文章とノートの重複を減らし、ページ・図表・出典を検証します。`,run))continue;
        return {canRetry:draft.singleFailures<2};
      }
    }
    return undefined;
  }
  private newRun(state:SessionState,target:AiTarget):AiRun{return {target,label:targetLabel(target),repair:{remaining:this.options.settings.get().autoRepair!==false?2:0,startedCalls:state.session.usage.calls},calls:0,notes:[]};}
  /** Other AIs chosen at creation write their own drafts of the same outline while the
   * main draft is written. A failed one is reported and never stops the main draft. */
  private startExtras(state:SessionState,outline:Outline):Promise<void>{
    const targets=state.sendScope==='design'?[]:(state.targets??[]).slice(1);
    if(!targets.length||state.extras?.started)return Promise.resolve();
    const extras=state.extras={started:true,ready:[] as DeckVariant[],failed:[] as string[]};
    return Promise.all(targets.map(async target=>{
      const run=this.newRun(state,target);
      try{const deck=await this.draftFor(state,outline,run);extras.ready.push({id:randomUUID(),label:run.label,deck,origin:{kind:'ai',ai:run.label,...(run.notes.length?{notes:run.notes.map(n=>`自動で対処：${n}`)}:{})}});}
      catch(error){extras.failed.push(`${run.label}の案は作成できませんでした（${error instanceof AppError?error.message:'接続または応答の不備'}）。`);}
    })).then(()=>undefined);
  }
  /** A whole draft of the outline by one chosen AI, checked and fitted like the main one. */
  private async draftFor(state:SessionState,outline:Outline,run:AiRun):Promise<DeckSpec>{
    const draft:GenerationDraft={key:run.target,slides:[],themeId:outline.themeId??this.preferredTheme,batchSize:this.baseBatch(state,outline),singleFailures:0,compact:false};
    const stopped=await this.writePages(state,outline,draft,run);
    if(stopped)throw new AppError(422,`${draft.slides.length} / ${outline.slides.length}枚で止まりました`,'EXTRA_STOPPED');
    let deck=validateDeck({id:randomUUID(),title:outline.title,mode:outline.mode,themeId:draft.themeId,slides:draft.slides},outline);
    deck.title=outline.title;this.verifySources(state,deck.slides);this.styleDeck(state,deck,outline);
    const typography=state.settings.typographyId;deck.typographyId=typography&&typography!=='auto'?typography:outline.typographyId??deck.typographyId;
    deck=await this.fitText(state,improveTextFit(deck),undefined,run);
    deck=diversifyDeck(deck,randomUUID(),this.recentLayouts);assertTextFits(deck);
    return deck;
  }
  private generationRecovery(state:SessionState,outline:Outline,stage:'content'|'text-fit',canRetry:boolean){
    const draft=state.draft!,complete=draft.slides.length;
    const hasRemaining=stage==='text-fit'||complete<outline.slides.length;
    const retryAvailable=canRetry&&(!hasRemaining||state.session.usage.calls<SESSION_CALL_LIMIT);
    state.session.phase='outline';
    state.session.recovery={task:'generate',stage,completedSlides:complete,totalSlides:outline.slides.length,nextBatchSize:stage==='text-fit'?draft.fit!.batchSize:draft.batchSize,retryAvailable,
      message:retryAvailable?(stage==='text-fit'?`本文${complete}枚は保持しています。文字量の調整を完了できませんでした。調整済みの文章を再利用し、未調整のページだけ小分けに処理します。`:`検証できた${complete} / ${outline.slides.length}枚を保持しています。途中のページや検証が通らないページは使いません。残りは最大${draft.batchSize}枚ずつ作成します。`):`検証できた本文${complete}枚と指示・資料を保持しています。同じ1枚での不備が繰り返されたか、呼び出し回数の上限に達したため再開を止めました。構成から情報を分けるか、優先する条件を整理してください。`};
    return state.session;
  }

  async revise(id: string, input: { slideId?: unknown; instruction?: unknown; variantId?: unknown }) {
    return this.lock(id,state=>this.performRevision(state,input),true,true);
  }
  async retryRevision(id:string){
    return this.lock(id,async state=>{
      const pending=state.revision;
      if(!pending||state.session.recovery?.task!=='revise')throw new AppError(409,'再開する修正指示がありません。');
      if(!state.session.recovery.retryAvailable)throw new AppError(429,'この修正の再試行を止めました。優先する条件を整理して再送してください。追加の呼び出しは行っていません。');
      return this.performRevision(state,{slideId:pending.slideId,variantId:pending.variantId,instruction:pending.instruction},true);
    },true,true);
  }
  private async performRevision(state:SessionState,input:{slideId?:unknown;instruction?:unknown;variantId?:unknown},resume=false,force=false){
      if (state.session.phase !== 'ready') throw new AppError(409, 'スライドを作成してから修正してください。');
      const variant = this.variant(state, input.variantId);
      const slide = variant.deck.slides.find((slide) => slide.id === input.slideId);
      if (!slide) throw new AppError(404, '修正するスライドが見つかりません。');
      const instruction = requireText(input.instruction, '修正指示', MAX_PROMPT_CHARACTERS);
      this.checkConversation([...state.session.messages,{role:'user',text:instruction}]);
      if(state.settings.provider==='chat'){
        this.checkChatMode(state);
        const pending:ChatDraft={task:'revise',payload:{outline:state.session.outline,targetSlide:slide,instruction},purpose:'revise',variantBase:JSON.stringify(variant.deck),variantId:variant.id,instruction,targetIds:[slide.id]};
        state.chat=pending;this.exposeChat(state);return state.session;
      }
      const base=JSON.stringify(variant.deck);
      let pending=state.revision;
      if(resume&&pending?.base!==base)throw new AppError(409,'修正対象の資料が変更されました。現在のスライドへ指示を送り直してください。');
      if(!pending||pending.base!==base||pending.slideId!==slide.id||pending.variantId!==variant.id||pending.instruction!==instruction){pending={base,variantId:variant.id,slideId:slide.id,instruction,title:slide.title,failures:0,compact:false};state.revision=pending;}
      if(pending.failures>=3&&!force)throw new AppError(429,'同じ修正の不備が繰り返されました。優先する条件を整理して再送してください。');
      while(!pending.result){
        const warnings=[...state.session.warnings];
        try{
          const raw=state.settings.provider==='demo'?{...slide,headline:instruction.slice(0,120),notes:`${DEMO_WARNING}\n修正指示: ${instruction}`}:await this.complete(state,'revise',{outline:state.session.outline,targetSlide:slide,instruction,compactOutput:pending.compact,compressionLevel:pending.failures},pending.compact?16_000:8_000);
          if((raw as any)?.id!==slide.id)throw new AppError(422,'修正されたページの識別子が一致しません。','INVALID_CONTENT');
          const result=validateSlide(raw,slide.id);
          if((slide.layoutId==='cover')!==(result.layoutId==='cover'))throw new AppError(422,'表紙と本文の役割は変更できません。','INVALID_CONTENT');
          this.verifySources(state,[result]);pending.result=result;
        }catch(error){
          state.session.warnings=warnings;
          if(!repairReason(error)&&!(error instanceof AppError&&error.code==='CALL_LIMIT'))throw error;
          pending.failures++;pending.compact=true;
          if(pending.failures<3&&this.tryRepair(state,'revise',error,`修正対象の1枚だけを、回答枠16,000トークンで再試行。ノートは通常${pending.failures>=2?200:400}文字を目安に重複を減らし、必須条件・図表・ページ番号・出典を再確認します。`))continue;
          return this.revisionRecovery(state,pending,'content');
        }
      }
      if(!pending.fit)pending.fit={deck:improveTextFit({...variant.deck,slides:variant.deck.slides.map(s=>s.id===slide.id?pending.result!:s)}),batchSize:READING_BATCH_SIZE,singleFailures:0};
      if(force)pending.fit.force=true;
      let fitted:DeckSpec;
      try{fitted=await this.fitText(state,pending.fit.deck,pending.fit);}
      catch(error){if(!repairReason(error)&&!(error instanceof AppError&&error.code==='CALL_LIMIT'))throw error;pending.failures++;return this.revisionRecovery(state,pending,'text-fit');}
      const result=fitted.slides.find(s=>s.id===slide.id)!;
      const changes=Object.entries({title:'見出し',headline:'要旨',body:'本文',items:'項目',notes:'発表者ノート',sources:'出典',chart:'グラフ',table:'表',diagram:'図解',equation:'数式',layoutId:'構図'}).filter(([key])=>JSON.stringify(slide[key as keyof SlideSpec])!==JSON.stringify(result[key as keyof SlideSpec])).map(([,label])=>label);
      if(state.session.repairReport)state.session.repairReport.changes=changes;
      // Variants compare the same content; a content edit invalidates all exports and updates both.
      for (const item of state.session.variants) { item.deck.slides = item.deck.slides.map((old) => old.id === slide.id ? structuredClone(result) : old); delete item.render; }
      if (state.session.outline) {
        const entry = state.session.outline.slides.find((entry) => entry.id === slide.id);
        if (entry) { entry.title = result.title; entry.layoutId = result.layoutId; }
      }
      state.session.messages.push({ role: 'user', text: `「${slide.title}」の修正: ${instruction}` }, { role: 'assistant', text: `指定したスライドの${changes.length?changes.join('・'):'内容（変更なし）'}を確認し、比較案にも同じ内容を反映しました。` });
      delete state.revision;delete state.session.recovery;
      return state.session;
  }
  private revisionRecovery(state:SessionState,pending:RevisionDraft,stage:'content'|'text-fit'){
    state.session.recovery={task:'revise',stage,slideId:pending.slideId,retryAvailable:pending.failures<3&&(pending.fit?.singleFailures??0)<2&&state.session.usage.calls<SESSION_CALL_LIMIT,
      message:stage==='text-fit'?'修正する本文は保持していますが、文字量の調整を完了できませんでした。修正前のスライドを保持しています。保存した指示から調整だけを再開できます。':'修正指示を保持しています。検証が通る修正を作れなかったため、修正前のスライドはそのままです。優先条件を整理して再送することもできます。'};
    return state.session;
  }

  private checkChatMode(state:SessionState){
    if(state.settings.provider!=='chat')throw new AppError(409,'この作業は月額版との連携ではありません。');
    if(this.options.settings.get().provider!=='chat')throw new AppError(409,'処理先が変更されています。月額版との連携に戻すか、新しく作成してください。');
  }
  private prepareChatPlan(state:SessionState,messages:Session['messages']){
    this.checkChatMode(state);delete state.draft;delete state.revision;delete state.session.recovery;
    state.session.messages=messages;
    state.chat={task:'plan',payload:{messages,currentOutline:state.session.outline,needsInputBrief:messages.filter(m=>m.role==='user').reduce((sum,m)=>sum+m.text.length,0)>12_000,compactOutline:true,...(state.oneShot&&!state.session.variants.length?{oneShot:true}:{})},messages};
    this.exposeChat(state);
  }
  private prepareChatGeneration(state:SessionState,outline:Outline,issues?:string[],correctionCode?:string,start?:{purpose:'generate'|'alternate';service?:ChatService}){
    this.checkChatMode(state);
    const purpose=start?.purpose??(state.chat?.purpose==='alternate'?'alternate':'generate'),service=start?.service??(purpose==='alternate'?state.chat?.service:undefined);
    const key=JSON.stringify({outline,messages:state.session.messages,settings:state.settings,purpose,service});
    if(state.draft?.key!==key)state.draft={key,slides:[],themeId:outline.themeId??this.preferredTheme,batchSize:this.freeDesign(state)?FREE_CHAT_BATCH_SIZE:outline.mode==='reading'?CHAT_READING_BATCH_SIZE:CHAT_GENERATION_BATCH_SIZE,singleFailures:0,compact:false};
    const draft=state.draft,targetSlides=outline.slides.slice(draft.slides.length,draft.slides.length+draft.batchSize);
    if(!targetSlides.length)throw new AppError(409,'本文は作成済みです。現在表示されている文字量調整の指示を使用してください。');
    state.chat={full:state.chat?.full,task:'generate',purpose,...(service?{service}:{}),targetIds:targetSlides.map(s=>s.id),payload:{outline,targetSlides,messages:state.session.messages,compactOutput:true,continuedFrom:draft.slides.map(continued)}};
    this.exposeChat(state,issues,correctionCode);
  }
  private exposeChat(state:SessionState,issues?:string[],correctionCode?:string){
    const pending=state.chat!;
    const request={...pending.payload};
    if(pending.task==='generate'&&request.outline?.inputBrief){request.confirmedInstructions=request.outline.inputBrief;delete request.messages;}
    const selected=pending.task==='generate'?request.targetSlides?.map((s:any)=>s.layoutId):pending.task==='revise'?[request.targetSlide?.layoutId]:undefined;
    const current=this.options.settings.get(),service=pending.service??current.chatService??'chatgpt',link=current.chatProjects?.[service];
    const projectMode=!!link&&link.kitVersion===aiKitVersion()&&!pending.full&&pending.task!=='summarize'&&this.freeDesign(state);
    const candidateIds=selected?candidateLayoutIds(selected):undefined;
    const masker=this.masking(state);
    state.session.chatHandoff=prepareChatHandoff({task:pending.task,service,candidateIds,...(pending.task==='summarize'?(masker?{system:systemPrompt('summarize')+'\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。'}:{}):{system:(masker?(text:string)=>text+'\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。':(text:string)=>text)(systemPrompt(pending.task as ModelTask,candidateIds,{mode:projectMode?'project':'full',focusIds:selected,oneShot:request.oneShot===true,...this.designOptions(state,request.outline)}))}),serviceUrl:link?.url,instructionMode:projectMode?'project':'full',projectStale:!!link&&link.kitVersion!==aiKitVersion(),content:(masker?<T,>(value:T)=>masker.maskDeep(value):<T,>(value:T)=>value)({mode:state.settings.mode,projectContext:{audience:state.project.audience,designAndWritingGuidance:state.project.guidance},preferences:{...this.stylePreferences(state),...(pending.task==='plan'&&!this.freeDesign(state)?{recentLayouts:this.recentLayouts.slice(-40),variationSeed:state.session.id}:{})},documents:pending.task==='summarize'?[]:documentContext(state.documents),request}),...(pending.purpose==='generate'?{completedSlides:state.draft?.slides.length??0,totalSlides:state.session.outline?.slides.length}:{}),...(pending.purpose==='revise'?{slideId:pending.targetIds?.[0]}:{}),validationIssues:issues,correctionCode});
    if(masker)this.recordMasked(state,masker,pending.task,service);
    delete state.session.recovery;
  }
  async cancelChat(id:string){
    return this.lock(id,async state=>{
      if(state.chat?.task!=='design')this.checkChatMode(state);delete state.chat;delete state.draft;delete state.revision;delete state.session.chatHandoff;delete state.session.recovery;
      state.session.phase=state.session.variants.length?'ready':state.session.outline?'outline':'clarifying';return state.session;
    },false);
  }
  async chatResponse(id:string,input:{requestId?:unknown;response?:unknown}){
    return this.lock(id,async state=>{
      const pending=state.chat;
      if(pending?.task==='design')return this.designResponse(state,pending,input);
      this.checkChatMode(state);
      if(!pending||!state.session.chatHandoff)throw new AppError(409,'取り込むAIの指示がありません。');
      if(typeof input.requestId!=='string'||input.requestId!==state.session.chatHandoff.requestId)throw new AppError(409,'古い指示への返答です。現在表示されている指示と返答を使用してください。','STALE_CHAT_RESPONSE');
      if(pending.purpose==='revise'){
        const variant=this.variant(state,pending.variantId);
        if(JSON.stringify(variant.deck)!==pending.variantBase)throw new AppError(409,'修正対象が変更されました。現在のスライドに指示を送り直してください。','STALE_CHAT_RESPONSE');
      }
      const warnings=[...state.session.warnings],priorDraftCount=state.draft?.slides.length??0;
      try{
        const raw=this.unmask(state,parseChatResponse(input.response));
        if(pending.task==='plan'&&(raw as any)?.kind==='deck'){
          if(!pending.payload.oneShot)throw new AppError(422,'今回は構成の確認です。kindをquestionsまたはoutlineにして返してください。','INVALID_CONTENT');
          await this.acceptOneShot(state,pending,raw as any);return state.session;
        }
        if(pending.task==='plan'){
          const result=validatePlanResponse(raw);
          if(result.outline){
            if(result.outline.mode!==state.settings.mode)throw new AppError(422,'構成案のモードが設定と異なります。','INVALID_CONTENT');
            this.checkSlideCount(state,result.outline);
            const original=(raw as any).outline.slides;
            if(original.some((s:any,i:number)=>s.id!==`slide-${i+1}`))throw new AppError(422,'構成案のページIDはslide-1から順番に指定してください。','INVALID_CONTENT');
            for(const s of result.outline.slides)if(s.sourceIds?.some(id=>!state.documents.some(d=>d.id===id)))throw new AppError(422,'構成案に資料にない出典IDがあります。','INVALID_SOURCE');
          }
          state.session.messages=pending.messages??state.session.messages;
          if(result.question){state.session.phase='clarifying';state.session.messages.push({role:'assistant',text:result.question});}
          else{state.session.outline=result.outline;state.session.phase='outline';state.session.messages.push({role:'assistant',text:'AIの構成案を取り込みました。順番と条件を確認してから作成してください。'});}
          delete state.chat;delete state.session.chatHandoff;return state.session;
        }
        if(pending.task==='generate'){
          const outline=state.session.outline!,draft=state.draft!,targetIds=pending.targetIds!;
          const value=raw as any;
          if(!value||value.mode!==outline.mode||!Array.isArray(value.slides)||value.slides.length!==targetIds.length||value.slides.some((s:any,i:number)=>s?.id!==targetIds[i]))throw new AppError(422,'返答のページID・順序・枚数・モードが今回の対象と一致しません。','INVALID_CONTENT');
          const slides=value.slides.map((s:unknown,i:number)=>validateSlide(s,targetIds[i]));
          if(slides.some((s:SlideSpec)=>(s.id==='slide-1')!==(s.layoutId==='cover')))throw new AppError(422,'表紙と本文の役割を変更できません。','INVALID_CONTENT');
          this.verifySources(state,slides);
          const themeId=knownTheme(value.themeId)?value.themeId:draft.themeId;
          draft.slides.push(...slides);if(draft.slides.length===slides.length)draft.themeId=themeId;
          if(draft.slides.length<outline.slides.length){this.prepareChatGeneration(state,outline);return state.session;}
          let deck=validateDeck({id:randomUUID(),title:outline.title,mode:outline.mode,themeId:draft.themeId,slides:draft.slides},outline);
          this.styleDeck(state,deck,outline);
          deck.typographyId=state.settings.typographyId&&state.settings.typographyId!=='auto'?state.settings.typographyId:outline.typographyId;
          await this.finishChatDeck(state,improveTextFit(deck),pending);return state.session;
        }
        if(pending.task==='revise'){
          const variant=this.variant(state,pending.variantId),old=pending.payload.targetSlide as SlideSpec;
          if((raw as any)?.id!==old.id)throw new AppError(422,'修正するページIDが一致しません。','INVALID_CONTENT');
          const slide=validateSlide(raw,old.id);
          if((slide.layoutId==='cover')!==(old.layoutId==='cover'))throw new AppError(422,'表紙と本文の役割を変更できません。','INVALID_CONTENT');
          this.verifySources(state,[slide]);
          this.verifyRevisionValues(old,slide,pending.instruction!,state);
          await this.finishChatDeck(state,improveTextFit({...variant.deck,slides:variant.deck.slides.map(s=>s.id===old.id?slide:s)}),pending);return state.session;
        }
        const deck=pending.summaryDeck!,ids=pending.payload.slides.map((s:any)=>s.slideId);
        const fitted=applySummaries(deck,raw,ids);
        if(fitProblems(fitted).some(p=>ids.includes(p.slideId)))throw new AppError(422,'要約後も文章が枠に収まりません。指定の文字量へ短くしてください。','TEXT_FIT_REQUIRED');
        await this.finishChatDeck(state,fitted,pending);return state.session;
      }catch(error){
        state.session.warnings=warnings;
        if(pending.task==='generate'&&state.chat===pending&&state.draft)state.draft.slides.splice(priorDraftCount);
        if(!(error instanceof AppError)||(!repairReason(error)&&!['CHAT_RESPONSE_REQUIRED','CHAT_RESPONSE_TOO_LARGE'].includes(error.code)))throw error;
        // A reply that is not complete JSON was often cut off by the chat's output
        // limit. Ask for half as many slides; validated slides are kept.
        if(pending.task==='generate'&&state.draft&&state.session.outline&&['INVALID_MODEL_JSON','CHAT_RESPONSE_TOO_LARGE'].includes(error.code)&&(pending.targetIds?.length??0)>1){
          state.draft.batchSize=Math.max(1,Math.ceil(pending.targetIds!.length/2));
          this.prepareChatGeneration(state,state.session.outline,[`${error.message} 返答が長すぎて途中で切れた可能性があるため、今回の対象を${state.draft.batchSize}枚に減らしました。`],error.code);return state.session;
        }
        // Keep old slides, original instructions and validated batches. Never
        // replay raw failed responses as instructions to an external model.
        this.exposeChat(state,[error.message],error.code);return state.session;
      }
    },false);
  }
  /** Uses the self-contained instruction for the current request, e.g. when the
   * chat could not read the project's catalog file. */
  async useFullInstruction(id:string){
    return this.lock(id,async state=>{this.checkChatMode(state);if(!state.chat||!state.session.chatHandoff)throw new AppError(409,'切り替えるAIへの指示がありません。');if(state.chat.task==='design')throw new AppError(409,'デザインだけの依頼は、常に完全な指示です。');state.chat.full=true;this.exposeChat(state,state.session.chatHandoff.validationIssues);return state.session;},false);
  }
  /** Outline and every slide returned at once (manual chat, "一度に作る"). The
   * same validation as the batch path applies; nothing is accepted partially. */
  private async acceptOneShot(state:SessionState,pending:ChatDraft,raw:{outline?:unknown;deck?:any}){
    const outline=validateOutline(raw.outline);
    if(outline.mode!==state.settings.mode)throw new AppError(422,'構成案のモードが設定と異なります。','INVALID_CONTENT');
    this.checkSlideCount(state,outline);
    for(const s of outline.slides)if(s.sourceIds?.some(id=>!state.documents.some(d=>d.id===id)))throw new AppError(422,'構成案に資料にない出典IDがあります。','INVALID_SOURCE');
    const value=raw.deck;
    if(!value||!Array.isArray(value.slides)||value.slides.length!==outline.slides.length||value.slides.some((s:any,i:number)=>s?.id!==outline.slides[i].id))throw new AppError(422,'deckのページID・順序・枚数がoutlineと一致しません。全ページを同じidで返してください。','INVALID_CONTENT');
    const slides=value.slides.map((s:unknown,i:number)=>validateSlide(s,outline.slides[i].id));
    if(slides.some((s:SlideSpec)=>(s.id==='slide-1')!==(s.layoutId==='cover')))throw new AppError(422,'表紙と本文の役割が構成と一致しません。','INVALID_CONTENT');
    this.verifySources(state,slides);
    let deck=validateDeck({id:randomUUID(),title:outline.title,mode:outline.mode,themeId:outline.themeId??this.preferredTheme,slides},outline);
    this.styleDeck(state,deck,outline);
    deck.typographyId=state.settings.typographyId&&state.settings.typographyId!=='auto'?state.settings.typographyId:outline.typographyId;
    state.session.messages=pending.messages??state.session.messages;state.session.outline=outline;
    deck=improveTextFit(deck);
    await this.finishChatDeck(state,deck,{...pending,purpose:'generate'});
  }
  private verifyRevisionValues(old:SlideSpec,revised:SlideSpec,instruction:string,state:SessionState){
    // Compare exact decimal values without rounding or unit conversion. A
    // percentage label may back a numeric chart value only with its original
    // unit retained by the author; this check does not prove unit semantics.
    const canonical=(token:string)=>{
      const normalized=token.normalize('NFKC').replace(/,/g,'').replace(/[−△]/g,'-').replace(/^\+/,'').replace(/%$/,'');
      const match=/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(normalized);
      if(!match)return normalized;
      const exponent=Number(match[4]??0);
      if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>1000)return normalized;
      const digits=match[2]+(match[3]??''),point=match[2].length+exponent;
      const expanded=point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
      const [integer,fraction='']=expanded.split('.'),whole=integer.replace(/^0+(?=\d)/,''),tail=fraction.replace(/0+$/,'');
      const value=whole+(tail?'.'+tail:'');return (match[1]&&value!=='0'?'-':'')+value;
    };
    const numbers=(text:string)=>Array.from(text.normalize('NFKC').match(/[+−△-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+−-]?\d+)?%?/g)??[]).map(canonical);
    const existingText=[old.title,old.headline,old.body,old.notes,...old.items.flatMap(i=>[i.label,i.description,i.value]),...(old.diagram?.items.flatMap(i=>[i.label,i.description,i.value])??[]),...(old.table?.headers??[]),...(old.table?.rows.flat()??[]),old.chart?.caption,old.chart?.unit,old.equation?.text,old.equation?.explanation,...designTexts(old)].filter((v):v is string=>typeof v==='string').join(' ');
    const chartsOf=(slide:SlideSpec)=>[slide.chart,...(slide.design?.elements.flatMap(e=>e.t==='chart'?[e.chart]:[])??[])].filter((c):c is NonNullable<SlideSpec['chart']>=>!!c);
    const allowed=new Set([...numbers(instruction+' '+existingText),...chartsOf(old).flatMap(c=>c.series.flatMap(s=>s.values.map(v=>canonical(String(v)))))]);
    for(const source of revised.sources){const document=state.documents.find(d=>d.id===source.documentId);const unit=document?.sources.find(u=>u.locator===source.locator);for(const value of numbers(unit?.text??''))allowed.add(value);}
    const newValues=[...chartsOf(revised).flatMap(c=>c.series.flatMap(s=>s.values.map(v=>canonical(String(v))))),...revised.items.flatMap(i=>numbers(i.value??'')),...(revised.design?.elements.flatMap(e=>e.t==='text'&&e.role==='number'?numbers(e.text):[])??[])];
    if(newValues.some(v=>!allowed.has(v)))throw new AppError(422,'修正で根拠のない数値が追加されました。元の数値、指示で指定した数値、または実在する出典の数値を使用してください。','INVALID_CONTENT');
  }
  private async finishChatDeck(state:SessionState,deck:DeckSpec,pending:ChatDraft){
    if(pending.purpose==='generate'&&state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,false,this.templateTheme(state)).deck;
    const problems=fitProblems(deck).slice(0,READING_BATCH_SIZE);
    if(problems.length){
      state.chat={...pending,task:'summarize',payload:{slides:problems},summaryDeck:deck};this.exposeChat(state);return;
    }
    this.verifySources(state,deck.slides);assertTextFits(deck);
    if(pending.purpose==='revise'){
      const variant=this.variant(state,pending.variantId),id=pending.targetIds![0],old=variant.deck.slides.find(s=>s.id===id)!,result=deck.slides.find(s=>s.id===id)!;
      const labels:Record<string,string>={title:'見出し',headline:'要旨',body:'本文',items:'項目',notes:'発表者ノート',sources:'出典',chart:'グラフ',table:'表',diagram:'図解',equation:'数式',layoutId:'構図'};
      const changes=Object.entries(labels).filter(([key])=>JSON.stringify(old[key as keyof SlideSpec])!==JSON.stringify(result[key as keyof SlideSpec])).map(([,label])=>label);
      for(const item of state.session.variants){item.deck.slides=item.deck.slides.map(s=>s.id===id?structuredClone(result):s);delete item.render;}
      const entry=state.session.outline?.slides.find(s=>s.id===id);if(entry){entry.title=result.title;entry.layoutId=result.layoutId;}
      state.session.messages.push({role:'user',text:`「${old.title}」の修正: ${pending.instruction}`},{role:'assistant',text:`AIの返答を検証し、${changes.length?changes.join('・'):'内容（変更なし）'}を反映しました。外部APIの呼び出しはありません。`});
    }else if(pending.purpose==='alternate'){
      deck=diversifyDeck(deck,state.session.id,this.recentLayouts);assertTextFits(deck);
      const ai=chatServiceName(pending.service??'other');
      state.session.variants.push({id:randomUUID(),label:ai,deck,origin:{kind:'ai',ai}});
      state.session.messages.push({role:'assistant',text:`${ai}の案を追加しました。同じページを並べて比べ、ページごとに内容とデザインを組み合わせられます。`});
    }else{
      deck=diversifyDeck(deck,state.session.id,this.recentLayouts);
      if(state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,true,this.templateTheme(state)).deck;
      assertTextFits(deck);
      const ai=chatServiceName(state.chat?.service??this.options.settings.get().chatService??state.settings.chatService??'chatgpt');
      state.session.variants=[{id:randomUUID(),label:ai,deck,origin:{kind:'ai',ai}}];await this.rememberLayouts(deck,state.session);
      state.session.messages.push({role:'assistant',text:`AIの返答から${deck.slides.length}枚を作成しました。検証済みのページを再利用し、外部APIは呼び出していません。`});
    }
    state.session.phase='ready';delete state.chat;delete state.session.chatHandoff;delete state.draft;delete state.revision;delete state.session.recovery;
    await this.persist(state);
  }

  async variants(id: string) {
    return this.lock(id, async (state) => {
      if (state.session.phase !== 'ready' || !state.session.variants.length) throw new AppError(409, '先にスライドを作成してください。');
      if (state.session.variants.length >= MAX_VARIANTS) throw new AppError(409, `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
      let deck = structuredClone(state.session.variants[0].deck);
      deck.id = randomUUID();
      const candidates=Object.keys(themes).filter(id=>id!==deck.themeId);
      deck.themeId = candidates.includes(this.preferredTheme) ? this.preferredTheme : candidates[(candidates.indexOf('midnight')+candidates.length)%candidates.length];
      delete deck.customTheme;
      deck = diversifyDeck(deck,randomUUID(),[...this.recentLayouts,...deck.slides.map(s=>s.layoutId)]);
      assertTextFits(deck);
      state.session.variants.push({ id: randomUUID(), label: 'テーマ違い', deck, origin:{kind:'restyle',parents:[state.session.variants[0].id]} });
      state.session.messages.push({ role: 'assistant', text: '同じ内容でテーマと構図の比較案を作成しました。文字が収まる候補から選び、追加のAI呼び出しはありません。' });
      return state.session;
    });
  }

  /** Creates the same approved outline with another AI chat (manual hand-off). The
   * result is added as a separate draft; the existing drafts are kept. */
  async alternate(id:string,input:{service?:unknown;direct?:unknown;cloudConsent?:unknown}){
    if(input.direct===true)return this.lock(id,async state=>{
      if(state.session.phase!=='ready'||!state.session.outline||!state.session.variants.length)throw new AppError(409,'先にスライドを作成してください。');
      if(state.session.chatHandoff)throw new AppError(409,'進行中のAIとの受け渡しを終えるか取り消してから作成してください。');
      if(state.session.variants.length>=MAX_VARIANTS)throw new AppError(409,`比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
      const target=input.service;
      if(target!=='chatgpt'&&target!=='claude')throw new AppError(400,'直接作れるのは、設定で接続したClaudeかChatGPTです。');
      if(input.cloudConsent!==true)throw new AppError(400,`${chatServiceName(target)}へ指示・資料・会話を送ることを確認してください。`,'CLOUD_CONSENT_REQUIRED');
      const binding=this.options.subscriptionBinding?.(target);
      if(!binding)throw new AppError(409,`設定から${chatServiceName(target)}のアカウントに接続してください。`,'SUBSCRIPTION_CONNECTION_REQUIRED');
      state.bindings={...state.bindings,[target]:binding};
      const run=this.newRun(state,target),deck=await this.draftFor(state,state.session.outline,run);
      state.session.variants.push({id:randomUUID(),label:run.label,deck,origin:{kind:'ai',ai:run.label,...(run.notes.length?{notes:run.notes.map(n=>`自動で対処：${n}`)}:{})}});
      state.session.messages.push({role:'assistant',text:`${run.label}でも同じ構成の案を作りました（AIの呼び出し${run.calls}回）。並べて比べたり、ページごとに組み合わせたりできます。`});
      return state.session;
    });
    return this.lock(id,async state=>{
      this.checkChatMode(state);
      if(state.session.phase!=='ready'||!state.session.outline||!state.session.variants.length)throw new AppError(409,'先にスライドを作成してください。');
      if(state.session.chatHandoff)throw new AppError(409,'進行中のAIとの受け渡しを終えるか取り消してから作成してください。');
      if(state.session.variants.length>=MAX_VARIANTS)throw new AppError(409,`比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
      const service=input.service;
      if(typeof service!=='string'||!['chatgpt','claude','gemini','copilot','other'].includes(service))throw new AppError(400,'案を作るAIを一覧から選んでください。');
      delete state.draft;
      this.prepareChatGeneration(state,state.session.outline,undefined,undefined,{purpose:'alternate',service:service as ChatService});
      return state.session;
    },false);
  }
  /** Builds a new draft page by page: the content of one draft set in the design of
   * another. Nothing is generated; a page whose places do not match keeps the design
   * of its content's draft, and the reason is reported. */
  async combine(id:string,input:{picks?:unknown;themeFrom?:unknown}){
    return this.lock(id,async state=>{
      const variants=state.session.variants;
      if(state.session.phase!=='ready'||variants.length<2)throw new AppError(409,'組み合わせるには2つ以上の案が必要です。');
      if(state.session.chatHandoff)throw new AppError(409,'進行中のAIとの受け渡しを終えてから組み合わせてください。');
      const base=variants[0].deck,count=base.slides.length;
      if(variants.some(v=>v.deck.slides.length!==count||v.deck.slides.some((s,i)=>s.id!==base.slides[i].id)))throw new AppError(409,'ページ数が違う案は組み合わせられません。');
      if(!Array.isArray(input.picks)||input.picks.length!==count)throw new AppError(400,'すべてのページについて、内容とデザインの案を選んでください。');
      const picks=(input.picks as any[]).map(p=>({content:this.variant(state,p?.content),design:this.variant(state,p?.design)}));
      const themeSource=this.variant(state,input.themeFrom??picks[0].design.id);
      const notes:string[]=[],slides:SlideSpec[]=[];
      picks.forEach(({content,design},i)=>{
        const page=content.deck.slides[i],target=design.deck.slides[i];
        if(content.id===design.id){slides.push(structuredClone(page));return;}
        const result=target.design?transplant(page,target):!page.design?{slide:{...structuredClone(page),layoutId:target.layoutId}}:{reason:'デザイン側のページが型で作られているため、配置を取り出せません。'};
        const fits=result.slide&&(target.design||fittingLayouts({...themeSource.deck,slides:[page]},page).some(l=>l.id===target.layoutId))&&!fitProblems({...themeSource.deck,slides:[result.slide]}).length;
        if(result.slide&&fits){slides.push(result.slide);return;}
        slides.push(structuredClone(page));
        notes.push(`${i+1}枚目：${result.slide?'文字がデザインの枠に収まりません。':result.reason}内容側（${content.label}）のデザインのままにしました。`);
      });
      const deck=validateDeck({...structuredClone(themeSource.deck),id:randomUUID(),slides});
      if(themeSource.deck.customTheme)deck.customTheme=structuredClone(themeSource.deck.customTheme);
      if(themeSource.deck.typographyId)deck.typographyId=themeSource.deck.typographyId;
      deck.title=base.title;
      this.verifySources(state,deck.slides);assertTextFits(deck);
      const existing=variants.findIndex(v=>v.origin?.kind==='combined');
      const variant:DeckVariant={id:randomUUID(),label:'組み合わせ',deck,origin:{kind:'combined',parents:[...new Set(picks.flatMap(p=>[p.content.id,p.design.id]))],notes}};
      if(existing>=0)variants[existing]=variant;else if(variants.length<MAX_VARIANTS)variants.push(variant);else throw new AppError(409,`比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから組み合わせてください。`);
      await this.recordChoices(picks.map(p=>({content:p.content.origin?.ai??p.content.label,design:p.design.origin?.ai??p.design.label})));
      state.session.messages.push({role:'assistant',text:`${count}枚を組み合わせた案を作りました。${notes.length?`${notes.length}枚は配置が合わないため、内容側のデザインのままです。`:''}AIは呼び出していません。`});
      return state.session;
    });
  }
  /** Asks a chat AI for a design only. The AI receives the places of each slide
   * (role, length, dummy sample), chart and table shapes and colour names; the
   * wording, numbers, documents, conversation and project notes stay on this PC.
   * Works for decks made by any provider, including a local LLM. */
  async requestDesign(id:string,input:{variantId?:unknown;service?:unknown;level?:unknown;topic?:unknown;direct?:unknown}){
    return this.lock(id,async state=>{
      if(state.session.phase!=='ready'||!state.session.variants.length)throw new AppError(409,'先にスライドを作成してください。');
      if(state.session.chatHandoff)throw new AppError(409,'進行中のAIとの受け渡しを終えるか取り消してから依頼してください。');
      if(state.session.variants.length>=MAX_VARIANTS)throw new AppError(409,`比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから依頼してください。`);
      const variant=this.variant(state,input.variantId),service=input.service;
      if(typeof service!=='string'||!['chatgpt','claude','gemini','copilot','other'].includes(service))throw new AppError(400,'デザインを頼むAIを一覧から選んでください。');
      if(input.level!=='structure'&&input.level!=='topic')throw new AppError(400,'送る範囲を選んでください。');
      let topic:string|undefined;
      if(input.level==='topic'){
        if(typeof input.topic!=='string'||!input.topic.trim()||input.topic.length>40||/[\r\n]/.test(input.topic))throw new AppError(400,'送ってよい話題名を40文字以内で入力してください（例：四半期の業績報告）。');
        topic=input.topic.trim();
      }
      if(input.direct===true){
        // Sent straight to the connected account: retries and text fitting happen here, with no copying.
        if(service!=='chatgpt'&&service!=='claude')throw new AppError(400,'直接送れるのは、設定で接続したClaudeかChatGPTです。');
        const binding=this.options.subscriptionBinding?.(service);
        if(!binding)throw new AppError(409,`設定から${chatServiceName(service)}のアカウントに接続してください。`,'SUBSCRIPTION_CONNECTION_REQUIRED');
        state.bindings={...state.bindings,[service]:binding};
        const run=this.newRun(state,service),designed=await this.designPages(state,variant.deck,input.level,topic,run);
        state.session.variants.push({id:randomUUID(),label:`デザイン：${run.label}`,deck:designed,origin:{kind:'ai',ai:run.label,parents:[variant.id],notes:[`${run.label}には内容を送らず、${input.level==='topic'?`許可した話題名「${topic}」と`:''}文字の枠の役割・文字数・グラフと表の形だけを渡しました。`,...run.notes.map(n=>`自動で対処：${n}`)]}});
        state.session.messages.push({role:'assistant',text:`${run.label}のデザインに、このPCで内容を入れた案を追加しました。内容・数値・資料は送信していません（AIの呼び出し${run.calls}回）。`});
        await this.persist(state);
        return state.session;
      }
      const ids=variant.deck.slides.map(s=>s.id),{contents}=designRequest(variant.deck,ids,input.level,topic);
      state.chat={task:'design',purpose:'design',service:service as ChatService,payload:{},design:{variantId:variant.id,level:input.level,topic,ids,done:[],contents,base:JSON.stringify(variant.deck)}};
      await this.exposeDesign(state);
      return state.session;
    },false);
  }
  /** Everything the user typed, uploaded or received for this deck. Nothing of it may
   * appear in a design-only request. */
  private protectedTexts(state:SessionState,deck:DeckSpec){
    return [...state.documents.flatMap(d=>[d.name,...d.sources.map(u=>u.text)]),...state.session.messages.map(m=>m.text),state.project.audience,state.project.guidance,state.project.name,deck.title,
      ...deck.slides.flatMap(s=>[s.title,s.notes,...slideContent(s).texts.map(t=>t.text),...slideContent(s).charts.flatMap(c=>[...c.categories,...c.series.map(x=>x.name),c.caption??'',c.unit??'',...c.series.flatMap(x=>x.values.map(String))]),...slideContent(s).tables.flatMap(t=>[...t.headers,...t.rows.flat()]),...s.sources.map(x=>x.quote??'')])].filter(Boolean);
  }
  private async exposeDesign(state:SessionState,issues?:string[]){
    const pending=state.chat!,draft=pending.design!,variant=this.variant(state,draft.variantId);
    const remaining=draft.ids.filter(id=>!draft.done.some(s=>s.id===id)),batch=remaining.slice(0,FREE_CHAT_BATCH_SIZE);
    const {packet}=designRequest(variant.deck,batch,draft.level,draft.topic);
    // The packet is built only from roles, lengths and dummy samples; this check proves
    // it holds none of the protected wording or numbers before anything is shown.
    const protectedTexts=this.protectedTexts(state,variant.deck),check=leakCheck(packet,protectedTexts,draft.topic?[draft.topic]:[]);
    if(check.hits.length)throw new AppError(422,`送信内容に資料・本文と同じ文字（${check.hits.length}件）が見つかったため、指示の作成を止めました。`,'DESIGN_LEAK_BLOCKED');
    // Correction notes are sent too; if one ever names real wording, a generic note replaces it.
    if(issues?.length&&phraseLeak(issues,[...protectedTexts.filter(t=>!state.session.messages.some(m=>m.role==='assistant'&&m.text===t))]))issues=['前の返答に不備がありました。すべてのslotを1回ずつ、文字数が収まる大きさで、枠が重ならないように配置してください。'];
    pending.payload=packet;
    const handoff=prepareChatHandoff({task:'design',service:pending.service??'chatgpt',system:designOnlyPrompt(draft.level),content:{request:packet},validationIssues:issues,completedSlides:draft.done.length,totalSlides:draft.ids.length});
    const hash=sha256(handoff.instruction);
    state.session.chatHandoff={...handoff,privacy:{level:draft.level,...(draft.topic?{topic:draft.topic}:{}),checkedCharacters:check.checkedCharacters,hits:0,sha256:hash,characters:handoff.instruction.length}};
    const record:SendRecord={at:new Date().toISOString(),task:'design',service:pending.service??'chatgpt',level:draft.level,...(draft.topic?{topic:draft.topic}:{}),slides:batch.length,characters:handoff.instruction.length,checkedCharacters:check.checkedCharacters,hits:0,sha256:hash};
    await appendFile(path.join(this.options.dataDir,'send-log.jsonl'),JSON.stringify(record)+'\n','utf8').catch(()=>{});
  }
  private async designResponse(state:SessionState,pending:ChatDraft,input:{requestId?:unknown;response?:unknown}){
    const draft=pending.design!;
    if(!state.session.chatHandoff||typeof input.requestId!=='string'||input.requestId!==state.session.chatHandoff.requestId)throw new AppError(409,'古い指示への返答です。現在表示されている指示と返答を使用してください。','STALE_CHAT_RESPONSE');
    const variant=this.variant(state,draft.variantId);
    if(JSON.stringify(variant.deck)!==draft.base)throw new AppError(409,'元の案が変更されました。デザインの依頼をやり直してください。','STALE_CHAT_RESPONSE');
    try{
      const raw=parseChatResponse(input.response),packet=pending.payload as DesignPacket;
      draft.done.push(...fillDesign(raw,packet,draft.contents,variant.deck));
      if(draft.done.length<draft.ids.length){await this.exposeDesign(state);return state.session;}
      const deck=validateDeck({...structuredClone(variant.deck),id:randomUUID(),slides:draft.ids.map(id=>draft.done.find(s=>s.id===id)!)});
      if(variant.deck.customTheme)deck.customTheme=structuredClone(variant.deck.customTheme);
      if(variant.deck.typographyId)deck.typographyId=variant.deck.typographyId;
      this.verifySources(state,deck.slides);assertTextFits(deck);
      const ai=chatServiceName(pending.service??'other');
      state.session.variants.push({id:randomUUID(),label:`デザイン：${ai}`,deck,origin:{kind:'ai',ai,parents:[variant.id],notes:[`${ai}には内容を送らず、${draft.level==='topic'?`許可した話題名「${draft.topic}」と`:''}文字の枠の役割・文字数・グラフと表の形だけを渡しました。`]}});
      state.session.messages.push({role:'assistant',text:`${ai}のデザインに、このPCで内容を入れた案を追加しました。内容・数値・資料は送信していません。`});
      delete state.chat;delete state.session.chatHandoff;state.session.phase='ready';
      await this.persist(state);
      return state.session;
    }catch(error){
      if(!(error instanceof AppError)||(!repairReason(error)&&!['CHAT_RESPONSE_REQUIRED','CHAT_RESPONSE_TOO_LARGE','TEXT_FIT_REQUIRED'].includes(error.code)))throw error;
      // The correction is built from slot names and dummy text only.
      await this.exposeDesign(state,[error.message]);return state.session;
    }
  }
  /** A design-only request sent directly to a connected AI, batch by batch. Only the
   * skeleton is sent (roles, lengths, dummy samples, chart and table shapes), each request
   * is checked against everything the user provided first, the reply is checked on the
   * dummy text, filled with the real content here, and slightly long text is set smaller
   * locally. Problems are retried with notes that name slots only. */
  private async designPages(state:SessionState,deck:DeckSpec,level:ShareLevel,topic:string|undefined,run:AiRun):Promise<DeckSpec>{
    const ids=deck.slides.map(s=>s.id),{contents}=designRequest(deck,ids,level,topic),protectedTexts=this.protectedTexts(state,deck),done:SlideSpec[]=[];
    let issues:string[]|undefined,batchSize=FREE_GENERATION_BATCH_SIZE;
    while(done.length<ids.length){
      const batch=ids.filter(id=>!done.some(s=>s.id===id)).slice(0,batchSize),{packet}=designRequest(deck,batch,level,topic);
      const check=leakCheck(packet,protectedTexts,topic?[topic]:[]);
      if(check.hits.length)throw new AppError(422,`送信内容に資料・本文と同じ文字（${check.hits.length}件）が見つかったため、送信を止めました。`,'DESIGN_LEAK_BLOCKED');
      // The app's own messages in the conversation are not the user's content.
      if(issues?.length&&phraseLeak(issues,protectedTexts.filter(t=>!state.session.messages.some(m=>m.role==='assistant'&&m.text===t))))issues=['前の返答に不備がありました。すべてのslotを1回ずつ、文字数が収まる大きさで、枠が重ならないように配置してください。'];
      const system=designOnlyPrompt(level),content=JSON.stringify({request:packet,...(issues?.length?{issues}:{})});
      await this.recordSend({task:'design',service:run.target,level,...(topic?{topic}:{}),slides:batch.length,checkedCharacters:check.checkedCharacters},system+content);
      try{
        const raw=await this.callDirect(state,run,system,content,Math.min(GENERATION_OUTPUT_TOKENS,3000+batch.length*3500));
        done.push(...fillDesign(raw,packet,contents,deck));issues=undefined;
        if(batchSize<FREE_GENERATION_BATCH_SIZE)batchSize++;
      }catch(error){
        const reason=repairReason(error);
        if(!(error instanceof AppError)||!reason||run.repair.remaining<=0||run.calls>=12||this.options.settings.get().autoRepair===false)throw error;
        run.repair.remaining--;run.notes.push(reason.reason);
        const broken=error instanceof OutputLimitError||error.code==='INVALID_MODEL_JSON';
        issues=[broken?'前の返答がJSONとして読めませんでした。説明を付けず、最後まで閉じたJSONだけを返してください。':error.message];
        if(broken)batchSize=Math.max(1,Math.floor(batch.length/2));
      }
    }
    const result=validateDeck({...structuredClone(deck),id:randomUUID(),slides:ids.map(id=>done.find(s=>s.id===id)!)});
    if(deck.customTheme)result.customTheme=structuredClone(deck.customTheme);
    if(deck.typographyId)result.typographyId=deck.typographyId;
    this.verifySources(state,result.slides);assertTextFits(result);
    return result;
  }
  /** Exactly the given instruction and input, to one AI (no documents or conversation are added). */
  private async callDirect(state:SessionState,run:AiRun,system:string,content:string,maxTokens:number){
    const settings=this.targetSettings(state,run.target);
    this.checkDestination(state,settings,true);
    if(run.calls>=12)throw new AppError(429,'1つの作業につきLLM呼び出しは12回までです。','CALL_LIMIT');
    const provider=(this.options.providerFactory??createProvider)(settings,this.options.settings.secret(settings.provider));
    state.session.usage.calls++;run.calls++;
    try{const response=await provider.complete({system,content,maxTokens});this.addUsage(state.session.usage,response.usage);return parseJsonResponse(response.text);}
    catch(error){
      if(error&&typeof error==='object'&&'usage' in error)this.addUsage(state.session.usage,error.usage as Usage);
      if(error instanceof OutputLimitError){try{return parseJsonResponse(error.partialText);}catch{/* Keep the output-limit error. */}}
      throw error;
    }
  }
  /** One send-log line: what was sent, how it was checked, and a fingerprint of the exact text. */
  private async recordSend(record:Omit<SendRecord,'at'|'characters'|'hits'|'sha256'>,instruction:string){
    const line:SendRecord={at:new Date().toISOString(),...record,characters:instruction.length,hits:0,sha256:sha256(instruction)};
    await appendFile(path.join(this.options.dataDir,'send-log.jsonl'),JSON.stringify(line)+'\n','utf8').catch(()=>{});
  }
  async sendLog():Promise<{records:SendRecord[]}>{
    const text=await readFile(path.join(this.options.dataDir,'send-log.jsonl'),'utf8').catch(()=>'');
    return {records:text.split('\n').filter(Boolean).slice(-50).flatMap(line=>{try{return [JSON.parse(line) as SendRecord];}catch{return [];}}).reverse()};
  }
  /** The masker of a session whose project sends masked content to a cloud AI. */
  private masking(state:SessionState):Masker|undefined{
    const privacy=(()=>{try{return this.projects.get(state.project.id).privacy;}catch{return state.project.privacy;}})();
    if((state.sendScope??privacy?.mode)!=='masked'||!['chat','subscription'].includes(state.settings.provider)&&!state.targets?.some(t=>t!=='local'))return undefined;
    state.masker??=new Masker(privacy?.terms??[]);
    return state.masker.learn([...state.documents.flatMap(d=>[d.name,...d.sources.map(u=>u.text)]),...state.session.messages.map(m=>m.text),state.project.audience,state.project.guidance]);
  }
  private unmask<T>(state:SessionState,value:T):T{
    if(!state.masker)return value;
    const {value:restored,unknown}=state.masker.unmaskDeep(value);
    if(unknown.length)throw new AppError(422,`返答に、渡していない伏せ字（${unknown.slice(0,3).join('、')}）があります。渡した伏せ字だけを、そのままの形で使ってください。`,'INVALID_CONTENT');
    return restored;
  }
  /** Proof for a masked hand-off: no masked original remains in the instruction. */
  private recordMasked(state:SessionState,masker:Masker,task:string,service:string){
    const handoff=state.session.chatHandoff!,residual=masker.residual(handoff.instruction);
    if(residual.length){delete state.session.chatHandoff;throw new AppError(422,`伏せ字にした語が指示に${residual.length}件残っているため、指示の作成を止めました。`,'MASK_LEAK_BLOCKED');}
    const hash=sha256(handoff.instruction),checked=state.documents.reduce((n,d)=>n+d.sources.reduce((m,u)=>m+u.text.length,0),0);
    handoff.privacy={level:'masked',checkedCharacters:checked,hits:0,sha256:hash,characters:handoff.instruction.length,masked:masker.size,items:masker.items()};
    const record:SendRecord={at:new Date().toISOString(),task,service,level:'masked',characters:handoff.instruction.length,checkedCharacters:checked,hits:0,sha256:hash,masked:masker.size};
    void appendFile(path.join(this.options.dataDir,'send-log.jsonl'),JSON.stringify(record)+'\n','utf8').catch(()=>{});
  }
  /** Recurring report, step 1: finds every number of the deck in the new period's
   * documents by the item it belongs to. Runs on this PC; no AI is called. */
  async refreshPlan(id:string,input:{variantId?:unknown},documents:ParsedDocument[]):Promise<RefreshPlan>{
    return this.lock(id,async state=>{
      if(state.session.phase!=='ready'||!state.session.variants.length)throw new AppError(409,'先にスライドを作成してください。');
      if(state.session.chatHandoff)throw new AppError(409,'進行中のAIとの受け渡しを終えるか取り消してから更新してください。');
      if(!state.documents.length)throw new AppError(409,'この資料は根拠資料なしで作られているため、数値がどの項目かを照合できません。資料を添付して作った資料で使ってください。','REFRESH_NO_SOURCES');
      if(!documents.length||documents.length>DOCUMENT_LIMITS.files)throw new AppError(400,'新しい期の資料を1〜8件選んでください。');
      documentContext(documents);
      const variant=this.variant(state,input.variantId);
      const plan:RefreshPlan={id:randomUUID(),variantId:variant.id,...planRefresh(variant.deck,state.documents,documents)};
      state.refresh={plan,documents,base:JSON.stringify(variant.deck)};
      return plan;
    },false);
  }
  /** Step 2: builds the refreshed deck with the reviewed values and opens it as a new
   * presentation whose evidence is the new documents. The previous one is unchanged. */
  async refreshApply(id:string,input:{planId?:unknown;values?:unknown;texts?:unknown}):Promise<RestoredPresentation>{
    return this.lock(id,async state=>{
      const draft=state.refresh;
      if(!draft||input.planId!==draft.plan.id)throw new AppError(409,'照合結果が古くなりました。新しい期の資料を選んで照合し直してください。','REFRESH_STALE');
      const variant=state.session.variants.find(v=>v.id===draft.plan.variantId);
      if(!variant||JSON.stringify(variant.deck)!==draft.base)throw new AppError(409,'照合した後に資料が変更されました。照合し直してください。','REFRESH_STALE');
      const record=(value:unknown,label:string,max:number,known:Set<string>)=>{
        if(value===undefined)return {} as Record<string,string>;
        if(!value||typeof value!=='object'||Array.isArray(value))throw new AppError(400,`${label}の形式が正しくありません。`);
        const entries=Object.entries(value as Record<string,unknown>);
        if(entries.some(([key])=>!known.has(key)))throw new AppError(400,'照合結果にない項目が含まれています。照合し直してください。');
        if(entries.some(([,v])=>typeof v!=='string'||v.length>max))throw new AppError(400,`${label}は${max}文字以内で入力してください。`);
        return Object.fromEntries(entries) as Record<string,string>;
      };
      const values=record(input.values,'数値',40,new Set(draft.plan.entries.map(e=>e.id))),texts=record(input.texts,'文章',800,new Set(draft.plan.texts.map(t=>t.id)));
      let result:ReturnType<typeof applyRefresh>;
      try{result=applyRefresh(variant.deck,draft.plan,{values,texts},draft.documents,state.documents);}
      catch(error){if(error instanceof RefreshInputError)throw new AppError(422,error.message,'REFRESH_INPUT');throw error;}
      let deck:DeckSpec;
      try{deck=validateDeck({...result.deck,id:randomUUID()});}
      catch(error){if(error instanceof AppError)throw new AppError(422,`更新後の内容を確認できません（${error.message.replace(/^生成内容を確認できません: /,'')}）。値や文章を見直してください。`,'REFRESH_INPUT');throw error;}
      if(result.deck.pageNumbers!==undefined)deck.pageNumbers=result.deck.pageNumbers;
      const problems=fitProblems(deck);
      if(problems.length)throw new AppError(422,`${deck.slides.findIndex(s=>s.id===problems[0].slideId)+1}枚目の文字が枠に収まりません。値や文章を短くしてから作成してください。`,'REFRESH_INPUT');
      this.reserveSession();
      const settings=this.options.settings.get();settings.mode=deck.mode;settings.slideCount=deck.slides.length;settings.themeId=deck.themeId;settings.typographyId=deck.typographyId??'auto';
      const summary:RefreshSummary={at:new Date().toISOString(),from:variant.deck.title,documents:draft.documents.map(d=>d.name),previousDocuments:state.documents.map(d=>d.name),changes:result.changes,edited:result.edited,unresolved:result.unresolved};
      const pages=new Set(result.changes.map(c=>c.slideId)).size;
      const session:Session={id:randomUUID(),provider:settings.provider,projectId:state.session.projectId,...(settings.provider==='subscription'?{subscriptionService:settings.subscriptionService??'chatgpt',cloudConsentRequired:true}:{}),phase:'ready',
        messages:[...state.session.messages,{role:'assistant',text:`前回の資料「${variant.deck.title}」のデザイン・構成・文章を引き継ぎ、新しい資料（${summary.documents.join('、')}）の数値で更新しました。${pages}枚・${result.changes.length}か所の数値を変更${result.edited?`、${result.edited}か所の文章を見直し`:''}${result.unresolved?`、${result.unresolved}か所は確認できなかったため前回の値のまま`:''}です。照合はこのPCで行い、AIは呼び出していません。`}],
        ...(state.session.outline?{outline:{...structuredClone(state.session.outline),title:deck.title}}:{}),
        variants:[{id:randomUUID(),label:'更新版',deck,origin:{kind:'refresh',parents:[variant.id]}}],usage:emptyUsage(),
        warnings:draft.documents.flatMap(d=>d.warnings.map(w=>`${d.name}: ${w}`)),refresh:summary};
      if(result.unresolved)session.warnings.push(`${result.unresolved}か所の数値は新しい資料で確認できなかったため、前回の値のままです。「出典と根拠を確認」で照合してください。`);
      const next:SessionState={session,documents:draft.documents,settings,project:state.project,createdAt:Date.now(),busy:false,subscriptionBinding:settings.provider==='subscription'?this.options.subscriptionBinding?.(settings.subscriptionService??'chatgpt'):undefined,design:state.design};
      this.verifySources(next,deck.slides);
      this.states.set(session.id,next);
      await this.persist(next);
      delete state.refresh;
      return {session,documents:draft.documents.map(documentSummary),mode:deck.mode};
    },false);
  }
  async removeVariant(id:string,variantId:string){
    return this.lock(id,async state=>{
      if(state.session.variants.length<2)throw new AppError(409,'最後の案は削除できません。');
      const index=state.session.variants.findIndex(v=>v.id===variantId);
      if(index<0)throw new AppError(404,'スライド案が見つかりません。');
      state.session.variants.splice(index,1);return state.session;
    });
  }
  /** Which AI's content and design people picked. Only AI names are stored, never slide text. */
  private async recordChoices(picks:{content:string;design:string}[]){
    const line=JSON.stringify({at:new Date().toISOString(),picks:picks.map(p=>({content:p.content.slice(0,40),design:p.design.slice(0,40)}))});
    await appendFile(path.join(this.options.dataDir,'choices.jsonl'),line+'\n','utf8').catch(()=>{});
  }
  async choiceStats():Promise<ChoiceStats>{
    const text=await readFile(path.join(this.options.dataDir,'choices.jsonl'),'utf8').catch(()=>'');
    const stats:ChoiceStats={decisions:0,content:{},design:{}};
    for(const line of text.split('\n').slice(-500)){
      try{const entry=JSON.parse(line);stats.decisions++;for(const p of entry.picks??[]){stats.content[p.content]=(stats.content[p.content]??0)+1;stats.design[p.design]=(stats.design[p.design]??0)+1;}}catch{/* skip a damaged line */}
    }
    return stats;
  }

  async changeTheme(id:string, input:{variantId?:unknown;themeId?:unknown;typographyId?:unknown}) {
    return this.lock(id, async state=>{
      const variant=this.variant(state,input.variantId);
      let deck:DeckSpec;
      if(input.themeId===TEMPLATE_THEME_ID){
        const template=this.templateTheme(state);
        if(!template)throw new AppError(409,'このプロジェクトに会社テンプレートが登録されていません。プロジェクト設定から読み込んでください。','TEMPLATE_REQUIRED');
        deck={...variant.deck,themeId:TEMPLATE_THEME_ID,customTheme:template};
      }else if(input.themeId===AI_THEME_ID){
        if(!variant.deck.aiTheme)throw new AppError(409,'この案にはAIが決めた配色がありません。');
        deck={...variant.deck,themeId:AI_THEME_ID};delete deck.customTheme;
      }else{deck={...variant.deck,themeId:validateTheme(input.themeId)};delete deck.customTheme;}
      if(input.typographyId!==undefined){if(input.typographyId==='auto')delete deck.typographyId;else deck.typographyId=validateTypography(input.typographyId);}
      assertTextFits(deck);
      variant.deck=deck; delete variant.render;
      return state.session;
    });
  }

  async changeLayout(id:string,input:{variantId?:unknown;slideId?:unknown;layoutId?:unknown}){
    return this.lock(id,async state=>{
      const variant=this.variant(state,input.variantId),slide=variant.deck.slides.find(s=>s.id===input.slideId);
      if(!slide)throw new AppError(404,'変更するスライドが見つかりません。');
      if(!fittingLayouts(variant.deck,slide).some(l=>l.id===input.layoutId))throw new AppError(422,'この構図では内容の関係や文字量を保持できません。表示された候補から選んでください。');
      const deck={...variant.deck,slides:variant.deck.slides.map(s=>s.id===slide.id?{...s,layoutId:String(input.layoutId)}:s)};
      assertTextFits(deck);variant.deck=deck;delete variant.render;
      return state.session;
    });
  }

  async changeChart(id:string,input:{variantId?:unknown;slideId?:unknown;type?:unknown}){
    return this.lock(id,async state=>{
      const variant=this.variant(state,input.variantId),slide=variant.deck.slides.find(s=>s.id===input.slideId);
      if(!slide?.chart)throw new AppError(404,'変更するグラフが見つかりません。');
      if(!compatibleChartTypes(slide.chart).includes(input.type as ChartType))throw new AppError(422,'このグラフ形式に必要なデータ条件を満たしていません。');
      const updated=validateSlide({...slide,chart:{...slide.chart,type:input.type}});
      const deck={...variant.deck,slides:variant.deck.slides.map(s=>s.id===slide.id?updated:s)};
      assertTextFits(deck);variant.deck=deck;delete variant.render;
      return state.session;
    });
  }

  private async rememberLayouts(deck:DeckSpec,session:Session){
    const layouts=deck.slides.map(s=>s.layoutId).filter(id=>id!=='cover');
    this.recentLayouts=[...this.recentLayouts,...layouts].slice(-128);
    try {await mkdir(this.options.dataDir,{recursive:true});await appendFile(path.join(this.options.dataDir,'layout-history.jsonl'),JSON.stringify({layouts})+'\n',{mode:0o600});}
    catch { session.warnings.push('今回の構図履歴を保存できませんでした。次回の重複回避はこの起動中だけ有効です。'); }
  }

  /** The project's company template as a theme, read fresh so a template
   * imported after the work started is used. */
  private templateTheme(state:SessionState):Theme|undefined{
    try{const template=this.projects.get(state.project.id).template;return template?templateToTheme(template):undefined;}catch{return undefined;}
  }
  private styleDeck(state:SessionState,deck:DeckSpec,outline:Outline){
    const wanted=state.settings.themeId;
    if(wanted===TEMPLATE_THEME_ID){
      const template=this.templateTheme(state);
      if(template){deck.themeId=TEMPLATE_THEME_ID;deck.customTheme=template;return;}
      state.session.warnings.push('会社テンプレートが登録されていないため、通常のテーマで作成しました。プロジェクト設定でテンプレートを読み込めます。');
      deck.themeId=outline.themeId??deck.themeId;delete deck.customTheme;return;
    }
    deck.themeId=wanted&&wanted!=='auto'?wanted:outline.themeId??deck.themeId;delete deck.customTheme;
    // おまかせ in free design: the colours the AI chose while planning become this deck's theme.
    if((!wanted||wanted==='auto')&&this.freeDesign(state)){
      if(outline.palette){deck.aiTheme=paletteTheme(outline.palette,deck.typographyId??outline.typographyId);deck.themeId=AI_THEME_ID;}
      else state.session.warnings.push(`AIが配色を返さなかったため、「${themes[deck.themeId]?.name??deck.themeId}」の配色で作成しました。テーマはあとから変更できます。`);
    }
  }
  /** Style hints for the model. A company template is applied by the app, so the
   * model only learns its palette/fonts and keeps choosing a built-in theme id. */
  /** free (default): the AI designs every page with its own ability. Template layouts
   * remain only for the demo and when the user chooses them in settings. */
  private freeDesign(state:SessionState){return state.settings.provider!=='demo'&&(state.settings.designMode??'free')!=='template';}
  /** HTML method (trial): an AI of a monthly plan writes the pages as HTML and the installed app's
   * browser reads them. Elsewhere (browser version, local LLM, manual chat, content kept on this PC)
   * the JSON method is used. */
  private htmlFor(state:SessionState,run?:AiRun){
    const settings=run?this.targetSettings(state,run.target):state.settings;
    return this.freeDesign(state)&&state.settings.designMode==='html'&&!!this.options.htmlLayout&&settings.provider==='subscription'&&state.sendScope!=='design';
  }
  /** HTML method: each returned page's HTML is drawn in a browser and read back as the page's design. */
  private async layoutPages(state:SessionState,outline:Outline,slides:unknown[],run?:AiRun){
    const theme=this.designOptions(state,outline,run).theme!;
    const pages=slides.filter((raw):raw is Record<string,any>=>!!raw&&typeof raw==='object'&&(raw as any).design===undefined);
    for(const raw of pages)if(typeof raw.html!=='string')raw.htmlProblem='htmlがありません。各ページのhtmlに<section class="slide">…</section>を書いてください。';
    const work=pages.filter(raw=>typeof raw.html==='string');
    if(!work.length)return;
    let results:HtmlPageLayout[];
    try{results=await this.options.htmlLayout!(work.map(raw=>({id:String(raw.id),html:String(raw.html).slice(0,200_000)})),theme,{minTextSize:state.settings.mode==='reading'?MIN_TEXT_SIZE.reading:MIN_TEXT_SIZE.presentation});}
    catch(error){throw new AppError(503,error instanceof Error?error.message:'HTMLを図形に変換できませんでした。','HTML_LAYOUT_UNAVAILABLE');}
    work.forEach((raw,i)=>{
      const result=results[i];delete raw.html;
      if(!result||'error' in result){raw.htmlProblem=result?.error??'HTMLを読み取れませんでした。';return;}
      raw.design={...(result.background?{background:result.background}:{}),elements:result.elements};
      if(result.problems.length)raw.htmlProblem=result.problems.slice(0,3).join(' ');
      else if(result.fitted)state.session.warnings.push(`「${typeof raw.title==='string'?raw.title.slice(0,40):raw.id}」は文字が下端に少しはみ出したため、文字を${Math.round(result.fitted*100)}%に縮めて収めました（AIは呼び出していません）。`);
    });
  }
  private designOptions(state:SessionState,outline?:Outline,run?:AiRun){
    if(!this.freeDesign(state))return {};
    const format=this.htmlFor(state,run)?'html' as const:'json' as const;
    const wanted=state.settings.themeId,template=wanted===TEMPLATE_THEME_ID?this.templateTheme(state):undefined;
    const typographyId=state.settings.typographyId&&state.settings.typographyId!=='auto'?state.settings.typographyId:outline?.typographyId;
    const themeId=wanted&&wanted!=='auto'&&wanted!==TEMPLATE_THEME_ID?wanted:outline?.themeId??state.draft?.themeId??this.preferredTheme;
    const ai=(!wanted||wanted==='auto')&&outline?.palette?paletteTheme(outline.palette,typographyId):undefined;
    return {design:'free' as const,format,editorial:state.settings.editorialGuide!==false,outputMode:state.settings.mode,theme:ai?ai:deckTheme(template?{themeId:TEMPLATE_THEME_ID,customTheme:template,typographyId}:{themeId,typographyId})};
  }
  private stylePreferences(state:SessionState){
    const template=state.settings.themeId===TEMPLATE_THEME_ID?(()=>{try{return this.projects.get(state.project.id).template;}catch{return undefined;}})():undefined;
    // Free design sends no theme of the app's choosing; the AI picks its own colours and fonts.
    const free=this.freeDesign(state);
    return {slideCount:state.settings.slideCount??'auto',themeId:template?'auto':state.settings.themeId??'auto',typographyId:state.settings.typographyId??'auto',...(free?{}:{preferredTheme:this.preferredTheme}),maxSlides:MAX_SLIDES,preferredDesign:this.designGuidance(state),
      ...(template?{companyTemplate:{name:template.name,colors:template.colors,fonts:template.fonts,note:free?'配色・書体は会社テンプレートをアプリが適用します。':'配色・書体は会社テンプレートをアプリが適用します。themeIdは候補から雰囲気が近いものを選んでください。色の意味付けは項目の順序と名前で示します。'}}:{})};
  }

  /** Citations with the extracted original text and an exact number check. */
  sourceReport(id:string,variantId?:unknown):SourceReport{
    const state=this.state(id),variant=this.variant(state,variantId);
    const documents=state.documents.map(document=>({id:document.id,name:document.name,sources:document.sources}));
    return {variantId:variant.id,documents:documents.length,slides:variant.deck.slides.map(slide=>auditSlide(slide,documents))};
  }
  /** Writes speaker notes (from presentation prep) to every variant. No AI call. */
  async applyNotes(id:string,input:{notes?:unknown}){
    return this.lock(id,async state=>{
      if(state.session.phase!=='ready')throw new AppError(409,'スライドを作成してから発表者ノートを反映してください。');
      if(state.chat)throw new AppError(409,'AIの返答を取り込むか連携を取り消してから反映してください。');
      if(!Array.isArray(input.notes)||!input.notes.length||input.notes.length>MAX_SLIDES)throw new AppError(400,'反映する発表者ノートがありません。');
      const notes=new Map<string,string>();
      for(const entry of input.notes as any[]){
        const slideId=requireText(entry?.slideId,'スライドID',100),text=typeof entry?.notes==='string'?entry.notes.trim():'';
        if(text.length>3000)throw new AppError(413,'発表者ノートは1枚3,000文字以内にしてください。');
        if(!state.session.variants[0].deck.slides.some(slide=>slide.id===slideId))throw new AppError(404,'ノートを反映するスライドが見つかりません。');
        notes.set(slideId,text);
      }
      for(const variant of state.session.variants){
        variant.deck.slides=variant.deck.slides.map(slide=>{
          const script=notes.get(slide.id);if(script===undefined)return slide;
          // Re-applying replaces the earlier script and keeps the original notes.
          const previous=slide.notes.startsWith('【話す内容】')?slide.notes.split('\n\n【補足】\n')[1]??'':slide.notes;
          return {...slide,notes:('【話す内容】\n'+script+(previous.trim()?'\n\n【補足】\n'+previous.trim():'')).slice(0,4000)};
        });
        delete variant.render;
      }
      state.session.messages.push({role:'assistant',text:`${notes.size}枚の発表者ノートに話す内容を反映しました。元の補足はノートの後半に残しています。`});
      return state.session;
    });
  }
  /** Adds or removes the appended "出典一覧" pages of every variant. */
  async setReferencesSlide(id:string,input:{enabled?:unknown}){
    return this.lock(id,async state=>{
      if(state.session.phase!=='ready')throw new AppError(409,'スライドを作成してから設定してください。');
      for(const variant of state.session.variants){if(input.enabled===true)variant.deck.referencesSlide=true;else delete variant.deck.referencesSlide;delete variant.render;}
      return state.session;
    });
  }
  setProjectTemplate(id:string,template:unknown){return this.projects.setTemplate(id,template);}

  private checkSlideCount(state:SessionState,outline:Outline) {
    if(typeof state.settings.slideCount==='number'&&outline.slides.length!==state.settings.slideCount)throw new AppError(422,`指定は表紙込み${state.settings.slideCount}枚ですが、構成案は${outline.slides.length}枚です。枚数を合わせるよう指示してください。`,'SLIDE_COUNT_MISMATCH');
  }

  /** Text that does not fit is resolved in this order: room and smaller type on this PC;
   * for an AI-designed page, the AI lays that page out again with the same words; for a
   * template page, the AI shortens the wording. When the user chose to finish anyway,
   * type may become as small as half, still without cutting a word or calling an AI. */
  private async fitText(state:SessionState,deck:DeckSpec,memo?:FitDraft,run?:AiRun) {
    if(state.settings.provider==='demo'){assertTextFits(deck);return deck;}
    let fitted=improveTextFit(deck,!!memo?.force);
    if(memo?.force){
      const left=fitProblems(fitted);
      if(left.length)throw new AppError(422,`${left.map(p=>fitted.slides.findIndex(s=>s.id===p.slideId)+1).join('・')}枚目は、文字を半分の大きさにしても枠に収まりません。そのページを修正（鉛筆ボタン）で直すか、構成で情報を分けてください。`,'TEXT_FIT_FORCED');
      const pages=deck.slides.flatMap((s,i)=>JSON.stringify(s.design)!==JSON.stringify(fitted.slides[i].design)?[i+1]:[]);
      if(pages.length)state.session.warnings.push(`${pages.join('・')}枚目は、文字を小さくして枠に収めました（最小で元の半分）。PowerPointで読みやすさを確認してください。`);
      memo.deck=fitted;return fitted;
    }
    if(memo)memo.deck=fitted;
    while(true){
      const all=fitProblems(fitted);
      if(!all.length)return fitted;
      const designed=all.find(p=>fitted.slides.find(s=>s.id===p.slideId)?.design);
      if(designed){
        const slide=fitted.slides.find(s=>s.id===designed.slideId)!;
        try{fitted=await this.relayout(state,fitted,slide,designed.issues.map(i=>i.text),run);if(memo){memo.deck=fitted;memo.singleFailures=0;}}
        catch(error){
          if(memo&&repairReason(error))memo.singleFailures++;
          if((memo?.singleFailures??0)<2&&this.tryRepair(state,'revise',error,`${slide.id}だけ、文章と数値を変えずに配置を直すよう再依頼します。`,run))continue;
          throw error;
        }
        continue;
      }
      const problems=all.slice(0,memo?.batchSize??READING_BATCH_SIZE);
      try{
        const response=await this.complete(state,'summarize',{slides:problems},memo?.singleFailures?14000:Math.min(14000,3000+problems.length*2500),run);
        const ids=problems.map(p=>p.slideId),next=improveTextFit(applySummaries(fitted,response,ids));
        // Progress is kept even when not every text is short enough yet.
        const issues=(list:typeof all)=>list.filter(p=>ids.includes(p.slideId)).reduce((n,p)=>n+p.issues.length,0);
        if(issues(fitProblems(next))>=issues(problems))throw new AppError(422,'要約後も文章が枠に収まりません。構成で情報を分けるか、短くする指示を追加してください。','TEXT_FIT_REQUIRED');
        fitted=next;if(memo){memo.deck=fitted;memo.singleFailures=0;}
      }catch(error){
        if(error instanceof OutputLimitError&&memo){memo.singleFailures=problems.length===1?memo.singleFailures+1:0;memo.batchSize=Math.max(1,Math.floor(problems.length/2));}
        if((memo?.singleFailures??0)<2&&this.tryRepair(state,'summarize',error,`本文は再生成せず、未調整の最大${memo?.batchSize??READING_BATCH_SIZE}枚だけを要約。表示枠・変更できる欄・数値の保持を確認します。`,run))continue;
        throw error;
      }
    }
  }

  /** An AI-designed page whose text does not fit is laid out again by the AI with the
   * same words, numbers, charts and tables; a reply that changes any of them is refused. */
  private async relayout(state:SessionState,deck:DeckSpec,slide:SlideSpec,texts:string[],run?:AiRun):Promise<DeckSpec>{
    const instruction=`この1枚では、次の文字が枠に収まりません：${texts.map(t=>`「${t.slice(0,40)}」`).join('、')}。文章・数値・グラフと表の内容は一字も変えずに、枠を広げる・文字を小さくする・配置を変えるなどして、すべての文字が枠に収まるデザインに直してください。`;
    const raw:any=await this.complete(state,'revise',{outline:state.session.outline,targetSlide:slide,instruction,compactOutput:true},GENERATION_OUTPUT_TOKENS,run);
    if(raw?.id!==slide.id)throw new AppError(422,'配置を直したページの識別子が一致しません。','INVALID_CONTENT');
    const result=validateSlide(raw,slide.id);
    if(!sameContent(slide,result))throw new AppError(422,`${slide.id}：配置の直しで文章や数値が変わりました。文章と数値は一字も変えず、枠と文字の大きさ・配置だけを直してください。`,'INVALID_CONTENT');
    // The words were not to change, so the page keeps its own title, notes and sources.
    const kept:SlideSpec={...result,title:slide.title,notes:slide.notes,sources:slide.sources,layoutId:slide.layoutId};
    for(const e of kept.design?.elements??[])if(e.t==='text'&&e.refs){const refs=e.refs.filter(n=>n<=slide.sources.length);if(refs.length)e.refs=refs;else delete e.refs;}
    const next=improveTextFit({...deck,slides:deck.slides.map(s=>s.id===slide.id?kept:s)});
    if(fitProblems(next).some(p=>p.slideId===slide.id))throw new AppError(422,`${slide.id}：配置を直しても文字が枠に収まりません。枠を広げるか、文字を小さくしてください。`,'TEXT_FIT_REQUIRED');
    return next;
  }
  /** The last step when text fitting stopped: text is set smaller (down to half) where it
   * does not fit, so the finished pages are kept. Nothing is cut and no AI is called. */
  async finishSmaller(id:string){
    const state=this.state(id),recovery=state.session.recovery;
    if(recovery?.task==='generate'&&recovery.stage==='text-fit')return this.generate(id,undefined,true);
    if(recovery?.task==='revise'&&recovery.stage==='text-fit'&&state.revision)return this.lock(id,async s=>{const p=s.revision!;return this.performRevision(s,{slideId:p.slideId,variantId:p.variantId,instruction:p.instruction},true,true);},true,true);
    if(state.chat?.task==='summarize'&&state.chat.summaryDeck)return this.lock(id,async s=>{
      const pending=s.chat!,deck=improveTextFit(pending.summaryDeck!,true),left=fitProblems(deck);
      if(left.length)throw new AppError(422,`${left.map(p=>deck.slides.findIndex(x=>x.id===p.slideId)+1).join('・')}枚目は、文字を半分の大きさにしても枠に収まりません。そのページを修正で直すか、構成で情報を分けてください。`,'TEXT_FIT_FORCED');
      s.session.warnings.push('文字が収まらなかったページは、AIに要約を頼まず、文字を小さくして仕上げました。PowerPointで読みやすさを確認してください。');
      await this.finishChatDeck(s,deck,pending);return s.session;
    });
    throw new AppError(409,'文字の調整で止まった作成・修正がありません。');
  }
  private operationCalls(state:SessionState){return state.session.usage.calls-(state.repairOperation?.startedCalls??0);}
  /** Whether another AI call is allowed: 12 per operation (or per AI of the session), 40 per presentation. */
  private callsLeft(state:SessionState,run?:AiRun){return (run?run.calls:this.operationCalls(state))<OPERATION_CALL_LIMIT&&state.session.usage.calls<SESSION_CALL_LIMIT;}
  async render(id: string, variantId: unknown) {
    return this.lock(id, async (state) => {
      const variant = this.variant(state, variantId);
      if(variant.render&&this.options.artifactRoot){const rendered=variant.render;const files=[rendered.pptxUrl,...rendered.thumbnails];const available=await Promise.all(files.map(file=>access(path.join(this.options.artifactRoot!,rendered.artifactId,path.basename(file))).then(()=>true,()=>false)));if(available.some(ok=>!ok))delete variant.render;}
      if (!variant.render) variant.render = await this.options.render(variant.deck, variant.id);
      return variant.render;
    });
  }
  async open(id: string, variantId: unknown) {
    const rendered = await this.render(id, variantId);
    if (!this.options.open) throw new AppError(501, 'PowerPointを開く機能はこの環境では利用できません。ファイルをダウンロードしてください。');
    await this.options.open(rendered.artifactId);
    return { ok: true };
  }
  async feedback(input: Feedback) {
    const state = this.state(input.sessionId);
    const variant = this.variant(state, input.variantId);
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new AppError(400, '評価は1〜5で選んでください。');
    const slide = input.slideId ? variant.deck.slides.find((slide) => slide.id === input.slideId) : undefined;
    if (input.slideId && !slide) throw new AppError(404, '評価対象のスライドがありません。');
    // Free-form reasons may contain confidential text. Persist only an allowlisted category.
    const categories: Record<string, string> = { visibility: 'visibility', logic: 'logic', accuracy: 'accuracy', '見やすい': 'visibility', '見やすさ': 'visibility', '論理': 'logic', '論理の通りやすさ': 'logic', '説明の分かりやすさ':'logic', '情報量':'density', '配色・雰囲気':'theme', '正確さ': 'accuracy', '内容の正確さ': 'accuracy' };
    const reason = [...new Set((typeof input.reason === 'string' ? input.reason : '').split('、').map(item => categories[item]).filter(Boolean))].join(',') || 'unspecified';
    const record = { version: 1, timestamp: new Date().toISOString(), mode: variant.deck.mode, theme: variant.deck.themeId, layouts: slide ? [slide.layoutId] : variant.deck.slides.map((slide) => slide.layoutId), rating: input.rating, reason };
    await mkdir(this.options.dataDir, { recursive: true });
    await appendFile(path.join(this.options.dataDir, 'preferences.jsonl'), `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await this.loadPreferences();
    return { ok: true, stored: '評価点・文法・配色・モードのみをローカル保存しました。資料・会話・自由記述は保存していません。' };
  }

  private state(id: string) {
    const state = this.states.get(id);
    if (!state) throw new AppError(404, '作業が見つかりません。保存した資料は履歴から開いてください。');
    return state;
  }
  private variant(state: SessionState, id: unknown): DeckVariant {
    const variant = id ? state.session.variants.find((variant) => variant.id === id) : state.session.variants[0];
    if (!variant) throw new AppError(404, 'スライド案が見つかりません。');
    return variant;
  }
  private async lock<T>(id: string, operation: (state: SessionState) => Promise<T>,save=true,repair=false): Promise<T> {
    const state = this.state(id);
    if (state.busy) throw new AppError(409, 'この作業は処理中です。完了してから操作してください。');
    state.busy = true;
    try {const result=repair?await this.withRepairs(state,()=>operation(state)):await operation(state);if(save&&state.session.phase==='ready'&&!state.chat)await this.persist(state);return result;} finally { state.busy = false; }
  }
  private async withRepairs<T>(state:SessionState,operation:()=>Promise<T>):Promise<T>{
    const context:RepairOperation={remaining:this.options.settings.get().autoRepair!==false?2:0,startedCalls:state.session.usage.calls};
    state.repairOperation=context;delete state.session.repairReport;
    let failed=false;
    try{return await operation();}catch(error){failed=true;throw error;}
    finally{
      const report=state.session.repairReport as Session['repairReport'];
      if(report){report.apiCalls=state.session.usage.calls-context.startedCalls;report.status=failed||state.session.recovery?'stopped':'recovered';
        if(report.status==='recovered')state.session.messages.push({role:'assistant',text:`自動対処${report.retries}回：${report.steps.map(s=>s.reason+' → '+s.adjustment).join(' / ')}。検証が通り、処理を完了しました。この操作のAI呼び出しは${report.apiCalls}回です。`});
      }
      delete state.repairOperation;
    }
  }
  private tryRepair(state:SessionState,task:ModelTask,error:unknown,adjustment:string,run?:AiRun){
    const reason=repairReason(error),operation=run?run.repair:state.repairOperation;
    if(!reason||!operation||operation.remaining<=0||!this.callsLeft(state,run)||this.options.settings.get().autoRepair===false)return false;
    // The app's own finding (which page and element, and what to change) goes with the retry, so the
    // same slip is not repeated. Quoted fragments of the model's text are left out.
    const code=(error as AppError).code,detail=['INVALID_CONTENT','INVALID_SOURCE','INVALID_QUOTE','TEXT_FIT_REQUIRED'].includes(code)?(error as AppError).message.replace(/^生成内容を確認できません: /,'').replace(/「[^」]*」/g,'（該当の文字）').slice(0,400):undefined;
    operation.remaining--;operation.next={task,code,...(detail?{detail}:{})};
    if(run)run.notes.push(reason.reason);else this.recordRepair(state,error,adjustment,true);
    return true;
  }
  private recordRepair(state:SessionState,error:unknown,adjustment:string,retry:boolean){
    const reason=repairReason(error);if(!reason)return;
    const report=state.session.repairReport??{status:'stopped' as const,retries:0,apiCalls:0,steps:[]};
    if(retry)report.retries++;report.steps.push({reason:reason.reason,adjustment});state.session.repairReport=report;
  }
  private checkConversation(messages:Session['messages']){if(messages.reduce((sum,m)=>sum+m.text.length,0)>240_000)throw new AppError(413,'会話全体が24万文字を超えました。作成済み資料を履歴に保存し、要点を整理して新しく作成してください。');}
  private async plan(state: SessionState, messages: Session['messages'],retry=false) {
    const needsInputBrief=messages.filter(m=>m.role==='user').reduce((sum,m)=>sum+m.text.length,0)>12_000;
    let failures=retry?(state.pendingPlan?.failures??0):0,compact=retry;
    let response:ReturnType<typeof validatePlanResponse>;
    while(true){
      // After a failed attempt the retry asks for one outline only, which is shorter.
      const proposals=!compact&&this.wantsProposals(state,needsInputBrief);
      const previous=proposals&&state.session.proposals?{previousProposals:state.session.proposals.items.map(({direction,difference,typicality})=>({direction,difference,typicality}))}:{};
      try{
        response=validatePlanResponse(await this.complete(state,'plan',{messages,currentOutline:state.session.outline,...(proposals?{proposals:OUTLINE_PROPOSALS,...previous}:{}),needsInputBrief,compactOutline:true,outputRetry:compact},compact?PLAN_RETRY_OUTPUT_TOKENS:PLAN_OUTPUT_TOKENS),proposals?outline=>this.checkOutline(state,outline):undefined);
        if(response.outline)this.checkOutline(state,response.outline);
        break;
      }catch(error){
        if(!repairReason(error)||(this.options.settings.get().autoRepair===false&&!(error instanceof OutputLimitError)))throw error;
        failures++;compact=true;
        if(this.tryRepair(state,'plan',error,'指定の枚数と条件を保持し、回答枠20,000トークンで見出し・役割・短い要点だけの構成を再作成します。'))continue;
        state.pendingPlan={messages:structuredClone(messages),failures};
        state.session.messages=messages;state.session.phase='clarifying';
        state.session.recovery={task:'plan',retryAvailable:failures<2&&state.session.usage.calls<SESSION_CALL_LIMIT,message:failures<2?'構成案を完了できませんでした。指示・資料・利用量を保持しています。回答枠を広げて、見出しと要点だけの構成を再試行できます。':'構成案の不備が繰り返されました。指示と資料は保持しています。プロンプト欄で優先する条件を整理してから送信してください。'};
        return;
      }
    }
    delete state.pendingPlan;delete state.session.recovery;delete state.draft;delete state.revision;
    state.session.messages = messages;
    const offered=response.proposals;
    if(offered?.problems.length)state.session.warnings.push(`AIが出した構成案のうち${offered.problems.length}案は、条件（枚数・表示モードなど）に合わないため外しました。`);
    if (response.question) {
      state.session.phase = 'clarifying';
      state.session.messages.push({ role: 'assistant', text: response.question });
    } else if(offered&&offered.items.length>1){
      // The user picks one direction (chooseProposal) before the outline is reviewed.
      state.session.proposals={items:offered.items,candidates:offered.candidates};
      state.session.phase='clarifying';
      state.session.messages.push({role:'assistant',text:`方向の違う構成案を${offered.items.length}つ用意しました。進める案を1つ選んでください。別の方向がよい場合は、同じ入力欄から指示できます。`});
    } else {
      const outline=response.outline??offered!.items[0].outline;
      if(offered)state.session.warnings.push('条件に合う構成案が1つだけだったため、その案で進めます。');
      state.session.outline = outline;
      if(needsInputBrief&&!outline.inputBrief)state.session.warnings.push('長文の確認用条件が返されませんでした。原文を省略せずに生成へ送ります。入力量が多い場合は条件を整理するよう指示してください。');
      state.session.phase = 'outline';
      state.session.messages.push({ role: 'assistant', text: '構成案を用意しました。見出しと説明の順番を確認してください。変更は同じ入力欄から指示できます。' });
    }
  }
  /** The first outline of an AI-designed deck made through a monthly plan comes as several
   * directions, each with the AI's own estimate of how typical it is, and the user picks one.
   * Later changes to the chosen outline, long instructions (inputBrief) and template designs
   * keep the single outline. */
  private wantsProposals(state:SessionState,needsInputBrief:boolean){
    return state.settings.outlineProposals!==false&&this.freeDesign(state)&&state.settings.provider==='subscription'&&!state.session.outline&&!needsInputBrief;
  }
  private checkOutline(state:SessionState,outline:Outline){
    if(outline.mode!==state.settings.mode)throw new AppError(422,'構成案の表示モードが指定と異なります。','INVALID_CONTENT');
    this.checkSlideCount(state,outline);
  }
  /** Makes one of the offered directions the outline. Allowed until slides are made. */
  async chooseProposal(id:string,index:unknown){
    return this.lock(id,async state=>{
      const offered=state.session.proposals;
      if(!offered||typeof index!=='number'||!Number.isInteger(index)||index<0||index>=offered.items.length)throw new AppError(400,'構成案を一覧から選んでください。');
      if(state.session.variants.length)throw new AppError(409,'スライドを作成した後は、構成案を選び直せません。新しく作成してください。');
      const proposal=offered.items[index];
      state.session.outline=structuredClone(proposal.outline);offered.chosen=index;
      delete state.session.recovery;delete state.draft;delete state.pendingPlan;
      state.session.phase='outline';
      state.session.messages.push({role:'assistant',text:`「${proposal.direction}」の案で進めます。見出しと説明の順番を確認してください。変更は同じ入力欄から指示できます。`});
      return state.session;
    },false);
  }
  /** The settings of one AI chosen for this session. */
  private targetSettings(state:SessionState,target:AiTarget):Settings{return settingsFor(state.settings,target);}
  /** Material goes only where the user agreed for this session: the provider it was
   * created with, or the AIs chosen at creation with the accounts connected then. */
  private checkDestination(state:SessionState,settings:Settings,other=false){
    const current=this.options.settings.get();
    if(!state.targets&&!other){
      if (current.provider !== state.settings.provider || (current.provider === 'local' && current.endpoint !== state.settings.endpoint)) throw new AppError(409, '処理先が変更されています。資料の送信先を確認して新しく作成してください。');
      if(state.settings.provider==='subscription')this.checkSubscriptionBinding(state);
      return;
    }
    if(settings.provider==='local'&&current.endpoint!==state.settings.endpoint)throw new AppError(409,'ローカルLLMの接続先が変更されています。送信先を確認して新しく作成してください。');
    if(settings.provider==='subscription'){
      const service=settings.subscriptionService??'chatgpt',binding=this.options.subscriptionBinding?.(service);
      if(!binding)throw new AppError(409,`${chatServiceName(service)}のアカウントが接続されていません。設定から接続し、新しく作成してください。`,'SUBSCRIPTION_CONNECTION_REQUIRED');
      if(state.bindings?.[service]!==binding)throw new AppError(409,`${chatServiceName(service)}の接続アカウントが変更されています。送信先を確認し、新しく作成してください。`,'SUBSCRIPTION_ACCOUNT_CHANGED');
    }
  }
  private async complete(state: SessionState, task: ModelTask, payload: unknown, maxTokens: number, run?:AiRun) {
    const settings=run?this.targetSettings(state,run.target):state.settings;
    if(settings.provider==='claude')throw new AppError(400,'有料APIは無効です。月額版との連携で新しく作成してください。','PAID_API_DISABLED');
    if(settings.provider==='chat')throw new AppError(409,'月額版との連携は、画面の指示をコピーして返答を取り込んでください。','CHAT_HANDOFF_REQUIRED');
    this.checkDestination(state,settings,!!run);
    if(state.session.cloudConsentRequired)throw new AppError(400,`履歴の指示・資料・会話を${state.settings.subscriptionService==='claude'?'Claude':'ChatGPT'}へ送ることを確認してください。`,'CLOUD_CONSENT_REQUIRED');
    // 12 calls per operation (each AI of the session has its own), 40 per presentation.
    if (!this.callsLeft(state,run)) throw new AppError(429, state.session.usage.calls>=SESSION_CALL_LIMIT?`1つの資料でのAI呼び出しは${SESSION_CALL_LIMIT}回までです。履歴に保存して、新しく作成してください。`:`1回の操作でのAI呼び出しは${OPERATION_CALL_LIMIT}回までです。要点をまとめて指示し直してください。`,'CALL_LIMIT');
    const provider = (this.options.providerFactory ?? createProvider)(settings, this.options.settings.secret(settings.provider));
    state.session.usage.calls++;if(run)run.calls++;
    try {
      const request={...payload as any};
      const operation=run?run.repair:state.repairOperation,correction=operation?.next;
      if(correction?.task===task){request.repair={reason:correction.code,instruction:repairInstruction(correction.code),...(correction.detail?{detail:correction.detail}:{})};delete operation!.next;}
      if(task==='generate'&&request.outline?.inputBrief){request.confirmedInstructions=request.outline.inputBrief;delete request.messages;}
      const selected=task==='generate'?request.targetSlides?.map((s:any)=>s.layoutId):task==='revise'?[request.targetSlide?.layoutId]:undefined;
      const masker=settings.provider==='subscription'?this.masking(state):undefined,protect=<T,>(value:T)=>masker?masker.maskDeep(value):value;
      const response = await provider.complete({ system: systemPrompt(task,selected?candidateLayoutIds(selected):undefined,{...this.designOptions(state,request.outline,run),...(task==='plan'&&request.proposals?{proposals:request.proposals}:{})})+(masker?'\n\n## 伏せ字について\nこのメッセージの資料・指示・会話では、社名・指定された語・連絡先・数値を【社名1】【語1】【連絡先1】【数値1】のような伏せ字にしています。伏せ字は、そのままの形で文章・見出し・出典の引用に使い、分解・計算・推測をしません。グラフの値には、資料にある数値の伏せ字（【数値n】の形）を文字列のまま書きます。アプリがこのPCで元の語と数値に戻します。':''), content: JSON.stringify(protect({ mode: state.settings.mode, projectContext:{audience:state.project.audience,designAndWritingGuidance:state.project.guidance}, preferences:{...this.stylePreferences(state),...(task==='plan'&&!this.freeDesign(state)?{recentLayouts:this.recentLayouts.slice(-40),variationSeed:state.session.id}: {})}, documents: task==='summarize'?[]:documentContext(task==='generate'?this.batchDocuments(state,request.targetSlides):state.documents), request })), maxTokens });
      this.addUsage(state.session.usage, response.usage);
      return this.unmask(state,parseJsonResponse(response.text));
    } catch (error) {
      if (error && typeof error === 'object' && 'usage' in error) this.addUsage(state.session.usage, error.usage as Usage);
      // A limit signal can arrive at the JSON boundary. Only accept complete JSON;
      // never add braces, clip a condition, or expose unfinished content as a plan.
      if(error instanceof OutputLimitError){try{return this.unmask(state,parseJsonResponse(error.partialText));}catch{/* Preserve the original output-limit error. */}}
      throw error;
    }
  }
  /** The documents a generation batch needs: those its pages name in the outline
   * (sourceIds). When any page names none, every document is sent as before. */
  private batchDocuments(state:SessionState,targets:Outline['slides']|undefined){
    const pages=(targets??[]).filter(s=>s.layoutId!=='cover');
    if(!pages.length||state.documents.length<2)return state.documents;
    const ids=new Set<string>();
    for(const page of pages){
      const named=(page.sourceIds??[]).map(id=>id.split(':')[0]).filter(id=>state.documents.some(d=>d.id===id));
      if(!named.length)return state.documents;
      named.forEach(id=>ids.add(id));
    }
    return state.documents.filter(d=>ids.has(d.id));
  }
  /** An existing task may never silently start sending material to another account. */
  private checkSubscriptionBinding(state:SessionState){
    const current=this.options.settings.get();
    const service=state.settings.subscriptionService??'chatgpt';
    if(current.provider!=='subscription'||(current.subscriptionService??'chatgpt')!==service)throw new AppError(409,'送信するサービスが変更されています。送信先を確認し、新しく作成するか履歴を開き直してください。','SUBSCRIPTION_SERVICE_CHANGED');
    const binding=this.options.subscriptionBinding?.(service);
    if(!binding)throw new AppError(409,'月額サービスのアカウントが接続されていません。設定から接続し、新しく作成するか履歴を開き直してください。','SUBSCRIPTION_CONNECTION_REQUIRED');
    if(!state.subscriptionBinding||state.subscriptionBinding!==binding)throw new AppError(409,'接続アカウントが変更されています。送信先を確認し、新しく作成するか履歴を開き直してください。','SUBSCRIPTION_ACCOUNT_CHANGED');
  }
  private addUsage(total: Usage, value: Usage) {
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) total[field] += value[field] || 0;
  }
  private verifySources(state: SessionState, slides: SlideSpec[]) {
    for (const slide of slides) {
      for (const source of slide.sources) {
        const document = state.documents.find((document) => document.id === source.documentId);
        const unit = document?.sources.find((unit) => unit.locator === source.locator);
        if (!document || !unit) throw new AppError(422, `「${slide.title}」の出典位置が資料に存在しません。内容を再生成してください。`, 'INVALID_SOURCE');
        if (source.quote && !looseText(unit.text).includes(looseText(source.quote))) {
          // A quote whose numbers are not in the cited text is invented evidence and is refused.
          // One that only differs in spacing, line breaks or punctuation of the PDF text is
          // dropped (the location itself is verified), instead of costing a whole regeneration.
          const values=sourceValues(unit.text);
          if (numbersIn(source.quote).some((value) => !values.has(value))) throw new AppError(422, `「${slide.title}」の引用が原資料と一致しません。内容を再生成してください。`, 'INVALID_QUOTE');
          delete source.quote;
          state.session.warnings.push(`「${slide.title}」の引用文が原文の表記と一致しないため、引用文を外しました。出典の位置は確認済みです。`);
        }
        Object.assign(source, { documentName: document.name });
      }
      if (state.documents.length && !slide.sources.length && slide.layoutId !== 'cover') state.session.warnings.push(`「${slide.title}」には資料への出典がありません。一般的な説明・仮説・根拠不足のどれに当たるか確認してください。`);
      if (slide.chart && state.documents.length) state.session.warnings.push(`「${slide.title}」: 出典の位置を確認しましたが、グラフの値・単位・比較条件は原資料と照合してください。`);
    }
    state.session.warnings = [...new Set(state.session.warnings)];
  }
}
