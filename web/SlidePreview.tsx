import React from 'react';
import type { RenderDocument, SceneElement, SmartArtElement, TextElement } from '../shared/contracts';
import {wrapText} from '../shared/layouts';
import {ChartPreview} from './ChartPreview';

function Text({element}: {element: TextElement}) {
  const lines = element.noWrap?element.text.split('\n'):wrapText(element.text, element.w-8, element.fontSize);
  const anchor = element.align === 'center' ? 'middle' : element.align === 'right' ? 'end' : 'start';
  const x = element.x + (anchor === 'middle' ? element.w / 2 : anchor === 'end' ? element.w : 0);
  return <text x={x} y={element.y + element.fontSize * .91} fontSize={element.fontSize} fill={element.color} fontFamily={element.font?`"${element.font}", "${element.fontFarEast??element.font}", "Yu Gothic", sans-serif`:undefined} fontWeight={element.bold ? 700 : 400} textAnchor={anchor}>
    {lines.map((line, i) => <tspan x={x} dy={i ? element.fontSize * 1.35 : 0} key={i}>{line}</tspan>)}
  </text>;
}

function SmartArt({element: e}: {element: SmartArtElement}) {
  const count = e.items.length;
  if (!count) return null;
  const item = (index: number, x: number, y: number, w: number, h: number) => <g key={`item${index}`}>
    <rect x={x} y={y} width={w} height={h} rx="5" fill={e.accent} />
    <Text element={{kind:'text',x:x+10,y:y+13,w:w-20,h:h-20,text:e.items[index].label,fontSize:e.fontSize,color:e.color,bold:true,align:'center'}} />
    {e.items[index].description && <Text element={{kind:'text',x:x+10,y:y+h*.53,w:w-20,h:h*.44,text:e.items[index].description!,fontSize:Math.max(11,e.fontSize-4),color:e.color,align:'center'}} />}
  </g>;
  if (e.layout === 'cycle') {
    const radius = Math.min(e.w*.3,e.h*.32), cx=e.x+e.w/2, cy=e.y+e.h/2, w=Math.min(150,e.w*.27), h=70;
    const points=e.items.map((_,i)=>({x:cx+Math.cos(i/count*Math.PI*2-Math.PI/2)*radius,y:cy+Math.sin(i/count*Math.PI*2-Math.PI/2)*radius}));
    return <g>{points.map((p,i)=><line key={`line${i}`} x1={p.x} y1={p.y} x2={points[(i+1)%count].x} y2={points[(i+1)%count].y} stroke={e.accent} strokeWidth="2"/>)}{points.map((p,i)=>item(i,p.x-w/2,p.y-h/2,w,h))}</g>;
  }
  if (e.layout === 'hierarchy') {
    const rootW=Math.min(230,e.w*.38), childW=Math.min(190,(e.w-12*(count-2))/Math.max(1,count-1));
    const topX=e.x+(e.w-rootW)/2, topY=e.y+12, childY=e.y+e.h*.55, childH=Math.min(100,e.h*.38);
    return <g><line x1={e.x+e.w/2} y1={topY+75} x2={e.x+e.w/2} y2={childY-20} stroke={e.accent}/>{e.items.slice(1).map((_,i)=>{
      const x=e.x+e.w*(i+.5)/(count-1)-childW/2;
      return <g key={i}><path d={`M${e.x+e.w/2} ${childY-20} H${x+childW/2} V${childY}`} fill="none" stroke={e.accent}/>{item(i+1,x,childY,childW,childH)}</g>;
    })}{item(0,topX,topY,rootW,75)}</g>;
  }
  const columns = e.layout==='list' ? Math.min(count,3) : count;
  const rows = Math.ceil(count/columns), gap=e.layout==='list'?18:25, w=(e.w-gap*(columns-1))/columns, h=Math.min(e.layout==='list'?115:145,(e.h-gap*(rows-1))/rows), startY=e.y+(e.h-(h*rows+gap*(rows-1)))/2;
  return <g>{e.items.map((_,i)=>{
    const x=e.x+(i%columns)*(w+gap), y=startY+Math.floor(i/columns)*(h+gap);
    return <g key={i}>{e.layout==='process'&&i<count-1&&<path d={`M${x+w+5} ${y+h/2-5} l8 5 -8 5`} stroke={e.accent} strokeWidth="2" fill="none"/>}{item(i,x,y,w,h)}</g>;
  })}</g>;
}

function Element({element: e,textColor}: {element: SceneElement;textColor:string}) {
  if(e.kind==='text') return <Text element={e}/>;
  if(e.kind==='line') return <line x1={e.x} y1={e.y+(e.flipY?e.h:0)} x2={e.x+e.w} y2={e.y+(e.flipY?0:e.h)} stroke={e.stroke} strokeWidth={e.strokeWidth??1}/>;
  if(e.kind==='chart') return <ChartPreview element={e} textColor={textColor}/>;
  if(e.kind==='smartart') return <SmartArt element={e}/>;
  if(e.shape==='ellipse') return <ellipse cx={e.x+e.w/2} cy={e.y+e.h/2} rx={e.w/2} ry={e.h/2} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth}/>;
  if(e.shape==='triangle') return <polygon points={`${e.x+e.w/2},${e.y} ${e.x+e.w},${e.y+e.h} ${e.x},${e.y+e.h}`} fill={e.fill} stroke={e.stroke}/>;
  if(e.shape==='arrow') return <polygon points={`${e.x},${e.y+e.h*.22} ${e.x+e.w*.75},${e.y+e.h*.22} ${e.x+e.w*.75},${e.y} ${e.x+e.w},${e.y+e.h/2} ${e.x+e.w*.75},${e.y+e.h} ${e.x+e.w*.75},${e.y+e.h*.78} ${e.x},${e.y+e.h*.78}`} fill={e.fill} stroke={e.stroke}/>;
  return <rect x={e.x} y={e.y} width={e.w} height={e.h} rx={e.shape==='roundRect'?8:0} fill={e.fill} stroke={e.stroke} strokeWidth={e.strokeWidth}/>;
}

export function SlidePreview({document, index, nativeUrl}: {document: RenderDocument; index: number; nativeUrl?: string}) {
  const slide=document.slides[index];
  if(!slide) return null;
  if(nativeUrl) return <img src={nativeUrl} alt={slide.title} loading="lazy"/>;
  return <svg viewBox={`0 0 ${document.width} ${document.height}`} role="img" aria-label={slide.title} style={{background:document.theme.background,fontFamily:`"${document.theme.font}", "Yu Gothic UI", sans-serif`}}>
    <title>{slide.title}</title>{slide.elements.map((element,i)=><Element key={i} element={element} textColor={document.theme.muted}/>)}
  </svg>;
}
