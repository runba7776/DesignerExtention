import { randomUUID } from 'node:crypto';
import type { ChartType, ChatService, DeckSpec, DeckVariant, SlideSpec } from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { validateDeck, validateSlide, validateTheme, validateTypography } from '../validation.js';
import { themes, TEMPLATE_THEME_ID } from '../../shared/themes.js';
import { fitProblems, assertTextFits } from '../text-fit.js';
import { diversifyDeck, fittingLayouts } from '../../shared/layout-selection.js';
import { transplant } from '../../shared/slots.js';
import { compatibleChartTypes } from '../../shared/charts.js';
import { AI_THEME_ID } from '../../shared/ai-theme.js';
import type { SessionEngine } from '../engine.js';
import { MAX_VARIANTS } from './session-state.js';
import { chatServiceName } from './helpers.js';

/** Other drafts of the same outline: other looks, other AIs, combining pages, and changing theme, layout or chart. */
export class DraftService {
  constructor(private readonly engine: SessionEngine) {}

  async variants(id: string) {
    return this.engine.lock(id, async state => {
      if (state.session.phase !== 'ready' || !state.session.variants.length)
        throw new AppError(409, '先にスライドを作成してください。');
      if (state.session.variants.length >= MAX_VARIANTS)
        throw new AppError(409, `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
      let deck = structuredClone(state.session.variants[0].deck);
      deck.id = randomUUID();
      const candidates = Object.keys(themes).filter(id => id !== deck.themeId);
      deck.themeId = candidates.includes(this.engine.preferredTheme)
        ? this.engine.preferredTheme
        : candidates[(candidates.indexOf('midnight') + candidates.length) % candidates.length];
      delete deck.customTheme;
      deck = diversifyDeck(deck, randomUUID(), [...this.engine.recentLayouts, ...deck.slides.map(s => s.layoutId)]);
      assertTextFits(deck);
      state.session.variants.push({
        id: randomUUID(),
        label: 'テーマ違い',
        deck,
        origin: { kind: 'restyle', parents: [state.session.variants[0].id] },
      });
      state.session.messages.push({
        role: 'assistant',
        text: '同じ内容でテーマと構図の比較案を作成しました。文字が収まる候補から選び、追加のAI呼び出しはありません。',
      });
      return state.session;
    });
  }

  /** Creates the same approved outline with another AI chat (manual hand-off). The
   * result is added as a separate draft; the existing drafts are kept. */
  async alternate(id: string, input: { service?: unknown; direct?: unknown; cloudConsent?: unknown }) {
    if (input.direct === true)
      return this.engine.lock(id, async state => {
        if (state.session.phase !== 'ready' || !state.session.outline || !state.session.variants.length)
          throw new AppError(409, '先にスライドを作成してください。');
        if (state.session.chatHandoff)
          throw new AppError(409, '進行中のAIとの受け渡しを終えるか取り消してから作成してください。');
        if (state.session.variants.length >= MAX_VARIANTS)
          throw new AppError(409, `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
        const target = input.service;
        if (target !== 'chatgpt' && target !== 'claude')
          throw new AppError(400, '直接作れるのは、設定で接続したClaudeかChatGPTです。');
        if (input.cloudConsent !== true)
          throw new AppError(
            400,
            `${chatServiceName(target)}へ指示・資料・会話を送ることを確認してください。`,
            'CLOUD_CONSENT_REQUIRED',
          );
        const binding = this.engine.options.subscriptionBinding?.(target);
        if (!binding)
          throw new AppError(
            409,
            `設定から${chatServiceName(target)}のアカウントに接続してください。`,
            'SUBSCRIPTION_CONNECTION_REQUIRED',
          );
        state.bindings = { ...state.bindings, [target]: binding };
        const run = this.engine.ai.newRun(state, target),
          deck = await this.engine.generation.draftFor(state, state.session.outline, run);
        state.session.variants.push({
          id: randomUUID(),
          label: run.label,
          deck,
          origin: {
            kind: 'ai',
            ai: run.label,
            ...(run.notes.length ? { notes: run.notes.map(n => `自動で対処：${n}`) } : {}),
          },
        });
        state.session.messages.push({
          role: 'assistant',
          text: `${run.label}でも同じ構成の案を作りました（AIの呼び出し${run.calls}回）。並べて比べたり、ページごとに組み合わせたりできます。`,
        });
        return state.session;
      });
    return this.engine.lock(
      id,
      async state => {
        this.engine.checkChatMode(state);
        if (state.session.phase !== 'ready' || !state.session.outline || !state.session.variants.length)
          throw new AppError(409, '先にスライドを作成してください。');
        if (state.session.chatHandoff)
          throw new AppError(409, '進行中のAIとの受け渡しを終えるか取り消してから作成してください。');
        if (state.session.variants.length >= MAX_VARIANTS)
          throw new AppError(409, `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから作成してください。`);
        const service = input.service;
        if (typeof service !== 'string' || !['chatgpt', 'claude', 'gemini', 'copilot', 'other'].includes(service))
          throw new AppError(400, '案を作るAIを一覧から選んでください。');
        delete state.draft;
        this.engine.chat.prepareChatGeneration(state, state.session.outline, undefined, undefined, {
          purpose: 'alternate',
          service: service as ChatService,
        });
        return state.session;
      },
      false,
    );
  }
  /** Builds a new draft page by page: the content of one draft set in the design of
   * another. Nothing is generated; a page whose places do not match keeps the design
   * of its content's draft, and the reason is reported. */
  async combine(id: string, input: { picks?: unknown; themeFrom?: unknown }) {
    return this.engine.lock(id, async state => {
      const variants = state.session.variants;
      if (state.session.phase !== 'ready' || variants.length < 2)
        throw new AppError(409, '組み合わせるには2つ以上の案が必要です。');
      if (state.session.chatHandoff)
        throw new AppError(409, '進行中のAIとの受け渡しを終えてから組み合わせてください。');
      const base = variants[0].deck,
        count = base.slides.length;
      if (
        variants.some(v => v.deck.slides.length !== count || v.deck.slides.some((s, i) => s.id !== base.slides[i].id))
      )
        throw new AppError(409, 'ページ数が違う案は組み合わせられません。');
      if (!Array.isArray(input.picks) || input.picks.length !== count)
        throw new AppError(400, 'すべてのページについて、内容とデザインの案を選んでください。');
      const picks = (input.picks as any[]).map(p => ({
        content: this.engine.variant(state, p?.content),
        design: this.engine.variant(state, p?.design),
      }));
      const themeSource = this.engine.variant(state, input.themeFrom ?? picks[0].design.id);
      const notes: string[] = [],
        slides: SlideSpec[] = [];
      picks.forEach(({ content, design }, i) => {
        const page = content.deck.slides[i],
          target = design.deck.slides[i];
        if (content.id === design.id) {
          slides.push(structuredClone(page));
          return;
        }
        const result = target.design
          ? transplant(page, target)
          : !page.design
            ? { slide: { ...structuredClone(page), layoutId: target.layoutId } }
            : { reason: 'デザイン側のページが型で作られているため、配置を取り出せません。' };
        const fits =
          result.slide &&
          (target.design ||
            fittingLayouts({ ...themeSource.deck, slides: [page] }, page).some(l => l.id === target.layoutId)) &&
          !fitProblems({ ...themeSource.deck, slides: [result.slide] }).length;
        if (result.slide && fits) {
          slides.push(result.slide);
          return;
        }
        slides.push(structuredClone(page));
        notes.push(
          `${i + 1}枚目：${result.slide ? '文字がデザインの枠に収まりません。' : result.reason}内容側（${content.label}）のデザインのままにしました。`,
        );
      });
      const deck = validateDeck({ ...structuredClone(themeSource.deck), id: randomUUID(), slides });
      if (themeSource.deck.customTheme) deck.customTheme = structuredClone(themeSource.deck.customTheme);
      if (themeSource.deck.typographyId) deck.typographyId = themeSource.deck.typographyId;
      deck.title = base.title;
      this.engine.pages.verifySources(state, deck.slides);
      assertTextFits(deck);
      const existing = variants.findIndex(v => v.origin?.kind === 'combined');
      const variant: DeckVariant = {
        id: randomUUID(),
        label: '組み合わせ',
        deck,
        origin: { kind: 'combined', parents: [...new Set(picks.flatMap(p => [p.content.id, p.design.id]))], notes },
      };
      if (existing >= 0) variants[existing] = variant;
      else if (variants.length < MAX_VARIANTS) variants.push(variant);
      else
        throw new AppError(
          409,
          `比較できる案は${MAX_VARIANTS}つまでです。不要な案を削除してから組み合わせてください。`,
        );
      await this.engine.library.recordChoices(
        picks.map(p => ({
          content: p.content.origin?.ai ?? p.content.label,
          design: p.design.origin?.ai ?? p.design.label,
        })),
      );
      state.session.messages.push({
        role: 'assistant',
        text: `${count}枚を組み合わせた案を作りました。${notes.length ? `${notes.length}枚は配置が合わないため、内容側のデザインのままです。` : ''}AIは呼び出していません。`,
      });
      return state.session;
    });
  }
  async removeVariant(id: string, variantId: string) {
    return this.engine.lock(id, async state => {
      if (state.session.variants.length < 2) throw new AppError(409, '最後の案は削除できません。');
      const index = state.session.variants.findIndex(v => v.id === variantId);
      if (index < 0) throw new AppError(404, 'スライド案が見つかりません。');
      state.session.variants.splice(index, 1);
      return state.session;
    });
  }
  async changeTheme(id: string, input: { variantId?: unknown; themeId?: unknown; typographyId?: unknown }) {
    return this.engine.lock(id, async state => {
      const variant = this.engine.variant(state, input.variantId);
      let deck: DeckSpec;
      if (input.themeId === TEMPLATE_THEME_ID) {
        const template = this.engine.pages.templateTheme(state);
        if (!template)
          throw new AppError(
            409,
            'このプロジェクトに会社テンプレートが登録されていません。プロジェクト設定から読み込んでください。',
            'TEMPLATE_REQUIRED',
          );
        deck = { ...variant.deck, themeId: TEMPLATE_THEME_ID, customTheme: template };
      } else if (input.themeId === AI_THEME_ID) {
        if (!variant.deck.aiTheme) throw new AppError(409, 'この案にはAIが決めた配色がありません。');
        deck = { ...variant.deck, themeId: AI_THEME_ID };
        delete deck.customTheme;
      } else {
        deck = { ...variant.deck, themeId: validateTheme(input.themeId) };
        delete deck.customTheme;
      }
      if (input.typographyId !== undefined) {
        if (input.typographyId === 'auto') delete deck.typographyId;
        else deck.typographyId = validateTypography(input.typographyId);
      }
      assertTextFits(deck);
      variant.deck = deck;
      delete variant.render;
      return state.session;
    });
  }

  async changeLayout(id: string, input: { variantId?: unknown; slideId?: unknown; layoutId?: unknown }) {
    return this.engine.lock(id, async state => {
      const variant = this.engine.variant(state, input.variantId),
        slide = variant.deck.slides.find(s => s.id === input.slideId);
      if (!slide) throw new AppError(404, '変更するスライドが見つかりません。');
      if (!fittingLayouts(variant.deck, slide).some(l => l.id === input.layoutId))
        throw new AppError(422, 'この構図では内容の関係や文字量を保持できません。表示された候補から選んでください。');
      const deck = {
        ...variant.deck,
        slides: variant.deck.slides.map(s => (s.id === slide.id ? { ...s, layoutId: String(input.layoutId) } : s)),
      };
      assertTextFits(deck);
      variant.deck = deck;
      delete variant.render;
      return state.session;
    });
  }

  async changeChart(id: string, input: { variantId?: unknown; slideId?: unknown; type?: unknown }) {
    return this.engine.lock(id, async state => {
      const variant = this.engine.variant(state, input.variantId),
        slide = variant.deck.slides.find(s => s.id === input.slideId);
      if (!slide?.chart) throw new AppError(404, '変更するグラフが見つかりません。');
      if (!compatibleChartTypes(slide.chart).includes(input.type as ChartType))
        throw new AppError(422, 'このグラフ形式に必要なデータ条件を満たしていません。');
      const updated = validateSlide({ ...slide, chart: { ...slide.chart, type: input.type } });
      const deck = { ...variant.deck, slides: variant.deck.slides.map(s => (s.id === slide.id ? updated : s)) };
      assertTextFits(deck);
      variant.deck = deck;
      delete variant.render;
      return state.session;
    });
  }
}
