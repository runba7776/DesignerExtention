import { randomUUID } from 'node:crypto';
import { access,appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChartType,DeckSpec, DeckVariant, DesignEntry, Feedback, Outline, RenderResult, RestoredPresentation, Session, Settings, SlideSpec, SubscriptionService, Usage } from '../shared/contracts.js';
import { documentContext, documentSummary, type ParsedDocument } from './document-model.js';
import { HistoryStore } from './history.js';
import { AppError, requireText } from './errors.js';
import { createProvider, emptyUsage, OutputLimitError,parseJsonResponse, type Provider } from './providers.js';
import { SettingsStore } from './settings.js';
import { systemPrompt, type ModelTask } from './prompts.js';
import { validateDeck, validateOutline, validatePlanResponse, validateSlide, validateTheme, validateTypography } from './validation.js';
import { demoDeck, demoOutline, DEMO_WARNING } from './demo.js';
import { GENERATION_BATCH_SIZE, READING_BATCH_SIZE, GENERATION_OUTPUT_TOKENS, MAX_SLIDES, MAX_PROMPT_CHARACTERS, PLAN_OUTPUT_TOKENS,PLAN_RETRY_OUTPUT_TOKENS } from '../shared/contracts.js';
import {completeSlidePrefix} from './partial-generation.js';
import {repairReason,repairInstruction} from './repair-policy.js';
import { themes } from '../shared/themes.js';
import { fitProblems, applySummaries, assertTextFits } from './text-fit.js';
import {candidateLayoutIds,diversifyDeck,fittingLayouts,improveTextFit} from '../shared/layout-selection.js';
import {listLayouts} from '../shared/layouts.js';
import {compatibleChartTypes} from '../shared/charts.js';
import {prepareChatHandoff,parseChatResponse} from './chat-handoff.js';
import {DesignLibraryStore} from './design-library.js';
import {applySavedDesign} from './design-application.js';
import {ProjectStore} from './projects.js';
import type {ProjectProfile,SourceReport,Theme} from '../shared/contracts.js';
import {TEMPLATE_THEME_ID} from '../shared/themes.js';
import {templateToTheme} from '../shared/template-style.js';
import {auditSlide} from '../shared/source-audit.js';

interface FitDraft {deck:DeckSpec;batchSize:number;singleFailures:number}
interface GenerationDraft {key:string;slides:SlideSpec[];themeId:string;batchSize:number;singleFailures:number;compact:boolean;fit?:FitDraft}
interface RevisionDraft {variantId:string;slideId:string;instruction:string;title:string;base:string;failures:number;compact:boolean;result?:SlideSpec;fit?:FitDraft}
interface RepairOperation {remaining:number;startedCalls:number;next?:{task:ModelTask;code:string}}
interface ChatDraft {task:ModelTask;payload:any;messages?:Session['messages'];purpose?:'generate'|'revise';summaryDeck?:DeckSpec;variantBase?:string;variantId?:string;instruction?:string;targetIds?:string[]}
interface SessionState { session: Session; documents: ParsedDocument[]; settings: Settings; project:ProjectProfile; createdAt: number; busy: boolean; subscriptionBinding?:string; historyRevision?:number; design?:DesignEntry; pendingPlan?:{messages:Session['messages'];failures:number}; draft?:GenerationDraft;revision?:RevisionDraft;repairOperation?:RepairOperation;chat?:ChatDraft }
export interface EngineOptions {
  settings: SettingsStore; projects?:ProjectStore; dataDir: string;
  render: (deck: DeckSpec, variantId: string) => Promise<RenderResult>;
  open?: (artifactId: string) => Promise<void>;
  providerFactory?: (settings: Settings, key?: string) => Provider;
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
  private designGuidance(state:SessionState){const design=state.design;return design?{themeId:design.themeId,typographyId:design.typographyId,layoutIds:design.layoutIds,explicit:Boolean(state.settings.preferredDesignId)}:undefined;}
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

