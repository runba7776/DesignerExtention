import type { ChartType,DeckSpec, Outline, SlideSpec, SourceRef, Theme } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { listLayouts } from '../shared/layouts.js';
import { MAX_SLIDES } from '../shared/contracts.js';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes.js';
import {typographyProfiles} from '../shared/typography.js';
import {iconCatalog} from '../shared/icons.js';
import {chartCatalog,chartDataProblem} from '../shared/charts.js';

// Kept separate from orchestration so additional layout grammars can be registered centrally.
export const SUPPORTED_LAYOUTS = listLayouts().map((entry) => entry.id);

function bad(message: string): never { throw new AppError(422, `生成内容を確認できません: ${message}`, 'INVALID_CONTENT'); }
function object(value: unknown, field: string): Record<string, any> { if (!value || typeof value !== 'object' || Array.isArray(value)) bad(`${field}の形式`); return value as Record<string, any>; }
function text(value: unknown, field: string, max: number, optional = false): string | undefined { if ((value === undefined || value === null) && optional) return undefined; if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max) bad(`${field}は${max}文字以内`); return value; }
function array(value: unknown, field: string, max: number): any[] { if (!Array.isArray(value) || value.length > max) bad(`${field}は${max}項目以内`); return value; }
function stringList(value: unknown, field: string, max: number, length = 200): string[] { return array(value, field, max).map((v) => text(v, field, length)!); }
function layout(value: unknown): string { if (typeof value !== 'string' || !SUPPORTED_LAYOUTS.includes(value)) bad('未登録の図形文法'); return value; }
function mode(value: unknown): 'presentation' | 'reading' { if (value !== 'presentation' && value !== 'reading') bad('表示モード'); return value; }

export function validateOutline(value: unknown): Outline {
  const data = object(value, '構成案');
  const slides = array(data.slides, 'スライド', MAX_SLIDES).map((entry, index) => {
    const slide = object(entry, 'スライド');
    return { id: `slide-${index + 1}`, title: text(slide.title, '見出し', 70)!, intent: text(slide.intent, '役割', 240)!, layoutId: layout(slide.layoutId), keyPoints: stringList(slide.keyPoints ?? [], '要点', 5, 180), ...(slide.sourceIds ? { sourceIds: stringList(slide.sourceIds, '参照資料', 12, 100) } : {}) };
  });
  if (slides.length < 2) bad(`表紙を含め2〜${MAX_SLIDES}枚にしてください`);
  if (slides[0].layoutId !== 'cover') bad('1枚目は表紙です');
  if (slides.slice(1).some((slide) => slide.layoutId === 'cover')) bad('表紙は1枚目だけです');
  return { title: text(data.title, '資料名', 100)!, mode: mode(data.mode), ...(data.themeId?{themeId:validateTheme(data.themeId)}:{}), ...(data.typographyId?{typographyId:validateTypography(data.typographyId)}:{}), ...(data.inputBrief?{inputBrief:text(data.inputBrief,'確認用の条件',6000)!}:{}), audience: text(data.audience, '対象者', 150, true), assumptions: stringList(data.assumptions ?? [], '前提', 8, 250), slides };
}

export function validateTheme(value:unknown):string {if(typeof value!=='string'||!Object.hasOwn(themes,value))bad('未登録のテーマ');return value;}
export function validateTypography(value:unknown):string {if(typeof value!=='string'||!Object.hasOwn(typographyProfiles,value))bad('未登録の書体');return value;}

