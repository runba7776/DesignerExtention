import {
  MAX_SLIDES,
  MIN_TEXT_SIZE,
  type DeckSpec,
  type Outline,
  type SlideSpec,
  type Theme,
} from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { createProvider } from '../providers.js';
import { validateSlide } from '../validation.js';
import type { HtmlPageLayout } from '../html-layout.js';
import { themes, TEMPLATE_THEME_ID } from '../../shared/themes.js';
import { deckTheme } from '../../shared/layouts.js';
import { AI_THEME_ID, paletteTheme } from '../../shared/ai-theme.js';
import { templateToTheme } from '../../shared/template-style.js';
import { sourceValues } from '../../shared/source-audit.js';
import { numbersIn } from '../../shared/numbers.js';
import type { SessionEngine } from '../engine.js';
import type { AiRun, SessionState } from './session-state.js';
import { looseText } from './helpers.js';

/** How pages are designed and checked: AI design or layouts, the HTML method, the theme and palette, and the checks every page passes. */
export class PageRules {
  constructor(private readonly engine: SessionEngine) {}

  /** The project's company template as a theme, read fresh so a template
   * imported after the work started is used. */
  templateTheme(state: SessionState): Theme | undefined {
    try {
      const template = this.engine.projects.get(state.project.id).template;
      return template ? templateToTheme(template) : undefined;
    } catch {
      return undefined;
    }
  }
  styleDeck(state: SessionState, deck: DeckSpec, outline: Outline) {
    const wanted = state.settings.themeId;
    if (wanted === TEMPLATE_THEME_ID) {
      const template = this.templateTheme(state);
      if (template) {
        deck.themeId = TEMPLATE_THEME_ID;
        deck.customTheme = template;
        return;
      }
      state.session.warnings.push(
        '会社テンプレートが登録されていないため、通常のテーマで作成しました。プロジェクト設定でテンプレートを読み込めます。',
      );
      deck.themeId = outline.themeId ?? deck.themeId;
      delete deck.customTheme;
      return;
    }
    deck.themeId = wanted && wanted !== 'auto' ? wanted : (outline.themeId ?? deck.themeId);
    delete deck.customTheme;
    // おまかせ in free design: the colours the AI chose while planning become this deck's theme.
    if ((!wanted || wanted === 'auto') && this.freeDesign(state)) {
      if (outline.palette) {
        deck.aiTheme = paletteTheme(outline.palette, deck.typographyId ?? outline.typographyId);
        deck.themeId = AI_THEME_ID;
      } else
        state.session.warnings.push(
          `AIが配色を返さなかったため、「${themes[deck.themeId]?.name ?? deck.themeId}」の配色で作成しました。テーマはあとから変更できます。`,
        );
    }
  }
  /** Style hints for the model. A company template is applied by the app, so the
   * model only learns its palette/fonts and keeps choosing a built-in theme id. */
  /** free (default): the AI designs every page with its own ability. Template layouts
   * remain only for the demo and when the user chooses them in settings. */
  freeDesign(state: SessionState) {
    return state.settings.provider !== 'demo' && (state.settings.designMode ?? 'free') !== 'template';
  }
  /** HTML method (trial): an AI of a monthly plan writes the pages as HTML and the installed app's
   * browser reads them. Elsewhere (browser version, local LLM, manual chat, content kept on this PC)
   * the JSON method is used. */
  htmlFor(state: SessionState, run?: AiRun) {
    const settings = run ? this.engine.ai.targetSettings(state, run.target) : state.settings;
    return (
      this.freeDesign(state) &&
      state.settings.designMode === 'html' &&
      !!this.engine.options.htmlLayout &&
      settings.provider === 'subscription' &&
      state.sendScope !== 'design'
    );
  }
  /** HTML method: each returned page's HTML is drawn in a browser and read back as the page's design. */
  async layoutPages(state: SessionState, outline: Outline, slides: unknown[], run?: AiRun) {
    const theme = this.designOptions(state, outline, run).theme!;
    const pages = slides.filter(
      (raw): raw is Record<string, any> => !!raw && typeof raw === 'object' && (raw as any).design === undefined,
    );
    for (const raw of pages)
      if (typeof raw.html !== 'string')
        raw.htmlProblem = 'htmlがありません。各ページのhtmlに<section class="slide">…</section>を書いてください。';
    const work = pages.filter(raw => typeof raw.html === 'string');
    if (!work.length) return;
    let results: HtmlPageLayout[];
    try {
      results = await this.engine.options.htmlLayout!(
        work.map(raw => ({ id: String(raw.id), html: String(raw.html).slice(0, 200_000) })),
        theme,
        {
          minTextSize: MIN_TEXT_SIZE[state.settings.mode === 'reading' ? 'reading' : 'presentation'],
          screenshot: !run && this.wantsReview(state),
        },
      );
    } catch (error) {
      throw new AppError(
        503,
        error instanceof Error ? error.message : 'HTMLを図形に変換できませんでした。',
        'HTML_LAYOUT_UNAVAILABLE',
      );
    }
    work.forEach((raw, i) => {
      const result = results[i];
      delete raw.html;
      if (!result || 'error' in result) {
        raw.htmlProblem = result?.error ?? 'HTMLを読み取れませんでした。';
        return;
      }
      raw.design = { ...(result.background ? { background: result.background } : {}), elements: result.elements };
      if (result.shot) raw.shot = result.shot;
      if (result.problems.length) raw.htmlProblem = result.problems.slice(0, 3).join(' ');
      else if (result.fitted)
        state.session.warnings.push(
          `「${typeof raw.title === 'string' ? raw.title.slice(0, 40) : raw.id}」は文字が下端に少しはみ出したため、文字を${Math.round(result.fitted * 100)}%に縮めて収めました（AIは呼び出していません）。`,
        );
    });
  }
  designOptions(state: SessionState, outline?: Outline, run?: AiRun) {
    if (!this.freeDesign(state)) return {};
    const format = this.htmlFor(state, run) ? ('html' as const) : ('json' as const);
    const wanted = state.settings.themeId,
      template = wanted === TEMPLATE_THEME_ID ? this.templateTheme(state) : undefined;
    const typographyId =
      state.settings.typographyId && state.settings.typographyId !== 'auto'
        ? state.settings.typographyId
        : outline?.typographyId;
    const themeId =
      wanted && wanted !== 'auto' && wanted !== TEMPLATE_THEME_ID
        ? wanted
        : (outline?.themeId ?? state.draft?.themeId ?? this.engine.preferredTheme);
    const ai =
      (!wanted || wanted === 'auto') && outline?.palette ? paletteTheme(outline.palette, typographyId) : undefined;
    return {
      design: 'free' as const,
      format,
      editorial: state.settings.editorialGuide !== false,
      outputMode: state.settings.mode,
      theme: ai
        ? ai
        : deckTheme(
            template ? { themeId: TEMPLATE_THEME_ID, customTheme: template, typographyId } : { themeId, typographyId },
          ),
    };
  }
  stylePreferences(state: SessionState) {
    const template =
      state.settings.themeId === TEMPLATE_THEME_ID
        ? (() => {
            try {
              return this.engine.projects.get(state.project.id).template;
            } catch {
              return undefined;
            }
          })()
        : undefined;
    // Free design sends no theme of the app's choosing; the AI picks its own colours and fonts.
    const free = this.freeDesign(state);
    return {
      slideCount: state.settings.slideCount ?? 'auto',
      themeId: template ? 'auto' : (state.settings.themeId ?? 'auto'),
      typographyId: state.settings.typographyId ?? 'auto',
      ...(free ? {} : { preferredTheme: this.engine.preferredTheme }),
      maxSlides: MAX_SLIDES,
      preferredDesign: this.designGuidance(state),
      ...(template
        ? {
            companyTemplate: {
              name: template.name,
              colors: template.colors,
              fonts: template.fonts,
              note: free
                ? '配色・書体は会社テンプレートをアプリが適用します。'
                : '配色・書体は会社テンプレートをアプリが適用します。themeIdは候補から雰囲気が近いものを選んでください。色の意味付けは項目の順序と名前で示します。',
            },
          }
        : {}),
    };
  }

