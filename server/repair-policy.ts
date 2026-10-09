import {AppError} from './errors.js';
/** Trusted corrections only. Model error strings and unfinished output never
 * become repair instructions. Transport/auth/context failures are not retried.
 */
const guidance:Record<string,{reason:string;instruction:string}>={
  OUTPUT_LIMIT:{reason:'返答が出力上限で途中終了',instruction:'回答を簡潔なJSONにし、未使用の任意項目と本文・ノートの重複を省きます。必須条件・数字・単位・否定は保持します。'},
  INVALID_MODEL_JSON:{reason:'返答の形式に不備',instruction:'Markdownや説明を付けず、型定義に一致する最後まで閉じたJSONだけを返します。'},
  INVALID_CONTENT:{reason:'図形・ページ・図表の仕様に不備',instruction:'指定のページID・順序・枚数・モード・表紙の役割を保ち、対応する図形文法とその項目数、図表のデータ仕様を確認します。'},
  SLIDE_COUNT_MISMATCH:{reason:'指定の枚数と構成が不一致',instruction:'表紙を含めた指定枚数を厳守します。'},
  INVALID_SOURCE:{reason:'資料にない出典位置',instruction:'documentsに実在するdocumentIdとlocatorだけを使います。根拠を捏造せず、確認できない主張は断定しません。'},
  INVALID_QUOTE:{reason:'引用が原資料と不一致',instruction:'quoteは資料の正確な短い原文を使うか省略します。実在するdocumentIdとlocatorを保ち、事実を変更しません。'},
  INVALID_SUMMARY:{reason:'要約の形式・数値・変更対象に不備',instruction:'指定されたfieldsのpathだけを短くします。元の数字・単位・否定・比較条件を保ち、値の創作や省略記号を使いません。'},
  TEXT_FIT_REQUIRED:{reason:'文章が表示枠に収まらない',instruction:'issuesのmaxCharactersを厳守して文章を要約します。数値・単位・否定・成立条件を保ち、文や数値を途中で切りません。'},
};
export function repairReason(error:unknown){return error instanceof AppError&&Object.hasOwn(guidance,error.code)?guidance[error.code]:undefined;}
export function repairInstruction(code:string){return Object.hasOwn(guidance,code)?guidance[code].instruction:undefined;}
