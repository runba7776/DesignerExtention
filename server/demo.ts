import { randomUUID } from 'node:crypto';
import type { DeckSpec, Outline, OutputMode, SlideSpec } from '../shared/contracts.js';
import type { ParsedDocument } from './document-model.js';

export const DEMO_WARNING = 'デモモード: AI・外部通信を使用しない画面確認用のサンプルです。入力資料の分析結果ではありません。';

export function demoOutline(prompt: string, mode: OutputMode, documents: ParsedDocument[], count:number|'auto'='auto'): Outline {
  const title = prompt.replace(/[\r\n]+/g, ' ').slice(0, 40) || 'プレゼンテーションの試作';
  const outline:Outline = {
    title, mode, audience: '構成確認で指定した読み手',
    assumptions: ['デモでは入力から分析・推論を行いません。内容は操作と図形配置の確認用です。', `${documents.length}件の資料をローカルで読み取りました。`],
    slides: [
      { id: 'slide-1', title, intent: '表紙', layoutId: 'cover', keyPoints: ['操作確認用デモ'] },
      { id: 'slide-2', title: '数値の違いを図で伝える', intent: '編集可能なグラフを確認する', layoutId: 'evidence', keyPoints: ['比較の単位', '差が見える配置'] },
      { id: 'slide-3', title: '情報の関係を見える形にする', intent: '構造の図解', layoutId: 'hierarchy', keyPoints: ['中心の問い', '根拠', '説明'] },
      { id: 'slide-4', title: '説明を組み立てる順序', intent: '手順の図解', layoutId: 'process', keyPoints: ['問い', '具体例', '読み取り', 'まとめ'] },
      { id: 'slide-5', title: '具体例から規則を見つける', intent: '数式と説明の配置を確認する', layoutId: 'concept', keyPoints: ['小さな例で試す', '成り立つ条件を残す'] },
      { id: 'slide-6', title: '確認したいポイント', intent: '確認と改善', layoutId: 'summary', keyPoints: ['構成', '見やすさ', '正確さ'] },
    ],
  };
  const extra=[
    {title:'観点を4つに分ける',layoutId:'matrix',points:['対象','条件','違い','根拠']},
    {title:'要点を並べてまとめる',layoutId:'pillars',points:['目的','説明','確認']},
    {title:'数値と単位を大きく見せる',layoutId:'kpi',points:['例 A','例 B','例 C']},
    {title:'対象ごとの比較',layoutId:'table_bands',points:['比較条件','読み取り']},
    {title:'具体例から全体を捉える',layoutId:'pyramid',points:['考え方','分類','具体例']},
    {title:'中心の問いを広げる',layoutId:'hub',points:['観察','具体例','説明','検証']},
    {title:'説明を順に進める',layoutId:'steps_vertical',points:['問い','例','確認','まとめ']},
    {title:'条件から候補を絞る',layoutId:'funnel',points:['候補','条件','検証','選択']},
    {title:'変更前と変更後',layoutId:'before_after',points:['変更前','変更後']},
    {title:'根拠を表で確かめる',layoutId:'table_full',points:['条件']},
    {title:'結論を根拠と並べる',layoutId:'table_insight',points:['読み取り']},
    {title:'項目を図で整理する',layoutId:'grouped_list',points:['目的','対象','根拠','条件']},
    {title:'結論と次の行動',layoutId:'conclusion',points:['確かめる','伝える','見直す']},
  ];
  if(typeof count==='number') {
    const first=outline.slides[0], last=outline.slides.at(-1)!;
    const middle=outline.slides.slice(1,-1);
    for(let i=middle.length;i<count-2;i++){const entry=extra[(i-4)%extra.length];middle.push({id:'',title:entry.title,layoutId:entry.layoutId,intent:'図形文法の動作確認',keyPoints:entry.points});}
    outline.slides=[first,...middle.slice(0,count-2),last].map((slide,i)=>({...slide,id:`slide-${i+1}`}));
  }
  return outline;
}

