import type {Theme} from './contracts';
export function mixColor(foreground:string,background:string,weight:number):string {
  const channel=(color:string,i:number)=>parseInt(color.slice(1+i*2,3+i*2),16);
  return '#'+[0,1,2].map(i=>Math.round(channel(foreground,i)*weight+channel(background,i)*(1-weight)).toString(16).padStart(2,'0')).join('').toUpperCase();
}
export function luminance(color:string){const rgb=[0,1,2].map(i=>parseInt(color.slice(1+i*2,3+i*2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;}
export function contrast(a:string,b:string){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
export function readableColor(color:string,background:string){if(contrast(color,background)>=4.5)return color;return contrast('#18232F',background)>contrast('#FFFFFF',background)?'#18232F':'#FFFFFF';}
export function itemColor(theme:Theme,index:number){const colors=theme.itemColors??[theme.accent,theme.secondary],base=readableColor(colors[index%colors.length],theme.background);return readableColor(base,mixColor(base,theme.background,luminance(theme.background)<.15?.14:.075));}
export function panelFill(theme:Theme,index:number){return mixColor(itemColor(theme,index),theme.background,luminance(theme.background)<.15?.14:.075);}
