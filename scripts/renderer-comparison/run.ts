/** Draws the comparison decks with both renderers on Windows and writes report.html.
 *
 *   npx tsx scripts/renderer-comparison/run.ts [--quick] [--out <directory>]
 *
 * Needs desktop PowerPoint and Excel and the built native renderer (Setup or `npm run build:native`). No AI is
 * called. The C# file comes from the app's own render bridge; the TS file from the browser build's PptxGenJS
 * writer; PowerPoint pictures both. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRenderBridge } from '../../server/render-bridge';
import { deckToPptx } from '../../web/hosted/pptx-renderer';
import { comparisonDecks } from './decks';
import { readPptx } from './structure';
import { compareDecks } from './compare';
import { decodePng, diffPictures, encodePng, halve, halveDiff } from './png';
import { buildReport, summarize, type ReportSlide } from './report';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const quick = args.includes('--quick');
const outArg = args[args.indexOf('--out') + 1];
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(
  args.includes('--out') && outArg ? outArg : path.join(root, 'runtime', 'renderer-comparison', stamp),
);

const bridge = createRenderBridge(root);
if (!(await bridge.nativeAvailable()))
  throw new Error('ネイティブ描画器がありません。先に npm run build:native を実行してください。');
await fs.mkdir(out, { recursive: true });
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const commit = await execute('git', ['rev-parse', '--short', 'HEAD'], { cwd: root }).then(
  r => r.stdout.trim(),
  () => undefined,
);

const slides: ReportSlide[] = [];
for (const item of comparisonDecks(quick)) {
  const dir = path.join(out, item.id);
  await fs.mkdir(dir, { recursive: true });
  console.log(`${item.id}: ${item.deck.slides.length}枚を描画`);
  const native = await bridge.render(item.deck, `compare-${item.id}`);
  const nativeDir = path.join(bridge.artifactRoot, native.artifactId);
  await fs.copyFile(path.join(nativeDir, 'presentation.pptx'), path.join(dir, 'native.pptx'));
  const { blob } = await deckToPptx(item.deck);
  await fs.writeFile(path.join(dir, 'hosted.pptx'), Buffer.from(await blob.arrayBuffer()));
  await execute(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(root, 'scripts', 'renderer-comparison', 'Export-Slides.ps1'),
      '-Path',
      path.join(dir, 'hosted.pptx'),
      '-Out',
      dir,
    ],
    { timeout: Math.max(120_000, item.deck.slides.length * 10_000) },
  );
  const comparisons = compareDecks(
    await readPptx(await fs.readFile(path.join(dir, 'native.pptx'))),
    await readPptx(await fs.readFile(path.join(dir, 'hosted.pptx'))),
  );
  for (const comparison of comparisons) {
    const n = comparison.number;
    const a = decodePng(await fs.readFile(path.join(nativeDir, `slide-${n}.png`))),
      b = decodePng(await fs.readFile(path.join(dir, `hosted-${n}.png`)));
    const diff = diffPictures(a, b);
    const small = {
      native: encodePng(halve(a)),
      hosted: encodePng(halve(b)),
      diff: encodePng(halveDiff(diff.picture)),
    };
    await fs.writeFile(path.join(dir, `native-${n}.png`), encodePng(a));
    await fs.writeFile(path.join(dir, `diff-${n}.png`), encodePng(diff.picture));
    slides.push({
      deck: item.title,
      label: item.labels[n - 1] ?? '',
      comparison,
      pixelShare: diff.share,
      images: { native: dataUrl(small.native), hosted: dataUrl(small.hosted), diff: dataUrl(small.diff) },
    });
  }
}
const createdAt = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
await fs.writeFile(path.join(out, 'report.html'), buildReport({ createdAt, commit, slides }));
await fs.writeFile(
  path.join(out, 'summary.json'),
  JSON.stringify(
    {
      createdAt,
      commit,
      summary: summarize(slides),
      slides: slides.map(s => ({
        deck: s.deck,
        page: s.comparison.number,
        label: s.label,
        pixelShare: s.pixelShare,
        differences: s.comparison.differences.map(d => ({ kind: d.kind, message: d.message })),
      })),
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ report: path.join(out, 'report.html'), ...summarize(slides) }, null, 2));