export function demoDeck(outline: Outline): DeckSpec {
  const slides: SlideSpec[] = outline.slides.map((slide, index) => ({
    id: slide.id, title: slide.title, layoutId: slide.layoutId, headline: index === 0 ? '操作確認用サンプル / AI未使用' : undefined,
    body: outline.mode === 'reading' ? '情報の関係と説明の順序を確認するためのサンプルです。読み手が知りたいことから逆算して、根拠と具体例を配置します。' : '問いに対して、根拠と具体例を順番に示します。',
    items: index === 0 ? [] : slide.keyPoints.map((label) => ({ label, description: `${label}を具体的に示します。` })),
    notes: DEMO_WARNING, sources: [],
  }));
  for (const slide of slides) {
    if (slide.layoutId === 'evidence') {
      slide.chart = { type: 'column', categories: ['例 A', '例 B', '例 C'], series: [{ name: 'サンプル値', values: [24, 42, 58] }], unit: '点', caption: '架空の動作確認用データ。資料の分析結果ではありません。' };
      slide.items = [{ label: '違いを読む', description: '同じ単位で比較します。' }, { label: '条件を添える', description: '期間と出典を示します。' }];
      slide.body = '架空の動作確認用データ';
    }
    if (slide.layoutId === 'concept') {
      slide.equation = { text: '1 + 3 + 5 + … + (2n − 1) = n²', explanation: '最初のn個の奇数の和はn²です。nは正の整数。' };
      slide.items = [{ label: 'n = 3 の例', description: '1 + 3 + 5 = 9 = 3²' }, { label: '説明と証明を区別', description: '一例の確認だけでは、すべてのnで成り立つ証明にはなりません。' }];
      slide.notes += '\nこの等式は最初のn個の奇数の和の公式。n=1で成立し、n²+(2n+1)=(n+1)²で帰納的に確認できます。';
    }
    if (slide.layoutId === 'hierarchy') slide.diagram = { type: 'hierarchy', items: [{ label: '中心となる問い' }, { label: '観察した事実', parent: 0 }, { label: '説明する内容', parent: 0 }, { label: '資料の根拠', parent: 1 }, { label: '具体的な例', parent: 2 }] };
    if (slide.layoutId === 'process') {
      slide.body='読み手の問いに合わせて、根拠と具体例を順番に示します。';
      slide.items = [{label:'問い',description:'何を伝えるか'}, {label:'具体例',description:'身近な例で示す'}, {label:'読み取り',description:'規則を見つける'}, {label:'まとめ',description:'問いへの答え'}];
      slide.diagram = { type: 'process', items: slide.items };
    }
    if (slide.layoutId === 'cycle') slide.diagram = { type: 'cycle', items: slide.items };
    if (slide.layoutId === 'kpi') slide.items=slide.items.map((item,i)=>({...item,value:`${[24,42,58][i]}点`,description:'架空のサンプル値'}));
    if (slide.layoutId.startsWith('table_')) {slide.table={headers:['対象','値','条件'],rows:[['例 A','24点','同じ条件'],['例 B','42点','同じ条件'],['例 C','58点','同じ条件']]};slide.headline='条件をそろえて比較する';}
    if (slide.layoutId === 'pyramid') slide.items=slide.items.map(({label})=>({label}));
    if (slide.layoutId === 'hub') {slide.headline='中心の問い';slide.items=slide.items.map(item=>({...item,description:'問いとの関係を示す'}));}
    if (slide.layoutId === 'funnel') slide.items=slide.items.map(item=>({...item,description:'条件を確認します'}));
    if (slide.layoutId === 'grouped_list') {slide.items=slide.items.map(({label})=>({label}));slide.diagram={type:'list',items:slide.items};}
    if (slide.layoutId === 'conclusion') slide.headline='根拠を確かめて伝える';
  }
  return { id: randomUUID(), title: outline.title, mode: outline.mode, themeId: outline.themeId??'paper', slides };
}