  /** In free design a saved design is sent only when the user chose it; votes alone do not steer the AI. */
  private designGuidance(state: SessionState) {
    const design = state.design;
    if (this.freeDesign(state) && !state.settings.preferredDesignId) return undefined;
    return design
      ? {
          themeId: design.themeId,
          typographyId: design.typographyId,
          ...(this.freeDesign(state) ? {} : { layoutIds: design.layoutIds }),
          explicit: Boolean(state.settings.preferredDesignId),
        }
      : undefined;
  }
  /** Pages can be shown to the AI as images: an AI-designed deck made through a monthly plan whose
   * provider takes pictures, and no masking (a picture shows the real names and numbers). */
  canLook(state: SessionState) {
    if (!this.freeDesign(state) || state.settings.provider !== 'subscription' || this.engine.ai.masking(state))
      return false;
    try {
      return (
        (this.engine.options.providerFactory ?? createProvider)(
          state.settings,
          this.engine.options.settings.secret(state.settings.provider),
        ).images === true
      );
    } catch {
      return false;
    }
  }
  /** The automatic look after the deck is shown: HTML method (its pages are drawn while converting). */
  wantsReview(state: SessionState) {
    return state.settings.visualReview !== false && this.htmlFor(state) && this.canLook(state);
  }
  /** One returned page: the HTML reading, format, cover role and sources. */
  checkPage(state: SessionState, raw: any, expected: string): SlideSpec {
    if (!raw || raw.id !== expected)
      throw new AppError(
        422,
        `${expected}がありません。生成したページの識別子・順序を構成と一致させてください。`,
        'INVALID_CONTENT',
      );
    const warnings = [...state.session.warnings];
    try {
      if (typeof raw.htmlProblem === 'string') throw new AppError(422, raw.htmlProblem, 'INVALID_CONTENT');
      const slide = validateSlide(raw, expected);
      if ((slide.id === 'slide-1') !== (slide.layoutId === 'cover'))
        throw new AppError(422, '表紙と本文の役割が構成と一致しません。', 'INVALID_CONTENT');
      this.verifySources(state, [slide]);
      return slide;
    } catch (error) {
      state.session.warnings = warnings;
      if (error instanceof AppError)
        error.message = `${expected}：${error.message.replace(/^生成内容を確認できません: /, '')}`;
      throw error;
    }
  }
  verifySources(state: SessionState, slides: SlideSpec[]) {
    for (const slide of slides) {
      for (const source of slide.sources) {
        const document = state.documents.find(document => document.id === source.documentId);
        const unit = document?.sources.find(unit => unit.locator === source.locator);
        if (!document || !unit)
          throw new AppError(
            422,
            `「${slide.title}」の出典位置が資料に存在しません。内容を再生成してください。`,
            'INVALID_SOURCE',
          );
        if (source.quote && !looseText(unit.text).includes(looseText(source.quote))) {
          // A quote whose numbers are not in the cited text is invented evidence and is refused.
          // One that only differs in spacing, line breaks or punctuation of the PDF text is
          // dropped (the location itself is verified), instead of costing a whole regeneration.
          const values = sourceValues(unit.text);
          if (numbersIn(source.quote).some(value => !values.has(value)))
            throw new AppError(
              422,
              `「${slide.title}」の引用が原資料と一致しません。内容を再生成してください。`,
              'INVALID_QUOTE',
            );
          delete source.quote;
          state.session.warnings.push(
            `「${slide.title}」の引用文が原文の表記と一致しないため、引用文を外しました。出典の位置は確認済みです。`,
          );
        }
        Object.assign(source, { documentName: document.name });
      }
      if (state.documents.length && !slide.sources.length && slide.layoutId !== 'cover')
        state.session.warnings.push(
          `「${slide.title}」には資料への出典がありません。一般的な説明・仮説・根拠不足のどれに当たるか確認してください。`,
        );
      if (slide.chart && state.documents.length)
        state.session.warnings.push(
          `「${slide.title}」: 出典の位置を確認しましたが、グラフの値・単位・比較条件は原資料と照合してください。`,
        );
    }
    state.session.warnings = [...new Set(state.session.warnings)];
  }
  checkSlideCount(state: SessionState, outline: Outline) {
    if (typeof state.settings.slideCount === 'number' && outline.slides.length !== state.settings.slideCount)
      throw new AppError(
        422,
        `指定は表紙込み${state.settings.slideCount}枚ですが、構成案は${outline.slides.length}枚です。枚数を合わせるよう指示してください。`,
        'SLIDE_COUNT_MISMATCH',
      );
  }
}
