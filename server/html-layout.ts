import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {IconId,Theme} from '../shared/contracts.js';
import {themeTokens} from '../shared/free-design.js';
import {iconCatalog,iconSvg} from '../shared/icons.js';

/** One AI-written HTML page, read back as free-design elements. Problems are the
 * app's findings (text outside the slide, in the footer or clipped), sent with a retry. */
/** fitted: the share (0.85-0.95) the text was made smaller to keep it above the footer, without asking the AI.
 * grown: text below the smallest size was made that size (the page still fitted), without asking the AI.
 * shot: the drawn page as a 960x540 PNG (base64), when asked for. */
export type HtmlPageLayout={background?:string;elements:Record<string,unknown>[];problems:string[];fitted?:number;grown?:boolean;shot?:string}|{error:string};
/** minTextSize: body text, and text marked data-role="caption", drawn smaller than this (px = pt) is reported. */
export interface HtmlLayoutOptions {minTextSize?:{body:number;caption:number};screenshot?:boolean}
export type HtmlLayout=(pages:{id:string;html:string}[],theme:Theme,options?:HtmlLayoutOptions)=>Promise<HtmlPageLayout[]>;

/** Removes anything that could run code or load from outside. The page also has a
 * CSP that blocks scripts and network access, and script execution is disabled. */
export function sanitizeHtml(html:string){
  return html.replace(/<\s*(script|iframe|object|embed|form|textarea|select|video|audio|foreignObject|noscript|template|title|head)\b[\s\S]*?<\/\s*\1\s*>/gi,'')
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|img|image|video|audio|source|foreignObject|noscript|template|html|body|head|title)\b[^>]*>/gi,'')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/\s(href|src|xlink:href|srcset|action|formaction|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'')
    .replace(/url\s*\(([^)]*)\)/gi,'none')
    .replace(/@import[^;]*;?/gi,'')
    .replace(/expression\s*\(/gi,'(');
}

/** The page the AI's HTML is drawn in: its slide size, the deck's colours and fonts as
 * CSS variables (defaults the AI may override; the fonts the browser actually used are
 * read back so PowerPoint draws the same lines). Features the converter cannot carry are switched off,
 * so what the browser shows is what PowerPoint gets. */
