/** Real PowerPoint previews of typography, color grouping and Microsoft-inspired layouts. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRenderBridge} from '../server/render-bridge';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {themes} from '../shared/themes';
import {typographyProfiles} from '../shared/typography';
import {listLayouts} from '../shared/layouts';

const root=fileURLToPath(new URL('..',import.meta.url)),bridge=createRenderBridge(root);
const out=path.join(root,'samples','generated'),qa=path.join(root,'runtime','qa-v05');
await fs.mkdir(out,{recursive:true});await fs.mkdir(qa,{recursive:true});
const reportFile=path.join(qa,'style-results.json');
const results:{theme:string;typography?:string;artifact:string;file:string;warnings:string[]}[]=await fs.readFile(reportFile,'utf8').then(JSON.parse,()=>[]);
const filter=process.argv.find(arg=>arg.startsWith('--only='))?.split('=')[1];
for(const [theme,t] of Object.entries(themes)){
  if(filter&&filter!==theme)continue;
  const existing=results.find(r=>r.theme===theme);if(existing){console.log(JSON.stringify({theme,reused:existing.artifact}));continue;}
  const ids=theme==='colorblock'?['cover',...listLayouts().filter(l=>l.id.startsWith('ms_')).map(l=>l.id),'central_thesis','comparison_spotlight','kpi','equation_bottom']:['cover','ms_banner_comparison','ms_color_rows','concept_full'];
  const slides=ids.map((id,i)=>({...sampleSlide(id),id:`slide-${i+1}`}));
  slides[0].title=`${t.name} / 書体と配色`;slides[0].headline=`${typographyProfiles[t.typographyId as keyof typeof typographyProfiles].name}・編集できる図形`;
  const deck=sampleDeck(slides,theme),render=await bridge.render(deck,`style-${theme}`);
  const filename=`Designer-Extention-v05-style-${theme}.pptx`,dest=path.join(out,filename);
  if(await fs.access(dest).then(()=>true,()=>false))throw new Error('Refusing to overwrite '+dest);
  await fs.copyFile(path.join(bridge.artifactRoot,render.artifactId,'presentation.pptx'),dest);
  results.push({theme,artifact:render.artifactId,file:filename,warnings:render.warnings});
  await fs.writeFile(reportFile,JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));
}
// The clear/Meiryo profile's native output is already covered by the warm theme.
// Every profile is the default of at least one theme, so no duplicate font rendering is needed.
const escape=(s:string)=>s.replace(/[&<>\"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]!));
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Designer Extention 書体と配色</title><style>body{font:16px 'Yu Gothic',sans-serif;margin:32px;background:#f4f5f3;color:#23342e}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}article{background:white;padding:20px}img{display:block;width:100%;margin:14px 0;border:1px solid #ddd}p{line-height:1.8}small{color:#58645c}a{color:#086d67}@media(max-width:800px){main{grid-template-columns:1fr}}</style><h1>12テーマ / 7種類の書体の組み合わせ</h1><p>PowerPointで描画した見本です。書体は見出し・本文・数値で役割を分け、項目は枠と配色で区切ります。</p><main>${results.map(r=>{const t=themes[r.theme],p=typographyProfiles[t.typographyId as keyof typeof typographyProfiles];return `<article><h2>${escape(t.name!)}</h2><p>${escape(t.description!)}</p><p><b>${escape(p.name)}</b><br>${escape(p.description)}<br><small>見出し：${escape(p.heading)} / 本文：${escape(p.body)} / 数字：${escape(p.number)}</small></p><img src="../runtime/artifacts/${r.artifact}/slide-2.png" alt="${escape(t.name!)}の比較の見本"><img src="../runtime/artifacts/${r.artifact}/slide-3.png" alt="${escape(t.name!)}の箇条書きの見本"><a href="../samples/generated/${r.file}">編集できる PowerPoint を開く</a></article>`;}).join('')}</main><p>公開見本の参考：<a href="https://powerpoint.cloud.microsoft/search/templates/">Microsoft PowerPoint テンプレート</a>。フォント・素材ファイルは同梱していません。</p></html>`;
await fs.writeFile(path.join(root,'docs','style-catalog.html'),html);
