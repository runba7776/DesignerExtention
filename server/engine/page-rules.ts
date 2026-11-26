import {
  MAX_SLIDES,
  MIN_TEXT_SIZE,
  type DeckSpec,
  type Outline,
  type SlideSpec,
  type Theme,
} from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { repairReason } from '../repair-policy.js';
import type { ParsedDocument } from '../document-model.js';
import { createProvider } from '../providers.js';
import { validateSlide } from '../validation.js';
import type { HtmlPageLayout } from '../html-layout.js';
import { themes, TEMPLATE_THEME_ID } from '../../shared/themes.js';
import { deckTheme } from '../../shared/layouts.js';
import { AI_THEME_ID, paletteTheme } from '../../shared/ai-theme.js';
import { templateToTheme } from '../../shared/template-style.js';
import { sourceValues } from '../../shared/source-audit.js';
import { numbersIn } from '../../shared/numbers.js';
import { makingMethod, writerTraits, type MakingMethod } from '../../shared/making.js';
import type { SessionEngine } from '../engine.js';
import type { AiRun, SessionState } from './session-state.js';
import { looseText } from './helpers.js';

/** A location that does not exist but lies between two that do, for locators that end in a number (行 4 between
 * 行 3 and 行 5; ページ 3; Sheet1!行 12): the AI meant a line beside an empty one. Returns the two around it, written
 * from what the documents hold (the AI's own text is not repeated). Anything else, a location past the end or of
 * another kind, is not a slip of one line and gets no such help. */
