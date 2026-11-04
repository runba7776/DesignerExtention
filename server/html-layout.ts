import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IconId, Theme } from '../shared/contracts.js';
import { themeTokens } from '../shared/free-design.js';
import { iconCatalog, iconSvg } from '../shared/icons.js';
import { presetOutline } from '../shared/shape-outline.js';

/** One AI-written HTML page, read back as free-design elements. Problems are the
 * app's findings (text outside the slide, in the footer or clipped), sent with a retry. */
/** fitted: the share (0.85-0.95) the text was made smaller to keep it above the footer, without asking the AI.
 * squeezed: the share the spacing was made smaller to (0.6 or 0.35), before or with the text, without asking the AI.
 * grown: text below the smallest size was made that size (the page still fitted), without asking the AI.
 * keptSmall: text a little below the smallest size was kept as written (made larger, it did not fit).
 * shot: the drawn page as a 960x540 PNG (base64), when asked for. */
export type HtmlPageLayout =
  | {
      background?: string;
      elements: Record<string, unknown>[];
      problems: string[];
      fitted?: number;
      squeezed?: number;
      grown?: boolean;
      keptSmall?: boolean;
      shot?: string;
    }
  | { error: string };
/** minTextSize: body text, and text marked data-role="caption", drawn smaller than this (px = pt) is reported.
 * keepSmall: text that cannot be made that size is kept down to the fitting floor instead (a local model
 * rarely fixed 14px text when asked, and the deck stopped). */
export interface HtmlLayoutOptions {
  minTextSize?: { body: number; caption: number };
  screenshot?: boolean;
  keepSmall?: boolean;
}
export type HtmlLayout = (
  pages: { id: string; html: string }[],
  theme: Theme,
  options?: HtmlLayoutOptions,
) => Promise<HtmlPageLayout[]>;

/** Removes anything that could run code or load from outside; url() stays only as a reference
 * inside the page (an SVG arrowhead, a gradient). The page also has a CSP that blocks scripts
 * and network access, and script execution is disabled. */
