/** One self-contained HTML page with both renderers' slides side by side, the pixels that differ and the list of
 * object differences, worst slides first in the summary. */
import type { DifferenceKind, SlideComparison } from './compare';

export interface ReportSlide {
  deck: string;
  label: string;
  comparison: SlideComparison;
  /** Share of pixels that differ clearly (0-1). */
  pixelShare: number;
  /** PNG files (data URLs or paths) of the native slide, the hosted slide and their difference. */
  images: { native: string; hosted: string; diff: string };
}
export interface ReportInput {
  createdAt: string;
  commit?: string;
  slides: ReportSlide[];
}

const escape = (text: string) =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const percent = (share: number) => `${(share * 100).toFixed(1)}%`;
const kindNames: Record<DifferenceKind, string> = {
  missing: 'TS版にない',
  extra: 'TS版だけにある',
  kind: '種類が違う',
  place: '位置',
  size: '大きさ',
  text: '文字',
  font: '書体・サイズ',
  fill: '塗り',
  geometry: '形',
};

export function summarize(slides: ReportSlide[]) {
  const byKind: Partial<Record<DifferenceKind, number>> = {};
  for (const s of slides) for (const d of s.comparison.differences) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  const pixel = slides.map(s => s.pixelShare).sort((a, b) => a - b);
  return {
    slides: slides.length,
    identical: slides.filter(s => !s.comparison.differences.length && s.pixelShare < 0.005).length,
    byKind,
    medianPixelShare: pixel.length ? pixel[Math.floor(pixel.length / 2)] : 0,
    maxPixelShare: pixel.at(-1) ?? 0,
    groups: {
      native: slides.reduce((n, s) => n + s.comparison.groups.native, 0),
      hosted: slides.reduce((n, s) => n + s.comparison.groups.hosted, 0),
    },
    notesDiffer: slides.filter(s => !s.comparison.notesEqual).length,
  };
}

export function buildReport(input: ReportInput) {
  const summary = summarize(input.slides);
  const order = input.slides
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        b.s.pixelShare - a.s.pixelShare || b.s.comparison.differences.length - a.s.comparison.differences.length,
    );
  const counts = (c: SlideComparison['counts']['native']) =>
    Object.entries(c)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  const rows = order
    .map(
      ({ s, i }) =>
        `<tr><td><a href="#s${i}">${escape(s.deck)} p.${s.comparison.number}</a></td><td>${escape(s.label)}</td><td class="n">${percent(s.pixelShare)}</td><td class="n">${s.comparison.differences.length}</td></tr>`,
    )
    .join('');
  const sections = input.slides
    .map((s, i) => {
      const c = s.comparison;
      const list = c.differences.length
        ? `<ul>${c.differences.map(d => `<li><span class="tag ${d.kind}">${kindNames[d.kind]}</span>${escape(d.message)}</li>`).join('')}</ul>`
        : '<p class="same">オブジェクトの違いはありません。</p>';
      return `<section id="s${i}"><h2>${escape(s.deck)} p.${c.number}　${escape(s.label)}</h2>
<p class="meta">画素の違い ${percent(s.pixelShare)} ・ オブジェクトの違い ${c.differences.length}件 ・ グループ C# ${c.groups.native} / TS ${c.groups.hosted}${c.notesEqual ? '' : ' ・ ノートが違う'}${c.backgroundEqual ? '' : ' ・ 背景が違う'}</p>
<div class="pics"><figure><img loading="lazy" src="${s.images.native}" alt=""><figcaption>C#（PowerPoint COM・インストール版）</figcaption></figure><figure><img loading="lazy" src="${s.images.hosted}" alt=""><figcaption>TS（PptxGenJS・ブラウザ版）</figcaption></figure><figure><img loading="lazy" src="${s.images.diff}" alt=""><figcaption>違う画素（赤）</figcaption></figure></div>
<p class="meta">C#: ${escape(counts(c.counts.native))}<br>TS: ${escape(counts(c.counts.hosted))}</p>
<details${c.differences.length ? ' open' : ''}><summary>オブジェクトの違い</summary>${list}</details></section>`;
    })
    .join('\n');
  const byKind = Object.entries(summary.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<li>${kindNames[k as DifferenceKind]}: ${n}件</li>`)
    .join('');
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>描画器の比較（C# と TS）</title>
<style>
body{font:15px/1.7 "Yu Gothic UI","Hiragino Sans",sans-serif;margin:0;color:#1d2733;background:#f6f7f9}
header,main{max-width:1500px;margin:0 auto;padding:24px}
h1{font-size:26px;margin:0 0 8px}h2{font-size:18px;margin:0 0 4px}
.lead{max-width:900px}
.cards{display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
.card{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:12px 16px;min-width:160px}
.card b{display:block;font-size:24px}
table{border-collapse:collapse;background:#fff;font-size:14px}td,th{border-bottom:1px solid #e3e6ea;padding:4px 10px;text-align:left}td.n{text-align:right;font-variant-numeric:tabular-nums}
.scroll{max-height:420px;overflow:auto;border:1px solid #dde1e6;display:inline-block}
section{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:16px;margin:20px 0}
.pics{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
figure{margin:0}img{width:100%;border:1px solid #ccd;display:block}figcaption{font-size:13px;color:#5a6573}
.meta{color:#5a6573;font-size:13px;margin:4px 0}
.tag{display:inline-block;font-size:12px;border-radius:4px;padding:0 6px;margin-right:6px;background:#eef1f4}
.tag.missing,.tag.extra,.tag.kind{background:#fde8e8;color:#a31b1b}.tag.place,.tag.size{background:#fff4dd;color:#7a5200}
.same{color:#2f7d4f}
@media(max-width:900px){.pics{grid-template-columns:1fr}}
</style></head><body>
<header><h1>描画器の比較：C#（PowerPoint COM）と TS（PptxGenJS）</h1>
<p class="lead">同じ資料データを2つの描画器でPPTXにし、どちらもPowerPointで画像に書き出して並べました。上の表は違いの大きい順です。「オブジェクトの違い」はPPTXの中身（図形の種類・位置・文字・書体・塗り）を1つずつ突き合わせた結果で、1.5pt未満のずれは数えていません。TS版はSmartArtを編集できる図形で描くので、SmartArtのページは「TS版にない／TS版だけにある」が必ず出ます。</p>
<p class="meta">作成 ${escape(input.createdAt)}${input.commit ? ` ・ コミット ${escape(input.commit)}` : ''}</p>
<div class="cards">
<div class="card">スライド<b>${summary.slides}</b></div>
<div class="card">ほぼ同じ<b>${summary.identical}</b></div>
<div class="card">画素の違い（中央値）<b>${percent(summary.medianPixelShare)}</b></div>
<div class="card">画素の違い（最大）<b>${percent(summary.maxPixelShare)}</b></div>
<div class="card">グループ C# / TS<b>${summary.groups.native} / ${summary.groups.hosted}</b></div>
<div class="card">ノートが違う<b>${summary.notesDiffer}</b></div>
</div>
<h2>違いの種類</h2><ul>${byKind || '<li>なし</li>'}</ul>
<h2>スライドごと（違いの大きい順）</h2>
<div class="scroll"><table><thead><tr><th>ページ</th><th>内容</th><th>画素</th><th>オブジェクト</th></tr></thead><tbody>${rows}</tbody></table></div>
</header>
<main>
${sections}
</main></body></html>
`;
}
