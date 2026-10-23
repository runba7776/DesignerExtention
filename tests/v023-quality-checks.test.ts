import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Outline} from '../shared/contracts.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {emptyUsage,type CompletionRequest} from '../server/providers.js';
import {freeSystemPrompt} from '../server/free-prompts.js';
import {findBrowser,layoutHtmlSlides,type HtmlLayout,type HtmlLayoutOptions} from '../server/html-layout.js';
import {paletteTheme} from '../shared/ai-theme.js';

const theme=paletteTheme({name:'検査',background:'#FFFFFF',text:'#1F2937',muted:'#6B7280',accent:'#225588',accent2:'#AA5522'});
const title='<h1 style="position:absolute;left:56px;top:20px;margin:0;font-size:28px">題名</h1>';
const read=async(body:string,options?:HtmlLayoutOptions)=>{const [r]=await layoutHtmlSlides([{id:'slide-2',html:`<section class="slide">${title}${body}</section>`}],theme,options);if('error' in r)assert.fail(r.error);return r;};
const label=(x:number,y:number,text:string)=>`<p style="position:absolute;left:${x}px;top:${y}px;margin:0;font-size:16px">${text}</p>`;

test('a large figure of only lines and a frame is reported as empty; connectors under cards and a figure with marks are not',{skip:!findBrowser()},async()=>{
  const grid='<svg style="position:absolute;left:120px;top:100px" width="460" height="300"><rect width="460" height="300" fill="#EEF2EE"/><line x1="0" y1="150" x2="460" y2="150" stroke="#999"/><line x1="230" y1="0" x2="230" y2="300" stroke="#999"/><line x1="0" y1="0" x2="0" y2="300" stroke="#333"/><line x1="0" y1="300" x2="460" y2="300" stroke="#333"/></svg>';
  const empty=await read(grid+label(130,110,'解決済み')+label(130,370,'未解決')+label(480,370,'言いやすい'));
  assert.ok(empty.problems.some(p=>/図に中身がありません/.test(p)),JSON.stringify(empty.problems));
  const marked=await read(grid.replace('</svg>','<circle cx="300" cy="80" r="8" fill="#C8442B"/></svg>')+label(130,110,'解決済み'));
  assert.ok(!marked.problems.some(p=>/図に中身がありません/.test(p)),'a point is content');
  const cards=[0,1,2,3].map(i=>`<div style="position:absolute;left:${80+i*210}px;top:200px;width:170px;height:120px;background:#EEF2F7"><p style="margin:12px;font-size:16px">段階${i+1}</p></div>`).join('');
  const connectors=await read('<svg style="position:absolute;left:0;top:0" width="960" height="540"><line x1="250" y1="260" x2="290" y2="260" stroke="#999"/><line x1="460" y1="260" x2="500" y2="260" stroke="#999"/><line x1="670" y1="260" x2="710" y2="260" stroke="#999"/></svg>'+cards);
  assert.ok(!connectors.problems.some(p=>/図に中身がありません/.test(p)),JSON.stringify(connectors.problems));
});

test('text below the smallest size of the mode is made that size when the page still fits, else reported; captions have their own size',{skip:!findBrowser()},async()=>{
  const reading={body:12,caption:10};
  const small=label(56,120,'本文').replace('font-size:16px','font-size:10px');
  const grown=await read(small,{minTextSize:reading});
  assert.deepEqual(grown.problems,[]);assert.equal(grown.grown,true);
  assert.equal(grown.elements.find(e=>e.t==='text'&&e.text==='本文')!.size,12,'made the smallest body size, without the AI');
  const boxed='<div style="position:absolute;left:56px;top:120px;width:200px;height:28px;overflow:hidden"><p style="margin:0;font-size:10px;line-height:14px">一行目<br>二行目</p></div>';
  const kept=await read(boxed,{minTextSize:reading});
  assert.equal(kept.grown,undefined);
  assert.ok(kept.problems.some(p=>/文字が小さすぎます（「一行目二行目」、10px）。この資料では、本文を12px以上、注記（data-role="caption"）を10px以上/.test(p)),JSON.stringify(kept.problems));
  const caption=label(56,120,'注記').replace('font-size:16px','font-size:11px').replace('<p ','<p data-role="caption" ');
  assert.deepEqual((await read(caption,{minTextSize:reading})).problems,[],'a caption may be smaller than body text');
  assert.deepEqual((await read(small)).problems,[],'no minimum given, nothing reported');
});

test('text running a little past the bottom is made smaller in the browser instead of asking the AI again',{skip:!findBrowser()},async()=>{
  const lines=(top:number,count:number)=>`<p style="position:absolute;left:56px;top:${top}px;width:840px;margin:0;font-size:20px;line-height:27px">${Array.from({length:count},(_,i)=>`${i+1}行目の説明です`).join('<br>')}</p>`;
  const fitted=await read(lines(380,5));
  assert.deepEqual(fitted.problems,[]);assert.equal(fitted.fitted,.85);
  const body=fitted.elements.find(e=>e.t==='text'&&String(e.text).startsWith('1行目'))!;
  assert.equal(body.size,17);assert.equal(body.text,'1行目の説明です\n2行目の説明です\n3行目の説明です\n4行目の説明です\n5行目の説明です','the words are not changed');
  const far=await read(lines(380,9));
  assert.equal(far.fitted,undefined);assert.ok(far.problems.some(p=>/下端の出典欄|スライドの外/.test(p)),'too far: left to the AI');
  const crossed=await read(lines(380,5)+label(56,400,'重なる注記'));
  assert.equal(crossed.fitted,undefined);assert.ok(crossed.problems.some(p=>/重なっています/.test(p)),'overlapping text is not fitted');
});

