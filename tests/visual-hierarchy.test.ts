import test from 'node:test';
import assert from 'node:assert/strict';
import { compileDeck } from '../core/shared/layouts';
import { sampleDeck } from '../core/shared/layout-samples';
import { themes } from '../core/shared/themes';
import { contextColor, contrast, onAccent } from '../core/shared/color';
import { chartColors } from '../core/shared/charts';
import { validateSlide } from '../core/validation';
import type { ChartElement, SceneElement, SlideSpec, TextElement } from '../core/shared/contracts';

const theme = themes.business;
const slide = (layoutId: string, extra: Partial<SlideSpec>): SlideSpec => ({
  id: layoutId,
  layoutId,
  title: '短い題名',
  items: [],
  sources: [],
  notes: '',
  ...extra,
});
const scene = (s: SlideSpec) => compileDeck(sampleDeck([s])).slides[0].elements;
const texts = (elements: SceneElement[]) => elements.filter((e): e is TextElement => e.kind === 'text');
const textOf = (elements: SceneElement[], value: string) =>
  texts(elements).find(e => e.text.replace(/\s/g, '') === value.replace(/\s/g, ''));

test('validation keeps one lead item per page and only highlights real categories', () => {
  const checked = validateSlide({
    id: 's1',
    layoutId: 'summary',
    title: '要点',
    items: [
      { label: 'A', emphasis: true },
      { label: 'B', emphasis: true },
      { label: 'C', emphasis: 'yes' },
    ],
    sources: [],
    notes: '',
  });
  assert.deepEqual(
    checked.items.map(i => !!i.emphasis),
    [true, false, false],
  );
  const chart = (highlight: unknown) =>
    validateSlide({
      id: 's2',
      layoutId: 'chart_spacious',
      title: '内訳',
      items: [],
      chart: {
        type: 'bar',
        categories: ['惣菜', '青果', 'パン'],
        series: [{ name: '量', values: [3, 2, 1] }],
        highlight,
      },
      sources: [],
      notes: '',
    }).chart!;
  assert.deepEqual(chart(['惣菜', '存在しない', '惣菜']).highlight, ['惣菜']);
  assert.equal(chart(['惣菜', '青果', 'パン']).highlight, undefined, 'highlighting everything is no highlight');
});

test('a highlighted chart keeps the accent for its subject and greys the context', () => {
  const elements = scene(
    slide('chart_spacious', {
      chart: {
        type: 'bar',
        categories: ['惣菜', '青果', 'パン', '日配'],
        series: [{ name: '廃棄量', values: [68, 59, 24, 19] }],
        highlight: ['惣菜'],
      },
    }),
  );
  const chart = elements.find((e): e is ChartElement => e.kind === 'chart')!;
  assert.deepEqual(chart.pointColors, [
    chartColors(theme)[0],
    contextColor(theme),
    contextColor(theme),
    contextColor(theme),
  ]);
  assert.ok(contrast(contextColor(theme), theme.background) >= 3, 'the grey bars stay visible');
});

test('the lead KPI sits on the accent field with readable type, the others step back', () => {
  const elements = scene(
    slide('kpi', {
      items: [
        { label: '廃棄量', value: '182kg', description: '日量' },
        { label: '廃棄額', value: '2,900万円', description: '年額', emphasis: true },
        { label: '値引き率', value: '38%', description: '閉店前' },
      ],
    }),
  );
  assert.ok(
    elements.some(e => e.kind === 'shape' && e.fill === theme.accent),
    'the lead card is filled with the accent',
  );
  assert.equal(textOf(elements, '2,900万円')?.color, onAccent(theme));
  assert.notEqual(textOf(elements, '182kg')?.color, theme.accent, 'quiet cards do not compete in the accent');
});

test('under a one-line title the takeaway becomes its subtitle; a long title pushes it down', () => {
  const headline = '惣菜と青果だけで廃棄の7割を占める';
  const items = [{ label: '惣菜' }, { label: '青果' }, { label: 'パン' }];
  const short = scene(slide('process', { headline, items, diagram: { type: 'process', items } }));
  assert.equal(textOf(short, headline)?.y, 96);
  assert.ok(
    textOf(short, '短い題名')!.y + textOf(short, '短い題名')!.h <= 96,
    'the title gives up its unused second line',
  );
  assert.equal(short.find(e => e.kind === 'smartart')?.y, 166, 'the diagram keeps its usual top');
  const long = scene(
    slide('process', {
      title: '地域スーパー3店舗で一年をかけて食品ロスを半分にするための四つの段階と、その順番の理由',
      headline,
      items,
      diagram: { type: 'process', items },
    }),
  );
  assert.equal(textOf(long, headline)?.y, 150);
  assert.equal(long.find(e => e.kind === 'smartart')?.y, 206);
});

test('a summary draws its conclusion on an accent band and lets the numbers lead the rows', () => {
  const elements = scene(
    slide('summary', {
      headline: '廃棄を半分、利益は年1,200万円改善',
      items: [
        { label: '廃棄量', value: '182kg→90kg/日', description: '発注見直しで半減' },
        { label: '値引き率', value: '38%→25%', description: '夕方からの段階値引き', emphasis: true },
        { label: '寄付', value: '月1.5トン', description: 'フードバンク2団体へ' },
      ],
    }),
  );
  assert.ok(elements.some(e => e.kind === 'shape' && e.fill === theme.accent && e.y === 150 && e.w === 848));
  const band = textOf(elements, '廃棄を半分、利益は年1,200万円改善')!;
  assert.equal(band.color, onAccent(theme));
  assert.equal(band.verticalAlign, 'middle');
  const value = textOf(elements, '38%→25%')!,
    label = textOf(elements, '値引き率')!;
  assert.equal(value.role, 'number');
  assert.ok(value.fontSize >= 26 && value.fontSize > label.fontSize, 'the number is larger than its label');
  assert.ok(value.x < label.x, 'the number comes first in its row');
  assert.ok(!texts(elements).some(e => e.text === '01'), 'row numbers step aside for the numbers');
});

test('a cycle without a note takes the middle of the page', () => {
  const items = [{ label: '記録' }, { label: '分析' }, { label: '対策' }, { label: '確認' }];
  const art = scene(slide('cycle', { items, diagram: { type: 'cycle', items } })).find(e => e.kind === 'smartart')!;
  assert.equal(art.x + art.w / 2, 480, 'centred on the page');
});
