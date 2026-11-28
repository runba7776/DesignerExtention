import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { layoutIssues } from '../server/render-bridge';
import { freeSystemPrompt } from '../core/free-prompts';
import { findBrowser, layoutHtmlSlides } from '../server/html-layout';
import { paletteTheme } from '../core/shared/ai-theme';

const theme = paletteTheme({
  name: 't',
  background: '#FFFFFF',
  text: '#1F2937',
  muted: '#6B7280',
  accent: '#1F5A4A',
  accent2: '#E0592A',
});

test('text PowerPoint set over another or past its box reaches the app as well-formed issues of this deck', () => {
  const issues = layoutIssues(
    [
      { slide: 4, kind: 'overlap', text: '月1.5トン', other: '売れ残りを寄付する' },
      { slide: 2, kind: 'notch', text: '一部の部署で試行' },
      { slide: 8, kind: 'edge', text: '現状の廃棄額は年2,900万円' },
      { slide: 9, kind: 'overflow', text: 'x'.repeat(80) },
      { slide: 0, kind: 'overflow', text: '範囲外のページ' },
      { slide: 3, kind: 'unknown', text: '知らない種類' },
      'not an object',
    ],
    9,
  );
  assert.deepEqual(issues, [
    { slide: 4, kind: 'overlap', text: '月1.5トン', other: '売れ残りを寄付する' },
    { slide: 2, kind: 'notch', text: '一部の部署で試行' },
    { slide: 8, kind: 'edge', text: '現状の廃棄額は年2,900万円' },
    { slide: 9, kind: 'overflow', text: 'x'.repeat(40) },
  ]);
  assert.deepEqual(layoutIssues(undefined, 9), []);
});

test('the PowerPoint renderer checks the drawn text and writes what remains for the app', () => {
  const source = readFileSync('native/Renderer.cs', 'utf8');
  assert.match(source, /CheckTextLayout\(slide, i \+ 1\);/);
  assert.match(source, /issues = Issues/);
  for (const kind of ['"overflow"', '"overlap"', '"edge"', '"notch"']) assert.ok(source.includes(kind), kind);
  // Text squeezed at the bottom of its card moves up with the card's other texts before it is made smaller.
  assert.match(source, /if \(CanLift\(pair\.Value, pair\.Key, held, texts, depthOf, wanted - below\)\)/);
  assert.ok(
    source.indexOf('CanLift(pair.Value') < source.indexOf('ShrinkUntil(last, () => card.B - InkBox(last).B >= wanted)'),
  );
});

test('the HTML instructions keep text on a chevron clear of its cut-in and point', () => {
  assert.match(
    freeSystemPrompt('generate', { format: 'html', outputMode: 'presentation' }),
    /切り欠きや先端に文字がかからないようにします/,
  );
});

test(
  'text in a chevron or pentagon keeps clear of its cut-in and point, the shape keeping its size',
  { skip: !findBrowser() },
  async () => {
    const shape = (kind: string, label: string) =>
      `<div data-shape="${kind}" style="flex:1;height:90px;background:#1F5A4A;color:#fff;display:flex;flex-direction:column;justify-content:center;padding:0 12px;font-size:18px"><b>${label}</b></div>`;
    const html = `<section class="slide"><h1 style="position:absolute;left:56px;top:32px;width:848px;margin:0;font-size:30px">段階</h1><div style="position:absolute;left:56px;top:140px;width:848px;display:flex;gap:4px">${shape('chevron', '現状把握と対象チームの選定')}${shape('pentagon', '結果確認と全社展開の判断')}</div><div data-shape="chevron" style="position:absolute;left:56px;top:300px;width:280px;height:90px;background:#ccc"></div></section>`;
    const [page] = await layoutHtmlSlides([{ id: 'slide-2', html }], theme, {});
    assert.ok(!('error' in page));
    const boxes = page.elements.filter((e: any) => e.t === 'box') as any[],
      texts = page.elements.filter((e: any) => e.t === 'text' && e.role !== 'title') as any[];
    assert.deepEqual(
      boxes.map(b => [b.shape, b.w, b.h]),
      [
        ['chevron', 422, 90],
        ['pentagon', 422, 90],
        ['chevron', 280, 90],
      ],
      'the shapes keep the size the page gave them',
    );
    const [chevron, pentagon] = boxes,
      [inChevron, inPentagon] = texts;
    assert.ok(inChevron.x >= chevron.x + 45 + 4, `left of the label ${inChevron.x} clear of the cut-in`);
    assert.ok(inChevron.x + inChevron.w <= chevron.x + chevron.w - 45, 'right of the label clear of the point');
    assert.ok(inPentagon.x >= pentagon.x + 45 * 0.75, 'the same room on the left: a label in the middle stays there');
    assert.ok(inPentagon.x + inPentagon.w <= pentagon.x + pentagon.w - 45 * 0.75);
  },
);