test('text running into a note below is fitted the same way, and fitting may take body text 2px below the smallest size, not further',{skip:!findBrowser()},async()=>{
  const presentation={body:16,caption:12};
  const block=(size:number,line:number)=>`<p style="position:absolute;left:56px;top:300px;width:840px;margin:0;font-size:${size}px;line-height:${line}px">${Array.from({length:5},(_,i)=>`${i+1}行目の説明です`).join('<br>')}</p>`;
  const note='<p style="position:absolute;left:56px;top:412px;margin:0;font-size:18px">補足の注記</p>';
  const fitted=await read(block(20,27)+note,{minTextSize:presentation});
  assert.deepEqual(fitted.problems,[]);assert.ok(fitted.fitted&&fitted.fitted>=.85,String(fitted.fitted));
  const tight=await read(block(16,26)+note.replace('top:412px','top:400px').replace('18px','16px'),{minTextSize:presentation});
  assert.ok(tight.problems.some(p=>/重なっています/.test(p)),JSON.stringify(tight.problems));
  assert.equal(tight.fitted,undefined,'16px made 85% (13.6px) is below 14px: left to the AI');
});

test('the instructions give text size targets per mode, ask for figures with content, and make the three directions differ',()=>{
  const html=freeSystemPrompt('generate',{format:'html',outputMode:'presentation'}),reading=freeSystemPrompt('generate',{format:'html',outputMode:'reading'}),json=freeSystemPrompt('generate',{outputMode:'presentation'});
  assert.match(html,/本文16px以上・注記12px以上を目安にします。注記（補足、図の目盛りや小さなラベル）の要素にはdata-role="caption"を付けます。data-role="caption"のない文字が16px未満、注記が12px未満のときは、アプリが大きくするか、直すよう依頼します。/);
  assert.match(reading,/本文12px以上・注記10px以上を目安にします。.*注記が10px未満のときは、アプリが大きくするか、直すよう依頼します。読む資料でも、1ページの文章は見出しの付いた3つまでのまとまりにします/);
  assert.match(json,/本文16pt以上・注記12pt以上を目安にします。/);assert.doesNotMatch(json,/アプリが大きくするか/);
  for(const prompt of [html,reading,json])assert.match(prompt,/図は中身まで描きます。軸や枠だけの図にせず/);
  const plan=freeSystemPrompt('plan',{proposals:3});
  assert.match(plan,/題材の選び方・話の順序・見せ方の型のうち、少なくとも2つが異なる/);
  assert.match(plan,/differenceに書いたこと（たとえば結論を冒頭に置く）は、その案のoutlineで実際にそうします/);
});

test('the app passes the smallest size of the mode and tells the user when a page was fitted',async()=>{
  const outline:Outline={title:'検査',mode:'reading',assumptions:[],slides:[{id:'slide-1',title:'表紙',intent:'表紙',layoutId:'cover',keyPoints:[]},{id:'slide-2',title:'本文',intent:'本文',layoutId:'free',keyPoints:[]}]} as Outline;
  const dir=await mkdtemp(path.join(tmpdir(),'de-quality-'));
  try{
    const settings=await new SettingsStore(dir,'').load();
    await settings.update({provider:'subscription',subscriptionService:'claude',slideCount:2,mode:'reading',designMode:'html',outlineProposals:false});
    const seen:HtmlLayoutOptions[]=[];
    const layout:HtmlLayout=async(pages,_theme,options)=>{seen.push(options??{});return pages.map(p=>({elements:[{t:'text',x:56,y:30,w:600,h:44,text:p.id==='slide-1'?'表紙':'本文',size:30,color:'ink',exact:true,role:p.id==='slide-1'?'body':'title'}],problems:[],...(p.id==='slide-2'?{fitted:.9}:{})}));};
    const usage={...emptyUsage(),calls:1};
    const engine=new SessionEngine({settings,dataDir:dir,htmlLayout:layout,subscriptionBinding:()=>'account',render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{
      const req=JSON.parse(r.content).request;
      if(!req.targetSlides)return {text:JSON.stringify({kind:'outline',outline}),usage};
      return {text:JSON.stringify({mode:'reading',id:'d',title:'検査',slides:req.targetSlides.map((s:any)=>({id:s.id,title:s.title,layoutId:s.layoutId,notes:'',sources:[],html:`<section class="slide"><h1>${s.title}</h1></section>`}))}),usage};
    }})});
    const session=await engine.create({prompt:'2枚',mode:'reading',cloudConsent:true},[]);
    const ready=await engine.generate(session.id);
    assert.equal(ready.phase,'ready');assert.deepEqual(seen[0].minTextSize,{body:12,caption:10});
    assert.ok(ready.warnings.some(w=>/「本文」は文字が下端に少しはみ出したため、文字を90%に縮めて収めました（AIは呼び出していません）/.test(w)),JSON.stringify(ready.warnings));
  }finally{await rm(dir,{recursive:true,force:true});}
});
