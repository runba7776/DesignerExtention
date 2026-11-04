// Fixed evaluation of a local model: the same five requests, made the way the app makes them, each in an
// empty data folder (the user's settings and history are not touched). Counts what a deck came out as, so
// a change to the instructions or checks can be compared by numbers rather than by one deck.
//   npm run eval:local -- --model gemma4:12b [--runs 2] [--only 1,3] [--no-review] [--render] [--design claude]
// --design: the content is written here and only the skeleton goes to the connected Claude/ChatGPT for the
// design (作成画面の「内容は送らない」). What was sent is checked again here against the request and the deck.
// --ai claude: the connected Claude/ChatGPT writes the whole deck, with photos found on Wikimedia Commons (kept in
// runtime/images); one outline instead of three directions. Counts the pictures, charts, tables and effects.
// --guide no-look | off (with --ai): the standing instruction (常設指示) without its section on the look that keeps
// decoration down, or not sent at all (only how the app's photos, charts and icons are placed is left).
// Results: runtime/eval/<time>-<model>.json (with --render, the pages as pictures beside it).
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeckSpec, SubscriptionService } from '../shared/contracts.js';
import { SessionEngine } from '../server/engine.js';
import { SettingsStore } from '../server/settings.js';
import { layoutHtmlSlides } from '../server/html-layout.js';
import { createRenderBridge } from '../server/render-bridge.js';
import { createProvider, type Provider } from '../server/providers.js';
import { SubscriptionManager } from '../server/subscription.js';
import { createImageStore } from '../server/images.js';

const REQUESTS = [
  '新入社員向けの情報セキュリティ研修を5枚で。パスワード管理と不審メールの見分け方、困ったときの報告先。',
  '第2四半期の営業報告を5枚で。売上は前年同期比12%増の4.8億円、新規顧客は35社、解約は8社。来期は既存顧客の追加購入を伸ばす。',
  '社内の会議を減らすための提案を5枚で。現状の問題、3つの施策、導入の手順、期待される効果。',
  '社員向けの防災訓練の案内を5枚で。目的、当日の流れ、集合場所、持ち物、問い合わせ先。',
  '中学生に光合成のしくみを説明する授業のスライドを5枚で。',
];

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : (process.argv[i + 1] ?? '');
};
const model = arg('model') ?? 'gemma4:12b',
  endpoint = arg('endpoint') ?? 'http://127.0.0.1:11434/v1',
  runs = Number(arg('runs') ?? 1),
  only = arg('only')?.split(',').map(Number),
  render = process.argv.includes('--render'),
  review = !process.argv.includes('--no-review'),
  design = arg('design') as SubscriptionService | undefined,
  ai = arg('ai') as SubscriptionService | undefined,
  guide = arg('guide') as 'no-look' | 'off' | undefined;
const root = path.resolve(import.meta.dirname, '..'),
  out = path.join(
    root,
    'runtime',
    'eval',
    `${new Date().toISOString().replace(/[:.]/g, '-')}-${ai ?? model.replace(/[^\w.-]/g, '_')}${design ? `-${design}` : ''}${guide ? `-${guide}` : ''}`,
  );
const bridge = render ? createRenderBridge(root) : undefined;
// The app's own connection to the monthly plan (runtime/), used as the app uses it.
const cloud = design ?? ai,
  subscriptions = cloud ? await new SubscriptionManager(path.join(root, 'runtime')).load() : undefined;
if (cloud) console.log(cloud, (await subscriptions!.refresh(cloud)).state); // reads the signed-in account
const images = ai ? createImageStore(path.join(root, 'runtime', 'images')) : undefined;
/** The instructions with the standing instruction's section on the look taken out (to its next section). */
const LOOK = '■ 見た目の癖で、作業的な印象を与えない';
function withoutLook(system: string) {
  const start = system.indexOf(LOOK);
  if (start < 0) return system; // the look at the drawn pages carries no standing instruction
  return system.slice(0, start) + system.slice(system.indexOf('\n■ ', start) + 1);
}

