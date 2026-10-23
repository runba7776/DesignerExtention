import { randomUUID } from 'node:crypto';
import type { DeckSpec, RestoredPresentation, Session, RefreshPlan, RefreshSummary } from '../../shared/contracts.js';
import { documentContext, documentSummary, DOCUMENT_LIMITS, type ParsedDocument } from '../document-model.js';
import { AppError } from '../errors.js';
import { emptyUsage } from '../providers.js';
import { validateDeck } from '../validation.js';
import { fitProblems } from '../text-fit.js';
import { applyRefresh, planRefresh, RefreshInputError } from '../../shared/refresh.js';
import type { SessionEngine } from '../engine.js';
import type { SessionState } from './session-state.js';

/** Recurring reports: the numbers of a saved deck matched with new documents, reviewed by the user, applied without an AI. */
export class RefreshService {
  constructor(private readonly engine: SessionEngine) {}

  /** Recurring report, step 1: finds every number of the deck in the new period's
   * documents by the item it belongs to. Runs on this PC; no AI is called. */
  async refreshPlan(id: string, input: { variantId?: unknown }, documents: ParsedDocument[]): Promise<RefreshPlan> {
    return this.engine.lock(
      id,
      async state => {
        if (state.session.phase !== 'ready' || !state.session.variants.length)
          throw new AppError(409, '先にスライドを作成してください。');
        if (state.session.chatHandoff)
          throw new AppError(409, '進行中のAIとの受け渡しを終えるか取り消してから更新してください。');
        if (!state.documents.length)
          throw new AppError(
            409,
            'この資料は根拠資料なしで作られているため、数値がどの項目かを照合できません。資料を添付して作った資料で使ってください。',
            'REFRESH_NO_SOURCES',
          );
        if (!documents.length || documents.length > DOCUMENT_LIMITS.files)
          throw new AppError(400, '新しい期の資料を1〜8件選んでください。');
        documentContext(documents);
        const variant = this.engine.variant(state, input.variantId);
        const plan: RefreshPlan = {
          id: randomUUID(),
          variantId: variant.id,
          ...planRefresh(variant.deck, state.documents, documents),
        };
        state.refresh = { plan, documents, base: JSON.stringify(variant.deck) };
        return plan;
      },
      false,
    );
  }
  /** Step 2: builds the refreshed deck with the reviewed values and opens it as a new
   * presentation whose evidence is the new documents. The previous one is unchanged. */
  async refreshApply(
    id: string,
    input: { planId?: unknown; values?: unknown; texts?: unknown },
  ): Promise<RestoredPresentation> {
    return this.engine.lock(
      id,
      async state => {
        const draft = state.refresh;
        if (!draft || input.planId !== draft.plan.id)
          throw new AppError(
            409,
            '照合結果が古くなりました。新しい期の資料を選んで照合し直してください。',
            'REFRESH_STALE',
          );
        const variant = state.session.variants.find(v => v.id === draft.plan.variantId);
        if (!variant || JSON.stringify(variant.deck) !== draft.base)
          throw new AppError(409, '照合した後に資料が変更されました。照合し直してください。', 'REFRESH_STALE');
        const record = (value: unknown, label: string, max: number, known: Set<string>) => {
          if (value === undefined) return {} as Record<string, string>;
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new AppError(400, `${label}の形式が正しくありません。`);
          const entries = Object.entries(value as Record<string, unknown>);
          if (entries.some(([key]) => !known.has(key)))
            throw new AppError(400, '照合結果にない項目が含まれています。照合し直してください。');
          if (entries.some(([, v]) => typeof v !== 'string' || v.length > max))
            throw new AppError(400, `${label}は${max}文字以内で入力してください。`);
          return Object.fromEntries(entries) as Record<string, string>;
        };
        const values = record(input.values, '数値', 40, new Set(draft.plan.entries.map(e => e.id))),
          texts = record(input.texts, '文章', 800, new Set(draft.plan.texts.map(t => t.id)));
        let result: ReturnType<typeof applyRefresh>;
        try {
          result = applyRefresh(variant.deck, draft.plan, { values, texts }, draft.documents, state.documents);
        } catch (error) {
          if (error instanceof RefreshInputError) throw new AppError(422, error.message, 'REFRESH_INPUT');
          throw error;
        }
        let deck: DeckSpec;
        try {
          deck = validateDeck({ ...result.deck, id: randomUUID() });
        } catch (error) {
          if (error instanceof AppError)
            throw new AppError(
              422,
              `更新後の内容を確認できません（${error.message.replace(/^生成内容を確認できません: /, '')}）。値や文章を見直してください。`,
              'REFRESH_INPUT',
            );
          throw error;
        }
        if (result.deck.pageNumbers !== undefined) deck.pageNumbers = result.deck.pageNumbers;
        const problems = fitProblems(deck);
        if (problems.length)
          throw new AppError(
            422,
            `${deck.slides.findIndex(s => s.id === problems[0].slideId) + 1}枚目の文字が枠に収まりません。値や文章を短くしてから作成してください。`,
            'REFRESH_INPUT',
          );
        this.engine.reserveSession();
        const settings = this.engine.options.settings.get();
        settings.mode = deck.mode;
        settings.slideCount = deck.slides.length;
        settings.themeId = deck.themeId;
        settings.typographyId = deck.typographyId ?? 'auto';
        const summary: RefreshSummary = {
          at: new Date().toISOString(),
          from: variant.deck.title,
          documents: draft.documents.map(d => d.name),
          previousDocuments: state.documents.map(d => d.name),
          changes: result.changes,
          edited: result.edited,
          unresolved: result.unresolved,
        };
        const pages = new Set(result.changes.map(c => c.slideId)).size;
        const session: Session = {
          id: randomUUID(),
          provider: settings.provider,
          projectId: state.session.projectId,
          ...(settings.provider === 'subscription'
            ? { subscriptionService: settings.subscriptionService ?? 'chatgpt', cloudConsentRequired: true }
            : {}),
          phase: 'ready',
          messages: [
            ...state.session.messages,
            {
              role: 'assistant',
              text: `前回の資料「${variant.deck.title}」のデザイン・構成・文章を引き継ぎ、新しい資料（${summary.documents.join('、')}）の数値で更新しました。${pages}枚・${result.changes.length}か所の数値を変更${result.edited ? `、${result.edited}か所の文章を見直し` : ''}${result.unresolved ? `、${result.unresolved}か所は確認できなかったため前回の値のまま` : ''}です。照合はこのPCで行い、AIは呼び出していません。`,
            },
          ],
          ...(state.session.outline
            ? { outline: { ...structuredClone(state.session.outline), title: deck.title } }
            : {}),
          variants: [{ id: randomUUID(), label: '更新版', deck, origin: { kind: 'refresh', parents: [variant.id] } }],
          usage: emptyUsage(),
          warnings: draft.documents.flatMap(d => d.warnings.map(w => `${d.name}: ${w}`)),
          refresh: summary,
        };
        if (result.unresolved)
          session.warnings.push(
            `${result.unresolved}か所の数値は新しい資料で確認できなかったため、前回の値のままです。「出典と根拠を確認」で照合してください。`,
          );
        const next: SessionState = {
          session,
          documents: draft.documents,
          settings,
          project: state.project,
          createdAt: Date.now(),
          busy: false,
          subscriptionBinding:
            settings.provider === 'subscription'
              ? this.engine.options.subscriptionBinding?.(settings.subscriptionService ?? 'chatgpt')
              : undefined,
          design: state.design,
        };
        this.engine.pages.verifySources(next, deck.slides);
        this.engine.states.set(session.id, next);
        await this.engine.persist(next);
        delete state.refresh;
        return { session, documents: draft.documents.map(documentSummary), mode: deck.mode };
      },
      false,
    );
  }
}
