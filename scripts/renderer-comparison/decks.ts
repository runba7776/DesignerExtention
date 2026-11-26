/** The decks both renderers draw for the comparison: every layout of the catalogue, every chart type, and pages
 * designed freely (as the HTML and coordinate methods make them) that use each kind of object. No AI is called;
 * the words and numbers are made up for the check. */
import type { ChartType, DeckSpec, FreeElement, SlideSpec } from '../../shared/contracts';
import { listLayouts } from '../../shared/layouts';
import { sampleDeck, sampleSlide } from '../../shared/layout-samples';
import { chartCatalog, isShareChart, isStackedChart } from '../../shared/charts';

/** The native renderer takes up to 30 slides a deck. */
const PER_DECK = 29;

export interface ComparisonDeck {
  id: string;
  title: string;
  deck: DeckSpec;
  /** What each slide shows, for the report. */
  labels: string[];
}

const note = '比較用の架空の内容です。';
const page = (id: string, title: string, layoutId: string, other: Partial<SlideSpec> = {}): SlideSpec => ({
  id,
  title,
  layoutId,
  items: [],
  notes: note,
  sources: [],
  ...other,
});

function layoutDecks(themeId: string): ComparisonDeck[] {
  const layouts = listLayouts().filter(l => l.id !== 'cover' && l.group !== 'free');
  const decks: ComparisonDeck[] = [];
  for (let start = 0; start < layouts.length; start += PER_DECK) {
    const batch = layouts.slice(start, start + PER_DECK);
    const slides = [sampleSlide('cover'), ...batch.map(l => sampleSlide(l.id))].map((s, i) => ({
      ...s,
      id: `slide-${i + 1}`,
    }));
    const n = decks.length + 1;
    decks.push({
      id: `layouts-${themeId}-${n}`,
      title: `構図カタログ ${n}（${themeId}）`,
      deck: sampleDeck(slides, themeId),
      labels: ['表紙', ...batch.map(l => `${l.name}（${l.id}）`)],
    });
  }
  return decks;
}

function chartDeck(): ComparisonDeck {
  const types = Object.keys(chartCatalog) as ChartType[];
  const charts = types.map((type, i) =>
    page(`slide-${i + 2}`, chartCatalog[type].name, 'chart_spacious', {
      chart: {
        type,
        categories: isShareChart(type) ? ['学習', '運動', '休息'] : ['対象A', '対象B', '対象C'],
        series: isShareChart(type)
          ? [{ name: '内訳', values: [45, 30, 25] }]
          : isStackedChart(type)
            ? [
                { name: '内訳A', values: [24, 36, 42] },
                { name: '内訳B', values: [12, 18, 24] },
              ]
            : type === 'waterfall'
              ? [{ name: '増減', values: [100, -20, 80] }]
              : [{ name: '参考値', values: [24, 36, 48] }],
        unit: isShareChart(type) ? '時間' : '件',
        caption: '比較用の架空データ',
      },
    }),
  );
  const edge = page(`slide-${types.length + 2}`, '棒グラフ：負・ゼロ・小数', 'chart_spacious', {
    chart: {
      type: 'bar',
      categories: ['検証A', '検証B', '検証C'],
      series: [
        { name: '実績', values: [-2.5, 0, 17.75] },
        { name: '比較', values: [12.5, 27.6, 34.75] },
      ],
      unit: '件',
    },
  });
  return {
    id: 'charts',
    title: 'グラフ',
    deck: {
      id: 'charts',
      title: 'グラフの比較',
      mode: 'presentation',
      themeId: 'business',
      slides: [page('slide-1', 'グラフの比較', 'cover', { headline: '7種類と境界値' }), ...charts, edge],
    },
    labels: ['表紙', ...types.map(type => `${chartCatalog[type].name}（${type}）`), '棒グラフの境界値'],
  };
}

const title = (text: string): FreeElement => ({
  t: 'text',
  x: 56,
  y: 28,
  w: 848,
  h: 52,
  text,
  size: 30,
  bold: true,
  color: 'ink',
  role: 'title',
});
const free = (id: string, heading: string, elements: FreeElement[], background?: string): SlideSpec =>
  page(id, heading, 'free', {
    design: { ...(background ? { background } : {}), elements: [title(heading), ...elements] },
  });

/** Pages as the HTML method leaves them: measured text, cards kept together, freeforms, effects and tables with
 * the browser's own cell looks. */
