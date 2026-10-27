import { randomUUID } from 'node:crypto';
import { access, appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_SLIDES,
  type ChoiceStats,
  type Feedback,
  type RestoredPresentation,
  type Session,
  type Settings,
  type SourceReport,
} from '../../shared/contracts.js';
import { documentSummary } from '../document-model.js';
import { AppError, requireText } from '../errors.js';
import { emptyUsage } from '../providers.js';
import { themes } from '../../shared/themes.js';
import { AI_THEME_ID } from '../../shared/ai-theme.js';
import { assertTextFits } from '../text-fit.js';
import { listLayouts } from '../../shared/layouts.js';
import { applySavedDesign } from '../design-application.js';
import { auditSlide } from '../../shared/source-audit.js';
import type { SessionEngine } from '../engine.js';
import type { SessionState } from './session-state.js';

/** Projects, history, favourite designs, feedback and rendering of saved work. */
export class LibraryService {
  constructor(private readonly engine: SessionEngine) {}

  listProjects() {
    return this.engine.projects.list();
  }
  createProject(input: unknown) {
    return this.engine.projects.create(input);
  }
  updateProject(id: string, input: unknown) {
    return this.engine.projects.update(id, input);
  }
  listHistory(projectId?: string) {
    if (projectId) this.engine.projects.get(projectId);
    return this.engine.history.list(projectId);
  }
  async historyVersions(id: string) {
    return { versions: await this.engine.history.versions(id) };
  }
  listDesigns(projectId?: string) {
    const selected = projectId ?? this.engine.options.settings.get().activeProjectId;
    this.engine.projects.get(selected);
    return this.engine.designs.list(selected);
  }
  voteDesign(id: string, delta: unknown = 1) {
    if (delta !== 1 && delta !== -1) throw new AppError(400, '投票は1回ずつ変更してください。');
    return this.engine.designs.vote(id, delta);
  }
  async removeDesign(id: string) {
    const design = await this.engine.designs.load(id);
    if (design.projectId !== this.engine.options.settings.get().activeProjectId)
      throw new AppError(403, '別のプロジェクトのお気に入りは削除できません。', 'PROJECT_MISMATCH');
    await this.engine.designs.remove(id);
    if (this.engine.options.settings.get().preferredDesignId === id)
      await this.engine.options.settings.update({ preferredDesignId: '' });
    return { ok: true };
  }
  async exportDesignPack(projectId: string) {
    const project = this.engine.projects.get(projectId);
    const pack = await this.engine.designs.exportPack(projectId);
    return project.template ? { ...pack, template: project.template } : pack;
  }
  async importDesignPack(projectId: string, input: unknown) {
    this.engine.projects.get(projectId);
    const pack = input as Record<string, unknown> | null;
    const hasTemplate =
      !!pack &&
      typeof pack === 'object' &&
      pack.template !== undefined &&
      pack.format === 'designer-extension-design-set';
    const designsOnly = hasTemplate ? { ...pack, template: undefined } : input;
    const imported =
      hasTemplate && Array.isArray(pack!.designs) && !pack!.designs.length
        ? { imported: 0 }
        : await this.engine.designs.importPack(projectId, designsOnly);
    if (hasTemplate) await this.engine.projects.setTemplate(projectId, pack!.template);
    return { ...imported, template: hasTemplate };
  }
  async saveDesign(id: string, input: { variantId?: unknown; slideId?: unknown; name?: unknown }) {
    return this.engine.lock(
      id,
      async state => {
        if (state.session.phase !== 'ready')
          throw new AppError(409, '完成したスライドからデザインを保存してください。');
        const variant = this.engine.variant(state, input.variantId);
        const slideId = input.slideId === undefined ? undefined : requireText(input.slideId, 'スライドID', 100);
        const name = input.name === undefined ? undefined : requireText(input.name, 'デザイン名', 100);
        const index = slideId ? variant.deck.slides.findIndex(s => s.id === slideId) : 0;
        if (index < 0) throw new AppError(404, '保存するスライドが見つかりません。');
        return this.engine.designs.save(variant.deck, {
          name,
          slideId,
          thumbnail: variant.render?.thumbnails[index],
          projectId: state.session.projectId,
        });
      },
      false,
    );
  }
  async applyDesign(id: string, input: { variantId?: unknown; designId?: unknown }) {
    return this.engine.lock(id, async state => {
      if (state.chat) throw new AppError(409, 'AIの返答を取り込むか連携を取り消してから、デザインを適用してください。');
      const variant = this.engine.variant(state, input.variantId),
        design = await this.engine.designs.load(requireText(input.designId, 'デザインID', 100));
      if (design.projectId !== state.session.projectId)
        throw new AppError(
          403,
          '別のプロジェクトのお気に入りは適用できません。デザイン設定を共有用ファイルで取り込んでください。',
          'PROJECT_MISMATCH',
        );
      const styled = applySavedDesign(variant.deck, design, true, this.engine.pages.templateTheme(state));
      this.engine.pages.verifySources(state, styled.deck.slides);
      variant.deck = styled.deck;
      delete variant.render;
      state.session.messages.push({
        role: 'assistant',
        text: `保存したデザイン「${design.name}」の配色・書体を適用し、${styled.changed}枚の構図を変更しました。${styled.skipped ? `${styled.skipped}枚は内容の関係・文字量を保つため元の構図を使いました。` : ''}文章・図表の数値・出典を保持し、AIは呼び出していません。`,
      });
      return state.session;
    });
  }
  async preferredDesign(settings: Settings, projectId: string, warnings: string[]) {
    try {
      if (settings.preferredDesignId) {
        const explicit = await this.engine.designs.load(settings.preferredDesignId);
        if (explicit.projectId === projectId) return explicit;
        warnings.push('指定されたお気に入りは別のプロジェクトにあるため、このプロジェクトのデザインを使います。');
      }
      return (await this.engine.designs.list(projectId)).entries.find(entry => entry.mode === settings.mode);
    } catch {
      warnings.push('お気に入りデザインを読み取れませんでした。通常のデザイン候補で作成します。');
      return undefined;
    }
  }
  async removeHistory(id: string) {
    const affected = [...this.engine.states.values()].filter(s => s.session.historyId === id);
    if (affected.some(s => s.busy)) throw new AppError(409, 'この資料は処理中です。完了してから削除してください。');
    affected.forEach(s => (s.busy = true));
    try {
      await this.engine.history.remove(id);
      for (const state of affected) {
        delete state.session.historyId;
        delete state.session.savedAt;
        state.historyRevision = 0;
      }
    } finally {
      affected.forEach(s => (s.busy = false));
    }
    return { ok: true };
  }
  async restoreHistory(id: string, duplicate = false, revision?: number) {
    const record =
      revision === undefined ? await this.engine.history.load(id) : await this.engine.history.loadVersion(id, revision);
    this.engine.reserveSession();
    if (revision !== undefined) duplicate = true;
    const project = this.engine.projects.get(record.session.projectId),
      priorSettings = this.engine.options.settings.get();
    await this.engine.options.settings.update({
      activeProjectId: project.id,
      ...(priorSettings.activeProjectId !== project.id ? { preferredDesignId: '' } : {}),
    });
    const settings = this.engine.options.settings.get(),
      deck = record.session.variants[0].deck;
    settings.mode = deck.mode;
    settings.slideCount = deck.slides.length;
    // The AI's palette is not a setting: it came from おまかせ, which takes it again from the outline.
    settings.themeId = deck.themeId === AI_THEME_ID ? 'auto' : deck.themeId;
    settings.typographyId = deck.typographyId ?? 'auto';
    const session: Session = {
      ...record.session,
      id: randomUUID(),
      provider: settings.provider,
      usage: emptyUsage(),
      cloudConsentRequired: settings.provider === 'subscription',
      ...(duplicate ? {} : { historyId: record.id, savedAt: record.updatedAt }),
    };
    if (settings.provider === 'subscription') session.subscriptionService = settings.subscriptionService ?? 'chatgpt';
    else delete session.subscriptionService;
    delete session.chatHandoff;
    const state: SessionState = {
      session,
      documents: record.documents,
      settings,
      project,
      createdAt: Date.now(),
      busy: false,
      subscriptionBinding:
        settings.provider === 'subscription'
          ? this.engine.options.subscriptionBinding?.(settings.subscriptionService ?? 'chatgpt')
          : undefined,
      historyRevision: duplicate ? 0 : record.revision,
      design: await this.preferredDesign(settings, project.id, session.warnings),
    };
    for (const variant of session.variants) {
      this.engine.pages.verifySources(state, variant.deck.slides);
      assertTextFits(variant.deck);
    }
    if (duplicate) await this.engine.persist(state, true);
    this.engine.states.set(session.id, state);
    return { session, documents: state.documents.map(documentSummary), mode: settings.mode };
  }
  async saveHistory(id: string) {
    return this.engine.lock(
      id,
      async state => {
        if (state.session.phase !== 'ready') throw new AppError(409, 'スライドを作成してから保存してください。');
        await this.engine.persist(state, true);
        return state.session;
      },
      false,
    );
  }
  async cloudConsent(id: string) {
    return this.engine.lock(
      id,
      async state => {
        if (state.settings.provider === 'subscription') this.engine.ai.checkSubscriptionBinding(state);
        state.session.cloudConsentRequired = false;
        return state.session;
      },
      false,
    );
  }
  async loadPreferences() {
    try {
      const rows = (await readFile(path.join(this.engine.options.dataDir, 'layout-history.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean)
        .slice(-64);
      this.engine.recentLayouts = rows
        .flatMap(row => {
          const ids = JSON.parse(row).layouts;
          return Array.isArray(ids)
            ? ids.filter((id: unknown) => typeof id === 'string' && listLayouts().some(l => l.id === id))
            : [];
        })
        .slice(-128);
    } catch {
      /* No layout history yet. */
    }
    try {
      const raw = await readFile(path.join(this.engine.options.dataDir, 'preferences.jsonl'), 'utf8');
      const recent = raw.split('\n').filter(Boolean).slice(-500);
      const scores = Object.fromEntries(Object.keys(themes).map(id => [id, { sum: 0, count: 0 }]));
      for (const line of recent) {
        const item = JSON.parse(line);
        if (Object.hasOwn(scores, item.theme) && typeof item.rating === 'number') {
          scores[item.theme].sum += item.rating;
          scores[item.theme].count++;
        }
      }
      const average = (entry: { sum: number; count: number }) => (entry.sum + 9) / (entry.count + 3);
      this.engine.preferredTheme = Object.keys(scores).sort((a, b) => average(scores[b]) - average(scores[a]))[0];
    } catch {
      /* No preference history on first launch. */
    }
  }
  get(id: string): Session {
    return this.engine.state(id).session;
  }
  resume(id: string): RestoredPresentation {
    const state = this.engine.state(id);
    return { session: state.session, documents: state.documents.map(documentSummary), mode: state.settings.mode };
  }
  listChatTasks() {
    return {
      sessions: [...this.engine.states.values()]
        .filter(s => s.settings.provider === 'chat')
        .map(s => ({
          id: s.session.id,
          title: s.session.outline?.title ?? '作成中の資料',
          phase: s.session.phase,
          ...(s.session.chatHandoff ? { task: s.session.chatHandoff.task } : {}),
        })),
    };
  }
  delete(id: string) {
    this.engine.states.delete(id);
  }

  async feedback(input: Feedback) {
    const state = this.engine.state(input.sessionId);
    const variant = this.engine.variant(state, input.variantId);
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
      throw new AppError(400, '評価は1〜5で選んでください。');
    const slide = input.slideId ? variant.deck.slides.find(slide => slide.id === input.slideId) : undefined;
    if (input.slideId && !slide) throw new AppError(404, '評価対象のスライドがありません。');
    // Free-form reasons may contain confidential text. Persist only an allowlisted category.
    const categories: Record<string, string> = {
      visibility: 'visibility',
      logic: 'logic',
      accuracy: 'accuracy',
      見やすい: 'visibility',
      見やすさ: 'visibility',
      論理: 'logic',
      論理の通りやすさ: 'logic',
      説明の分かりやすさ: 'logic',
      情報量: 'density',
      '配色・雰囲気': 'theme',
      正確さ: 'accuracy',
      内容の正確さ: 'accuracy',
    };
    const reason =
      [
        ...new Set(
          (typeof input.reason === 'string' ? input.reason : '')
            .split('、')
            .map(item => categories[item])
            .filter(Boolean),
        ),
      ].join(',') || 'unspecified';
    const record = {
      version: 1,
      timestamp: new Date().toISOString(),
      mode: variant.deck.mode,
      theme: variant.deck.themeId,
      layouts: slide ? [slide.layoutId] : variant.deck.slides.map(slide => slide.layoutId),
      rating: input.rating,
      reason,
    };
    await mkdir(this.engine.options.dataDir, { recursive: true });
    await appendFile(path.join(this.engine.options.dataDir, 'preferences.jsonl'), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
    });
    // A rating of a deck made from one of the three directions also weighs that pick for later orders.
    if (state.session.proposals?.chosen !== undefined && state.settings.provider !== 'demo')
      await this.engine.planning.remember(state, { type: 'rating', rating: input.rating });
    await this.loadPreferences();
    return {
      ok: true,
      stored: '評価点・文法・配色・モードのみをローカル保存しました。資料・会話・自由記述は保存していません。',
    };
  }

  /** Which AI's content and design people picked. Only AI names are stored, never slide text. */
  async recordChoices(picks: { content: string; design: string }[]) {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      picks: picks.map(p => ({ content: p.content.slice(0, 40), design: p.design.slice(0, 40) })),
    });
    await appendFile(path.join(this.engine.options.dataDir, 'choices.jsonl'), line + '\n', 'utf8').catch(() => {});
  }
  async choiceStats(): Promise<ChoiceStats> {
    const text = await readFile(path.join(this.engine.options.dataDir, 'choices.jsonl'), 'utf8').catch(() => '');
    const stats: ChoiceStats = { decisions: 0, content: {}, design: {} };
    for (const line of text.split('\n').slice(-500)) {
      try {
        const entry = JSON.parse(line);
        stats.decisions++;
        for (const p of entry.picks ?? []) {
          stats.content[p.content] = (stats.content[p.content] ?? 0) + 1;
          stats.design[p.design] = (stats.design[p.design] ?? 0) + 1;
        }
      } catch {
        /* skip a damaged line */
      }
    }
    return stats;
  }

