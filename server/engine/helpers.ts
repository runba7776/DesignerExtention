// Small pure helpers shared by the parts of the engine.
import type { AiTarget, DeckSpec, Outline, ReviewHint, Settings, SlideSpec } from '../../shared/contracts.js';
import { AppError } from '../errors.js';
import { validateDesignReply } from '../validation.js';
import { themes } from '../../shared/themes.js';
import { fitProblems } from '../text-fit.js';
import { improveTextFit } from '../../shared/layout-selection.js';
import { slideContent } from '../../shared/slots.js';
import type { DesignPacket, SlotContent } from '../../shared/confidential.js';
import { draftMarks } from '../../shared/blanks.js';
import { compositionOf, repeatedPages } from '../../shared/composition.js';

/** Text compared without spacing, line breaks and punctuation, which PDF extraction changes. */
export const looseText = (text: string) =>
  text.normalize('NFKC').replace(/[\s、。,.・「」『』()（）［］\[\]:：;；\-－―〜~]/g, '');

/** A palette whose background is dark (relative luminance below 0.2). */
export function darkPalette(palette?: { background: string }) {
  const hex = /^#([0-9a-f]{6})$/i.exec(palette?.background ?? '')?.[1];
  if (!hex) return false;
  const [r, g, b] = [0, 2, 4]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.2;
}

export const chatServiceNames: Record<string, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  copilot: 'Microsoft Copilot',
  other: 'その他のAI',
};

export const chatServiceName = (service: string) => chatServiceNames[service] ?? 'AI';

export const targetLabel = (target: AiTarget) => (target === 'local' ? 'ローカルLLM' : chatServiceName(target));

/** Whether two versions of a page say the same: the same words (spacing aside), numbers, charts and tables. */
export function sameContent(a: SlideSpec, b: SlideSpec) {
  const squash = (text: string) => text.replace(/\s+/g, '');
  const key = (s: SlideSpec) => {
    const c = slideContent(s),
      title = s.design?.elements.find(e => e.t === 'text' && e.role === 'title');
    return JSON.stringify({
      title: title && title.t === 'text' ? squash(title.text) : squash(s.title),
      texts: c.texts.map(t => squash(t.text)).sort(),
      charts: c.charts.map(x => [x.categories, x.series.map(v => [v.name, v.values])]),
      tables: c.tables,
    });
  };
  return key(a) === key(b);
}

/** The settings of one AI chosen for a session. */
export function settingsFor(base: Settings, target: AiTarget): Settings {
  if (target === 'local')
    return { ...base, provider: 'local', model: base.localModel ?? (base.provider === 'local' ? base.model : '') };
  return {
    ...base,
    provider: 'subscription',
    subscriptionService: target,
    model: base.provider === 'subscription' && base.subscriptionService === target ? base.model : 'auto',
  };
}

/** A design reply filled with the real content. A text a little long for its box is
 * set smaller first; a real overflow is reported by slot name only (never the wording). */
export function fillDesign(raw: unknown, packet: DesignPacket, contents: Record<string, SlotContent>, deck: DeckSpec) {
  const slides = improveTextFit({ ...deck, slides: validateDesignReply(raw, packet, contents, deck) }).slides;
  const fit = fitProblems({ ...deck, slides });
  if (fit.length) {
    const problems = fit.flatMap(p =>
      p.issues.map(issue => {
        const slot = Object.entries(contents[p.slideId].texts).find(([, v]) => issue.text.startsWith(v.text))?.[0];
        return `${p.slideId}の${slot ?? '文字の枠'}は、その大きさでは文字が収まりません。枠を広げるか、文字を小さくしてください。`;
      }),
    );
    throw new AppError(422, [...new Set(problems)].join(' '), 'TEXT_FIT_REQUIRED');
  }
  return slides;
}

/** A built-in theme id; anything else an AI writes ("ai", a made-up name) is ignored, not an error. */
export function knownTheme(value: unknown): value is string {
  return typeof value === 'string' && Object.hasOwn(themes, value);
}

/** What a later batch needs to keep the deck consistent without re-reading earlier pages. */
export function continued(slide: SlideSpec) {
  if (!slide.design) return { title: slide.title, headline: slide.headline, layoutId: slide.layoutId };
  const kinds = new Map<string, number>();
  for (const e of slide.design.elements) {
    const key = e.t === 'box' ? (e.shape ?? 'rect') : e.t;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const title = slide.design.elements.find(e => e.t === 'text' && e.role === 'title');
  return {
    title: slide.title,
    layoutId: slide.layoutId,
    layout: compositionOf(slide),
    composition: [...kinds].map(([k, n]) => `${k}×${n}`).join(' '),
    ...(slide.design.background ? { background: slide.design.background } : {}),
    ...(title && title.t === 'text' ? { titleBox: [title.x, title.y, title.w, title.h, title.size] } : {}),
  };
}

/** The facts the user gave for the open items of an outline, by name. */
export function factValues(outline: Outline): Record<string, string> {
  return Object.fromEntries((outline.openFacts ?? []).filter(f => f.value).map(f => [f.label, f.value!]));
}

/** An outline without the user's answers, to find the sample pages made for it before they were given. */
export function plainOutline(outline: Outline) {
  return JSON.stringify({
    ...outline,
    ...(outline.openFacts
      ? { openFacts: outline.openFacts.map(({ label, hint }) => ({ label, ...(hint ? { hint } : {}) })) }
      : {}),
  });
}

/** What the app finds on finished pages without an AI: notes to the maker or empty dates left on a slide,
 * and the same kind of page (a table, a row of cards) three pages in a row. */
export function deckFindings(slides: SlideSpec[]): ReviewHint[] {
  const out: ReviewHint[] = [];
  for (const slide of slides) {
    const marks = draftMarks(slide);
    const memo = marks.filter(m => m.kind === 'memo'),
      blank = marks.filter(m => m.kind === 'blank');
    if (memo.length)
      out.push({
        slideId: slide.id,
        title: slide.title,
        severity: 'high',
        what: `作り手向けのメモ（「${memo[0].sample}」）がスライドに残っています`,
        fix: 'メモはノートの「確認事項」へ移し、未定の事実は［項目名］の記入欄にする',
      });
    if (blank.length)
      out.push({
        slideId: slide.id,
        title: slide.title,
        severity: 'high',
        what: `空欄（「${blank[0].sample}」）が記入欄の形になっていません`,
        fix: '未定の事実は［実施日］のような記入欄にする',
      });
  }
  for (const page of repeatedPages(slides)) {
    const slide = slides.find(s => s.id === page.slideId)!;
    out.push({
      slideId: slide.id,
      title: slide.title,
      severity: 'high',
      what: `前後と同じ${page.kind === 'table' ? '表' : '囲みの並び'}の構図が3ページ以上続いています`,
      fix: 'このページの内容に合う別の見せ方にする（文章・数値はそのまま）',
    });
  }
  return out;
}