export function slidePage(html:string,theme:Theme){
  const t=themeTokens(theme),font=(name:string|undefined)=>`"${(name??theme.font).replace(/"/g,'')}"`;
  const vars=`--bg:${t.bg};--ink:${t.ink};--muted:${t.muted};--accent:${t.accent};--accent2:${t.accent2};--surface:${t.surface};--rule:${t.rule};--negative:${t.negative};--on-accent:${t.onAccent};--heading-font:${font(theme.headingFont)};--body-font:${font(theme.font)};--number-font:${font(theme.numberFont)}`;
  // lang="ja" + auto-phrase: Japanese lines break between phrases (確かめる, 素数は) as in the app's JSON method.
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'">
<style>:root{${vars}}html,body{margin:0;padding:0;background:#FFFFFF}section.slide{background:var(--bg);color:var(--ink);word-break:auto-phrase;line-break:strict;font-family:var(--body-font)}section.slide :is(h1,[data-role="title"]){font-family:var(--heading-font)}section.slide [data-role="number"]{font-family:var(--number-font),var(--body-font)}</style></head><body>${sanitizeHtml(html)}
<style>section.slide{width:960px!important;height:540px!important;position:relative!important;overflow:hidden!important;box-sizing:border-box!important;margin:0!important}
section.slide,section.slide *{letter-spacing:normal!important;word-spacing:normal!important;text-shadow:none!important;box-shadow:none!important;transform:none!important;filter:none!important;writing-mode:horizontal-tb!important;list-style:none!important}
section.slide *::before,section.slide *::after{content:none!important}</style></body></html>`;
}

/** Runs inside the page (scripts of the page itself are disabled). Reads the browser's
 * layout of <section class="slide"> and returns free-design elements. */
export const CONVERT_SCRIPT=String.raw`(function(){
  const round=v=>Math.round(v*10)/10;
  const color=value=>{const m=/rgba?\(([^)]+)\)/.exec(value||'');if(!m)return {hex:null,a:0};const p=m[1].split(/[\s,/]+/).filter(Boolean).map(Number),a=p.length>3?p[3]:1;return {hex:'#'+p.slice(0,3).map(v=>Math.max(0,Math.min(255,Math.round(v))).toString(16).padStart(2,'0')).join('').toUpperCase(),a};};
  const firstGradientColor=image=>{const m=/rgba?\([^)]+\)/.exec(image||'');return m?color(m[0]):{hex:null,a:0};};
  const section=document.querySelector('section.slide');
  if(!section)return JSON.stringify({error:'<section class="slide">がありません。各ページのhtmlは<section class="slide">…</section>で書いてください。'});
  const base=section.getBoundingClientRect(),out=[],problems=[],inks=[],figures=[],kinds=new Set(),options=window.__deOptions||{};let background;
  const ink=c=>{const middle=(c.r.top+c.r.bottom)/2;return {l:c.r.left,r:c.r.right,t:middle-c.size/2,b:middle+c.size/2};};
  const rect=r=>{const x=Math.max(0,r.left-base.left),y=Math.max(0,r.top-base.top);return {x:round(x),y:round(y),w:round(Math.max(1,Math.min(r.right-base.left,960)-x)),h:round(Math.max(1,Math.min(r.bottom-base.top,540)-y))};};
  const inside=r=>r.width>0.5&&r.height>0.5&&r.right>base.left&&r.bottom>base.top&&r.left<base.right&&r.top<base.bottom;
  const short=s=>s.replace(/\s+/g,'').slice(0,14);
  const roleOf=el=>{const m=el.closest('[data-role]');const v=m&&section.contains(m)?m.getAttribute('data-role'):null;if(['title','heading','number','caption','body'].includes(v))return v;return el.closest('h1')?'title':'body';};
  function radius(cs,w,h){const v=cs.borderTopLeftRadius;if(!v||v.startsWith('0'))return 0;const n=parseFloat(v);return v.includes('%')?n/100*Math.min(w,h):n;}
  function svgMarkup(svg,r){
    const clone=svg.cloneNode(true),source=[svg,...svg.querySelectorAll('*')],target=[clone,...clone.querySelectorAll('*')];
    source.forEach((el,i)=>{const cs=getComputedStyle(el),t=target[i];for(const p of ['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','stroke-linecap','stroke-linejoin','stroke-dasharray','font-size','font-weight'])t.setAttribute(p,cs.getPropertyValue(p));if(el.tagName==='text'||el.tagName==='tspan')t.setAttribute('font-family',cs.fontFamily);t.removeAttribute('class');t.removeAttribute('style');});
    clone.setAttribute('xmlns','http://www.w3.org/2000/svg');clone.setAttribute('width',String(round(r.width)));clone.setAttribute('height',String(round(r.height)));
    if(!clone.getAttribute('viewBox'))clone.setAttribute('viewBox','0 0 '+round(r.width)+' '+round(r.height));
    return new XMLSerializer().serializeToString(clone);
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
  /** One text element from characters that share a font size: browser lines, and the
   * colour/weight changes inside them as runs. */
  function emit(block,chars){
    if(!chars.length)return;
    const size=chars[0].size,lines=[];let current=null;
    for(const c of chars){if(!current||c.r.top>current.top+size*.5){current={top:c.r.top,chars:[]};lines.push(current);}current.chars.push(c);}
    for(const l of lines){while(l.chars.length&&/\s/.test(l.chars[0].ch))l.chars.shift();while(l.chars.length&&/\s/.test(l.chars[l.chars.length-1].ch))l.chars.pop();}
    const visible=lines.filter(l=>l.chars.length);if(!visible.length)return;
    for(const l of visible){l.top=Math.min(...l.chars.map(c=>c.r.top));l.bottom=Math.max(...l.chars.map(c=>c.r.bottom));l.left=Math.min(...l.chars.map(c=>c.r.left));l.right=Math.max(...l.chars.map(c=>c.r.right));}
    const key=c=>{const k=color(c.cs.color).hex+'|'+((parseInt(c.cs.fontWeight,10)||400)>=600?1:0)+'|'+(c.cs.fontStyle==='italic'?1:0);return k;};
    // keys[i] is the style of text[i] (UTF-16 positions, as PowerPoint counts characters).
    let text='';const keys=[];
    visible.forEach((l,li)=>{if(li){text+='\n';keys.push(keys[keys.length-1]);}for(const c of l.chars){const ch=/\s/.test(c.ch)?' ':c.ch;text+=ch;for(let u=0;u<ch.length;u++)keys.push(key(c));}});
    const counts={};for(const k of keys)counts[k]=(counts[k]||0)+1;
    const mainKey=Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0],main=mainKey.split('|');
    const runs=[];let at=0;
    while(at<text.length){const k=keys[at];let end=at;while(end<text.length&&keys[end]===k)end++;if(k!==mainKey){const p=k.split('|'),run={s:at,l:end-at};if(p[0]!==main[0])run.color=p[0];if(p[1]!==main[1])run.bold=p[1]==='1';if(p[2]!==main[2])run.italic=p[2]==='1';runs.push(run);}at=end;}
    const cs=getComputedStyle(block),align=cs.textAlign==='center'?'c':cs.textAlign==='right'||cs.textAlign==='end'?'r':'l';
    const measured=visible.length>1?(visible[visible.length-1].top-visible[0].top)/(visible.length-1):0,pitch=measured>size*1.3?measured:0;
    const content=block.getBoundingClientRect(),padL=parseFloat(cs.paddingLeft)||0,padR=parseFloat(cs.paddingRight)||0;
    let left=Math.min(...visible.map(l=>l.left)),right=Math.max(...visible.map(l=>l.right));
    const glyphs=visible.flatMap(l=>l.chars.filter(c=>!/\s/.test(c.ch)).map(ink));
    check(block,Math.min(...glyphs.map(g=>g.t)),Math.max(...glyphs.map(g=>g.b)),left,right,short(text));
    const min=options.minTextSize&&(roleOf(block)==='caption'?options.minTextSize.caption:options.minTextSize.body);
    if(min&&size<min-0.25){kinds.add('small');problems.push('文字が小さすぎます（「'+short(text)+'」、'+round(size)+'px）。この資料では、本文を'+options.minTextSize.body+'px以上、注記（data-role="caption"）を'+options.minTextSize.caption+'px以上にしてください。');}
    inks.push({size,sample:short(text),glyphs,l:Math.min(...glyphs.map(g=>g.l)),r:Math.max(...glyphs.map(g=>g.r)),t:Math.min(...glyphs.map(g=>g.t)),b:Math.max(...glyphs.map(g=>g.b))});
    if(align!=='l'){left=Math.min(left,content.left+padL);right=Math.max(right,content.right-padR);}
    const top=visible[0].top-(pitch?(pitch-(visible[0].bottom-visible[0].top))/2:0),bottom=pitch?top+pitch*visible.length:Math.max(visible[visible.length-1].bottom,visible[0].top+(measured||size*1.25)*visible.length);
    const slack=(right-left)*.06+2,x=align==='r'?left-slack:align==='c'?left-slack/2:left;
    const box=rect({left:Math.max(base.left,x),top,right:Math.max(base.left,x)+right-left+slack,bottom:bottom+2});
    block.setAttribute('data-de-text',((block.getAttribute('data-de-text')||'')+' '+out.length).trim());
    out.push({t:'text',...box,text,size:round(size),color:main[0]==='null'?'#000000':main[0],bold:main[1]==='1',...(main[2]==='1'?{italic:true}:{}),align,...(pitch?{lh:round(pitch)}:{}),exact:true,role:roleOf(block),...(runs.length&&runs.length<=40?{runs}:{})});
  }
  function textNodes(el){const list=[],walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);let n;while((n=walker.nextNode()))if(n.textContent.trim())list.push(n);return list;}
  /** Only inline children (span, strong, br…): the whole element is one text. */
  function inlineOnly(el){for(const c of el.children){if(c instanceof SVGElement||c.dataset.chart!==undefined)return false;const d=getComputedStyle(c).display;if(d==='none')continue;if(d!=='inline'&&d!=='contents')return false;if(!inlineOnly(c))return false;}return true;}
  function shapes(el,cs,r,alpha){
    let bg=color(cs.backgroundColor);if(!bg.a&&cs.backgroundImage&&cs.backgroundImage!=='none')bg=firstGradientColor(cs.backgroundImage);
    const sides=['Top','Right','Bottom','Left'].map(s=>({w:parseFloat(cs['border'+s+'Width'])||0,c:color(cs['border'+s+'Color']),style:cs['border'+s+'Style']})).map(s=>s.style==='none'||!s.c.a?{...s,w:0}:s);
    const uniform=sides.every(s=>s.w>0&&s.w===sides[0].w&&s.c.hex===sides[0].c.hex),box=rect(r),rad=radius(cs,r.width,r.height);
    if(bg.a>0.01||uniform){
      const shape=rad>=Math.min(r.width,r.height)/2-0.5?(Math.abs(r.width-r.height)<1?'ellipse':'roundRect'):rad>0?'roundRect':'rect';
      out.push({t:'box',...box,shape,fill:bg.a>0.01?bg.hex:'none',...(bg.a*alpha<0.99&&bg.a>0.01?{op:round(bg.a*alpha*100)/100}:{}),...(shape==='roundRect'?{r:Math.min(.5,Math.round(rad/Math.min(r.width,r.height)*1000)/1000)}:{}),...(uniform?{line:sides[0].c.hex,lw:sides[0].w}:{})});
    }
    if(!uniform)sides.forEach((s,i)=>{if(!s.w)return;const x=box.x,y=box.y,w=box.w,h=box.h;const bar=i===0?{x,y,w,h:s.w}:i===1?{x:x+w-s.w,y,w:s.w,h}:i===2?{x,y:y+h-s.w,w,h:s.w}:{x,y,w:s.w,h};out.push({t:'box',...bar,shape:'rect',fill:s.c.hex,...(s.c.a*alpha<0.99?{op:round(s.c.a*alpha*100)/100}:{})});});
  }
  function visit(el,opacity){
    const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')return;
    const alpha=opacity*parseFloat(cs.opacity||'1');if(alpha<0.02)return;
    const r=el.getBoundingClientRect();
    // An app icon (data-icon, drawn by the app before reading): one editable icon, in the colour of its text.
    if(el.getAttribute('data-de-icon')==='1'){
      if(!inside(r))return;
      shapes(el,cs,r,alpha);
      const size=Math.min(r.width,r.height),left=r.left+(r.width-size)/2,top=r.top+(r.height-size)/2,box=rect({left,top,right:left+size,bottom:top+size});
      out.push({t:'icon',icon:el.getAttribute('data-icon'),x:box.x,y:box.y,size:round(size),color:color(cs.color).hex});
      return;
    }
    if(el instanceof SVGSVGElement){
      if(!inside(r))return;
      out.push({t:'svg',...rect(r),svg:svgMarkup(el,r)});
      // A large figure of lines and frames only (axes, a grid) is a candidate for an empty figure.
      if(r.width>=150&&r.height>=150&&r.width*r.height>=0.12*960*540&&!el.querySelector('circle,ellipse,path,polygon,text,image,use,foreignObject'))figures.push({box:rect(r),index:out.length-1});
      return;
    }
    if(el.dataset&&el.dataset.chart!==undefined){try{out.push({t:'chart',...rect(r),chart:JSON.parse(el.dataset.chart)});}catch(e){problems.push('グラフのdata-chartをJSONとして読めません。');}return;}
    if(el===section){const bg=color(cs.backgroundColor);if(bg.a>0.5)background=bg.hex;}
    else if(inside(r))shapes(el,cs,r,alpha);
    if(el!==section&&inlineOnly(el)){
      // Backgrounds of inline parts (a highlighted word) go under the text.
      for(const c of el.querySelectorAll('*')){const ccs=getComputedStyle(c),bg=color(ccs.backgroundColor);if(bg.a>0.01)for(const part of c.getClientRects())if(inside(part))out.push({t:'box',...rect(part),shape:'rect',fill:bg.hex,...(bg.a<0.99?{op:round(bg.a*100)/100}:{})});}
      const chars=characters(textNodes(el));
      if(chars.length&&chars.every(c=>Math.abs(c.size-chars[0].size)<0.5))emit(el,chars);
      else for(const node of textNodes(el))emit(node.parentElement,characters([node]));
      return;
    }
    for(const child of el.childNodes){
      if(child.nodeType===Node.TEXT_NODE){if(child.textContent.trim())emit(el,characters([child]));}
      else if(child.nodeType===Node.ELEMENT_NODE)visit(child,alpha);
    }
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
  // Lines drawn under cards and labels (connectors) carry the page; a frame with at most three labels
  // in it and nothing drawn inside is an empty figure.
  for(const f of figures){
    const b=f.box,within=out.filter((e,i)=>i!==f.index&&(e.t==='text'||e.t==='box'||e.t==='chart'||e.t==='svg')&&e.x+e.w/2>=b.x&&e.x+e.w/2<=b.x+b.w&&e.y+e.h/2>=b.y&&e.y+e.h/2<=b.y+b.h).length;
    if(within<=3){kinds.add('empty');problems.push('図に中身がありません（線と枠だけの図です）。説明用の目安でも、点・棒・図形・文字など、図が伝える内容を図の中に描いてください。');}
  }
  return JSON.stringify({background,elements:out,problems:[...new Set(problems)],fit:problems.length>0&&[...kinds].every(k=>k==='bottom'||k==='overlap'),grow:problems.length>0&&[...kinds].every(k=>k==='small')});
})()`;

/** Makes every text of the page smaller by the given share (line heights given in px too). Boxes,
 * gaps and figures keep their size, so the composition stays; only the text takes less room. */
const fitScript=(share:number)=>`(function(){const s=document.querySelector('section.slide');if(!s)return 0;
const list=[s,...s.querySelectorAll('*')].filter(e=>!(e instanceof SVGElement)),sizes=list.map(e=>{const cs=getComputedStyle(e);return [parseFloat(cs.fontSize),cs.lineHeight];});
list.forEach((e,i)=>{const [size,lh]=sizes[i];e.style.setProperty('font-size',(size*${share})+'px','important');if(lh.endsWith('px'))e.style.setProperty('line-height',(parseFloat(lh)*${share})+'px','important');});return list.length;})()`;
/** Makes text drawn below the smallest size of the mode (body, or a caption) that size, so a page whose only
 * problem is small text can be kept without asking the AI again when it still fits. */
const growScript=(min:{body:number;caption:number})=>`(function(){const s=document.querySelector('section.slide');if(!s)return 0;let n=0;
for(const e of [s,...s.querySelectorAll('*')]){if(e instanceof SVGElement||![...e.childNodes].some(c=>c.nodeType===3&&c.textContent.trim()))continue;
const cs=getComputedStyle(e),size=parseFloat(cs.fontSize),m=e.closest('[data-role]'),min=m&&m.getAttribute('data-role')==='caption'?${min.caption}:${min.body};
if(size>=min-0.25)continue;e.style.setProperty('font-size',min+'px','important');if(cs.lineHeight.endsWith('px'))e.style.setProperty('line-height',(parseFloat(cs.lineHeight)*min/size)+'px','important');n++;}return n;})()`;
/** The app's icons (data-icon) drawn into the page before it is read, so the layout and the picture show
 * them; an unknown id is left empty. Each becomes one editable icon when read. */
const ICON_SCRIPT=`(function(){const map=${JSON.stringify(Object.fromEntries(Object.keys(iconCatalog).map(id=>[id,iconSvg(id as IconId)])))},s=document.querySelector('section.slide');if(!s)return 0;let n=0;
for(const e of s.querySelectorAll('[data-icon]')){const svg=map[e.getAttribute('data-icon')];if(!svg)continue;
const cs=getComputedStyle(e);if(cs.display==='inline')e.style.setProperty('display','inline-block','important');
const r=e.getBoundingClientRect();if(r.width<4||r.height<4){const size=Math.max(16,parseFloat(cs.fontSize)*1.5)+'px';e.style.setProperty('width',size,'important');e.style.setProperty('height',size,'important');}
e.innerHTML=svg;const g=e.firstElementChild;g.setAttribute('width','100%');g.setAttribute('height','100%');g.style.display='block';e.setAttribute('data-de-icon','1');n++;}return n;})()`;
/** For the picture only (after the page was read): each chart place gets a plain sketch of its data,
 * since the real chart is drawn later by PowerPoint and the place would otherwise look empty. */
const CHART_SKETCH_SCRIPT=String.raw`(function(){
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
  return true;
})()`;
/** Text that only runs a little past the bottom, or into another text below it, is made smaller in these steps
 * before the AI is asked again. Made smaller this way, body text may go 2px (a caption 1px) below the smallest
 * size of the mode: a page a little too full is kept instead of stopping the deck. */
const FIT_STEPS=[0.95,0.9,0.85];
const fitFloor=(min:{body:number;caption:number})=>({body:min.body-2,caption:min.caption-1});

const japanese=/Gothic|Mincho|Meiryo|游|ゴシック|明朝|メイリオ|BIZ|UD |Kyokasho|教科書|Noto (Sans|Serif) (JP|CJK)|Hiragino|Yu |MS P?(Gothic|Mincho)|Source Han|源ノ/i;
/** The fonts the browser actually drew each text with (an installed fallback when the
 * AI named a font this PC lacks): Japanese and Latin, as PowerPoint sets them. */
async function usedFonts(send:(method:string,params?:Record<string,unknown>)=>Promise<any>,elements:Record<string,unknown>[]){
  await send('DOM.enable');await send('CSS.enable');
  const root=(await send('DOM.getDocument',{depth:0})).result?.root?.nodeId;if(!root)return;
  const nodes:number[]=(await send('DOM.querySelectorAll',{nodeId:root,selector:'[data-de-text]'})).result?.nodeIds??[];
  for(const nodeId of nodes){
    const attributes:string[]=(await send('DOM.getAttributes',{nodeId})).result?.attributes??[];
    const indexes=(attributes[attributes.indexOf('data-de-text')+1]??'').split(' ').map(Number).filter(n=>Number.isInteger(n));
    let fonts:{familyName:string;glyphCount:number}[]=(await send('CSS.getPlatformFontsForNode',{nodeId})).result?.fonts??[];
    if(!fonts.length)for(const child of ((await send('DOM.querySelectorAll',{nodeId,selector:'*'})).result?.nodeIds??[]).slice(0,6)){fonts=(await send('CSS.getPlatformFontsForNode',{nodeId:child})).result?.fonts??[];if(fonts.length)break;}
    if(!fonts.length)continue;
    const sorted=[...fonts].sort((a,b)=>b.glyphCount-a.glyphCount),farEast=sorted.find(f=>japanese.test(f.familyName))?.familyName??sorted[0].familyName,latin=sorted.find(f=>!japanese.test(f.familyName))?.familyName??farEast;
    for(const i of indexes){const e=elements[i];if(e&&e.t==='text'){e.font=latin;e.fontFarEast=farEast;}}
  }
}
const browsers=()=>[
  path.join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles??'C:/Program Files','Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.LOCALAPPDATA??'','Microsoft/Edge/Application/msedge.exe'),
  path.join(process.env.ProgramFiles??'C:/Program Files','Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)']??'C:/Program Files (x86)','Google/Chrome/Application/chrome.exe'),
];
export function findBrowser(){return browsers().find(file=>existsSync(file));}

/** Colours the deck's theme defines become their names, so a later theme change
 * recolours them. */
function tokenize<T extends {background?:string;elements:Record<string,unknown>[]}>(page:T,theme:Theme):T{
  const byHex=new Map<string,string>();for(const [name,hex] of Object.entries(themeTokens(theme)))if(!byHex.has(hex.toUpperCase()))byHex.set(hex.toUpperCase(),name);
  const name=(v:unknown)=>typeof v==='string'&&byHex.get(v.toUpperCase())||v;
  for(const e of page.elements){for(const key of ['color','fill','line'])if(key in e)e[key]=name(e[key]);if(Array.isArray(e.runs))for(const run of e.runs as Record<string,unknown>[])if(run.color)run.color=name(run.color);}
  if(page.background)page.background=name(page.background) as string;
  return page;
}

/** Draws each page in a headless Edge (no window; the user's screen is untouched) and
 * reads the layout. DESIGNER_HTML_DEBUG=<folder> keeps each page and a screenshot. */
export const layoutHtmlSlides:HtmlLayout=async(pages,theme,options={})=>{
  if(!pages.length)return [];
  const browser=findBrowser();
  if(!browser)throw new Error('HTML方式の変換に使うMicrosoft Edgeが見つかりません。');
  const profile=await mkdtemp(path.join(tmpdir(),'de-html-'));
  const child=spawn(browser,['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--disable-sync','--disable-component-update','--mute-audio','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore',windowsHide:true});
  let ws:WebSocket|undefined;
  try{
    let port:number|undefined;
    for(let i=0;i<150&&!port;i++){await new Promise(r=>setTimeout(r,100));try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0])||undefined;}catch{/* starting */}}
    if(!port)throw new Error('HTML方式の変換に使うMicrosoft Edgeを起動できませんでした。');
    let target:{type:string;webSocketDebuggerUrl:string}|undefined;
    for(let i=0;i<50&&!target;i++){try{target=((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[]).find(t=>t.type==='page');}catch{/* starting */}if(!target)await new Promise(r=>setTimeout(r,100));}
    if(!target)throw new Error('HTML方式の変換に使うMicrosoft Edgeに接続できませんでした。');
    const socket=ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve);socket.addEventListener('error',reject);});
    let id=0;const pending=new Map<number,(m:any)=>void>();
    socket.addEventListener('message',event=>{const m=JSON.parse(String(event.data));if(m.id&&pending.has(m.id)){pending.get(m.id)!(m);pending.delete(m.id);}});
    const send=(method:string,params:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const i=++id;const timer=setTimeout(()=>{pending.delete(i);reject(new Error(`${method} timed out`));},20_000);pending.set(i,m=>{clearTimeout(timer);resolve(m);});socket.send(JSON.stringify({id:i,method,params}));});
    await send('Page.enable');await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride',{width:960,height:540,deviceScaleFactor:1,mobile:false});
    await send('Emulation.setScriptExecutionDisabled',{value:true});
    const debug=process.env.DESIGNER_HTML_DEBUG;if(debug)await mkdir(debug,{recursive:true});
    const results:HtmlPageLayout[]=[];
    for(const page of pages){
      try{
        const doc=slidePage(page.html,theme);
        // Draws the page afresh (optionally with smaller text) and reads it.
        const read=async(share?:number,grow=false)=>{
          await send('Page.navigate',{url:'data:text/html;charset=utf-8;base64,'+Buffer.from(doc,'utf8').toString('base64')});
          for(let i=0;i<100;i++){const state=await send('Runtime.evaluate',{expression:'document.readyState',returnByValue:true});if(state.result?.result?.value==='complete')break;await new Promise(r=>setTimeout(r,50));}
          await send('Runtime.evaluate',{expression:'document.fonts.ready.then(()=>true)',awaitPromise:true});
          await send('Runtime.evaluate',{expression:`window.__deOptions=${JSON.stringify({minTextSize:share&&options.minTextSize?fitFloor(options.minTextSize):options.minTextSize})}`});
          await send('Runtime.evaluate',{expression:ICON_SCRIPT});
          if(share)await send('Runtime.evaluate',{expression:fitScript(share)});
          if(grow&&options.minTextSize)await send('Runtime.evaluate',{expression:growScript(options.minTextSize)});
          const value=(await send('Runtime.evaluate',{expression:CONVERT_SCRIPT,returnByValue:true})).result?.result?.value;
          return typeof value==='string'?JSON.parse(value):{error:'HTMLを読み取れませんでした。'};
        };
        let parsed=await read(),fitted:number|undefined,grown=false;
        if(!parsed.error&&parsed.fit){
          for(const share of FIT_STEPS){const next=await read(share);if(!next.error&&!next.problems.length){parsed=next;fitted=share;break;}}
          // The page in the browser must be the one whose elements are kept (fonts are read from it).
          if(fitted===undefined)parsed=await read();
        }else if(!parsed.error&&parsed.grow){
          const next=await read(undefined,true);
          if(!next.error&&!next.problems.length){parsed=next;grown=true;}else parsed=await read();
        }
        // The fonts are read before the chart sketches are added, from the page as it was read.
        if(!parsed.error)await usedFonts(send,parsed.elements);
        if(options.screenshot&&!parsed.error)await send('Runtime.evaluate',{expression:CHART_SKETCH_SCRIPT});
        const shot=debug||options.screenshot?(await send('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width:960,height:540,scale:1}})).result?.data as string|undefined:undefined;
        if(debug){const stamp=`${Date.now()}-${page.id}`;await writeFile(path.join(debug,`${stamp}.html`),doc,'utf8');if(shot)await writeFile(path.join(debug,`${stamp}.png`),Buffer.from(shot,'base64'));}
        results.push(parsed.error?{error:parsed.error}:tokenize({...(parsed.background?{background:parsed.background}:{}),elements:parsed.elements,problems:parsed.problems,...(fitted?{fitted}:{}),...(grown?{grown}:{}),...(options.screenshot&&shot?{shot}:{})},theme) as HtmlPageLayout);
      }catch{results.push({error:'HTMLを読み取れませんでした。<section class="slide">…</section>の形で書いてください。'});}
    }
    return results;
  }finally{
    try{ws?.close();}catch{/* closed */}
    child.kill();
    setTimeout(()=>{rm(profile,{recursive:true,force:true}).catch(()=>{/* Edge may still hold files */});},1500);
  }
};
