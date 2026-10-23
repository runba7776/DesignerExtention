import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  DeckSpec,
  DeckVariant,
  RenderResult,
  Session,
  Settings,
  SubscriptionService,
} from '../shared/contracts.js';
import { HistoryStore } from './history.js';
import { AppError } from './errors.js';
import type { Provider } from './providers.js';
import { SettingsStore } from './settings.js';
import type { HtmlLayout } from './html-layout.js';
import { DesignLibraryStore } from './design-library.js';
import { ProjectStore } from './projects.js';
import { fillBlanks } from '../shared/blanks.js';
import { AiCalls } from './engine/ai-calls.js';
import { PageRules } from './engine/page-rules.js';
import { LibraryService } from './engine/library.js';
import { PlanningService } from './engine/planning.js';
import { GenerationService } from './engine/generation.js';
import { ReviewService } from './engine/review.js';
import { SampleService } from './engine/sample.js';
import { RevisionService } from './engine/revision.js';
import { ChatHandoffService } from './engine/chat-handoff.js';
import { DraftService } from './engine/drafts.js';
import { DesignRequestService } from './engine/design-requests.js';
import { RefreshService } from './engine/refresh.js';
import type { SessionState } from './engine/session-state.js';

export interface EngineOptions {
  settings: SettingsStore;
  projects?: ProjectStore;
  dataDir: string;
  render: (deck: DeckSpec, variantId: string) => Promise<RenderResult>;
  open?: (artifactId: string) => Promise<void>;
  providerFactory?: (settings: Settings, key?: string) => Provider;
  /** HTML method (trial): draws AI-written HTML pages in a browser and reads their layout. */
  htmlLayout?: HtmlLayout;
  /** The recorded creation the sample experience replays (see showcase.ts); without it the plain sample is used. */
  showcase?: () => Promise<unknown>;
  subscriptionBinding?: (service: SubscriptionService) => string | undefined;
  artifactRoot?: string;
}

/** One open presentation per session: the public operations used by the routes, carried out by the parts in
 * server/engine/ (planning, generation, review, chat hand-off, drafts, design requests, refresh, revision, library,
 * sample), with AI calls in ai-calls.ts and the page rules in page-rules.ts. */
export class SessionEngine {
  // The open presentations and the stores, used by the parts.
  readonly states = new Map<string, SessionState>();
  preferredTheme = 'paper';
  recentLayouts: string[] = [];
  readonly history: HistoryStore;
  readonly designs: DesignLibraryStore;
  readonly projects: ProjectStore;

  // The parts of the work (server/engine/).
  readonly ai = new AiCalls(this);
  readonly pages = new PageRules(this);
  readonly library = new LibraryService(this);
  readonly planning = new PlanningService(this);
  readonly generation = new GenerationService(this);
  readonly review = new ReviewService(this);
  readonly sample = new SampleService(this);
  readonly revision = new RevisionService(this);
  readonly chat = new ChatHandoffService(this);
  readonly drafts = new DraftService(this);
  readonly designRequests = new DesignRequestService(this);
  readonly refresh = new RefreshService(this);

  // The operations the routes call, by part.

  // Projects, history, favourite designs, feedback and rendering of saved work.
  readonly listProjects = this.library.listProjects.bind(this.library);
  readonly createProject = this.library.createProject.bind(this.library);
  readonly updateProject = this.library.updateProject.bind(this.library);
  readonly listHistory = this.library.listHistory.bind(this.library);
  readonly historyVersions = this.library.historyVersions.bind(this.library);
  readonly listDesigns = this.library.listDesigns.bind(this.library);
  readonly voteDesign = this.library.voteDesign.bind(this.library);
  readonly removeDesign = this.library.removeDesign.bind(this.library);
  readonly exportDesignPack = this.library.exportDesignPack.bind(this.library);
  readonly importDesignPack = this.library.importDesignPack.bind(this.library);
  readonly saveDesign = this.library.saveDesign.bind(this.library);
  readonly applyDesign = this.library.applyDesign.bind(this.library);
  readonly removeHistory = this.library.removeHistory.bind(this.library);
  readonly restoreHistory = this.library.restoreHistory.bind(this.library);
  readonly saveHistory = this.library.saveHistory.bind(this.library);
  readonly cloudConsent = this.library.cloudConsent.bind(this.library);
  readonly loadPreferences = this.library.loadPreferences.bind(this.library);
  readonly get = this.library.get.bind(this.library);
  readonly resume = this.library.resume.bind(this.library);
  readonly listChatTasks = this.library.listChatTasks.bind(this.library);
  readonly delete = this.library.delete.bind(this.library);
  readonly feedback = this.library.feedback.bind(this.library);
  readonly choiceStats = this.library.choiceStats.bind(this.library);
  readonly sourceReport = this.library.sourceReport.bind(this.library);
  readonly applyNotes = this.library.applyNotes.bind(this.library);
  readonly setReferencesSlide = this.library.setReferencesSlide.bind(this.library);
  readonly setProjectTemplate = this.library.setProjectTemplate.bind(this.library);
  readonly render = this.library.render.bind(this.library);
  readonly open = this.library.open.bind(this.library);

  // Starting a presentation and agreeing on its outline: questions, the three directions, the pick and the memory of picks.
  readonly create = this.planning.create.bind(this.planning);
  readonly message = this.planning.message.bind(this.planning);
  readonly retryPlan = this.planning.retryPlan.bind(this.planning);
  readonly chooseProposal = this.planning.chooseProposal.bind(this.planning);