/** Pieces of the request and the written deck (4 characters, or a number of 2 digits or more) found in the
 * skeleton's strings sent to the cloud AI (its JSON numbers are sizes and lengths): none should be there. The
 * app's own retry notes beside it are checked by the app (phraseLeak) and kept in the sent file to read. */
function leaks(sent: string[], request: string, deck?: DeckSpec) {
  const stringsOf = (v: unknown): string[] =>
    typeof v === 'string'
      ? [v]
      : Array.isArray(v)
        ? v.flatMap(stringsOf)
        : v && typeof v === 'object'
          ? Object.values(v).flatMap(stringsOf)
          : [];
  const strings = sent.flatMap(content => stringsOf(JSON.parse(content).request)),
    texts = [request, ...stringsOf(deck?.slides)],
    pieces = new Set<string>();
  for (const text of texts) {
    const chars = Array.from(text.normalize('NFKC'));
    for (let i = 0; i + 4 <= chars.length; i++) {
      const piece = chars.slice(i, i + 4).join('');
      if (/[^\x00-\x7f]/.test(piece) && !/\s/.test(piece)) pieces.add(piece);
    }
    for (const n of text.normalize('NFKC').match(/\d+(?:\.\d+)?/g) ?? []) if (n.length >= 2) pieces.add(n);
  }
  const all = strings.join('\n').normalize('NFKC');
  // A number counts only on its own (35 is not part of 135 or 3.5).
  return [...pieces].filter(p =>
    /^\d+(\.\d+)?$/.test(p) ? new RegExp(`(?<![\\d.])${p.replace('.', '\\.')}(?![\\d.])`).test(all) : all.includes(p),
  );
}

