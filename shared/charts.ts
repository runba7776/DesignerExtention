import type { ChartSpec, ChartType, Theme } from './contracts';
import { mixColor, contrast, luminance } from './color';

/** One catalogue drives prompting, validation, manual choices and native rendering. */
export const chartCatalog: Record<ChartType, { name: string; use: string; avoid: string }> = {
  bar: {
    name: '横棒グラフ',
    use: '項目間の量を比較。項目名が長い場合にも向く。',
    avoid: '異なる単位・期間を同じ軸で比較しない。',
  },
  column: {
    name: '縦棒グラフ',
    use: '少数の項目や期間の量を比較。棒の基準は0。',
    avoid: '長い項目名や多数の項目には横棒を使う。',
  },
  line: {
    name: '折れ線グラフ',
    use: '時間など、連続した順序に沿う変化を見る。',
    avoid: '無関係な企業・分類を線でつないで連続性を作らない。',
  },
  pie: {
    name: '円グラフ',
    use: '同じ全体を分けた、重複しない内訳の割合を示す。',
    avoid: '負の値、複数系列、欠けた内訳、別々の指標は使わない。',
  },
  doughnut: {
    name: 'ドーナツグラフ',
    use: '同じ全体の少数の内訳を、割合で見る。',
    avoid: '円グラフと同じ条件。細かな量の比較には棒を使う。',
  },
  stackedBar: {
    name: '積み上げ横棒',
    use: '対象ごとの合計と、合計に含まれる内訳を比較。',
    avoid: '足せない指標、重複した分類、負の値には使わない。',
  },
  stackedColumn: {
    name: '積み上げ縦棒',
    use: '期間・対象ごとの合計と内訳を比較。',
    avoid: '足せない指標や重複した分類を積み上げない。',
  },
  waterfall: {
    name: '滝グラフ（増減の橋渡し）',
    use: '前の値から要因ごとの増減を経て今の値に至る説明。categoriesの先頭が起点、末尾が終点、途中が要因。1系列で、起点＋途中の増減の合計＝終点。',
    avoid: '足し合わせて終点にならない数値、別々の指標の並列には使わない。',
  },
};
export const isShareChart = (type: ChartType) => type === 'pie' || type === 'doughnut';
export const isStackedChart = (type: ChartType) => type === 'stackedBar' || type === 'stackedColumn';
/** Start + changes must reach the end total (rounding of the source allowed). */
export function waterfallProblem(chart: ChartSpec): string | undefined {
  const values = chart.series[0]?.values ?? [];
  if (chart.series.length !== 1 || values.length < 3) return '滝グラフは起点・1つ以上の増減・終点の1系列が必要です。';
  const start = values[0],
    end = values[values.length - 1],
    reached = values.slice(1, -1).reduce((sum, v) => sum + v, start);
  if (Math.abs(reached - end) > Math.max(1, Math.abs(end) * 0.01))
    return `滝グラフの起点（${chartNumber(start)}）と増減の合計が終点（${chartNumber(end)}）になりません（計算上は${chartNumber(reached)}）。資料の数値で起点・増減・終点をそろえてください。`;
}
export function chartDataProblem(chart: ChartSpec): string | undefined {
  if (!Object.hasOwn(chartCatalog, chart.type)) return '未登録のグラフ形式です。';
  if (!chart.categories.length || chart.categories.length > 8 || !chart.series.length || chart.series.length > 3)
    return 'グラフは1〜8項目・1〜3系列です。';
  if (chart.series.some(s => s.values.length !== chart.categories.length || s.values.some(v => !Number.isFinite(v))))
    return 'グラフの項目と数値が一致しません。';
  if (
    isShareChart(chart.type) &&
    (chart.series.length !== 1 ||
      chart.series[0].values.some(v => v < 0) ||
      !(chart.series[0].values.reduce((a, b) => a + b, 0) > 0) ||
      !Number.isFinite(chart.series[0].values.reduce((a, b) => a + b, 0)))
  )
    return '円・ドーナツグラフは非負で合計が正の1系列が必要です。';
  if (chart.type === 'waterfall') return waterfallProblem(chart);
  if (
    isStackedChart(chart.type) &&
    (chart.series.length < 2 ||
      chart.series.some(s => s.values.some(v => v < 0)) ||
      chart.categories.some((_, i) => !Number.isFinite(chart.series.reduce((sum, s) => sum + s.values[i], 0))))
  )
    return '積み上げグラフは非負の2〜3系列が必要です。';
}
export function compatibleChartTypes(chart: ChartSpec): ChartType[] {
  return (Object.keys(chartCatalog) as ChartType[]).filter(type => !chartDataProblem({ ...chart, type }));
}
/** Distinct data colours, including categories beyond the former three-colour loop. */
export function chartColors(theme: Theme) {
  const seeds = [theme.accent, theme.secondary, '#8B5AC4', '#C86219', '#278874', '#C64168', '#667A25', '#557DBC'];
  return seeds.map(c => {
    const toward = luminance(theme.background) < 0.4 ? '#FFFFFF' : '#172D4A';
    let result = c;
    for (let w = 0.08; contrast(result, theme.background) < 3 && w <= 1; w += 0.08) result = mixColor(toward, c, w);
    return result;
  });
}
export function chartGridColor(theme: Theme) {
  return mixColor(theme.foreground, theme.background, 0.14);
}
export function chartNumber(value: number) {
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 15, maximumSignificantDigits: 15 }).format(value);
}
