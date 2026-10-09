import type {DeckSpec,SlideSpec} from './contracts';
import {listLayouts} from './layouts';

/** Neutral sample content for catalog previews, automated geometry checks and native QA. */
export function sampleSlide(layoutId:string,count?:number):SlideSpec{
  const l=listLayouts().find(l=>l.id===layoutId)!;
  const n=count??Math.min(l.maxItems,l.group==='hierarchy'?5:4);
  const slide:SlideSpec={id:layoutId,layoutId,title:l.name,headline:'要点と根拠を伝える',body:'同じ条件で情報を確かめます。',items:Array.from({length:n},(_,i)=>({label:l.group==='timeline'?`${2023+i}年`:`項目${i+1}`,description:'条件と根拠を示す。',...(l.group==='metrics'?{value:`${24+i*12}点`}:{})})),sources:[],notes:`配置: ${l.placement}\n用途: ${l.whenToUse}\n注意: ${l.avoidWhen}\n文字量: ${l.textBudget}\n動作確認用の架空データ。`};
  if(layoutId==='cover'){slide.items=[];slide.headline='構図の見本 / AI未使用';}
  if(['design_icon_circles','design_icon_tiles','design_icon_rows','design_comparison','chart_icon_notes'].includes(layoutId))slide.items=slide.items.map((item,i)=>({...item,icon:(['document','chart','people','globe'] as const)[i%4]}));
  if(l.table){slide.table={headers:['対象','値','条件'],rows:[['例 A','24点','同じ条件'],['例 B','36点','同じ条件'],['例 C','48点','同じ条件']]};}
  if(l.chart&&!l.table){slide.chart={type:'column',categories:['例 A','例 B','例 C'],series:[{name:'参考値',values:[24,36,48]}],unit:'点',caption:'架空の動作確認用データ'};}
  if(l.equation){slide.equation={text:'1 + 3 + 5 = 9',explanation:'最初の3個の奇数の和。'};}
  if(l.diagram){slide.diagram={type:l.diagramType!,items:slide.items.map((item,i)=>({label:item.label,...(l.diagramType==='hierarchy'&&i?{parent:Math.floor((i-1)/2)}:{})}))};}
  if(l.group==='hub')slide.headline='中心の問い';
  if(layoutId==='pyramid')slide.items=slide.items.map(({label})=>({label}));
  return slide;
}
export function sampleDeck(slides:SlideSpec[],themeId='business'):DeckSpec{return {id:'layout-catalog',title:'構図カタログ',mode:'presentation',themeId,slides};}