/** One deck: how it ended, its pages by how they were made, and what the app found on the way. */
async function makeDeck(request: string) {
  const dir = await mkdtemp(path.join(tmpdir(), 'de-eval-'));
  const started = Date.now();
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({
      ...(ai
        ? { provider: 'subscription' as const, subscriptionService: ai, outlineProposals: false }
        : { provider: 'local' as const, endpoint, model }),
      slideCount: 5,
      mode: 'presentation',
      visualReview: review,
      ...(guide === 'off' && { editorialGuide: false }),
    });
    const sent: string[] = [],
      replies: string[] = [];
    // The same provider, recorded (a call that failed has no reply); it still reads pictures (the look at the pages).
    const recorded = (provider: Provider): Provider => ({
      images: provider.images,
      complete: r => {
        const at = sent.push(r.content) - 1;
        return provider
          .complete(guide === 'no-look' ? { ...r, system: withoutLook(r.system) } : r)
          .then(answer => ((replies[at] = answer.text), answer));
      },
    });
    const engine = new SessionEngine({
      settings,
      dataDir: dir,
      htmlLayout: layoutHtmlSlides,
      images,
      render:
        bridge?.render ?? (async () => ({ artifactId: '', pptxUrl: '', thumbnails: [], warnings: [], native: false })),
      // The look at the pages sees them drawn in PowerPoint when they are drawn.
      ...(bridge && { artifactRoot: path.join(root, 'runtime', 'artifacts') }),
      // With a cloud AI, what goes to it (the local model writing the content with --design is not counted as
      // sent); without one, the local model, to read its look at the pages afterwards.
      providerFactory: (current, key) =>
        current.provider === 'subscription'
          ? recorded(subscriptions!.createProvider(current))
          : cloud
            ? createProvider(current, key)
            : recorded(createProvider(current, key)),
      ...(subscriptions && { subscriptionBinding: service => subscriptions.binding(service) }),
    });
    let session = await engine.create(
      {
        prompt: request,
        ...(design && { targets: ['local', design], sendScope: 'design' }),
        ...(ai && { cloudConsent: true }),
      },
      [],
    );
    // Questions before the outline are answered once, as a user leaving it to the AI would.
    if (!session.outline && session.phase === 'clarifying')
      session = await engine.message(session.id, 'おまかせします。合理的な仮定を置いて構成案を作ってください。');
    if (session.outline) await engine.generate(session.id).catch(() => undefined);
    // A stopped deck is made again once, as a user would press 作成 again.
    if (session.outline && session.phase !== 'ready') await engine.generate(session.id).catch(() => undefined);
    const htmlBefore = session.variants?.[0]?.deck.slides.filter(s => s.design).length ?? 0,
      written = Math.round((Date.now() - started) / 1000);
    // The look at the drawn pages the screen starts after showing the deck.
    if (session.polish?.state === 'pending') await engine.polish(session.id).catch(() => undefined);
    const deck = session.variants?.[0]?.deck,
      designed = session.variants.find(v => v.label.startsWith('デザイン：'));
    const hints = session.reviewHints ?? [];
    // Exactly what left this PC for the cloud AI (or what the local model was asked) and what came back.
    const sentFile = `sent-${REQUESTS.indexOf(request) + 1}-${Date.now()}.json`;
    if (sent.length)
      await writeFile(
        path.join(out, sentFile),
        JSON.stringify(
          sent.map((s, i) => ({ sent: JSON.parse(s), reply: replies[i] })),
          null,
          1,
        ),
        'utf8',
      );
    const result = {
      request,
      finished: session.phase === 'ready',
      seconds: Math.round((Date.now() - started) / 1000),
      written,
      calls: session.usage.calls,
      pages: deck?.slides.length ?? 0,
      htmlBefore,
      html: deck?.slides.filter(s => s.design).length ?? 0,
      reviewed: session.reviewReport
        ? {
            checked: session.reviewReport.checked,
            fixed: session.reviewReport.fixed.length,
            unresolved: session.reviewReport.unresolved.length,
          }
        : undefined,
      keptWithSlips: hints.filter(h => h.what.startsWith('AIが直しきれなかった')).length,
      layout: hints.filter(h => h.what.startsWith('AIのデザインが通らなかった')).length,
      fromOutline: hints.filter(h => h.what.startsWith('AIが作れなかった')).length,
      fittedByApp: session.warnings.filter(w => w.includes('AIは呼び出していません')).length,
      repairs: session.repairReport?.retries ?? 0,
      askedFirst: session.messages.filter(m => m.role === 'user').length > 1,
      reasons: hints.map(h => /（(.*)）/.exec(h.what)?.[1]?.slice(0, 60)).filter(Boolean),
      hints: hints.map(h => ({
        slide: h.slideId,
        severity: h.severity,
        what: h.what.slice(0, 120),
        ...(h.fixed ? { fixed: true } : {}),
        ...(h.unresolved ? { unresolved: true } : {}),
      })),
      titles: deck?.slides.map(s => s.title) ?? [],
      // What carries each page besides its words: photos (found, or left as a frame), charts, tables, drawn
      // figures, and shapes with a shadow or gradient.
      visuals: (() => {
        const all = deck?.slides.flatMap(s => s.design?.elements ?? []) ?? [];
        return {
          pagesWithVisual: (deck?.slides ?? []).filter(
            s =>
              s.layoutId !== 'cover' &&
              (s.design?.elements ?? []).some(
                e =>
                  e.t === 'chart' ||
                  e.t === 'table' ||
                  e.t === 'image' ||
                  (e.t === 'svg' && e.w * e.h >= 0.08 * 960 * 540),
              ),
          ).length,
          photos: all.filter(e => e.t === 'image' && e.src).length,
          frames: all.filter(e => e.t === 'image' && !e.src).length,
          words: all.flatMap(e => (e.t === 'image' ? [e.q] : [])),
          charts: all.filter(e => e.t === 'chart').length,
          tables: all.filter(e => e.t === 'table').length,
          figures: all.filter(e => e.t === 'svg' && e.w * e.h >= 0.08 * 960 * 540).length,
          shadows: all.filter(e => e.t === 'box' && e.shadow).length,
          gradients: all.filter(e => e.t === 'box' && e.grad).length,
          spaced: all.filter(e => e.t === 'text' && e.sp).length,
          icons: all.filter(e => e.t === 'icon').length,
          // Thin bands and rules (a box 8px or less across, or a line): what the section on the look holds back.
          rules: all.filter(e => e.t === 'line' || (e.t === 'box' && Math.min(e.w, e.h) <= 8)).length,
        };
      })(),
      ...(design && {
        design: {
          made: !!designed,
          calls: sent.length,
          sentCharacters: sent.reduce((n, s) => n + s.length, 0),
          leaks: leaks(sent, request, deck),
          sent: sentFile,
          failed: session.warnings.filter(w => w.includes('デザインは作成できませんでした')),
        },
      }),
      stopped:
        session.phase === 'ready'
          ? undefined
          : (session.recovery?.message ?? session.messages.at(-1)?.text)?.slice(0, 160),
    };
    if (render && deck && session.phase === 'ready') {
      const pictures: string[] = [];
      for (const variant of [session.variants[0], ...(designed ? [designed] : [])]) {
        const drawn = await engine.render(session.id, variant.id).catch((error: Error) => error);
        if (drawn instanceof Error) {
          pictures.push(`${variant.label}: ${drawn.message.slice(0, 200)}`);
          continue;
        }
        const from = path.join(root, 'runtime', 'artifacts', drawn.artifactId);
        const to = path.join(
          out,
          `deck-${REQUESTS.indexOf(request) + 1}-${variant === designed ? 'design' : 'content'}-${Date.now()}`,
        );
        await mkdir(to, { recursive: true });
        await cp(from, to, { recursive: true });
        await rm(from, { recursive: true, force: true });
        pictures.push(path.relative(out, to));
      }
      Object.assign(result, { pictures });
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await mkdir(out, { recursive: true });
const results: ({ case: number; run: number } & Awaited<ReturnType<typeof makeDeck>>)[] = [];
for (let run = 1; run <= runs; run++)
  for (const [i, request] of REQUESTS.entries()) {
    if (only && !only.includes(i + 1)) continue;
    const result = await makeDeck(request);
    results.push({ case: i + 1, run, ...result });
    console.log(
      `#${i + 1} run ${run}: ${result.finished ? 'finished' : 'stopped'} ${result.seconds}s (pages ${result.written}s), ${result.calls} calls, HTML ${result.htmlBefore}→${result.html}/${result.pages}, layout ${result.layout}, outline ${result.fromOutline}, kept ${result.keptWithSlips}, fitted ${result.fittedByApp}${result.reviewed ? `, review checked ${result.reviewed.checked} fixed ${result.reviewed.fixed} unresolved ${result.reviewed.unresolved}` : ''}, visual pages ${result.visuals.pagesWithVisual}/${Math.max(0, result.pages - 1)} (photos ${result.visuals.photos}, frames ${result.visuals.frames}, charts ${result.visuals.charts}, tables ${result.visuals.tables}, figures ${result.visuals.figures}, shadows ${result.visuals.shadows}, gradients ${result.visuals.gradients}, icons ${result.visuals.icons}, rules ${result.visuals.rules})${result.design ? `, design ${result.design.made ? 'made' : 'failed'} ${result.design.calls} calls, leaks ${result.design.leaks.length}${result.design.failed.length ? ` (${result.design.failed.join(' ')})` : ''}` : ''}`,
    );
  }
const sum = (key: 'html' | 'pages' | 'seconds' | 'calls' | 'layout' | 'fromOutline') =>
  results.reduce((n, r) => n + r[key], 0);
const summary = {
  model: ai ?? model,
  guide: guide ?? 'full',
  review,
  decks: results.length,
  finished: results.filter(r => r.finished).length,
  htmlShare: sum('pages') ? Math.round((sum('html') / sum('pages')) * 100) : 0,
  layoutPages: sum('layout'),
  outlinePages: sum('fromOutline'),
  secondsPerDeck: results.length ? Math.round(sum('seconds') / results.length) : 0,
  callsPerDeck: results.length ? Math.round((sum('calls') / results.length) * 10) / 10 : 0,
  ...(design && {
    design,
    designed: results.filter(r => r.design?.made).length,
    leaks: results.reduce((n, r) => n + (r.design?.leaks.length ?? 0), 0),
  }),
};
await writeFile(path.join(out, 'results.json'), JSON.stringify({ summary, results }, null, 2), 'utf8');
console.log(JSON.stringify(summary));
console.log('saved to', path.relative(root, out));
