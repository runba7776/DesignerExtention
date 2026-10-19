import type {Theme, TextElement} from './contracts';

/** Design guidance, not trained model weights. Fonts are supplied by Windows. */
export const typographyProfiles = {
  balanced: {name:'端正なゴシック',heading:'Yu Gothic',body:'Yu Gothic Medium',number:'Bahnschrift',description:'游ゴシックの整った字形。見出しを太く、本文は中太、数字は輪郭の明確な欧文。',whenToUse:'汎用の発表、企画、技術説明',avoidWhen:'細いウェイトを小さい本文に使わない'},
  clear: {name:'くっきり読みやすく',heading:'Meiryo',body:'Meiryo',number:'Arial',description:'メイリオの広い字面と太い線。画面で読ませる文章を優先する。',whenToUse:'読む資料、長めの説明、幅広い年齢の読み手',avoidWhen:'字幅が広いため狭い列に長文を詰めない'},
  modern: {name:'すっきりモダン',heading:'Yu Gothic UI',body:'Yu Gothic UI',number:'Segoe UI',description:'游ゴシック UI のコンパクトな仮名と、Segoe UI の素直な数字。',whenToUse:'製品紹介、技術、現代的な企画',avoidWhen:'狭い枠を理由に本文を小さくしない'},
  editorial: {name:'明朝の見出し',heading:'Yu Mincho',body:'Yu Gothic Medium',number:'Georgia',description:'游明朝の線の強弱で見出しを印象づける。本文はゴシックで読む負担を抑える。',whenToUse:'研究、歴史、読み物、落ち着いた提案',avoidWhen:'明朝を細かい表や密な本文に多用しない'},
  accessible: {name:'判別しやすい UD',heading:'BIZ UDPGothic',body:'BIZ UDPGothic',number:'Arial',description:'BIZ UDPゴシックの文字を見分けやすい字形。報告と数値を落ち着いて示す。',whenToUse:'比較、業務報告、教室や会議の投影',avoidWhen:'UD 書体でも小さい文字や低いコントラストを避ける'},
  book: {name:'本のような見出し',heading:'BIZ UDPMincho Medium',body:'BIZ UDPGothic',number:'Georgia',description:'BIZ UDP明朝の見出しと UD ゴシックの本文。文字の形を読み取りやすく保つ。',whenToUse:'講義、説明資料、文章中心のテーマ',avoidWhen:'装飾的な書体を同じページに追加しない'},
  classroom: {name:'親しみのある教科書体',heading:'UD Digi Kyokasho NP',body:'BIZ UDPGothic',number:'Arial',description:'UD デジタル教科書体の筆運びが見える字形を大きな見出しに使う。',whenToUse:'数学の紹介、授業、身近なテーマ',avoidWhen:'小さい表・数値の比較には本文のゴシックを使う'},
} as const;
export type TypographyId = keyof typeof typographyProfiles;
export const typographyCatalog = () => Object.entries(typographyProfiles).map(([id,p])=>({id,...p}));
export function withTypography(theme:Theme,id?:string):Theme {
  const profile=typographyProfiles[(id && Object.hasOwn(typographyProfiles,id)?id:theme.typographyId??'balanced') as TypographyId];
  return {...theme,font:profile.body,headingFont:profile.heading,numberFont:profile.number,equationFont:'Cambria Math',typographyId:id??theme.typographyId??'balanced'};
}
/** Fonts Windows (Japanese) and Office provide. */
const standardFonts=['Yu Gothic','Yu Gothic Medium','Yu Gothic Light','Yu Gothic UI','Yu Gothic UI Semibold','Yu Mincho','Yu Mincho Demibold','Yu Mincho Light','Meiryo','Meiryo UI','BIZ UDPGothic','BIZ UDGothic','BIZ UDPMincho','BIZ UDPMincho Medium','BIZ UDMincho','BIZ UDMincho Medium','UD Digi Kyokasho NP','UD Digi Kyokasho NK','UD Digi Kyokasho N','UD Digi Kyokasho NP-R','UD Digi Kyokasho NP-B','UD Digi Kyokasho NK-R','UD Digi Kyokasho NK-B','MS Gothic','MS PGothic','MS UI Gothic','MS Mincho','MS PMincho','Arial','Arial Black','Segoe UI','Segoe UI Semibold','Bahnschrift','Calibri','Cambria','Candara','Century','Century Gothic','Constantia','Corbel','Franklin Gothic Medium','Georgia','Tahoma','Times New Roman','Trebuchet MS','Verdana'];
const fontKey=(name:string)=>name.normalize('NFKC').toLowerCase().replace(/[\s_-]/g,'');
const byKey=new Map(standardFonts.map(name=>[fontKey(name),name]));
/** A font name the AI chose, kept free: Japanese names of standard fonts become the
 * names Windows uses (游ゴシック → Yu Gothic); any other name is kept as written. The
 * PowerPoint step uses it when this PC has it, otherwise the nearest installed font of
 * the same style (明朝 for a serif). */
export function resolveFont(name:string|undefined,fallback:string){
  if(!name||!name.trim())return fallback;
  const key=fontKey(name),exact=byKey.get(key);
  if(exact)return exact;
  const has=(...words:string[])=>words.some(w=>key.includes(fontKey(w)));
  if(has('UDデジタル教科書体'))return 'UD Digi Kyokasho NP';
  if(has('BIZUDP明朝'))return 'BIZ UDPMincho';
  if(has('BIZUD明朝'))return 'BIZ UDMincho';
  if(has('BIZUDPゴシック'))return 'BIZ UDPGothic';
  if(has('BIZUDゴシック'))return 'BIZ UDGothic';
  if(has('メイリオ'))return has('ui')?'Meiryo UI':'Meiryo';
  if(has('游明朝'))return 'Yu Mincho';
  if(has('游ゴシック'))return has('ui')?'Yu Gothic UI':has('medium','ミディアム')?'Yu Gothic Medium':has('light','ライト')?'Yu Gothic Light':'Yu Gothic';
  if(has('MSP明朝'))return 'MS PMincho';
  if(has('MS明朝'))return 'MS Mincho';
  if(has('MSPゴシック'))return 'MS PGothic';
  if(has('MSゴシック'))return 'MS Gothic';
  return name.trim().slice(0,60);
}
export function fontFor(theme:Theme,role:TextElement['role']) {
  if(role==='heading')return {font:theme.headingFont??theme.font,fontFarEast:theme.headingFont??theme.font};
  if(role==='number')return {font:theme.numberFont??theme.font,fontFarEast:theme.font};
  if(role==='equation')return {font:theme.equationFont??'Cambria Math',fontFarEast:theme.font};
  return {font:theme.font,fontFarEast:theme.font};
}
