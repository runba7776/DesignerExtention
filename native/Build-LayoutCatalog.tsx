/** Generated directly from the same grammar registry used by the app and model. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';
import {listLayouts,compileDeck} from '../shared/layouts';
import {sampleSlide,sampleDeck} from '../shared/layout-samples';
import {researchSources,groupNames} from '../shared/layout-guidance';
import {SlidePreview} from '../web/SlidePreview';
import {createRenderBridge} from '../server/render-bridge';

const root=fileURLToPath(new URL('..',import.meta.url));
const layouts=listLayouts(),out=path.join(root,'docs');await fs.mkdir(out,{recursive:true});
const problems=layouts.flatMap(l=>[1,l.maxItems].filter((n,i,a)=>a.indexOf(n)===i).flatMap(n=>{
  const scene=compileDeck(sampleDeck([sampleSlide(l.id,n)]));return scene.slides.flatMap(s=>(s.textIssues??[]).map(issue=>({layout:l.id,count:n,...issue})));
}));
console.log(JSON.stringify({layouts:layouts.length,textProblems:problems},null,2));
if(problems.length)process.exitCode=1;
const markdown=['# 構図カタログ',`\n${layouts.length}種類。2026年10月1日に公開テンプレートを調査し、一般的な配置パターンを独自の編集可能な図形で実装しました。外部のPPTXや画像素材は同梱していません。`,...layouts.map((l,i)=>`\n## ${i+1}. ${l.name}（${l.id}）\n\n- 分類: ${groupNames[l.group]}\n- 配置: ${l.placement}\n- 用途: ${l.whenToUse}\n- 避ける条件: ${l.avoidWhen}\n- 文字量: ${l.textBudget}\n- 項目上限: ${l.maxItems}\n${l.references?.map(key=>`- 調査参考: [${researchSources[key].title}](${researchSources[key].url})`).join('\n')??'- 調査参考: 既存の構図'}`)].join('\n');
await fs.writeFile(path.join(out,'layout-catalog.md'),markdown);
const html=renderToStaticMarkup(<html lang="ja"><head><meta charSet="utf-8"/><title>Designer Extention 構図カタログ</title><style>{`body{font:16px 'Yu Gothic',sans-serif;background:#f4f4ee;color:#203630;margin:35px}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{background:white;border:1px solid #ddd;padding:18px;break-inside:avoid}svg{width:100%;display:block;border:1px solid #ddd}h2{font-size:20px}p{font-size:14px;line-height:1.8}a{color:#087f78}@media(max-width:800px){main{grid-template-columns:1fr}}@media print{main{display:block}article{page-break-after:always}}`}</style></head><body><h1>{layouts.length}種類の構図カタログ</h1><p>図は配置の見本です。内容・文字量・最近使った構図に応じて候補を選び、必要なら要約します。</p><main>{layouts.map((l,i)=><article key={l.id}><h2>{i+1}. {l.name}</h2><SlidePreview document={compileDeck(sampleDeck([sampleSlide(l.id)]))} index={0}/><p><b>配置: </b>{l.placement}<br/><b>用途: </b>{l.whenToUse}<br/><b>文字量: </b>{l.textBudget}<br/><b>注意: </b>{l.avoidWhen}</p>{l.references?.map(key=><p key={key}><a href={researchSources[key].url}>{researchSources[key].title}</a></p>)}</article>)}</main></body></html>);
await fs.writeFile(path.join(out,'layout-catalog.html'),'<!doctype html>'+html);
if(process.argv.includes('--render')&&!problems.length){
  const bridge=createRenderBridge(root),body=layouts.filter(l=>l.id!=='cover');
  const first=Number(process.argv.find(arg=>arg.startsWith('--start='))?.split('=')[1]??0);
  const end=Number(process.argv.find(arg=>arg.startsWith('--end='))?.split('=')[1]??body.length);
  for(let start=first;start<Math.min(end,body.length);start+=29){
    const batch=body.slice(start,start+29),slides=[sampleSlide('cover'),...batch.map(l=>sampleSlide(l.id))].map((s,i)=>({...s,id:`slide-${i+1}`}));
    slides[0].title=`構図カタログ ${Math.floor(start/29)+1}`;
    const result=await bridge.render(sampleDeck(slides),`catalog-${start}`);
    const name=`Designer-Extention-v06-catalog-${Math.floor(start/29)+1}.pptx`,dest=path.join(root,'samples','generated',name);
    if(await fs.access(dest).then(()=>true,()=>false))throw new Error('Refusing to overwrite '+dest);
    await fs.copyFile(path.join(bridge.artifactRoot,result.artifactId,'presentation.pptx'),dest);
    console.log(JSON.stringify({file:dest,artifact:result.artifactId,layouts:batch.map(l=>l.id),warnings:result.warnings}));
  }
}