  async create(input: { prompt: unknown; mode?: unknown; cloudConsent?: unknown }, documents: ParsedDocument[]) {
    const prompt = requireText(input.prompt, '指示',MAX_PROMPT_CHARACTERS);
    const settings = this.options.settings.get();
    const project=this.projects.get(settings.activeProjectId);
    if (input.mode !== undefined) {
      if (!['presentation', 'reading'].includes(String(input.mode))) throw new AppError(400, '表示モードが正しくありません。');
      settings.mode = input.mode as Settings['mode'];
    }
    if (settings.provider === 'subscription' && input.cloudConsent !== true) throw new AppError(400, `${settings.subscriptionService==='claude'?'Claude':'ChatGPT'}へ指示・資料・会話を送ることを確認してください。`, 'CLOUD_CONSENT_REQUIRED');
    const subscriptionBinding=settings.provider==='subscription'?this.options.subscriptionBinding?.(settings.subscriptionService??'chatgpt'):undefined;
    if(settings.provider==='subscription'&&!subscriptionBinding)throw new AppError(409,'設定から月額サービスのアカウントに接続してから作成してください。','SUBSCRIPTION_CONNECTION_REQUIRED');
    documentContext(documents);
    this.reserveSession();
    const session: Session = { id: randomUUID(),provider:settings.provider,projectId:project.id,...(settings.provider==='subscription'?{subscriptionService:settings.subscriptionService??'chatgpt'}:{}), phase: 'clarifying', messages: [{ role: 'user', text: prompt }], variants: [], usage: emptyUsage(), warnings: documents.flatMap((document) => document.warnings.map((warning) => `${document.name}: ${warning}`)) };
    const state: SessionState = { session, documents, settings, project, subscriptionBinding, busy: false, createdAt: Date.now(),design:await this.preferredDesign(settings,project.id,session.warnings) };
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

  async generate(id: string, inputOutline?: unknown) {
    return this.lock(id, async (state) => {
      const outline = inputOutline ? validateOutline(inputOutline) : state.session.outline;
      if (!outline || state.session.phase === 'clarifying') throw new AppError(409, '先に構成案を確認してください。');
      if (outline.mode !== state.settings.mode) throw new AppError(422, '構成案のモードが作成時の設定と異なります。新しく作成してください。');
      this.checkSlideCount(state,outline);
      if(state.session.recovery?.task==='generate'&&!state.session.recovery.retryAvailable)throw new AppError(429,'再開の上限に達しました。追加の呼び出しは行っていません。構成から情報を分けるか、優先条件を整理してください。');
      state.session.outline=outline;
      if(state.settings.provider==='chat'){this.prepareChatGeneration(state,outline);return state.session;}
      let value:unknown;
      if(state.settings.provider==='demo')value=demoDeck(outline);
      else {
        const key=JSON.stringify({outline,messages:state.session.messages,settings:state.settings});
        if(state.draft?.key!==key)state.draft={key,slides:[],themeId:outline.themeId??this.preferredTheme,batchSize:outline.mode==='reading'?READING_BATCH_SIZE:GENERATION_BATCH_SIZE,singleFailures:0,compact:false};
        const draft=state.draft;
        while(draft.slides.length<outline.slides.length) {
          const start=draft.slides.length,targetSlides=outline.slides.slice(start,start+draft.batchSize);
          const warningsBefore=[...state.session.warnings];
          let response:any;
          try{
            response=await this.complete(state,'generate',{outline,targetSlides,messages:state.session.messages,compactOutput:draft.compact,continuedFrom:draft.slides.map(s=>({title:s.title,headline:s.headline,layoutId:s.layoutId}))},draft.compact?GENERATION_OUTPUT_TOKENS:Math.min(GENERATION_OUTPUT_TOKENS,4000+targetSlides.length*2500));
            if(!response||response.mode!==outline.mode||!Array.isArray(response.slides)||response.slides.length!==targetSlides.length)throw new AppError(422,'指定したページ数・モードで応答されませんでした。','INVALID_CONTENT');
            if(response.slides.some((s:any,i:number)=>s?.id!==targetSlides[i].id))throw new AppError(422,'生成したページの識別子・順序が構成と一致しません。','INVALID_CONTENT');
            const slides=response.slides.map((s:unknown,i:number)=>validateSlide(s,targetSlides[i].id));
            if(slides.some((s:SlideSpec)=>(s.id==='slide-1')!==(s.layoutId==='cover')))throw new AppError(422,'表紙と本文の役割が構成と一致しません。','INVALID_CONTENT');
            this.verifySources(state,slides);
            if(start===0&&response.themeId)draft.themeId=validateTheme(response.themeId);
            draft.slides.push(...slides);draft.singleFailures=0;
          }
          catch(error){
            state.session.warnings=warningsBefore;
            if(error instanceof AppError&&error.code==='CALL_LIMIT')return this.generationRecovery(state,outline,'content',false);
            if(!repairReason(error)||(this.options.settings.get().autoRepair===false&&!(error instanceof OutputLimitError)))throw error;
            const prefix=error instanceof OutputLimitError?completeSlidePrefix(error.partialText):undefined;
            if(prefix?.mode===outline.mode){
              for(let i=0;i<Math.min(prefix.slides.length,targetSlides.length);i++){
                const warnings=[...state.session.warnings];
                try{
                  const raw=prefix.slides[i] as any;
                  if(raw?.id!==targetSlides[i].id)break;
                  const slide=validateSlide(raw,targetSlides[i].id);
                  if((slide.id==='slide-1')!==(slide.layoutId==='cover'))break;
                  this.verifySources(state,[slide]);
                  if(start===0&&i===0&&prefix.themeId)draft.themeId=validateTheme(prefix.themeId);
                  draft.slides.push(slide);
                }catch{state.session.warnings=warnings;break;}
              }
            }
            const gained=draft.slides.length-start;
            draft.singleFailures=targetSlides.length===1&&!gained?draft.singleFailures+1:0;
            draft.batchSize=Math.max(1,Math.floor(targetSlides.length/2));draft.compact=true;
            if(draft.slides.length===outline.slides.length&&this.options.settings.get().autoRepair!==false){
              this.recordRepair(state,error,'最後まで返された全ページを検証し、追加の本文生成なしで仕上げへ進めました。',false);continue;
            }
            if(draft.singleFailures<2&&this.tryRepair(state,'generate',error,`検証できた${draft.slides.length}枚を再利用し、残りを最大${draft.batchSize}枚ずつ、回答枠16,000トークンで再生成。文章とノートの重複を減らし、ページ・図表・出典を検証します。`))continue;
            return this.generationRecovery(state,outline,'content',draft.singleFailures<2);
          }
        }
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
      try{deck=await this.fitText(state,draft?.fit?.deck??improveTextFit(deck),draft?.fit);}
      catch(error){if(!draft?.fit||(!repairReason(error)&&!(error instanceof AppError&&error.code==='CALL_LIMIT')))throw error;return this.generationRecovery(state,outline,'text-fit',!!repairReason(error)&&draft.fit.singleFailures<2);}
      deck = diversifyDeck(deck,state.session.id,this.recentLayouts);
      if(state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,true,this.templateTheme(state)).deck;
      assertTextFits(deck);
      state.session.outline = outline;
      state.session.variants = [{ id: randomUUID(), label: 'A', deck }];
      state.session.phase = 'ready';
      delete state.session.recovery;delete state.draft;
      await this.rememberLayouts(deck,state.session);
      state.session.messages.push({ role: 'assistant', text: `${deck.slides.length}枚を作成しました。サムネイルで確認し、必要なら対象のスライドに修正を指示してください。` });
      return state.session;
    },true,true);
  }

  private generationRecovery(state:SessionState,outline:Outline,stage:'content'|'text-fit',canRetry:boolean){
    const draft=state.draft!,complete=draft.slides.length;
    const hasRemaining=stage==='text-fit'||complete<outline.slides.length;
    const retryAvailable=canRetry&&(!hasRemaining||state.session.usage.calls<12);
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
  private async performRevision(state:SessionState,input:{slideId?:unknown;instruction?:unknown;variantId?:unknown},resume=false){
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
      if(pending.failures>=3)throw new AppError(429,'同じ修正の不備が繰り返されました。優先する条件を整理して再送してください。');
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
    state.session.recovery={task:'revise',stage,slideId:pending.slideId,retryAvailable:pending.failures<3&&(pending.fit?.singleFailures??0)<2&&state.session.usage.calls<12,
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
    state.chat={task:'plan',payload:{messages,currentOutline:state.session.outline,needsInputBrief:messages.filter(m=>m.role==='user').reduce((sum,m)=>sum+m.text.length,0)>12_000,compactOutline:true},messages};
    this.exposeChat(state);
  }
  private prepareChatGeneration(state:SessionState,outline:Outline){
    this.checkChatMode(state);
    const key=JSON.stringify({outline,messages:state.session.messages,settings:state.settings});
    if(state.draft?.key!==key)state.draft={key,slides:[],themeId:outline.themeId??this.preferredTheme,batchSize:outline.mode==='reading'?READING_BATCH_SIZE:GENERATION_BATCH_SIZE,singleFailures:0,compact:false};
    const draft=state.draft,targetSlides=outline.slides.slice(draft.slides.length,draft.slides.length+draft.batchSize);
    if(!targetSlides.length)throw new AppError(409,'本文は作成済みです。現在表示されている文字量調整の指示を使用してください。');
    state.chat={task:'generate',purpose:'generate',targetIds:targetSlides.map(s=>s.id),payload:{outline,targetSlides,messages:state.session.messages,compactOutput:true,continuedFrom:draft.slides.map(s=>({title:s.title,headline:s.headline,layoutId:s.layoutId}))}};
    this.exposeChat(state);
  }
  private exposeChat(state:SessionState,issues?:string[],correctionCode?:string){
    const pending=state.chat!;
    const request={...pending.payload};
    if(pending.task==='generate'&&request.outline?.inputBrief){request.confirmedInstructions=request.outline.inputBrief;delete request.messages;}
    const selected=pending.task==='generate'?request.targetSlides?.map((s:any)=>s.layoutId):pending.task==='revise'?[request.targetSlide?.layoutId]:undefined;
    state.session.chatHandoff=prepareChatHandoff({task:pending.task,service:this.options.settings.get().chatService??'chatgpt',candidateIds:selected?candidateLayoutIds(selected):undefined,content:{mode:state.settings.mode,projectContext:{audience:state.project.audience,designAndWritingGuidance:state.project.guidance},preferences:{...this.stylePreferences(state),...(pending.task==='plan'?{recentLayouts:this.recentLayouts.slice(-40),variationSeed:state.session.id}:{})},documents:pending.task==='summarize'?[]:documentContext(state.documents),request},...(pending.purpose==='generate'?{completedSlides:state.draft?.slides.length??0,totalSlides:state.session.outline?.slides.length}:{}),...(pending.purpose==='revise'?{slideId:pending.targetIds?.[0]}:{}),validationIssues:issues,correctionCode});
    delete state.session.recovery;
  }
  async cancelChat(id:string){
    return this.lock(id,async state=>{
      this.checkChatMode(state);delete state.chat;delete state.draft;delete state.revision;delete state.session.chatHandoff;delete state.session.recovery;
      state.session.phase=state.session.variants.length?'ready':state.session.outline?'outline':'clarifying';return state.session;
    },false);
  }
  async chatResponse(id:string,input:{requestId?:unknown;response?:unknown}){
    return this.lock(id,async state=>{
      this.checkChatMode(state);
      const pending=state.chat;
      if(!pending||!state.session.chatHandoff)throw new AppError(409,'取り込むAIの指示がありません。');
      if(typeof input.requestId!=='string'||input.requestId!==state.session.chatHandoff.requestId)throw new AppError(409,'古い指示への返答です。現在表示されている指示と返答を使用してください。','STALE_CHAT_RESPONSE');
      if(pending.purpose==='revise'){
        const variant=this.variant(state,pending.variantId);
        if(JSON.stringify(variant.deck)!==pending.variantBase)throw new AppError(409,'修正対象が変更されました。現在のスライドに指示を送り直してください。','STALE_CHAT_RESPONSE');
      }
      const warnings=[...state.session.warnings],priorDraftCount=state.draft?.slides.length??0;
      try{
        const raw=parseChatResponse(input.response);
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
          const themeId=value.themeId?validateTheme(value.themeId):draft.themeId;
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
        // Keep old slides, original instructions and validated batches. Never
        // replay raw failed responses as instructions to an external model.
        this.exposeChat(state,[error.message],error.code);return state.session;
      }
    },false);
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
    const existingText=[old.title,old.headline,old.body,old.notes,...old.items.flatMap(i=>[i.label,i.description,i.value]),...(old.diagram?.items.flatMap(i=>[i.label,i.description,i.value])??[]),...(old.table?.headers??[]),...(old.table?.rows.flat()??[]),old.chart?.caption,old.chart?.unit,old.equation?.text,old.equation?.explanation].filter((v):v is string=>typeof v==='string').join(' ');
    const allowed=new Set([...numbers(instruction+' '+existingText),...(old.chart?.series.flatMap(s=>s.values.map(v=>canonical(String(v))))??[])]);
    for(const source of revised.sources){const document=state.documents.find(d=>d.id===source.documentId);const unit=document?.sources.find(u=>u.locator===source.locator);for(const value of numbers(unit?.text??''))allowed.add(value);}
    const newValues=[...(revised.chart?.series.flatMap(s=>s.values.map(v=>canonical(String(v))))??[]),...revised.items.flatMap(i=>numbers(i.value??''))];
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
    }else{
      deck=diversifyDeck(deck,state.session.id,this.recentLayouts);
      if(state.settings.preferredDesignId&&state.design)deck=applySavedDesign(deck,state.design,true,this.templateTheme(state)).deck;
      assertTextFits(deck);
      state.session.variants=[{id:randomUUID(),label:'A',deck}];await this.rememberLayouts(deck,state.session);
      state.session.messages.push({role:'assistant',text:`AIの返答から${deck.slides.length}枚を作成しました。検証済みのページを再利用し、外部APIは呼び出していません。`});
    }
    state.session.phase='ready';delete state.chat;delete state.session.chatHandoff;delete state.draft;delete state.revision;delete state.session.recovery;
    await this.persist(state);
  }

  async variants(id: string) {
    return this.lock(id, async (state) => {
      if (state.session.phase !== 'ready' || !state.session.variants.length) throw new AppError(409, '先にスライドを作成してください。');
      if (state.session.variants.length >= 2) return state.session;
      let deck = structuredClone(state.session.variants[0].deck);
      deck.id = randomUUID();
      const candidates=Object.keys(themes).filter(id=>id!==deck.themeId);
      deck.themeId = candidates.includes(this.preferredTheme) ? this.preferredTheme : candidates[(candidates.indexOf('midnight')+candidates.length)%candidates.length];
      delete deck.customTheme;
      deck = diversifyDeck(deck,randomUUID(),[...this.recentLayouts,...deck.slides.map(s=>s.layoutId)]);
      assertTextFits(deck);
      state.session.variants.push({ id: randomUUID(), label: 'B', deck });
      state.session.messages.push({ role: 'assistant', text: '同じ内容でテーマと構図の比較案を作成しました。文字が収まる候補から選び、追加のAI呼び出しはありません。' });
      return state.session;
    });
  }

  async changeTheme(id:string, input:{variantId?:unknown;themeId?:unknown;typographyId?:unknown}) {
    return this.lock(id, async state=>{
      const variant=this.variant(state,input.variantId);
      let deck:DeckSpec;
      if(input.themeId===TEMPLATE_THEME_ID){
        const template=this.templateTheme(state);
        if(!template)throw new AppError(409,'このプロジェクトに会社テンプレートが登録されていません。プロジェクト設定から読み込んでください。','TEMPLATE_REQUIRED');
        deck={...variant.deck,themeId:TEMPLATE_THEME_ID,customTheme:template};
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
  }
  /** Style hints for the model. A company template is applied by the app, so the
   * model only learns its palette/fonts and keeps choosing a built-in theme id. */
  private stylePreferences(state:SessionState){
    const template=state.settings.themeId===TEMPLATE_THEME_ID?(()=>{try{return this.projects.get(state.project.id).template;}catch{return undefined;}})():undefined;
    return {slideCount:state.settings.slideCount??'auto',themeId:template?'auto':state.settings.themeId??'auto',typographyId:state.settings.typographyId??'auto',preferredTheme:this.preferredTheme,maxSlides:MAX_SLIDES,preferredDesign:this.designGuidance(state),
      ...(template?{companyTemplate:{name:template.name,colors:template.colors,fonts:template.fonts,note:'配色・書体は会社テンプレートをアプリが適用します。themeIdは候補から雰囲気が近いものを選んでください。色の意味付けは項目の順序と名前で示します。'}}:{})};
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

  private async fitText(state:SessionState,deck:DeckSpec,memo?:FitDraft) {
    if(state.settings.provider==='demo'){assertTextFits(deck);return deck;}
    let fitted=deck;
    while(true){
      const problems=fitProblems(fitted).slice(0,memo?.batchSize??READING_BATCH_SIZE);
      if(!problems.length)return fitted;
      try{
        const response=await this.complete(state,'summarize',{slides:problems},memo?.singleFailures?14000:Math.min(14000,3000+problems.length*2500));
        const ids=problems.map(p=>p.slideId),next=applySummaries(fitted,response,ids);
        if(fitProblems(next).some(p=>ids.includes(p.slideId)))throw new AppError(422,'要約後も文章が枠に収まりません。構成で情報を分けるか、短くする指示を追加してください。','TEXT_FIT_REQUIRED');
        fitted=next;if(memo){memo.deck=fitted;memo.singleFailures=0;}
      }catch(error){
        if(error instanceof OutputLimitError&&memo){memo.singleFailures=problems.length===1?memo.singleFailures+1:0;memo.batchSize=Math.max(1,Math.floor(problems.length/2));}
        if((memo?.singleFailures??0)<2&&this.tryRepair(state,'summarize',error,`本文は再生成せず、未調整の最大${memo?.batchSize??READING_BATCH_SIZE}枚だけを要約。表示枠・変更できる欄・数値の保持を確認します。`))continue;
        throw error;
      }
    }
  }

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
  private tryRepair(state:SessionState,task:ModelTask,error:unknown,adjustment:string){
    const reason=repairReason(error),operation=state.repairOperation;
    if(!reason||!operation||operation.remaining<=0||state.session.usage.calls>=12||this.options.settings.get().autoRepair===false)return false;
    operation.remaining--;operation.next={task,code:(error as AppError).code};
    this.recordRepair(state,error,adjustment,true);
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
      try{
        response=validatePlanResponse(await this.complete(state,'plan',{messages,currentOutline:state.session.outline,needsInputBrief,compactOutline:true,outputRetry:compact},compact?PLAN_RETRY_OUTPUT_TOKENS:PLAN_OUTPUT_TOKENS));
        if(response.outline&&response.outline.mode!==state.settings.mode)throw new AppError(422,'構成案の表示モードが指定と異なります。','INVALID_CONTENT');
        if(response.outline)this.checkSlideCount(state,response.outline);
        break;
      }catch(error){
        if(!repairReason(error)||(this.options.settings.get().autoRepair===false&&!(error instanceof OutputLimitError)))throw error;
        failures++;compact=true;
        if(this.tryRepair(state,'plan',error,'指定の枚数と条件を保持し、回答枠20,000トークンで見出し・役割・短い要点だけの構成を再作成します。'))continue;
        state.pendingPlan={messages:structuredClone(messages),failures};
        state.session.messages=messages;state.session.phase='clarifying';
        state.session.recovery={task:'plan',retryAvailable:failures<2&&state.session.usage.calls<12,message:failures<2?'構成案を完了できませんでした。指示・資料・利用量を保持しています。回答枠を広げて、見出しと要点だけの構成を再試行できます。':'構成案の不備が繰り返されました。指示と資料は保持しています。プロンプト欄で優先する条件を整理してから送信してください。'};
        return;
      }
    }
    delete state.pendingPlan;delete state.session.recovery;delete state.draft;delete state.revision;
    state.session.messages = messages;
    if (response.question) {
      state.session.phase = 'clarifying';
      state.session.messages.push({ role: 'assistant', text: response.question });
    } else {
      state.session.outline = response.outline;
      if(needsInputBrief&&!response.outline?.inputBrief)state.session.warnings.push('長文の確認用条件が返されませんでした。原文を省略せずに生成へ送ります。入力量が多い場合は条件を整理するよう指示してください。');
      state.session.phase = 'outline';
      state.session.messages.push({ role: 'assistant', text: '構成案を用意しました。見出しと説明の順番を確認してください。変更は同じ入力欄から指示できます。' });
    }
  }
  private async complete(state: SessionState, task: ModelTask, payload: unknown, maxTokens: number) {
    if(state.settings.provider==='claude')throw new AppError(400,'有料APIは無効です。月額版との連携で新しく作成してください。','PAID_API_DISABLED');
    if(state.settings.provider==='chat')throw new AppError(409,'月額版との連携は、画面の指示をコピーして返答を取り込んでください。','CHAT_HANDOFF_REQUIRED');
    const current = this.options.settings.get();
    if (current.provider !== state.settings.provider || (current.provider === 'local' && current.endpoint !== state.settings.endpoint)) throw new AppError(409, '処理先が変更されています。資料の送信先を確認して新しく作成してください。');
    if(state.settings.provider==='subscription')this.checkSubscriptionBinding(state);
    if(state.session.cloudConsentRequired)throw new AppError(400,`履歴の指示・資料・会話を${state.settings.subscriptionService==='claude'?'Claude':'ChatGPT'}へ送ることを確認してください。`,'CLOUD_CONSENT_REQUIRED');
    if (state.session.usage.calls >= 12) throw new AppError(429, '1つの作業につきLLM呼び出しは12回までです。要点をまとめて新しく作成してください。','CALL_LIMIT');
    const provider = (this.options.providerFactory ?? createProvider)(state.settings, this.options.settings.secret(state.settings.provider));
    state.session.usage.calls++;
    try {
      const request={...payload as any};
      const correction=state.repairOperation?.next;
      if(correction?.task===task){request.repair={reason:correction.code,instruction:repairInstruction(correction.code)};delete state.repairOperation!.next;}
      if(task==='generate'&&request.outline?.inputBrief){request.confirmedInstructions=request.outline.inputBrief;delete request.messages;}
      const selected=task==='generate'?request.targetSlides?.map((s:any)=>s.layoutId):task==='revise'?[request.targetSlide?.layoutId]:undefined;
      const response = await provider.complete({ system: systemPrompt(task,selected?candidateLayoutIds(selected):undefined), content: JSON.stringify({ mode: state.settings.mode, projectContext:{audience:state.project.audience,designAndWritingGuidance:state.project.guidance}, preferences:{...this.stylePreferences(state),...(task==='plan'?{recentLayouts:this.recentLayouts.slice(-40),variationSeed:state.session.id}: {})}, documents: task==='summarize'?[]:documentContext(state.documents), request }), maxTokens });
      this.addUsage(state.session.usage, response.usage);
      return parseJsonResponse(response.text);
    } catch (error) {
      if (error && typeof error === 'object' && 'usage' in error) this.addUsage(state.session.usage, error.usage as Usage);
      // A limit signal can arrive at the JSON boundary. Only accept complete JSON;
      // never add braces, clip a condition, or expose unfinished content as a plan.
      if(error instanceof OutputLimitError){try{return parseJsonResponse(error.partialText);}catch{/* Preserve the original output-limit error. */}}
      throw error;
    }
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
        if (source.quote && !unit.text.replace(/\s+/g, '').includes(source.quote.replace(/\s+/g, ''))) throw new AppError(422, `「${slide.title}」の引用が原資料と一致しません。内容を再生成してください。`, 'INVALID_QUOTE');
        Object.assign(source, { documentName: document.name });
      }
      if (state.documents.length && !slide.sources.length && slide.layoutId !== 'cover') state.session.warnings.push(`「${slide.title}」には資料への出典がありません。一般的な説明・仮説・根拠不足のどれに当たるか確認してください。`);
      if (slide.chart && state.documents.length) state.session.warnings.push(`「${slide.title}」: 出典の位置を確認しましたが、グラフの値・単位・比較条件は原資料と照合してください。`);
    }
    state.session.warnings = [...new Set(state.session.warnings)];
  }
}