function freeDeck(): ComparisonDeck {
  const shapes = (
    ['rect', 'roundRect', 'ellipse', 'triangle', 'arrow', 'chevron', 'pentagon', 'hexagon', 'diamond'] as const
  ).flatMap((shape, i): FreeElement[] => [
    { t: 'box', x: 56 + (i % 5) * 172, y: 110 + Math.floor(i / 5) * 180, w: 140, h: 90, shape, fill: 'accent' },
    {
      t: 'text',
      x: 56 + (i % 5) * 172,
      y: 206 + Math.floor(i / 5) * 180,
      w: 140,
      h: 28,
      text: shape,
      size: 16,
      color: 'ink',
      align: 'c',
    },
  ]);
  const effects: FreeElement[] = [
    {
      t: 'box',
      x: 56,
      y: 120,
      w: 250,
      h: 150,
      shape: 'roundRect',
      r: 16,
      fill: 'surface',
      shadow: { x: 0, y: 6, blur: 18, color: '#000000', op: 0.25 },
    },
    {
      t: 'box',
      x: 350,
      y: 120,
      w: 250,
      h: 150,
      fill: 'accent',
      grad: {
        angle: 90,
        stops: [
          { color: 'accent', at: 0 },
          { color: 'accent2', at: 1 },
        ],
      },
    },
    { t: 'box', x: 644, y: 120, w: 250, h: 150, fill: 'none', line: 'accent', lw: 3, dash: true },
    { t: 'box', x: 120, y: 320, w: 120, h: 120, fill: 'accent2', op: 0.5, rot: 15 },
    { t: 'line', x1: 350, y1: 380, x2: 600, y2: 380, color: 'ink', lw: 2, arrow: 'end' },
    { t: 'line', x1: 650, y1: 330, x2: 880, y2: 450, color: 'accent', lw: 2, dash: true, arrow: 'both' },
    {
      t: 'path',
      x: 300,
      y: 300,
      w: 300,
      h: 80,
      d: 'M 300 380 C 380 300 520 300 600 380',
      line: 'accent',
      lw: 3,
      arrow: 'end',
    },
  ];
  const card = (
    g: number,
    x: number,
    heading: string,
    body: string,
    icon: 'people' | 'chart' | 'clock',
  ): FreeElement[] => [
    { g, t: 'box', x, y: 120, w: 260, h: 300, shape: 'roundRect', r: 12, fill: 'surface', line: 'rule', lw: 1 },
    { g, t: 'icon', icon, x: x + 24, y: 144, size: 48, color: 'accent' },
    { g, t: 'text', x: x + 24, y: 210, w: 212, h: 40, text: heading, size: 22, bold: true, color: 'ink', exact: true },
    {
      g,
      t: 'text',
      x: x + 24,
      y: 260,
      w: 212,
      h: 120,
      text: body,
      size: 16,
      color: 'ink',
      exact: true,
      runs: [{ s: 0, l: 2, color: 'accent', bold: true }],
    },
  ];
  const cards = [
    ...card(1, 56, '対象を絞る', '2部署で\n30人が試す', 'people'),
    ...card(2, 350, '数字で見る', '作業時間を\n毎週記録する', 'chart'),
    ...card(3, 644, '期限を決める', '3か月で\n判断する', 'clock'),
  ];
  const tables: FreeElement[] = [
    {
      t: 'table',
      x: 56,
      y: 110,
      w: 400,
      h: 160,
      headers: ['項目', '現状', '目標'],
      rows: [
        ['作業時間', '12時間', '8時間'],
        ['手戻り', '5件', '2件'],
      ],
      size: 16,
    },
    {
      t: 'table',
      x: 500,
      y: 110,
      w: 400,
      h: 150,
      headers: ['段階', '内容'],
      rows: [
        ['試行', '2部署'],
        ['展開', '全社'],
      ],
      cols: [120, 280],
      rowH: [50, 50, 50],
      head: true,
      cells: [
        [
          { size: 16, bold: true, color: 'onAccent', fill: 'accent', va: 'm', pad: [8, 4, 8, 4] },
          { size: 16, bold: true, color: 'onAccent', fill: 'accent', va: 'm', pad: [8, 4, 8, 4] },
        ],
        [
          { size: 16, color: 'ink', bd: [null, null, { w: 1, c: 'rule' }, null] },
          { size: 16, color: 'ink', align: 'r', bd: [null, null, { w: 1, c: 'rule' }, null] },
        ],
        [
          { size: 16, color: 'ink', fill: 'surface' },
          { size: 16, color: 'ink', fill: 'surface', align: 'r', runs: [{ s: 0, l: 2, bold: true }] },
        ],
      ],
    },
    {
      t: 'chart',
      x: 56,
      y: 300,
      w: 840,
      h: 190,
      chart: {
        type: 'column',
        categories: ['4月', '5月', '6月'],
        series: [{ name: '件数', values: [12, 18, 24] }],
        unit: '件',
      },
    },
  ];
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120" viewBox="0 0 200 120"><rect x="10" y="10" width="180" height="100" rx="12" fill="#087F8C"/><circle cx="60" cy="60" r="30" fill="#FFFFFF"/></svg>';
  const pictures: FreeElement[] = [
    { t: 'svg', x: 56, y: 120, w: 300, h: 180, svg },
    { t: 'image', x: 400, y: 120, w: 300, h: 200, q: 'office' },
    {
      t: 'text',
      x: 56,
      y: 330,
      w: 840,
      h: 120,
      text: '長い本文が枠の中で折り返されるかを見ます。日本語の行は単語の途中で切れないように、数値と単位（120件）も分けずに置きます。',
      size: 20,
      color: 'ink',
      lh: 1.5,
    },
  ];
  const slides = [
    free(
      'slide-1',
      '自由配置の比較',
      [
        {
          t: 'text',
          x: 64,
          y: 200,
          w: 800,
          h: 100,
          text: 'HTML・座標で作るページ',
          size: 40,
          bold: true,
          color: 'white',
        },
      ],
      'ink',
    ),
    free('slide-2', '図形の種類', shapes),
    free('slide-3', '影・グラデーション・破線・回転・矢印', effects),
    free('slide-4', 'カードとアイコン（グループ）', cards),
    free('slide-5', '表とグラフ', tables),
    free('slide-6', '画像・SVG・折り返し', pictures),
  ];
  slides[0].layoutId = 'cover';
  return {
    id: 'free',
    title: '自由配置（HTML・座標）',
    deck: { id: 'free', title: '自由配置の比較', mode: 'presentation', themeId: 'business', slides },
    labels: [
      '表紙（背景色）',
      '図形の種類',
      '影・グラデーション・破線・回転・矢印',
      'カードとアイコン',
      '表とグラフ',
      '画像・SVG・折り返し',
    ],
  };
}

/** quick: one deck of each kind, for a short run. */
export function comparisonDecks(quick = false): ComparisonDeck[] {
  const layouts = layoutDecks('business');
  return quick
    ? [layouts[0], chartDeck(), freeDeck()]
    : [...layouts, ...layoutDecks('midnight').slice(0, 1), chartDeck(), freeDeck()];
}