export function validateSlide(value: unknown, expectedId?: string): SlideSpec {
  const data = object(value, 'スライド');
  const layoutId = layout(data.layoutId);
  const maximum = listLayouts().find((entry) => entry.id === layoutId)!.maxItems;
  const items = array(data.items ?? [], '図形の項目', maximum).map((entry, index) => {
    const item = object(entry, '項目');
    if (item.parent !== undefined && (!Number.isInteger(item.parent) || item.parent < 0 || item.parent >= index)) bad('階層の親は先行する項目を指定してください');
    if(item.icon!==undefined && (typeof item.icon!=='string'||(item.icon!=='none'&&!Object.hasOwn(iconCatalog,item.icon))))bad('未登録のアイコン');
    if(item.refs!==undefined&&(!Array.isArray(item.refs)||item.refs.length>5||item.refs.some((n:unknown)=>!Number.isInteger(n)||(n as number)<1||(n as number)>10)))bad('項目の出典番号は1から始まる番号で5件以内');
    return { label: text(item.label, '項目名', 65)!, description: text(item.description, '項目の説明', 170, true), value: text(item.value, '強調値', 40, true), ...(item.parent !== undefined ? { parent: item.parent } : {}),...(item.icon!==undefined?{icon:item.icon}:{}),...(Array.isArray(item.refs)&&item.refs.length?{refs:[...new Set(item.refs as number[])]}:{}) };
  });
  const slide: SlideSpec = {
    id: expectedId ?? text(data.id, '識別子', 100)!, title: text(data.title, '見出し', 70)!, layoutId: layout(data.layoutId),
    headline: text(data.headline, '要旨', 150, true), body: text(data.body, '本文', 800, true), items,
    notes: text(data.notes ?? '', '発表者ノート', 4000, true) ?? '',
    sources: array(data.sources ?? [], '出典', 10).map((entry): SourceRef => {
      const source = object(entry, '出典');
      return { documentId: text(source.documentId, '資料ID', 100)!, locator: text(source.locator, '出典位置', 160)!, quote: text(source.quote, '引用', 500, true) };
    }),
  };
  if (data.chart !== undefined) {
    const chart = object(data.chart, 'グラフ');
    if (typeof chart.type!=='string'||!Object.hasOwn(chartCatalog,chart.type)) bad('グラフ形式');
    const categories = stringList(chart.categories, 'グラフ項目', 8, 40);
    const series = array(chart.series, 'グラフ系列', 3).map((entry) => {
      const series = object(entry, '系列');
      const values = array(series.values, '数値', 8);
      if (values.length !== categories.length || values.some((v) => typeof v !== 'number' || !Number.isFinite(v))) bad('グラフの項目と数値の対応');
      return { name: text(series.name, '系列名', 45)!, values };
    });
    if (!categories.length || !series.length) bad('グラフのデータがありません');
    slide.chart = { type: chart.type as ChartType, categories, series, unit: text(chart.unit, '単位', 40, true), caption: text(chart.caption, 'グラフ注釈', 240, true) };
    const chartProblem=chartDataProblem(slide.chart);if(chartProblem)bad(chartProblem);
  }
  if (data.diagram !== undefined) {
    const diagram = object(data.diagram, '図解');
    if (!['process', 'cycle', 'hierarchy', 'list'].includes(diagram.type)) bad('SmartArtの種類');
    const checked = validateSlide({ id: 'diagram-items', title: 'items', layoutId: 'hierarchy', items: diagram.items, sources: [], notes: '' });
    if (!checked.items.length) bad('図解の項目がありません');
    if (checked.items.length > maximum) bad(`この文法の図解は${maximum}項目以内です`);
    slide.diagram = { type: diagram.type, items: checked.items };
  }
  if (data.table !== undefined) {
    const table = object(data.table, '表');
    const headers = stringList(table.headers, '表の列', 4, 45);
    const rows = array(table.rows, '表の行', 5).map((row) => stringList(row, '表のセル', 4, 100));
    if (!headers.length || !rows.length || rows.some((row) => row.length !== headers.length)) bad('表の列数が一致しません');
    slide.table = { headers, rows };
  }
  if (data.equation !== undefined) {
    const equation = object(data.equation, '数式');
    slide.equation = { text: text(equation.text, '数式', 160)!, explanation: text(equation.explanation, '数式の説明', 400, true) };
  }
  // Citation markers must point at a source of this slide.
  if([...slide.items,...(slide.diagram?.items??[])].some(item=>item.refs?.some(n=>n>slide.sources.length)))bad('項目の出典番号がスライドの出典の数を超えています');
  const grammar=listLayouts().find(item=>item.id===slide.layoutId)!;
  if(slide.items.length<grammar.minItems)bad(`この構図には${grammar.minItems}項目以上必要です`);
  if(grammar.group==='cause'&&!slide.headline&&!slide.body)bad('原因図には結果・問題の要旨が必要です');
  if (slide.chart && !grammar.chart) bad('グラフに対応した文法を使用してください');
  if (slide.table && !grammar.table) bad('表に対応した文法を使用してください');
  if (slide.chart && slide.table) bad('1枚にグラフと表を同時に指定しないでください');
  if (slide.equation && !grammar.equation) bad('数式に対応した文法を使用してください');
  if (slide.diagram && !grammar.diagram) bad('SmartArtに対応した文法を使用してください');
  if(slide.diagram && slide.diagram.type!==grammar.diagramType)bad('図形文法とSmartArtの種類が一致しません');
  if(slide.table && grammar.tableMaxRows && slide.table.rows.length>grammar.tableMaxRows)bad(`この表の構図は${grammar.tableMaxRows}行以内です`);
  if (['process', 'hierarchy', 'cycle', 'timeline'].includes(slide.layoutId) && !(slide.diagram?.items.length || slide.items.length)) bad('図解には項目が必要です');
  return slide;
}

