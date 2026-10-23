/** Semantic groups are deliberately separate: variety must not invent a relationship. */
export type LayoutGroup =
  | 'free'
  | 'cover'
  | 'points'
  | 'comparison'
  | 'change'
  | 'sequence'
  | 'timeline'
  | 'table'
  | 'chart'
  | 'metrics'
  | 'hub'
  | 'pyramid'
  | 'funnel'
  | 'concept'
  | 'cycle'
  | 'hierarchy'
  | 'cause';
export const researchSources = {
  cone: {
    title: 'Cone / c-slide — 39のデザインパターン集',
    url: 'https://cone-c-slide.com/see-sla/blog/design-pattern/',
  },
  microsoft: {
    title: 'Microsoft PowerPoint — 公開テンプレート（カラー ブロック・プリズム・ノートほか）',
    url: 'https://powerpoint.cloud.microsoft/search/templates/',
  },
  timeline: {
    title: 'PresentationGO — Infographic Timeline',
    url: 'https://www.presentationgo.com/presentation/infographic-timeline-powerpoint-google-slides/',
  },
  vertical: {
    title: 'PresentationGO — Vertical Zigzag Timeline',
    url: 'https://www.presentationgo.com/presentation/vertical-zigzag-timeline-diagram/',
  },
  planning: {
    title: 'PresentationGO — Timelines & Planning',
    url: 'https://www.presentationgo.com/presentation/category/timelines-planning/',
  },
  comparison: {
    title: 'PresentationGO — Pricing Tables',
    url: 'https://www.presentationgo.com/presentation/category/text-tables/pricing-tables/',
  },
  options: { title: 'SlideModel — Options', url: 'https://slidemodel.com/templates/tag/options/' },
  matrix: {
    title: 'SlideModel — SWOT Matrix',
    url: 'https://slidemodel.com/templates/swot-matrix-powerpoint-template/',
  },
  swimlane: { title: 'SlideModel — Swimlane', url: 'https://slidemodel.com/templates/tag/swimlane/' },
  editorial: { title: 'Moda — Slide Templates', url: 'https://moda.app/templates/slides' },
  simplicity: {
    title: 'Envato / Alex-OnePoint — Simplicity 2025',
    url: 'https://graphicriver.net/item/simplicity-premium-and-easy-to-edit-template/12165048',
  },
  massive: {
    title: 'Envato / Designball — Massive X',
    url: 'https://graphicriver.net/item/massive-x-presentation-template/21482501',
  },
  fishbone: {
    title: 'SlideModel — Fishbone Diagram',
    url: 'https://slidemodel.com/templates/fishbone-diagram-presentation-template/',
  },
  valuechain: {
    title: 'SlideModel — Value Chain Analysis',
    url: 'https://slidemodel.com/templates/value-chain-analysis-powerpoint-template/',
  },
};
export type ResearchSource = keyof typeof researchSources;
export const groupNames: Record<LayoutGroup, string> = {
  free: 'AIによる自由デザイン',
  cover: '表紙',
  points: '要点・まとめ',
  comparison: '比較',
  change: '変化の前後',
  sequence: '工程・順序',
  timeline: '時系列',
  table: '表',
  chart: 'グラフ',
  metrics: '数値の強調',
  hub: '中心と関連',
  pyramid: '段階的な階層',
  funnel: '絞り込み',
  concept: '概念・数式',
  cycle: '循環',
  hierarchy: '親子関係',
  cause: '原因と結果',
};
export const groupCautions: Record<LayoutGroup, string> = {
  free: '数値の大きさを図形の大きさで表す場合は実際の値に比例させる',
  cover: '本文のページには使用しない',
  points: '順序・因果・優劣を配置だけで付けない',
  comparison: '比較条件が違う対象は条件を明記する',
  change: '無関係な2対象の比較には使わない',
  sequence: '順序のない項目には使わない',
  timeline: '実際の時点をラベルに記載。距離は期間の長さを表さない',
  table: '値・単位・列と行の対応を変えない',
  chart: '軸・系列・数値・比較条件を変えない',
  metrics: '数値を創作しない。図の面積は数量を表さない',
  hub: '周辺要素の因果や順位を示すものではない',
  pyramid: '上位と下位が説明できない分類には使わない。幅は数量ではない',
  funnel: '絞り込みがない情報に使わない。幅は数量ではない',
  concept: '数式と成立条件を保持する',
  cycle: '最終段階から最初へ戻る関係が必要',
  hierarchy: '親子関係を変えない。全項目を同じ階層に平坦化しない',
  cause: '原因・要因と結果の関係が明示されている場合のみ。仮説は仮説と記載し、相関を因果に変えない',
};
/** Legacy grammars also expose an explicit placement contract. */
export const legacyGuidance: Record<string, { group: LayoutGroup; placement: string }> = {
  cover: { group: 'cover', placement: '題名を中央または左上の広い領域に、導入を下に置く' },
  evidence: { group: 'points', placement: '左の主張・図表に約2/3、右の根拠に約1/3を使う' },
  comparison: { group: 'comparison', placement: '対象を等幅の縦列に並べ、同じ高さで比較する' },
  process: { group: 'sequence', placement: '横向きのSmartArt工程図と、下部の補足' },
  hierarchy: { group: 'hierarchy', placement: '親から子へ広がるSmartArt階層図を中央に置く' },
  cycle: { group: 'cycle', placement: '左に循環SmartArt、右に短い説明' },
  timeline: { group: 'timeline', placement: '横軸の上に時点、下に出来事を置く' },
  concept: { group: 'concept', placement: '左に大きな概念・数式、右に具体例や説明' },
  summary: { group: 'points', placement: '項目名と説明を縦に並べ、細い線で区切る' },
  table_full: { group: 'table', placement: '本文領域の横幅いっぱいを表に使う' },
  table_insight: { group: 'table', placement: '上に結論、下に横幅いっぱいの表' },
  table_bands: { group: 'table', placement: '1対象を1本の横帯とし、帯の中で列をそろえる' },
  pillars: { group: 'points', placement: '上に項目番号、中央に項目名、下に説明を横並びにする' },
  matrix: { group: 'points', placement: '本文領域を2×2に分けて観点を配置する' },
  pyramid: { group: 'pyramid', placement: '上位を狭い上段、具体的な下位を広い下段に置く' },
  funnel: { group: 'funnel', placement: '左の帯を段階ごとに狭め、右に条件を添える' },
  hub: { group: 'hub', placement: '中央に概念、四隅に関連する要素' },
  steps_vertical: { group: 'sequence', placement: '左の縦軸に番号、右に手順と説明' },
  kpi: { group: 'metrics', placement: '指標名・大きな値・条件を縦組みで横に並べる' },
  before_after: { group: 'change', placement: '変更前と変更後を左右に置き、中央に矢印' },
  conclusion: { group: 'points', placement: '左に大きな結論、右に根拠や次の行動を縦に配置' },
  grouped_list: { group: 'points', placement: 'SmartArtの縦方向ボックスに項目を並べる' },
};