  /** Citations with the extracted original text and an exact number check. */
  sourceReport(id: string, variantId?: unknown): SourceReport {
    const state = this.engine.state(id),
      variant = this.engine.variant(state, variantId);
    const documents = state.documents.map(document => ({
      id: document.id,
      name: document.name,
      sources: document.sources,
    }));
    return {
      variantId: variant.id,
      documents: documents.length,
      slides: variant.deck.slides.map(slide => auditSlide(slide, documents)),
    };
  }
  /** Writes speaker notes (from presentation prep) to every variant. No AI call. */
  async applyNotes(id: string, input: { notes?: unknown }) {
    return this.engine.lock(id, async state => {
      if (state.session.phase !== 'ready')
        throw new AppError(409, 'スライドを作成してから発表者ノートを反映してください。');
      if (state.chat) throw new AppError(409, 'AIの返答を取り込むか連携を取り消してから反映してください。');
      if (!Array.isArray(input.notes) || !input.notes.length || input.notes.length > MAX_SLIDES)
        throw new AppError(400, '反映する発表者ノートがありません。');
      const notes = new Map<string, string>();
      for (const entry of input.notes as any[]) {
        const slideId = requireText(entry?.slideId, 'スライドID', 100),
          text = typeof entry?.notes === 'string' ? entry.notes.trim() : '';
        if (text.length > 3000) throw new AppError(413, '発表者ノートは1枚3,000文字以内にしてください。');
        if (!state.session.variants[0].deck.slides.some(slide => slide.id === slideId))
          throw new AppError(404, 'ノートを反映するスライドが見つかりません。');
        notes.set(slideId, text);
      }
      for (const variant of state.session.variants) {
        variant.deck.slides = variant.deck.slides.map(slide => {
          const script = notes.get(slide.id);
          if (script === undefined) return slide;
          // Re-applying replaces the earlier script and keeps the original notes.
          const previous = slide.notes.startsWith('【話す内容】')
            ? (slide.notes.split('\n\n【補足】\n')[1] ?? '')
            : slide.notes;
          return {
            ...slide,
            notes: ('【話す内容】\n' + script + (previous.trim() ? '\n\n【補足】\n' + previous.trim() : '')).slice(
              0,
              4000,
            ),
          };
        });
        delete variant.render;
      }
      state.session.messages.push({
        role: 'assistant',
        text: `${notes.size}枚の発表者ノートに話す内容を反映しました。元の補足はノートの後半に残しています。`,
      });
      return state.session;
    });
  }
  /** Adds or removes the appended "出典一覧" pages of every variant. */
  async setReferencesSlide(id: string, input: { enabled?: unknown }) {
    return this.engine.lock(id, async state => {
      if (state.session.phase !== 'ready') throw new AppError(409, 'スライドを作成してから設定してください。');
      for (const variant of state.session.variants) {
        if (input.enabled === true) variant.deck.referencesSlide = true;
        else delete variant.deck.referencesSlide;
        delete variant.render;
      }
      return state.session;
    });
  }
  setProjectTemplate(id: string, template: unknown) {
    return this.engine.projects.setTemplate(id, template);
  }

  async render(id: string, variantId: unknown) {
    return this.engine.lock(id, async state => {
      const variant = this.engine.variant(state, variantId);
      if (variant.render && this.engine.options.artifactRoot) {
        const rendered = variant.render;
        const files = [rendered.pptxUrl, ...rendered.thumbnails];
        const available = await Promise.all(
          files.map(file =>
            access(path.join(this.engine.options.artifactRoot!, rendered.artifactId, path.basename(file))).then(
              () => true,
              () => false,
            ),
          ),
        );
        if (available.some(ok => !ok)) delete variant.render;
      }
      if (!variant.render) variant.render = await this.engine.options.render(variant.deck, variant.id);
      return variant.render;
    });
  }
  async open(id: string, variantId: unknown) {
    const rendered = await this.render(id, variantId);
    if (!this.engine.options.open)
      throw new AppError(501, 'PowerPointを開く機能はこの環境では利用できません。ファイルをダウンロードしてください。');
    await this.engine.options.open(rendered.artifactId);
    return { ok: true };
  }
}