export function sanitizeHtml(html: string) {
  return html
    .replace(
      /<\s*(script|iframe|object|embed|form|textarea|select|video|audio|foreignObject|noscript|template|title|head)\b[\s\S]*?<\/\s*\1\s*>/gi,
      '',
    )
    .replace(
      /<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|img|image|video|audio|source|foreignObject|noscript|template|html|body|head|title)\b[^>]*>/gi,
      '',
    )
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|xlink:href|srcset|action|formaction|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/url\s*\((?!\s*(?:["']|&quot;|&#0*39;|&apos;)?#)[^)]*\)/gi, 'none')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(');
}

/** The page the AI's HTML is drawn in: its slide size, the deck's colours and fonts as
 * CSS variables (defaults the AI may override; the fonts the browser actually used are
 * read back so PowerPoint draws the same lines). Features the converter cannot carry are switched off,
 * so what the browser shows is what PowerPoint gets. */
export function slidePage(html: string, theme: Theme) {
  const t = themeTokens(theme),
    font = (name: string | undefined) => `"${(name ?? theme.font).replace(/"/g, '')}"`;
  const vars = `--bg:${t.bg};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--accent2:${t.accent2};--surface:${t.surface};--rule:${t.rule};--negative:${t.negative};--on-accent:${t.onAccent};--heading-font:${font(theme.headingFont)};--body-font:${font(theme.font)};--number-font:${font(theme.numberFont)}`;
  // lang="ja" + auto-phrase: Japanese lines break between phrases (確かめる, 素数は) as in the app's JSON method.
  // Moves inside an SVG stay (a mirrored hand): PowerPoint draws them, so the picture the AI reviews must show them too.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'">
<style>:root{${vars}}html,body{margin:0;padding:0;background:#FFFFFF}section.slide{background:var(--bg);color:var(--ink);word-break:auto-phrase;line-break:strict;font-family:var(--body-font)}section.slide :is(h1,[data-role="title"]){font-family:var(--heading-font)}section.slide [data-role="number"]{font-family:var(--number-font),var(--body-font)}</style></head><body>${sanitizeHtml(html)}
<style>section.slide{width:960px!important;height:540px!important;position:relative!important;overflow:hidden!important;box-sizing:border-box!important;margin:0!important}
section.slide,section.slide *{word-spacing:normal!important;text-shadow:none!important;filter:none!important;writing-mode:horizontal-tb!important;list-style:none!important}
section.slide [data-image]{overflow:hidden!important}
section.slide,section.slide :not(svg *){transform:none!important;clip-path:none!important}
section.slide *::before,section.slide *::after{content:none!important}</style></body></html>`;
}

/** Runs inside the page (scripts of the page itself are disabled). Reads the browser's
 * layout of <section class="slide"> and returns free-design elements. */
export const CONVERT_SCRIPT = String.raw`(function(){
  const round=v=>Math.round(v*10)/10;
  const color=value=>{const m=/rgba?\(([^)]+)\)/.exec(value||'');if(!m)return {hex:null,a:0};const p=m[1].split(/[\s,/]+/).filter(Boolean).map(Number),a=p.length>3?p[3]:1;return {hex:'#'+p.slice(0,3).map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase(),a};};
  const firstGradientColor=image=>{const m=/rgba?\([^)]+\)/.exec(image||'');return m?color(m[0]):{hex:null,a:0};};
  // One straight gradient (2-4 colours, each with its own opacity) and the first outer shadow, as PowerPoint draws them.
  const toAngle={'top':0,'right':90,'bottom':180,'left':270,'top right':45,'right top':45,'bottom right':135,'right bottom':135,'bottom left':225,'left bottom':225,'top left':315,'left top':315};
  const gradientOf=image=>{
    const m=/^linear-gradient\((.*)\)$/.exec((image||'').trim());if(!m||m[1].includes('gradient('))return null;
    const head=m[1].split(/,(?![^(]*\))/)[0].trim(),deg=/^(-?[\d.]+)deg$/.exec(head),to=/^to\s+(.+)$/.exec(head);
    let stops=[...m[1].matchAll(/rgba?\([^)]+\)(?:\s+(-?[\d.]+)%)?/g)].map(s=>({c:color(s[0]),at:s[1]===undefined?null:parseFloat(s[1])/100}));
    if(stops.length<2)return null;if(stops.length>4)stops=[...stops.slice(0,3),stops[stops.length-1]];
    return {angle:deg?round((parseFloat(deg[1])%360+360)%360):to?(toAngle[to[1].trim()]??180):180,stops:stops.map((s,i)=>({color:s.c.hex,at:Math.max(0,Math.min(1,Math.round((s.at??i/(stops.length-1))*100)/100)),...(s.c.a<0.99?{op:round(s.c.a*100)/100}:{})}))};
  };
  const shadowOf=value=>{
    const first=(value||'none').split(/,(?![^(]*\))/)[0];if(first==='none'||/inset/.test(first))return null;
    const c=color(first),n=(first.replace(/rgba?\([^)]+\)/,'').match(/-?[\d.]+px/g)||[]).map(parseFloat),clamp=(v,a,b)=>round(Math.max(a,Math.min(b,v)));
    if(n.length<2||c.a<0.02)return null;
    return {x:clamp(n[0],-40,40),y:clamp(n[1],-40,40),blur:clamp(n[2]||0,0,80),color:c.hex,...(c.a<0.99?{op:round(c.a*100)/100}:{})};
  };
  const section=document.querySelector('section.slide');
  if(!section)return JSON.stringify({error:'<section class="slide">がありません。各ページのhtmlは<section class="slide">…</section>で書いてください。'});
  const base=section.getBoundingClientRect(),out=[],problems=[],inks=[],figures=[],kinds=new Set(),options=window.__deOptions||{};let background;
  // A PowerPoint shape asked for by name (data-shape="chevron"): the page shows its outline and it is read as that shape.
  const outline=${presetOutline};
  for(const e of section.querySelectorAll('[data-shape]')){const r=e.getBoundingClientRect(),p=outline(e.dataset.shape,r.width,r.height);if(p)e.style.setProperty('clip-path','polygon('+p.map((v,i)=>(i%2?' ':i?',':'')+round(v)+'px').join('')+')','important');}
  const ink=c=>{const middle=(c.r.top+c.r.bottom)/2;return {l:c.r.left,r:c.r.right,t:middle-c.size/2,b:middle+c.size/2};};
  const rect=r=>{const x=Math.max(0,r.left-base.left),y=Math.max(0,r.top-base.top);return {x:round(x),y:round(y),w:round(Math.max(1,Math.min(r.right-base.left,960)-x)),h:round(Math.max(1,Math.min(r.bottom-base.top,540)-y))};};
  const inside=r=>r.width>0.5&&r.height>0.5&&r.right>base.left&&r.bottom>base.top&&r.left<base.right&&r.top<base.bottom;
  const short=s=>s.replace(/\s+/g,'').slice(0,14);
  const roleOf=el=>{const m=el.closest('[data-role]');const v=m&&section.contains(m)?m.getAttribute('data-role'):null;if(['title','heading','number','caption','body'].includes(v))return v;return el.closest('h1')?'title':'body';};
  function radius(cs,w,h){const v=cs.borderTopLeftRadius;if(!v||v.startsWith('0'))return 0;const n=parseFloat(v);return v.includes('%')?n/100*Math.min(w,h):n;}
  function svgMarkup(svg,r){
    const clone=svg.cloneNode(true),source=[svg,...svg.querySelectorAll('*')],target=[clone,...clone.querySelectorAll('*')];
    source.forEach((el,i)=>{const cs=getComputedStyle(el),t=target[i];for(const p of ['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','font-size','font-weight','marker-start','marker-mid','marker-end'])t.setAttribute(p,cs.getPropertyValue(p));if(el.tagName==='text'||el.tagName==='tspan')t.setAttribute('font-family',cs.fontFamily);t.removeAttribute('class');t.removeAttribute('style');});
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width',String(round(r.width)));clone.setAttribute('height',String(round(r.height)));
    if(!clone.getAttribute('viewBox'))clone.setAttribute('viewBox','0 0 '+round(r.width)+' '+round(r.height));
    return new XMLSerializer().serializeToString(clone);
  }
  /** An SVG drawn with lines, shapes and paths as PowerPoint lines (a drawn arrowhead as the line's own), rectangles,
   * ovals and freeforms (one figure each), in slide points. Null keeps it a picture: text, pictures, gradients,
   * clipping, filters, see-through lines, a turned rectangle or oval, a drawing past its frame or the slide, or more
   * than 40 parts. */
  function svgShapes(svg,r,alpha){
    if(r.left<base.left-1||r.top<base.top-1||r.right>base.right+1||r.bottom>base.bottom+1)return null;
    const parts=[],P=(m,x,y)=>[round(m.a*x+m.c*y+m.e-base.left),round(m.b*x+m.d*y+m.f-base.top)];
    for(const el of svg.querySelectorAll('*')){
      if(el.tagName==='g'||el.closest('defs,marker,symbol,clipPath,mask,pattern,linearGradient,radialGradient,filter,title,desc,metadata,style'))continue;
      const tag=el.tagName;if(!/^(line|polyline|polygon|rect|circle|ellipse|path)$/.test(tag))return null;
      const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')continue;
      let a=alpha;for(let p=el;p!==svg;p=p.parentNode){const s=getComputedStyle(p);a*=parseFloat(s.opacity||'1');if(s.clipPath!=='none'||s.mask!=='none'||s.filter!=='none')return null;}
      const b=el.getBoundingClientRect(),m=el.getScreenCTM();
      if(/url\(/.test(cs.fill+cs.stroke)||!m||b.left<r.left-1||b.top<r.top-1||b.right>r.right+1||b.bottom>r.bottom+1)return null;
      const k=Math.sqrt(Math.abs(m.a*m.d-m.b*m.c)),fill=color(cs.fill),stroke=color(cs.stroke),lw=(parseFloat(cs.strokeWidth)||0)*k;
      const fo=fill.a*parseFloat(cs.fillOpacity||'1')*a,so=stroke.a*parseFloat(cs.strokeOpacity||'1')*a,filled=tag!=='line'&&fo>0.02,stroked=so>0.02&&lw>0.1;
      if(!filled&&!stroked)continue;
      if(stroked&&so<0.95)return null;
      const look={fill:filled?fill.hex:'none',...(filled&&fo<0.99?{op:round(fo*100)/100}:{}),...(stroked?{line:stroke.hex,lw:round(Math.max(0.25,Math.min(12,lw)))}:{}),...(stroked&&cs.strokeDasharray!=='none'?{dash:true}:{})};
      if(tag==='rect'||tag==='circle'||tag==='ellipse'){
        if(Math.abs(m.b)>1e-6||Math.abs(m.c)>1e-6)return null;
        const box=rect(b),rad=tag==='rect'?(parseFloat(cs.rx)>0?parseFloat(cs.rx):parseFloat(cs.ry)>0?parseFloat(cs.ry):0)*k:0;
        parts.push({t:'box',...box,shape:tag!=='rect'?'ellipse':rad>0?'roundRect':'rect',...(rad>0?{r:Math.min(.5,Math.round(rad/Math.min(box.w,box.h)*1000)/1000)}:{}),...look});continue;
      }
      let cmds;
      if(tag==='path')cmds=pathCommands(el.getAttribute('d')||'');
      else if(tag==='line')cmds=[['M',el.x1.baseVal.value,el.y1.baseVal.value],['L',el.x2.baseVal.value,el.y2.baseVal.value]];
      else{const ps=el.points;cmds=Array.from({length:ps.numberOfItems},(_,i)=>{const q=ps.getItem(i);return [i?'L':'M',q.x,q.y];});if(tag==='polygon')cmds.push(['Z']);}
      if(!cmds)return null;
      // One figure each: a filled one with holes cannot be one freeform.
      const figs=[];for(const c of cmds){if(c[0]==='M')figs.push([]);if(!figs.length)return null;figs[figs.length-1].push(c);}
      if(filled&&figs.length>1)return null;
      const arrow=['none','start','end','both'][(cs.markerStart!=='none'?1:0)+(cs.markerEnd!=='none'?2:0)];
      for(const f of figs){
        if(f.length<(stroked?2:3))continue;
        const pts=f.map(c=>[c[0],...c.slice(1).flatMap((v,j)=>j%2?[]:P(m,v,c[j+2]))]),open=f[f.length-1][0]!=='Z';
        if(!filled&&f.length===2&&f[1][0]==='L'){parts.push({t:'line',x1:pts[0][1],y1:pts[0][2],x2:pts[1][1],y2:pts[1][2],color:look.line,lw:look.lw,...(look.dash?{dash:true}:{}),...(arrow!=='none'?{arrow}:{})});continue;}
        const xs=pts.flatMap(c=>c.filter((_,j)=>j%2)),ys=pts.flatMap(c=>c.filter((_,j)=>j&&!(j%2)));
        parts.push({t:'path',...rect({left:Math.min(...xs)+base.left,top:Math.min(...ys)+base.top,right:Math.max(...xs)+base.left,bottom:Math.max(...ys)+base.top}),d:pts.map(c=>c.join(' ')).join(' '),...look,...(open&&arrow!=='none'?{arrow}:{})});
      }
    }
    // A line ending in a drawn triangle or chevron of its colour is one PowerPoint arrow.
    for(const p of parts.filter(q=>q.t==='line'))for(const end of ['end','start']){
      if(p.arrow===end||p.arrow==='both')continue;
      const [ex,ey,sx,sy]=end==='end'?[p.x2,p.y2,p.x1,p.y1]:[p.x1,p.y1,p.x2,p.y2],len=Math.hypot(ex-sx,ey-sy)||1,ux=(ex-sx)/len,uy=(ey-sy)/len,tol=Math.max(1.5,p.lw/2);
      const along=t=>(t[0]-ex)*ux+(t[1]-ey)*uy,off=t=>(t[1]-ey)*ux-(t[0]-ex)*uy;
      let tip;
      const head=parts.find(q=>{
        const v=q.t==='path'?q.d.split(' '):[],open=q.fill==='none';
        if(v.length!==(open?9:10)||v[3]!=='L'||v[6]!=='L'||(open?q.line:q.fill)!==p.color)return false;
        const pts=[[+v[1],+v[2]],[+v[4],+v[5]],[+v[7],+v[8]]];tip=open?pts[1]:pts.reduce((a,b)=>along(b)>along(a)?b:a);
        const [a,b]=pts.filter(t=>t!==tip),mid=[(a[0]+b[0])/2,(a[1]+b[1])/2];
        return along(tip)>0&&Math.abs(off(tip))<=tol&&Math.abs(off(mid))<=tol&&off(a)*off(b)<0&&along(mid)<=p.lw&&along(mid)>=-Math.hypot(tip[0]-mid[0],tip[1]-mid[1]);
      });
      if(!head)continue;
      parts.splice(parts.indexOf(head),1);
      if(end==='end'){p.x2=tip[0];p.y2=tip[1];}else{p.x1=tip[0];p.y1=tip[1];}
      p.arrow=p.arrow?'both':end;
    }
    return parts.length&&parts.length<=40?parts:null;
  }
  /** SVG path data as absolute M, L, C and Z commands (quadratic curves and arcs as cubic curves); null if unreadable. */
  function pathCommands(d){
    const tk=d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g)||[],out=[];
    let i=0,cmd='',x=0,y=0,sx=0,sy=0,px=0,py=0,last='';
    const n=()=>{const v=parseFloat(tk[i++]);if(!Number.isFinite(v))throw 0;return v;};
    const flag=()=>{const t=tk[i];if(t===undefined)throw 0;if(t.length>1&&/^[01]/.test(t)){tk[i]=t.slice(1);return t[0]==='1';}i++;return t==='1';};
    try{
      while(i<tk.length){
        if(/[a-zA-Z]/.test(tk[i]))cmd=tk[i++];else if(!cmd)return null;
        const C=cmd.toUpperCase(),ox=cmd===C?0:x,oy=cmd===C?0:y;
        if(C==='Z'){out.push(['Z']);x=sx;y=sy;last='Z';continue;}
        if(C==='M'){x=ox+n();y=oy+n();sx=x;sy=y;out.push(['M',x,y]);cmd=cmd==='m'?'l':'L';last='M';continue;}
        if(C==='L'||C==='H'||C==='V'){if(C!=='V')x=ox+n();if(C!=='H')y=oy+n();out.push(['L',x,y]);}
        else if(C==='C'||C==='S'){let a=last==='C'?2*x-px:x,b=last==='C'?2*y-py:y;if(C==='C'){a=ox+n();b=oy+n();}px=ox+n();py=oy+n();const ex=ox+n(),ey=oy+n();out.push(['C',a,b,px,py,ex,ey]);x=ex;y=ey;}
        else if(C==='Q'||C==='T'){if(C==='Q'){px=ox+n();py=oy+n();}else{px=last==='Q'?2*x-px:x;py=last==='Q'?2*y-py:y;}const ex=ox+n(),ey=oy+n();out.push(['C',x+2/3*(px-x),y+2/3*(py-y),ex+2/3*(px-ex),ey+2/3*(py-ey),ex,ey]);x=ex;y=ey;}
        else if(C==='A'){const rx=n(),ry=n(),deg=n(),large=flag(),sweep=flag(),ex=ox+n(),ey=oy+n();out.push(...arcCurves(x,y,rx,ry,deg,large,sweep,ex,ey));x=ex;y=ey;}
        else return null;
        last=C==='S'?'C':C==='T'?'Q':C;
      }
    }catch(e){return null;}
    return out;
  }
  /** An SVG arc (endpoints, radii, turn and flags) as cubic curves of at most a quarter turn each. */
  function arcCurves(x1,y1,rx,ry,deg,large,sweep,x2,y2){
    rx=Math.abs(rx);ry=Math.abs(ry);if(!rx||!ry||(x1===x2&&y1===y2))return [['L',x2,y2]];
    const f=deg*Math.PI/180,co=Math.cos(f),si=Math.sin(f),dx=(x1-x2)/2,dy=(y1-y2)/2,xp=co*dx+si*dy,yp=-si*dx+co*dy,l=xp*xp/(rx*rx)+yp*yp/(ry*ry);
    if(l>1){rx*=Math.sqrt(l);ry*=Math.sqrt(l);}
    const k=(large===sweep?-1:1)*Math.sqrt(Math.max(0,(rx*rx*ry*ry-rx*rx*yp*yp-ry*ry*xp*xp)/(rx*rx*yp*yp+ry*ry*xp*xp))),cxp=k*rx*yp/ry,cyp=-k*ry*xp/rx;
    const cx=co*cxp-si*cyp+(x1+x2)/2,cy=si*cxp+co*cyp+(y1+y2)/2,ang=(ux,uy,vx,vy)=>Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy);
    const t1=ang(1,0,(xp-cxp)/rx,(yp-cyp)/ry);let dt=ang((xp-cxp)/rx,(yp-cyp)/ry,(-xp-cxp)/rx,(-yp-cyp)/ry);
    if(!sweep&&dt>0)dt-=2*Math.PI;else if(sweep&&dt<0)dt+=2*Math.PI;
    const seg=Math.max(1,Math.ceil(Math.abs(dt)/(Math.PI/2)-1e-9)),d=dt/seg,e=4/3*Math.tan(d/4),out=[];
    const pt=t=>[cx+rx*Math.cos(t)*co-ry*Math.sin(t)*si,cy+rx*Math.cos(t)*si+ry*Math.sin(t)*co],tan=t=>[-rx*Math.sin(t)*co-ry*Math.cos(t)*si,-rx*Math.sin(t)*si+ry*Math.cos(t)*co];
    for(let j=0;j<seg;j++){const a=t1+j*d,b=a+d,[ax,ay]=pt(a),[bx,by]=pt(b),[ux,uy]=tan(a),[vx,vy]=tan(b);out.push(['C',ax+e*ux,ay+e*uy,bx-e*vx,by-e*vy,bx,by]);}
    return out;
  }
  /** Checks where one text's characters are drawn against the slide, the footer and a clipping box around it. */
  function check(el,top,bottom,left,right,sample){
    const y2=bottom-base.top,x2=right-base.left,side=top-base.top< -1||left-base.left< -1||x2>961;
    // kinds: only text running off the bottom (and nothing else) may be fitted by making the text smaller.
    if(side||y2>541){kinds.add(side?'side':'bottom');problems.push('文字がスライドの外にはみ出しています（「'+sample+'」）。文字を減らすか、枠と文字の大きさを調整してください。');return;}
    if(y2>497){kinds.add('bottom');problems.push('文字が下端の出典欄（下から44px、y=496以降）に入っています（「'+sample+'」）。下から44pxには文字を置かないでください。');return;}
    for(let a=el;a&&a!==section;a=a.parentElement){const cs=getComputedStyle(a);if(cs.overflow==='visible'&&cs.overflowX==='visible'&&cs.overflowY==='visible')continue;const r=a.getBoundingClientRect();if(bottom>r.bottom+2||right>r.right+2||top<r.top-2||left<r.left-2){kinds.add('clip');problems.push('文字が囲みからはみ出して一部が隠れています（「'+sample+'」）。囲みを広げるか、文字を減らしてください。');}break;}
  }
  /** Characters of the given text nodes with their place and style; collapsed white space has no box. */
  function characters(nodes){
    const list=[];
    for(const node of nodes){
      const parent=node.parentElement,cs=getComputedStyle(parent);if(cs.visibility==='hidden')continue;
      const value=node.textContent,range=document.createRange();let i=0;
      for(const ch of Array.from(value)){range.setStart(node,i);range.setEnd(node,i+ch.length);i+=ch.length;const rects=range.getClientRects(),r=rects[rects.length-1];if(!r||r.width<0.01)continue;list.push({ch,r,cs,parent,size:parseFloat(cs.fontSize)});}
    }
    return list;
  }
  /** Characters that share a font size as one text in browser lines, with the colour/weight changes inside it as
   * runs (null when no character shows). */
  function textOf(chars){
    if(!chars.length)return null;
    const size=chars[0].size,lines=[];let current=null;
    for(const c of chars){if(!current||c.r.top>current.top+size*.5){current={top:c.r.top,chars:[]};lines.push(current);}current.chars.push(c);}
    for(const l of lines){while(l.chars.length&&/\s/.test(l.chars[0].ch))l.chars.shift();while(l.chars.length&&/\s/.test(l.chars[l.chars.length-1].ch))l.chars.pop();}
    const visible=lines.filter(l=>l.chars.length);if(!visible.length)return null;
    for(const l of visible){l.top=Math.min(...l.chars.map(c=>c.r.top));l.bottom=Math.max(...l.chars.map(c=>c.r.bottom));l.left=Math.min(...l.chars.map(c=>c.r.left));l.right=Math.max(...l.chars.map(c=>c.r.right));}
    const key=c=>{const k=color(c.cs.color).hex+'|'+((parseInt(c.cs.fontWeight,10)||400)>=600?1:0)+'|'+(c.cs.fontStyle==='italic'?1:0);return k;};
    // keys[i] is the style of text[i] (UTF-16 positions, as PowerPoint counts characters).
    let text='';const keys=[];
    visible.forEach((l,li)=>{if(li){text+='\n';keys.push(keys[keys.length-1]);}for(const c of l.chars){const ch=/\s/.test(c.ch)?' ':c.ch;text+=ch;for(let u=0;u<ch.length;u++)keys.push(key(c));}});
    const counts={};for(const k of keys)counts[k]=(counts[k]||0)+1;
    const mainKey=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0],main=mainKey.split('|');
    const runs=[];let at=0;
    while(at<text.length){const k=keys[at];let end=at;while(end<text.length&&keys[end]===k)end++;if(k!==mainKey){const p=k.split('|'),run={s:at,l:end-at};if(p[0]!==main[0])run.color=p[0];if(p[1]!==main[1])run.bold=p[1]==='1';if(p[2]!==main[2])run.italic=p[2]==='1';runs.push(run);}at=end;}
    const measured=visible.length>1?(visible[visible.length-1].top-visible[0].top)/(visible.length-1):0,pitch=measured>size*1.3?measured:0;
    return {size,visible,text,runs,main,measured,pitch,glyphs:visible.flatMap(l=>l.chars.filter(c=>!/\s/.test(c.ch)).map(ink))};
  }
  /** Checks a text where it is drawn (the slide, the footer, a clipping box, the smallest size) and keeps its
   * characters for the overlap checks (index: the element it belongs to). */
  function checkText(block,t,index){
    const glyphs=t.glyphs,sample=short(t.text);
    check(block,Math.min(...glyphs.map(g=>g.t)),Math.max(...glyphs.map(g=>g.b)),Math.min(...t.visible.map(l=>l.left)),Math.max(...t.visible.map(l=>l.right)),sample);
    const min=options.minTextSize&&(roleOf(block)==='caption'?options.minTextSize.caption:options.minTextSize.body);
    if(min&&t.size<min-0.25){kinds.add('small');problems.push('文字が小さすぎます（「'+sample+'」、'+round(t.size)+'px）。この資料では、本文を'+options.minTextSize.body+'px以上、注記（data-role="caption"）を'+options.minTextSize.caption+'px以上にしてください。');}
    inks.push({size:t.size,sample,glyphs,block,index,l:Math.min(...glyphs.map(g=>g.l)),r:Math.max(...glyphs.map(g=>g.r)),t:Math.min(...glyphs.map(g=>g.t)),b:Math.max(...glyphs.map(g=>g.b))});
  }
  /** One text element from characters that share a font size: browser lines, and the
   * colour/weight changes inside them as runs. */
  function emit(block,chars){
    const t=textOf(chars);if(!t)return;
    checkText(block,t,out.length);
    const {size,visible,text,runs,main,measured,pitch}=t;
    const cs=getComputedStyle(block),align=cs.textAlign==='center'?'c':cs.textAlign==='right'||cs.textAlign==='end'?'r':'l';
    const content=block.getBoundingClientRect(),padL=parseFloat(cs.paddingLeft)||0,padR=parseFloat(cs.paddingRight)||0;
    let left=Math.min(...visible.map(l=>l.left)),right=Math.max(...visible.map(l=>l.right));
    if(align!=='l'){left=Math.min(left,content.left+padL);right=Math.max(right,content.right-padR);}
    const top=visible[0].top-(pitch?(pitch-(visible[0].bottom-visible[0].top))/2:0),bottom=pitch?top+pitch*visible.length:Math.max(visible[visible.length-1].bottom,visible[0].top+(measured||size*1.25)*visible.length);
    const slack=(right-left)*.06+2,x=align==='r'?left-slack:align==='c'?left-slack/2:left;
    const box=rect({left:Math.max(base.left,x),top,right:Math.max(base.left,x)+right-left+slack,bottom:bottom+2});
    block.setAttribute('data-de-text',((block.getAttribute('data-de-text')||'')+' '+out.length).trim());
    const spacing=parseFloat(chars[0].cs.letterSpacing)||0;
    out.push({t:'text',...box,text,size:round(size),color:main[0]==='null'?'#000000':main[0],bold:main[1]==='1',...(main[2]==='1'?{italic:true}:{}),align,...(pitch?{lh:round(pitch)}:{}),...(Math.abs(spacing)>=0.1?{sp:round(Math.max(-3,Math.min(20,spacing)))}:{}),exact:true,role:roleOf(block),...(runs.length&&runs.length<=40?{runs}:{})});
  }
  function textNodes(el){const list=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode()))if(n.textContent.trim())list.push(n);return list;}
  /** Only inline children (span, strong, br…): the whole element is one text. */
  function inlineOnly(el){for(const c of el.children){if(c instanceof SVGElement||c.dataset.chart!==undefined||c.dataset.image!==undefined)return false;const d=getComputedStyle(c).display;if(d==='none')continue;if(d!=='inline'&&d!=='contents')return false;if(!inlineOnly(c))return false;}return true;}
  function shapes(el,cs,r,alpha){
    let bg=color(cs.backgroundColor),grad=null;
    if(!bg.a&&cs.backgroundImage&&cs.backgroundImage!=='none'){grad=gradientOf(cs.backgroundImage);bg=grad?{hex:grad.stops[0].color,a:1}:firstGradientColor(cs.backgroundImage);}
    const shadow=shadowOf(cs.boxShadow);
    const sides=['Top','Right','Bottom','Left'].map(s=>({w:parseFloat(cs['border'+s+'Width'])||0,c:color(cs['border'+s+'Color']),style:cs['border'+s+'Style']})).map(s=>s.style==='none'||!s.c.a?{...s,w:0}:s);
    const uniform=sides.every(s=>s.w>0&&s.w===sides[0].w&&s.c.hex===sides[0].c.hex),box=rect(r),rad=radius(cs,r.width,r.height);
    if(bg.a>0.01||uniform){
      const shape=el.dataset&&outline(el.dataset.shape,1,1)?el.dataset.shape:rad>=Math.min(r.width,r.height)/2-0.5?(Math.abs(r.width-r.height)<1?'ellipse':'roundRect'):rad>0?'roundRect':'rect';
      out.push({t:'box',...box,shape,fill:bg.a>0.01?bg.hex:'none',...(bg.a*alpha<0.99&&bg.a>0.01?{op:round(bg.a*alpha*100)/100}:{}),...(shape==='roundRect'?{r:Math.min(.5,Math.round(rad/Math.min(r.width,r.height)*1000)/1000)}:{}),...(uniform?{line:sides[0].c.hex,lw:sides[0].w,...(/dash|dot/.test(sides[0].style)?{dash:true}:{})}:{}),...(grad?{grad}:{}),...(shadow?{shadow}:{})});
    }
    if(!uniform)sides.forEach((s,i)=>{if(!s.w)return;const x=box.x,y=box.y,w=box.w,h=box.h;const bar=i===0?{x,y,w,h:s.w}:i===1?{x:x+w-s.w,y,w:s.w,h}:i===2?{x,y:y+h-s.w,w,h:s.w}:{x,y,w:s.w,h};out.push({t:'box',...bar,shape:'rect',fill:s.c.hex,...(s.c.a*alpha<0.99?{op:round(s.c.a*alpha*100)/100}:{})});});
  }
  /** A table as PowerPoint's own table: column widths, row heights and each cell's text and look as drawn. Merged or
   * spaced-out cells, more than 8 columns or 15 rows, or anything but text in a cell keep the drawn parts. */
  function table(el,cs,r){
    const rows=[...el.rows],n=rows[0]?rows[0].cells.length:0,collapse=cs.borderCollapse==='collapse';
    if(n<1||n>8||rows.length<2||rows.length>15||!inside(r)||rows.some(row=>row.cells.length!==n||[...row.cells].some(c=>c.colSpan>1||c.rowSpan>1)))return false;
    if(!collapse&&Math.max(...cs.borderSpacing.split(' ').map(parseFloat))>4)return false;
    if(el.querySelector('svg,table,[data-chart],[data-image],[data-icon]'))return false;
    const index=out.length,xs=[r.left,...[...rows[0].cells].slice(1).map(c=>c.getBoundingClientRect().left),r.right],ys=[r.top,...rows.slice(1).map(row=>row.getBoundingClientRect().top),r.bottom];
    const side=(s,name)=>{const w=parseFloat(s['border'+name+'Width'])||0,c=color(s['border'+name+'Color']),st=s['border'+name+'Style'];return w>0.4&&st!=='none'&&st!=='hidden'&&c.a>0.01?{w:round(w),c:c.hex}:null;};
    const cells=rows.map((row,ri)=>[...row.cells].map((cell,ci)=>{
      const ccs=getComputedStyle(cell),group=row.parentElement!==el?row.parentElement:null,edge={Top:ri===0,Bottom:ri===rows.length-1,Left:ci===0,Right:ci===n-1};
      // Collapsed borders of the row, its group and the table are drawn on the cells along them.
      const bd=['Top','Right','Bottom','Left'].map(name=>side(ccs,name)||(collapse&&(name==='Top'||name==='Bottom'||edge[name])?side(getComputedStyle(row),name):null)||(collapse&&group&&((name==='Top'&&row===group.rows[0])||(name==='Bottom'&&row===group.rows[group.rows.length-1])||((name==='Left'||name==='Right')&&edge[name]))?side(getComputedStyle(group),name):null)||(edge[name]?side(cs,name):null));
      let bg=null;for(const a of [cell,row,group,el]){if(!a)continue;const s=getComputedStyle(a),b=color(s.backgroundColor),g=b.a>0.01?b:s.backgroundImage&&s.backgroundImage!=='none'?firstGradientColor(s.backgroundImage):b;if(g.a>0.01){bg=g;break;}}
      const t=textOf(characters(textNodes(cell)));if(t)checkText(cell,t,index);
      const main=t?t.main:[color(ccs.color).hex,(parseInt(ccs.fontWeight,10)||400)>=600?'1':'0',ccs.fontStyle==='italic'?'1':'0'],va=ccs.verticalAlign;
      // PowerPoint sets one line at the top of a cell higher than a browser does unless it keeps the browser's line
      // height (a measured one for 'normal'); centred, one line sits right without it.
      const lineBox=()=>{const p=document.createElement('div');p.style.cssText='position:absolute;visibility:hidden;white-space:nowrap';p.textContent=t.text;cell.appendChild(p);const h=p.getBoundingClientRect().height;p.remove();return h;};
      const lh=!t?0:t.pitch||(va!=='middle'&&va!=='bottom'?parseFloat(ccs.lineHeight)||lineBox():0),pad=['Left','Top','Right','Bottom'].map(s=>round(parseFloat(ccs['padding'+s])||0));
      // Text at the top starts where the browser drew its first line (as a text box does), not only below the padding.
      if(t&&va!=='middle'&&va!=='bottom')pad[1]=round(Math.max(0,t.visible[0].top-(lh?(lh-(t.visible[0].bottom-t.visible[0].top))/2:0)-ys[ri]));
      return {text:t?t.text:'',look:{size:round(t?t.size:parseFloat(ccs.fontSize)),color:main[0]==='null'?'#000000':main[0],...(main[1]==='1'?{bold:true}:{}),...(main[2]==='1'?{italic:true}:{}),align:ccs.textAlign==='center'?'c':ccs.textAlign==='right'||ccs.textAlign==='end'?'r':'l',va:va==='middle'?'m':va==='bottom'?'b':'t',...(bg?{fill:bg.hex,...(bg.a<0.99?{op:round(bg.a*100)/100}:{})}:{}),...(lh?{lh:round(lh)}:{}),pad,...(bd.some(Boolean)?{bd}:{}),...(t&&t.runs.length&&t.runs.length<=40?{runs:t.runs}:{})}};
    }));
    el.setAttribute('data-de-text',String(index));
    out.push({t:'table',...rect(r),headers:cells[0].map(c=>c.text),rows:cells.slice(1).map(row=>row.map(c=>c.text)),cols:xs.slice(1).map((x,i)=>round(x-xs[i])),rowH:ys.slice(1).map((y,i)=>round(y-ys[i])),cells:cells.map(row=>row.map(c=>c.look)),...([...rows[0].cells].every(c=>c.tagName==='TH')||rows[0].parentElement.tagName==='THEAD'?{head:true}:{})});
    return true;
  }
  function visit(el,opacity){
    const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')return;
    const alpha=opacity*parseFloat(cs.opacity||'1');if(alpha<0.02)return;
    const r=el.getBoundingClientRect(),start=out.length;
    // A box with parts drawn inside it (a card: its shape, texts and icons) stays together; own: its own shapes.
    const together=own=>{if(own&&out.length-start>own)for(let i=start;i<out.length;i++)if(out[i].g===undefined)out[i].g=start;};
    // An app icon (data-icon, drawn by the app before reading): one editable icon, in the colour of its text.
    if(el.getAttribute('data-de-icon')==='1'){
      if(!inside(r))return;
      shapes(el,cs,r,alpha);
      const own=out.length-start,size=Math.min(r.width,r.height),left=r.left+(r.width-size)/2,top=r.top+(r.height-size)/2,box=rect({left,top,right:left+size,bottom:top+size});
      out.push({t:'icon',icon:el.getAttribute('data-icon'),x:box.x,y:box.y,size:round(size),color:color(cs.color).hex});
      together(own);return;
    }
    if(el instanceof SVGSVGElement){
      if(!inside(r))return;
      // Its lines and shapes become PowerPoint's own, kept together; anything else keeps it a picture.
      const parts=svgShapes(el,r,alpha);
      if(parts&&out.length+parts.length<=150)out.push(...parts.map(p=>parts.length>1?{...p,g:start}:p));else out.push({t:'svg',...rect(r),svg:svgMarkup(el,r)});
      // A large figure of lines and frames only (axes, a grid) is a candidate for an empty figure.
      if(r.width>=150&&r.height>=150&&r.width*r.height>=0.12*960*540&&!el.querySelector('circle,ellipse,path,polygon,text,image,use,foreignObject'))figures.push({box:rect(r),from:start,to:out.length});
      return;
    }
    if(el.dataset&&el.dataset.chart!==undefined){try{out.push({t:'chart',...rect(r),chart:JSON.parse(el.dataset.chart)});}catch(e){problems.push('グラフのdata-chartをJSONとして読めません。');}return;}
    // A place for a photo (English search words); the app finds the picture after reading the page.
    if(el.dataset&&el.dataset.image!==undefined){
      if(!inside(r))return;
      if(r.width<40||r.height<30){problems.push('画像の枠（data-image）が小さすぎます。幅と高さ（40px以上）を指定してください。');return;}
      const alt=el.getAttribute('data-alt');shapes(el,cs,r,alpha);
      out.push({t:'image',...rect(r),q:String(el.dataset.image).slice(0,80),...(alt?{alt:alt.slice(0,60)}:{})});return;
    }
    if(el.tagName==='TABLE'&&table(el,cs,r))return;
    if(el===section){const bg=color(cs.backgroundColor);if(bg.a>0.5)background=bg.hex;}
    else if(inside(r))shapes(el,cs,r,alpha);
    const own=out.length-start;
    if(el!==section&&inlineOnly(el)){
      // Backgrounds of inline parts (a highlighted word) go under the text.
      for(const c of el.querySelectorAll('*')){const ccs=getComputedStyle(c),bg=color(ccs.backgroundColor);if(bg.a>0.01)for(const part of c.getClientRects())if(inside(part))out.push({t:'box',...rect(part),shape:'rect',fill:bg.hex,...(bg.a<0.99?{op:round(bg.a*100)/100}:{})});}
      const chars=characters(textNodes(el));
      if(chars.length&&chars.every(c=>Math.abs(c.size-chars[0].size)<0.5))emit(el,chars);
      else for(const node of textNodes(el))emit(node.parentElement,characters([node]));
      together(own);return;
    }
    for(const child of el.childNodes){
      if(child.nodeType===Node.TEXT_NODE){if(child.textContent.trim())emit(el,characters([child]));}
      else if(child.nodeType===Node.ELEMENT_NODE)visit(child,alpha);
    }
    together(own);
  }
  visit(section,1);
  // Text drawn on top of other text: compared glyph by glyph, so a number and its smaller unit side by
  // side, or one line above another, are not overlaps. A numeral 3x the size or more is a backdrop.
  for(let i=0;i<inks.length;i++)for(let j=i+1;j<inks.length;j++){
    const a=inks[i],b=inks[j];
    if(Math.max(a.size,b.size)>=3*Math.min(a.size,b.size)||a.r<=b.l||b.r<=a.l||a.b<=b.t||b.b<=a.t)continue;
    const hit=a.glyphs.some(p=>b.glyphs.some(q=>{const w=Math.min(p.r,q.r)-Math.max(p.l,q.l),h=Math.min(p.b,q.b)-Math.max(p.t,q.t);return w>0&&h>0&&w*h>.25*Math.min((p.r-p.l)*(p.b-p.t),(q.r-q.l)*(q.b-q.t));}));
    if(hit){kinds.add('overlap');problems.push('文字どうしが重なっています（「'+a.sample+'」と「'+b.sample+'」）。位置か大きさを調整してください。');}
  }
  // A table grows with its wrapped cells, so a note placed by position under it ends up on its last row.
  for(const table of section.querySelectorAll('table')){
    const r=table.getBoundingClientRect();
    for(const a of inks)if(!table.contains(a.block)&&a.glyphs.some(g=>Math.min(g.r,r.right)-Math.max(g.l,r.left)>2&&Math.min(g.b,r.bottom)-Math.max(g.t,r.top)>2)){kinds.add('overlap');problems.push('文字が表に重なっています（「'+a.sample+'」）。表の行は文字の折り返しで高くなるので、表の下の文字は位置で固定せず表の後に続けて置くか、表から離してください。');}
  }
  // Text hidden under a shape drawn after it (later in the page, so on top): a character whose middle is inside an
  // opaque box or circle. Pages that set z-index are left alone, since the order on screen is then not the page order.
  const layered=[...section.querySelectorAll('*')].some(el=>{const z=getComputedStyle(el).zIndex;return z!=='auto'&&z!=='0';});
  if(!layered)for(const a of inks){
    for(let j=a.index+1;j<out.length;j++){
      const e=out[j];if(e.t!=='image'&&(e.t!=='box'||e.fill==='none'||(e.op!==undefined&&e.op<0.6)))continue;
      const under=a.glyphs.some(g=>{const cx=(g.l+g.r)/2-base.left,cy=(g.t+g.b)/2-base.top;
        if(e.shape==='ellipse'){const rx=e.w/2,ry=e.h/2,dx=(cx-e.x-rx)/rx,dy=(cy-e.y-ry)/ry;return dx*dx+dy*dy<1;}
        return cx>e.x+1&&cx<e.x+e.w-1&&cy>e.y+1&&cy<e.y+e.h-1;});
      if(under){kinds.add('covered');problems.push('文字が後ろに置いた図形に隠れています（「'+a.sample+'」）。図形を文字より先に置くか、文字の位置をずらしてください。');break;}
    }
  }
  // A shape stopping partway into the footer lies across the sources and page number the app draws there
  // (a closing band hid the page number); one reaching the slide's bottom edge is a band they are drawn on.
  if(out.some(e=>(e.t==='image'||(e.t==='box'&&e.fill!=='none'))&&e.w>40&&e.y+e.h>501&&e.y+e.h<539)){kinds.add('bottom');problems.push('図形が下端の出典・ページ番号の欄（y=496以降）にかかっています。図形の下端をy=496より上にするか、スライドの下端まで伸ばしてください。');}
  // Lines drawn under cards and labels (connectors) carry the page; a frame with at most three labels
  // in it and nothing drawn inside is an empty figure.
  for(const f of figures){
    const b=f.box,within=out.filter((e,i)=>(i<f.from||i>=f.to)&&(e.t==='text'||e.t==='box'||e.t==='chart'||e.t==='svg')&&e.x+e.w/2>=b.x&&e.x+e.w/2<=b.x+b.w&&e.y+e.h/2>=b.y&&e.y+e.h/2<=b.y+b.h).length;
    if(within<=3){kinds.add('empty');problems.push('図に中身がありません（線と枠だけの図です）。説明用の目安でも、点・棒・図形・文字など、図が伝える内容を図の中に描いてください。');}
  }
  // How far the text goes, measured, first: a model told only "the text runs off" did not see by how much
  // (gemma4:12b stacked boxes down to 600-850px).
  const lowest=inks.length?Math.round(Math.max(...inks.map(a=>a.b))-base.top):0;
  if(lowest>497)problems.unshift('ページの文字が上からy='+lowest+'pxまであります（出典欄はy=496から。文字は470px程度までに）。縦に積む段を減らして横に並べるか、要点・説明を減らしてください。');
  return JSON.stringify({background,elements:out,problems:[...new Set(problems)],fit:problems.length>0&&[...kinds].every(k=>k==='bottom'||k==='overlap'||k==='covered'),grow:problems.length>0&&[...kinds].every(k=>k==='small')});
})()`;

/** Makes every text of the page smaller by the given share (line heights given in px too). Boxes,
 * gaps and figures keep their size, so the composition stays; only the text takes less room. */
const fitScript = (share: number) => `(function(){const s=document.querySelector('section.slide');if(!s)return 0;
const list=[s,...s.querySelectorAll('*')].filter(e=>!(e instanceof SVGElement)),sizes=list.map(e=>{const cs=getComputedStyle(e);return [parseFloat(cs.fontSize),cs.lineHeight];});
list.forEach((e,i)=>{const [size,lh]=sizes[i];e.style.setProperty('font-size',(size*${share})+'px','important');if(lh.endsWith('px'))e.style.setProperty('line-height',(parseFloat(lh)*${share})+'px','important');});return list.length;})()`;
/** Makes the room inside and between boxes smaller by the given share (padding, vertical margins, gaps; line
 * spacing above 1.3 comes part of the way down). Text keeps its size. Tried before the text is made smaller:
 * pages ran off the bottom mostly through stacked boxes and wide spacing, not through their text. */
const squeezeScript = (share: number) => `(function(){const s=document.querySelector('section.slide');if(!s)return 0;
const props=['padding-top','padding-bottom','padding-left','padding-right','margin-top','margin-bottom','row-gap','column-gap'],list=[...s.querySelectorAll('*')].filter(e=>!(e instanceof SVGElement));
const before=list.map(e=>{const cs=getComputedStyle(e);return {v:props.map(p=>parseFloat(cs.getPropertyValue(p))||0),lh:parseFloat(cs.lineHeight),size:parseFloat(cs.fontSize)};});
list.forEach((e,i)=>{const b=before[i];props.forEach((p,k)=>{if(b.v[k]>0)e.style.setProperty(p,(b.v[k]*${share})+'px','important');});if(b.lh>b.size*1.3)e.style.setProperty('line-height',Math.max(b.size*1.3,b.lh*${(1 + share) / 2})+'px','important');});return list.length;})()`;
/** Makes text drawn below the smallest size of the mode (body, or a caption) that size, so a page whose only
 * problem is small text can be kept without asking the AI again when it still fits. */
const growScript = (min: {
  body: number;
  caption: number;
}) => `(function(){const s=document.querySelector('section.slide');if(!s)return 0;let n=0;
for(const e of [s,...s.querySelectorAll('*')]){if(e instanceof SVGElement||![...e.childNodes].some(c=>c.nodeType===3&&c.textContent.trim()))continue;
const cs=getComputedStyle(e),size=parseFloat(cs.fontSize),m=e.closest('[data-role]'),min=m&&m.getAttribute('data-role')==='caption'?${min.caption}:${min.body};
if(size>=min-0.25)continue;e.style.setProperty('font-size',min+'px','important');if(cs.lineHeight.endsWith('px'))e.style.setProperty('line-height',(parseFloat(cs.lineHeight)*min/size)+'px','important');n++;}return n;})()`;
/** The app's icons (data-icon) drawn into the page before it is read, so the layout and the picture show
 * them; an unknown id is left empty. Each becomes one editable icon when read. */
const ICON_SCRIPT = `(function(){const map=${JSON.stringify(Object.fromEntries(Object.keys(iconCatalog).map(id => [id, iconSvg(id as IconId)])))},s=document.querySelector('section.slide');if(!s)return 0;let n=0;
for(const e of s.querySelectorAll('[data-icon]')){const svg=map[e.getAttribute('data-icon')];if(!svg)continue;
const cs=getComputedStyle(e);if(cs.display==='inline')e.style.setProperty('display','inline-block','important');
const r=e.getBoundingClientRect();if(r.width<4||r.height<4){const size=Math.max(16,parseFloat(cs.fontSize)*1.5)+'px';e.style.setProperty('width',size,'important');e.style.setProperty('height',size,'important');}
e.innerHTML=svg;const g=e.firstElementChild;g.setAttribute('width','100%');g.setAttribute('height','100%');g.style.display='block';e.setAttribute('data-de-icon','1');n++;}return n;})()`;
/** For the picture only (after the page was read): each chart place gets a plain sketch of its data,
 * since the real chart is drawn later by PowerPoint and the place would otherwise look empty; each photo
 * place gets a plain picture mark (the photo is found after the review). */
const CHART_SKETCH_SCRIPT = String.raw`(function(){
  const ns='http://www.w3.org/2000/svg',palette=['#4E79A7','#F28E2B','#59A14F'];
  for(const el of document.querySelectorAll('section.slide [data-chart]')){
    let c;try{c=JSON.parse(el.dataset.chart);}catch(e){continue;}
    const r=el.getBoundingClientRect(),w=Math.max(40,r.width),h=Math.max(40,r.height),cats=Array.isArray(c.categories)?c.categories:[],series=Array.isArray(c.series)?c.series:[];
    const svg=document.createElementNS(ns,'svg');svg.setAttribute('width',w);svg.setAttribute('height',h);svg.style.display='block';
    const add=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const k in attrs)n.setAttribute(k,attrs[k]);if(text!==undefined)n.textContent=text;svg.appendChild(n);return n;};
    const values=series.flatMap(s=>(s.values||[]).map(Number).filter(Number.isFinite)),max=Math.max(1,...values.map(Math.abs)),pad=18,base=h-pad;
    const type=String(c.type||'column');
    if(type==='pie'||type==='doughnut'){
      const vals=(series[0]?.values||[]).map(v=>Math.max(0,Number(v)||0)),sum=vals.reduce((a,b)=>a+b,0)||1,cx=w/2,cy=h/2,rad=Math.min(w,h)/2-pad;let a0=-Math.PI/2;
      vals.forEach((v,i)=>{const a1=a0+v/sum*2*Math.PI,large=a1-a0>Math.PI?1:0;add('path',{d:'M'+cx+' '+cy+' L'+(cx+rad*Math.cos(a0))+' '+(cy+rad*Math.sin(a0))+' A'+rad+' '+rad+' 0 '+large+' 1 '+(cx+rad*Math.cos(a1))+' '+(cy+rad*Math.sin(a1))+' Z',fill:palette[i%3],opacity:String(1-i*0.12)});a0=a1;});
    }else{
      add('line',{x1:pad,y1:base,x2:w-4,y2:base,stroke:'#888'});
      const n=Math.max(1,cats.length),slot=(w-pad-4)/n;
      cats.forEach((cat,i)=>add('text',{x:pad+slot*i+slot/2,y:h-4,'font-size':'10','text-anchor':'middle',fill:'#555'},String(cat).slice(0,8)));
      if(type==='line')series.forEach((s,k)=>add('polyline',{points:(s.values||[]).map((v,i)=>(pad+slot*i+slot/2)+','+(base-(Number(v)||0)/max*(base-8))).join(' '),fill:'none',stroke:palette[k%3],'stroke-width':'2'}));
      else series.forEach((s,k)=>(s.values||[]).forEach((v,i)=>{const bw=slot*0.7/Math.max(1,series.length),bh=Math.abs(Number(v)||0)/max*(base-8);add('rect',{x:pad+slot*i+slot*0.15+bw*k,y:base-bh,width:bw,height:bh,fill:palette[k%3]});}));
    }
    el.replaceChildren(svg);
  }
  // A photo place: a plain picture mark with its description (the photo is found later).
  for(const el of document.querySelectorAll('section.slide [data-image]')){
    const r=el.getBoundingClientRect(),svg=document.createElementNS(ns,'svg');svg.setAttribute('width',r.width);svg.setAttribute('height',r.height);svg.style.display='block';
    const add=(tag,attrs,text)=>{const n=document.createElementNS(ns,tag);for(const k in attrs)n.setAttribute(k,attrs[k]);if(text!==undefined)n.textContent=text;svg.appendChild(n);};
    add('rect',{width:r.width,height:r.height,fill:'#C9D2DC'});
    add('path',{d:'M'+r.width*.3+' '+r.height*.68+' L'+r.width*.45+' '+r.height*.45+' L'+r.width*.56+' '+r.height*.6+' L'+r.width*.62+' '+r.height*.52+' L'+r.width*.72+' '+r.height*.68+' Z',fill:'#8A98A8'});
    add('text',{x:r.width/2,y:r.height*.85,'font-size':'12','text-anchor':'middle',fill:'#44505C'},'写真：'+(el.getAttribute('data-alt')||el.dataset.image).slice(0,24));
    el.replaceChildren(svg);
  }
  return true;
})()`;
/** Text that only runs a little past the bottom, or into another text below it, is made smaller in these steps
 * before the AI is asked again. Made smaller this way, body text may go 2px (a caption 1px) below the smallest
 * size of the mode: a page a little too full is kept instead of stopping the deck. */
const FIT_STEPS = [0.95, 0.9, 0.85];
/** The spacing is made smaller first (text kept), then the text with the spacing at its smallest. */
const SQUEEZE_STEPS = [0.6, 0.35];
const fitSteps: { squeeze: number; share?: number }[] = [
  ...SQUEEZE_STEPS.map(squeeze => ({ squeeze })),
  ...FIT_STEPS.map(share => ({ squeeze: SQUEEZE_STEPS.at(-1)!, share })),
];
const fitFloor = (min: { body: number; caption: number }) => ({ body: min.body - 2, caption: min.caption - 1 });

const japanese =
  /Gothic|Mincho|Meiryo|游|ゴシック|明朝|メイリオ|BIZ|UD |Kyokasho|教科書|Noto (Sans|Serif) (JP|CJK)|Hiragino|Yu |MS P?(Gothic|Mincho)|Source Han|源ノ/i;
/** The fonts the browser actually drew each text with (an installed fallback when the
 * AI named a font this PC lacks): Japanese and Latin, as PowerPoint sets them. */
async function usedFonts(
  send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  elements: Record<string, unknown>[],
) {
  await send('DOM.enable');
  await send('CSS.enable');
  const root = (await send('DOM.getDocument', { depth: 0 })).result?.root?.nodeId;
  if (!root) return;
  const nodes: number[] =
    (await send('DOM.querySelectorAll', { nodeId: root, selector: '[data-de-text]' })).result?.nodeIds ?? [];
  for (const nodeId of nodes) {
    const attributes: string[] = (await send('DOM.getAttributes', { nodeId })).result?.attributes ?? [];
    const indexes = (attributes[attributes.indexOf('data-de-text') + 1] ?? '')
      .split(' ')
      .map(Number)
      .filter(n => Number.isInteger(n));
    let fonts: { familyName: string; glyphCount: number }[] =
      (await send('CSS.getPlatformFontsForNode', { nodeId })).result?.fonts ?? [];
    if (!fonts.length)
      for (const child of ((await send('DOM.querySelectorAll', { nodeId, selector: '*' })).result?.nodeIds ?? []).slice(
        0,
        6,
      )) {
        fonts = (await send('CSS.getPlatformFontsForNode', { nodeId: child })).result?.fonts ?? [];
        if (fonts.length) break;
      }
    if (!fonts.length) continue;
    const sorted = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount),
      farEast = sorted.find(f => japanese.test(f.familyName))?.familyName ?? sorted[0].familyName,
      latin = sorted.find(f => !japanese.test(f.familyName))?.familyName ?? farEast;
    for (const i of indexes) {
      const e = elements[i];
      if (e && (e.t === 'text' || e.t === 'table')) {
        e.font = latin;
        e.fontFarEast = farEast;
      }
    }
  }
}
const browsers = () => [
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
];
export function findBrowser() {
  return browsers().find(file => existsSync(file));
}

/** Colours the deck's theme defines become their names, so a later theme change
 * recolours them. */
function tokenize<T extends { background?: string; elements: Record<string, unknown>[] }>(page: T, theme: Theme): T {
  const byHex = new Map<string, string>();
  for (const [name, hex] of Object.entries(themeTokens(theme)))
    if (!byHex.has(hex.toUpperCase())) byHex.set(hex.toUpperCase(), name);
  const name = (v: unknown) => (typeof v === 'string' && byHex.get(v.toUpperCase())) || v;
  const parts = (e: Record<string, unknown>) => {
    for (const key of ['color', 'fill', 'line']) if (key in e) e[key] = name(e[key]);
    if (Array.isArray(e.runs))
      for (const run of e.runs as Record<string, unknown>[]) if (run.color) run.color = name(run.color);
    if (Array.isArray(e.bd)) for (const side of e.bd as ({ c: unknown } | null)[]) if (side) side.c = name(side.c);
  };
  for (const e of page.elements) {
    parts(e);
    if (Array.isArray(e.cells)) for (const row of e.cells as Record<string, unknown>[][]) row.forEach(parts);
  }
  if (page.background) page.background = name(page.background) as string;
  return page;
}

/** Draws each page in a headless Edge (no window; the user's screen is untouched) and
 * reads the layout. DESIGNER_HTML_DEBUG=<folder> keeps each page and a screenshot. */
export const layoutHtmlSlides: HtmlLayout = async (pages, theme, options = {}) => {
  if (!pages.length) return [];
  const browser = findBrowser();
  if (!browser) throw new Error('HTML方式の変換に使うMicrosoft Edgeが見つかりません。');
  const profile = await mkdtemp(path.join(tmpdir(), 'de-html-'));
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
      '--mute-audio',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let ws: WebSocket | undefined;
  try {
    let port: number | undefined;
    for (let i = 0; i < 150 && !port; i++) {
      await new Promise(r => setTimeout(r, 100));
      try {
        port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]) || undefined;
      } catch {
        /* starting */
      }
    }
    if (!port) throw new Error('HTML方式の変換に使うMicrosoft Edgeを起動できませんでした。');
    let target: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        target = ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find(
          t => t.type === 'page',
        );
      } catch {
        /* starting */
      }
      if (!target) await new Promise(r => setTimeout(r, 100));
    }
    if (!target) throw new Error('HTML方式の変換に使うMicrosoft Edgeに接続できませんでした。');
    const socket = (ws = new WebSocket(target.webSocketDebuggerUrl));
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    let id = 0;
    const pending = new Map<number, (m: any) => void>();
    socket.addEventListener('message', event => {
      const m = JSON.parse(String(event.data));
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)!(m);
        pending.delete(m.id);
      }
    });
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((resolve, reject) => {
        const i = ++id;
        const timer = setTimeout(() => {
          pending.delete(i);
          reject(new Error(`${method} timed out`));
        }, 20_000);
        pending.set(i, m => {
          clearTimeout(timer);
          resolve(m);
        });
        socket.send(JSON.stringify({ id: i, method, params }));
      });
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 960, height: 540, deviceScaleFactor: 1, mobile: false });
    await send('Emulation.setScriptExecutionDisabled', { value: true });
    const debug = process.env.DESIGNER_HTML_DEBUG;
    if (debug) await mkdir(debug, { recursive: true });
    const results: HtmlPageLayout[] = [];
    for (const page of pages) {
      try {
        const doc = slidePage(page.html, theme);
        // Draws the page afresh (optionally with less spacing, smaller text, or checked against the fitting floor) and reads it.
        const read = async ({
          share,
          squeeze,
          grow = false,
          floor = !!share,
        }: { share?: number; squeeze?: number; grow?: boolean; floor?: boolean } = {}) => {
          await send('Page.navigate', {
            url: 'data:text/html;charset=utf-8;base64,' + Buffer.from(doc, 'utf8').toString('base64'),
          });
          for (let i = 0; i < 100; i++) {
            const state = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
            if (state.result?.result?.value === 'complete') break;
            await new Promise(r => setTimeout(r, 50));
          }
          await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true });
          await send('Runtime.evaluate', {
            expression: `window.__deOptions=${JSON.stringify({ minTextSize: floor && options.minTextSize ? fitFloor(options.minTextSize) : options.minTextSize })}`,
          });
          await send('Runtime.evaluate', { expression: ICON_SCRIPT });
          if (squeeze) await send('Runtime.evaluate', { expression: squeezeScript(squeeze) });
          if (share) await send('Runtime.evaluate', { expression: fitScript(share) });
          if (grow && options.minTextSize)
            await send('Runtime.evaluate', { expression: growScript(options.minTextSize) });
          const value = (await send('Runtime.evaluate', { expression: CONVERT_SCRIPT, returnByValue: true })).result
            ?.result?.value;
          return typeof value === 'string' ? JSON.parse(value) : { error: 'HTMLを読み取れませんでした。' };
        };
        let parsed = await read(),
          fitted: number | undefined,
          squeezed: number | undefined,
          grown = false,
          keptSmall = false;
        if (!parsed.error && parsed.fit) {
          for (const step of fitSteps) {
            const next = await read(step);
            if (!next.error && !next.problems.length) {
              parsed = next;
              ({ share: fitted, squeeze: squeezed } = step);
              break;
            }
          }
          // The page in the browser must be the one whose elements are kept (fonts are read from it).
          if (squeezed === undefined) parsed = await read();
        } else if (!parsed.error && parsed.grow) {
          const next = await read({ grow: true });
          if (!next.error && !next.problems.length) {
            parsed = next;
            grown = true;
          } else {
            parsed = await read({ floor: options.keepSmall });
            keptSmall = !!options.keepSmall && !parsed.error && !parsed.problems.length;
          }
        }
        // The fonts are read before the chart sketches are added, from the page as it was read.
        if (!parsed.error) await usedFonts(send, parsed.elements);
        if (options.screenshot && !parsed.error) await send('Runtime.evaluate', { expression: CHART_SKETCH_SCRIPT });
        const shot =
          debug || options.screenshot
            ? ((
                await send('Page.captureScreenshot', {
                  format: 'png',
                  clip: { x: 0, y: 0, width: 960, height: 540, scale: 1 },
                })
              ).result?.data as string | undefined)
            : undefined;
        if (debug) {
          const stamp = `${Date.now()}-${page.id}`;
          await writeFile(path.join(debug, `${stamp}.html`), doc, 'utf8');
          if (shot) await writeFile(path.join(debug, `${stamp}.png`), Buffer.from(shot, 'base64'));
        }
        results.push(
          parsed.error
            ? { error: parsed.error }
            : (tokenize(
                {
                  ...(parsed.background ? { background: parsed.background } : {}),
                  elements: parsed.elements,
                  problems: parsed.problems,
                  ...(fitted ? { fitted } : {}),
                  ...(squeezed ? { squeezed } : {}),
                  ...(grown ? { grown } : {}),
                  ...(keptSmall ? { keptSmall } : {}),
                  ...(options.screenshot && shot ? { shot } : {}),
                },
                theme,
              ) as HtmlPageLayout),
        );
      } catch {
        results.push({ error: 'HTMLを読み取れませんでした。<section class="slide">…</section>の形で書いてください。' });
      }
    }
    return results;
  } finally {
    try {
      ws?.close();
    } catch {
      /* closed */
    }
    child.kill();
    setTimeout(() => {
      rm(profile, { recursive: true, force: true }).catch(() => {
        /* Edge may still hold files */
      });
    }, 1500);
  }
};
