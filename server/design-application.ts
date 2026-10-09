import type {DeckSpec,DesignEntry,Theme} from '../shared/contracts.js';
import {TEMPLATE_THEME_ID} from '../shared/themes.js';
import {fittingLayouts,improveTextFit} from '../shared/layout-selection.js';
import {assertTextFits} from './text-fit.js';

/** Change style only; never copy a favorite's text/data or force a new relationship. */
export function applySavedDesign(deck:DeckSpec,design:DesignEntry,requireFit=true,template?:Theme){
  // A favorite made with the company template needs the project's template;
  // without one, the current colors are kept and only layouts are reused.
  const usesTemplate=design.themeId===TEMPLATE_THEME_ID;
  let styled:DeckSpec=usesTemplate?template?{...structuredClone(deck),themeId:TEMPLATE_THEME_ID,customTheme:structuredClone(template)}:structuredClone(deck):{...structuredClone(deck),themeId:design.themeId};
  if(!usesTemplate)delete styled.customTheme;
  if(design.typographyId)styled.typographyId=design.typographyId;else delete styled.typographyId;
  let changed=0,skipped=0;
  const hasCover=design.layoutIds[0]==='cover',body=design.layoutIds.filter(id=>id!=='cover');
  styled.slides=styled.slides.map((slide,index)=>{
    if(slide.layoutId==='cover')return slide;
    const wanted=body.length===1?body[0]:design.layoutIds[hasCover?index:index-1];
    if(!wanted||wanted==='cover')return slide;
    if(wanted===slide.layoutId)return slide;
    if(!fittingLayouts(styled,slide).some(candidate=>candidate.id===wanted)){skipped++;return slide;}
    changed++;return {...slide,layoutId:wanted};
  });
  styled=improveTextFit(styled);if(requireFit)assertTextFits(styled);
  return {deck:styled,changed,skipped};
}