export function validateDeck(value: unknown, expectedOutline?: Outline): DeckSpec {
  const data = object(value, '資料');
  const slides = array(data.slides, 'スライド', MAX_SLIDES).map((slide, index) => validateSlide(slide, `slide-${index + 1}`));
  if (slides.length < 2 || slides[0].layoutId !== 'cover' || slides.slice(1).some((s) => s.layoutId === 'cover')) bad(`表紙1枚を含む2〜${MAX_SLIDES}枚が必要です`);
  if (expectedOutline && slides.length !== expectedOutline.slides.length) bad('承認した構成案と枚数が異なります');
  const template=data.themeId===TEMPLATE_THEME_ID;
  return { id: typeof data.id === 'string' ? data.id.slice(0, 100) : 'deck', title: text(data.title, '資料名', 100)!, mode: mode(data.mode), themeId: template?TEMPLATE_THEME_ID:validateTheme(data.themeId??'paper'), ...(data.typographyId?{typographyId:validateTypography(data.typographyId)}:{}), ...(template?{customTheme:validateCustomTheme(data.customTheme)}:{}), ...(data.referencesSlide===true?{referencesSlide:true}:{}), slides };
}

const color=(value:unknown,field:string)=>{if(typeof value!=='string'||!/^#[0-9A-F]{6}$/i.test(value))bad(`${field}の色`);return value.toUpperCase();};
const fontName=(value:unknown,field:string,optional=false)=>{if(value===undefined&&optional)return undefined;if(typeof value!=='string'||!value.trim()||value.length>64||[...value].some(ch=>ch.charCodeAt(0)<32||'<>"'.includes(ch)))bad(`${field}の書体名`);return value.trim();};
/** A company template theme copied into a deck. Only colors, font names and the
 * fixed style choices are accepted; no markup or free-form drawing. */
export function validateCustomTheme(value:unknown):Theme{
  const data=object(value,'会社テンプレート');
  const pick=<T extends string>(field:unknown,allowed:readonly T[],fallback:T):T=>allowed.includes(field as T)?field as T:fallback;
  const itemColors=array(data.itemColors??[],'項目の色',6).map((c,i)=>color(c,`項目${i+1}`));
  return {name:text(data.name??'会社テンプレート','テンプレート名',100)!,description:text(data.description??'','テンプレートの説明',200,true)??'',background:color(data.background,'背景'),foreground:color(data.foreground,'文字'),muted:color(data.muted,'補足文字'),accent:color(data.accent,'強調'),secondary:color(data.secondary,'第2強調'),pale:color(data.pale,'淡色'),
    font:fontName(data.font,'本文')!,headingFont:fontName(data.headingFont,'見出し',true),numberFont:fontName(data.numberFont,'数字',true),equationFont:fontName(data.equationFont,'数式',true),itemColors:itemColors.length?itemColors:undefined,
    panelStyle:pick(data.panelStyle,['tint','outline','header'] as const,'tint'),coverStyle:pick(data.coverStyle,['editorial','split','band','block'] as const,'band'),headingStyle:pick(data.headingStyle,['rule','accent','band'] as const,'rule'),tableStyle:pick(data.tableStyle,['minimal','striped','contrast'] as const,'striped')};
}

export function validatePlanResponse(value: unknown): { question?: string; outline?: Outline } {
  const data = object(value, '構成の応答');
  if (data.kind === 'questions') return { question: text(data.message, '確認事項', 2500)! };
  if (data.kind === 'outline') return { outline: validateOutline(data.outline) };
  bad('kindはquestionsまたはoutlineです');
}