  // Writing the pages of an agreed outline, fitting their text, and filling blanks the user answers.
  readonly generate = this.generation.generate.bind(this.generation);
  readonly finishSmaller = this.generation.finishSmaller.bind(this.generation);
  readonly fillBlanks = this.generation.fillBlanks.bind(this.generation);

  // Looking at drawn pages as pictures: samples of the directions, the look after the deck is shown, a page on request.
  readonly polish = this.review.polish.bind(this.review);
  readonly previewProposal = this.review.previewProposal.bind(this.review);
  readonly refinePage = this.review.refinePage.bind(this.review);
  readonly reviewVersion = this.review.reviewVersion.bind(this.review);

  // Changing one page on the user's instruction, with its numbers checked against the sources.
  readonly revise = this.revision.revise.bind(this.revision);
  readonly retryRevision = this.revision.retryRevision.bind(this.revision);

  // Manual chat: the instruction the user copies to an AI chat, and the reply pasted back.
  readonly cancelChat = this.chat.cancelChat.bind(this.chat);
  readonly chatResponse = this.chat.chatResponse.bind(this.chat);
  readonly useFullInstruction = this.chat.useFullInstruction.bind(this.chat);

  // Other drafts of the same outline: other looks, other AIs, combining pages, and changing theme, layout or chart.
  readonly variants = this.drafts.variants.bind(this.drafts);
  readonly alternate = this.drafts.alternate.bind(this.drafts);
  readonly combine = this.drafts.combine.bind(this.drafts);
  readonly removeVariant = this.drafts.removeVariant.bind(this.drafts);
  readonly changeTheme = this.drafts.changeTheme.bind(this.drafts);
  readonly changeLayout = this.drafts.changeLayout.bind(this.drafts);
  readonly changeChart = this.drafts.changeChart.bind(this.drafts);

  // Asking a cloud AI for the design only: the content stays on this PC, and what is sent is recorded.
  readonly requestDesign = this.designRequests.requestDesign.bind(this.designRequests);
  readonly sendLog = this.designRequests.sendLog.bind(this.designRequests);

  // Recurring reports: the numbers of a saved deck matched with new documents, reviewed by the user, applied without an AI.
  readonly refreshPlan = this.refresh.refreshPlan.bind(this.refresh);
  readonly refreshApply = this.refresh.refreshApply.bind(this.refresh);

  constructor(readonly options: EngineOptions) {
    this.history = new HistoryStore(options.dataDir);
    this.designs = new DesignLibraryStore(options.dataDir);
    this.projects = options.projects ?? new ProjectStore(options.dataDir);
  }

  // The open presentations: finding one, one operation at a time, saving to the history.
  reserveSession() {
    for (const [id, state] of this.states)
      if (!state.busy && Date.now() - state.createdAt > 2 * 60 * 60 * 1000) this.states.delete(id);
    if (this.states.size >= 25)
      throw new AppError(
        429,
        'この起動中の作業数が上限に達しました。不要な作業を閉じるか、保存後に再起動してください。',
      );
  }
  async persist(state: SessionState, strict = false) {
    try {
      const saved = await this.history.save(
        state.session,
        state.documents,
        state.session.historyId,
        state.historyRevision ?? 0,
      );
      state.session.historyId = saved.id;
      state.session.savedAt = saved.updatedAt;
      state.historyRevision = saved.revision;
      delete state.session.historySaveError;
    } catch (error) {
      const message =
        error instanceof AppError
          ? error.message
          : '履歴を保存できませんでした。PowerPointファイルを保存し、空き容量を確認してください。';
      state.session.historySaveError = message;
      if (strict) throw error;
      state.session.warnings = [...new Set([...state.session.warnings, message])];
    }
  }
  checkChatMode(state: SessionState) {
    if (state.settings.provider !== 'chat') throw new AppError(409, 'この作業は月額版との連携ではありません。');
    if (this.options.settings.get().provider !== 'chat')
      throw new AppError(409, '処理先が変更されています。月額版との連携に戻すか、新しく作成してください。');
  }
  async rememberLayouts(deck: DeckSpec, session: Session) {
    const layouts = deck.slides.map(s => s.layoutId).filter(id => id !== 'cover');
    this.recentLayouts = [...this.recentLayouts, ...layouts].slice(-128);
    try {
      await mkdir(this.options.dataDir, { recursive: true });
      await appendFile(path.join(this.options.dataDir, 'layout-history.jsonl'), JSON.stringify({ layouts }) + '\n', {
        mode: 0o600,
      });
    } catch {
      session.warnings.push('今回の構図履歴を保存できませんでした。次回の重複回避はこの起動中だけ有効です。');
    }
  }

  state(id: string) {
    const state = this.states.get(id);
    if (!state) throw new AppError(404, '作業が見つかりません。保存した資料は履歴から開いてください。');
    return state;
  }
  variant(state: SessionState, id: unknown): DeckVariant {
    const variant = id ? state.session.variants.find(variant => variant.id === id) : state.session.variants[0];
    if (!variant) throw new AppError(404, 'スライド案が見つかりません。');
    return variant;
  }
  async lock<T>(id: string, operation: (state: SessionState) => Promise<T>, save = true, repair = false): Promise<T> {
    const state = this.state(id);
    if (state.busy) throw new AppError(409, 'この作業は処理中です。完了してから操作してください。');
    state.busy = true;
    try {
      const result = repair ? await this.ai.withRepairs(state, () => operation(state)) : await operation(state);
      if (save && state.session.phase === 'ready' && !state.chat) await this.persist(state);
      return result;
    } finally {
      state.busy = false;
    }
  }
}