function locatorsAround(document: ParsedDocument, locator: string) {
  const match = /^(.*?)(\d+)$/.exec(locator.trim());
  if (!match) return undefined;
  const [, prefix, digits] = match,
    wanted = Number(digits),
    numbers = document.sources.flatMap(unit =>
      unit.locator.startsWith(prefix) && /^\d+$/.test(unit.locator.slice(prefix.length))
        ? [Number(unit.locator.slice(prefix.length))]
        : [],
    ),
    below = Math.max(...numbers.filter(n => n < wanted)),
    above = Math.min(...numbers.filter(n => n > wanted));
  return Number.isFinite(below) && Number.isFinite(above)
    ? { wanted: `${prefix}${wanted}`, near: [`${prefix}${below}`, `${prefix}${above}`] }
    : undefined;
}
/** Takes one citation off a page and renumbers the marks that point to the later ones. */
function dropSource(slide: SlideSpec, at: number) {
  slide.sources.splice(at, 1);
  const gone = at + 1,
    renumber = (holder: { refs?: number[] }) => {
      const refs = holder.refs?.filter(n => n !== gone).map(n => (n > gone ? n - 1 : n));
      if (refs?.length) holder.refs = refs;
      else delete holder.refs;
    };
  for (const item of [...slide.items, ...(slide.diagram?.items ?? [])]) renumber(item);
  for (const element of slide.design?.elements ?? []) if (element.t === 'text') renumber(element);
}

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
  /** The AI that writes: the session's, or the AI of this run when the session has several. */
  writer(state: SessionState, run?: AiRun) {
    return (run ? this.engine.ai.targetSettings(state, run.target) : state.settings).provider;
  }
  /** How this session's pages are written (see shared/making.ts for the table). Once the browser that reads HTML
   * could not start in this session, the rest is written as if it were not there (coordinates, or the layouts for
   * a local model). */
  making(state: SessionState, run?: AiRun): MakingMethod {
    return makingMethod({
      provider: state.settings.provider,
      writer: run && this.writer(state, run),
      designMode: state.settings.designMode,
      sendScope: state.sendScope,
      canReadHtml: !!this.engine.options.htmlLayout && !state.htmlUnavailable,
    });
  }
  /** The AI designs every page with its own ability (HTML or coordinates), not from the app's layouts. */
  freeDesign(state: SessionState) {
    return this.making(state) !== 'template';
  }
  htmlFor(state: SessionState, run?: AiRun) {
    return this.making(state, run) === 'html';
  }
  /** Photos from Wikimedia Commons for the places the AI marks (installed app): the AI's search words leave
   * this PC, so only when the content already goes to a cloud AI as it is (not masked, not kept on this PC). */
  imagesFor(state: SessionState, run?: AiRun) {
    return (
      !!this.engine.options.images &&
      this.freeDesign(state) &&
      state.settings.imageSearch !== false &&
      [this.writer(state, run), state.settings.provider].every(p => writerTraits(p).photos) &&
      state.sendScope !== 'design' &&
      !this.engine.ai.masking(state)
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
          keepSmall: writerTraits(this.writer(state, run)).keepsSmallText,
        },
      );
    } catch (error) {
      state.htmlUnavailable = error instanceof Error ? error.message : 'HTMLを図形に変換できませんでした。';
      throw new AppError(503, state.htmlUnavailable, 'HTML_LAYOUT_UNAVAILABLE');
    }
    work.forEach((raw, i) => {
      const result = results[i],
        html = raw.html;
      delete raw.html;
      if (!result || 'error' in result) {
        raw.htmlProblem = result?.error ?? 'HTMLを読み取れませんでした。';
        return;
      }
      raw.design = { ...(result.background ? { background: result.background } : {}), elements: result.elements };
      // The page's HTML stays beside its picture: the look at the pages tells a page in HTML from one made from a layout.
      if (result.shot) Object.assign(raw, { shot: result.shot, shotHtml: html });
      const name = `「${typeof raw.title === 'string' ? raw.title.slice(0, 40) : raw.id}」`;
      if (result.problems.length) {
        raw.htmlProblem = result.problems.slice(0, 3).join(' ');
        if (result.unreadable) raw.htmlUnreadable = true;
      } else if (result.squeezed || result.fitted) {
        const done = [
          result.squeezed && '余白を詰め',
          result.fitted && `文字を${Math.round(result.fitted * 100)}%に縮め`,
        ];
        state.session.warnings.push(
          `${name}は文字のはみ出しや重なりを防ぐため、${done.filter(Boolean).join('、')}て収めました（AIは呼び出していません）。`,
        );
      } else if (result.keptSmall)
        state.session.warnings.push(
          `${name}は一部の文字を既定より少し小さいまま（本文は最大2px）作成しました。大きくすると収まらないためです（AIは呼び出していません）。`,
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
      local: writerTraits(this.writer(state, run)).localGuide,
      images: this.imagesFor(state, run),
      editorial: state.settings.editorialGuide !== false,
      outputMode: state.settings.mode,
      theme: ai
        ? ai
        : deckTheme(
            template ? { themeId: TEMPLATE_THEME_ID, customTheme: template, typographyId } : { themeId, typographyId },
          ),
    };
  }
  /** Style hints for the model. A company template is applied by the app, so the
   * model only learns its palette/fonts and keeps choosing a built-in theme id. */
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
  /** Pages can be shown to the AI as images: an AI-designed deck made through a monthly plan or a local
   * model whose provider takes pictures, and no masking (a picture shows the real names and numbers). */
  canLook(state: SessionState) {
    if (
      !this.freeDesign(state) ||
      !['subscription', 'local'].includes(state.settings.provider) ||
      this.engine.ai.masking(state)
    )
      return false;
    try {
      return (this.engine.options.providerFactory ?? createProvider)(state.settings).images === true;
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
    // An AI-designed page is the cover or a free page by its place, so one left without it is not asked again
    // (gemma4 left it out of single pages).
    if (raw.layoutId === undefined && this.freeDesign(state)) raw.layoutId = expected === 'slide-1' ? 'cover' : 'free';
    const warnings = [...state.session.warnings];
    try {
      if (typeof raw.htmlProblem === 'string') throw new AppError(422, raw.htmlProblem, 'INVALID_CONTENT');
      const slide = validateSlide(raw, expected);
      if ((slide.id === 'slide-1') !== (slide.layoutId === 'cover'))
        throw new AppError(422, '表紙と本文の役割が構成と一致しません。', 'INVALID_CONTENT');
      // gemma4 returned layout pages with nothing but the title (3 of 5 in one deck); no layout is only a title.
      const { items, body, headline, chart, table, diagram, equation, design } = slide;
      if (
        state.settings.provider === 'local' &&
        slide.layoutId !== 'cover' &&
        !items.length &&
        !(body || headline || chart || table || diagram || equation || design)
      )
        throw new AppError(
          422,
          'ページに題名しかありません。要点（items）か本文（body）を書いてください。',
          'INVALID_CONTENT',
        );
      this.verifySources(state, [slide]);
      return slide;
    } catch (error) {
      state.session.warnings = warnings;
      if (error instanceof AppError)
        error.message = `${expected}：${error.message.replace(/^生成内容を確認できません: /, '')}`;
      throw error;
    }
  }
  /** A citation the documents do not hold (an empty line beside the one meant, as 行 2, 4, 152 and 169 of one file;
   * a location past the end; another document) or a quote whose numbers are not in the cited text is asked for once
   * more, an empty line with the two locations around it. After that, or where nothing is asked again (samples, a
   * pasted reply), that citation is left out and the user is told, instead of stopping the deck: the empty lines
   * alone stopped one at 0 of 8 pages three times. The numbers it was given for then show as uncited. */
  /** With automatic repair turned off, a citation the documents do not hold at all, or an invented quote, is refused
   * as it always was, so that the user decides; an empty line beside the one meant is still left out. */
  private refuses() {
    return this.engine.options.settings.get().autoRepair === false;
  }
  private asksAgain(state: SessionState, code: 'INVALID_SOURCE' | 'INVALID_QUOTE') {
    const reason = repairReason(new AppError(422, '', code))?.reason;
    return (
      (state.repairOperation?.remaining ?? 0) > 0 &&
      !state.session.repairReport?.steps.some(step => step.reason === reason)
    );
  }
  /** stored: a deck that was checked when it was made (history, a saved design, a combination) is refused when a
   * citation no longer holds, and nothing is left out of it. */
  verifySources(state: SessionState, slides: SlideSpec[], stored = false) {
    for (const slide of slides) {
      for (let at = 0; at < slide.sources.length; at++) {
        const source = slide.sources[at];
        const document = state.documents.find(document => document.id === source.documentId);
        const unit = document?.sources.find(unit => unit.locator === source.locator);
        if (!document || !unit) {
          const around = document && locatorsAround(document, source.locator);
          if (stored || this.asksAgain(state, 'INVALID_SOURCE') || (!around && this.refuses()))
            throw new AppError(
              422,
              `「${slide.title}」の出典位置が資料に存在しません。${around ? `${around.wanted}は資料にない位置です（空行など）。近くにある位置は${around.near.join('と')}です。` : ''}documentsにあるunitのdocumentIdとlocatorを、そのままの文字で使ってください。`,
              'INVALID_SOURCE',
            );
          dropSource(slide, at--);
          state.session.warnings.push(
            around
              ? `「${slide.title}」の出典のうち、資料の空行などを指していた1件（${around.wanted}）を外しました。根拠の位置を確認してください。`
              : `「${slide.title}」の出典のうち、資料にない位置を指していたものを外しました。根拠を確認してください。`,
          );
          continue;
        }
        if (source.quote && !looseText(unit.text).includes(looseText(source.quote))) {
          // A quote whose numbers are not in the cited text is invented evidence: asked again once, then the
          // citation goes. One that only differs in spacing, line breaks or punctuation of the PDF text loses
          // its quote only (the location itself is verified), instead of costing a whole regeneration.
          const values = sourceValues(unit.text);
          if (numbersIn(source.quote).some(value => !values.has(value))) {
            if (stored || this.asksAgain(state, 'INVALID_QUOTE') || this.refuses())
              throw new AppError(
                422,
                `「${slide.title}」の引用が原資料と一致しません。quoteは資料の原文をそのまま短く使うか、省いてください。`,
                'INVALID_QUOTE',
              );
            dropSource(slide, at--);
            state.session.warnings.push(
              `「${slide.title}」の出典のうち、引用の数値が資料のその位置にないものを外しました。根拠を確認してください。`,
            );
            continue;
          }
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
