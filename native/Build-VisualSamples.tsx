/** Reviewable offline examples. All icons and graphs stay editable in PowerPoint. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {compileDeck,registerLayout} from '../shared/layouts';
import {iconCatalog} from '../shared/icons';
import {chartCatalog,isShareChart,isStackedChart} from '../shared/charts';
import type {DeckSpec,ChartType,IconId,SlideSpec} from '../shared/contracts';
import {createRenderBridge} from '../server/render-bridge';

const root=fileURLToPath(new URL('..',import.meta.url)),qa=path.join(root,'runtime','qa-v07'),out=path.join(root,'samples','generated'),bridge=createRenderBridge(root);
const rendererHash=createHash('sha256').update(await fs.readFile(path.join(root,'native','bin','DesignerExtension.Renderer.exe'))).digest('hex');
await fs.mkdir(qa,{recursive:true});await fs.mkdir(out,{recursive:true});
registerLayout({id:'qa_icon_gallery',name:'アイコンの一覧',description:'検証用',maxItems:12,autoSelect:false,render(c){c.slide.items.forEach((item,i)=>{const x=67+i%6*145,y=161+Math.floor(i/6)*159;c.icon(item,{x:x+34,y,w:56,h:56},c.itemColor(i));c.text(item.label,{x,y:y+70,w:127,h:73},16,c.theme.foreground,false,'center');});}});
const base=(id:string,title:string,layoutId:string):SlideSpec=>({id,title,layoutId,items:[],notes:'表示例の数値は架空です。入力資料の分析結果ではありません。',sources:[]});
const charts=(Object.keys(chartCatalog) as ChartType[]).map((type,i)=>({...base(`slide-${i+2}`,chartCatalog[type].name,'chart_spacious'),chart:{type,categories:isShareChart(type)?['学習','運動','休息']:type==='line'?['4月','5月','6月']:['対象A','対象B','対象C'],series:isShareChart(type)?[{name:'全体の内訳',values:[45,30,25]}]:isStackedChart(type)?[{name:'内訳A',values:[24,36,42]},{name:'内訳B',values:[12,18,24]}]:[{name:'参考値',values:[24,36,48]}],unit:isShareChart(type)?'時間':'件',caption:'説明用の架空データ。各項目の単位と条件は同じ。'}}));
const reading={...base('slide-9','数値と読み取りを一緒に見せる','chart_icon_notes'),chart:{type:'bar' as const,categories:['学習','運動','休息'],series:[{name:'参考値',values:[45,30,25]}],unit:'時間',caption:'説明用の例：同じ期間の時間配分'},items:[{label:'学習',description:'数値を比較して見る。',icon:'book' as IconId},{label:'運動',description:'違いを棒の長さで読む。',icon:'heart' as IconId},{label:'休息',description:'全体との関係を確かめる。',icon:'clock' as IconId}]};
const icons=Object.entries(iconCatalog) as [IconId,string][];
const pages=Array.from({length:4},(_,i)=>({...base(`slide-${10+i}`,`用途で選べるアイコン ${i*12+1}〜${(i+1)*12}`,'qa_icon_gallery'),items:icons.slice(i*12,i*12+12).map(([icon,label])=>({label,icon}))}));
const deck:DeckSpec={id:'visuals-v07',title:'アイコンとグラフの拡張',themeId:'business',mode:'presentation',slides:[{...base('slide-1','図で伝える選択肢を増やす','cover'),headline:'48種類のアイコンと7種類のグラフ'},...charts,reading,...pages]};
type Result={id:string;fingerprint:string;artifact:string;file:string;slides:number;warnings:string[]};
const report=path.join(qa,'results.json'),results:Result[]=await fs.readFile(report,'utf8').then(JSON.parse,()=>[]);
const edgeCharts:DeckSpec={...deck,id:'edge-charts',title:'グラフの境界値確認',slides:[
  ...(['bar','column','line'] as ChartType[]).map((type,i)=>({...base(`edge-${i}`,`${chartCatalog[type].name}：負・ゼロ・小数`,'chart_spacious'),chart:{type,categories:['検証A','=データ','検証C'],series:[{name:'実績',values:[-2.5,0,17.75]},{name:'比較',values:[12.5,27.6,34.75]}],unit:'件'}})),
  ...(['pie','doughnut'] as ChartType[]).map((type,i)=>({...base(`edge-share-${i}`,`${chartCatalog[type].name}：8項目`,'chart_spacious'),chart:{type,categories:['学習','運動','休息','移動','読書','食事','家事','その他'],series:[{name:'内訳',values:[24,18,12,9,8,7,6,4]}],unit:'時間'}})),
  {...base('edge-one','ドーナツ：1項目とゼロの項目','chart_spacious'),chart:{type:'doughnut',categories:['使用','未使用'],series:[{name:'内訳',values:[100,0]}],unit:'件'}}
]};
for(const [id,spec] of [['business',deck],['midnight',{...deck,themeId:'midnight',mode:'reading'}],['edge-charts',edgeCharts]] as [string,DeckSpec][]){
  const scene=compileDeck(spec),fingerprint=createHash('sha256').update(JSON.stringify(scene)+rendererHash).digest('hex');assert.deepEqual(scene.slides.flatMap(s=>s.textIssues??[]),[],id);
  const prior=results.find(r=>r.id===id&&r.fingerprint===fingerprint);if(prior){console.log(JSON.stringify({reused:prior}));continue;}
  const rendered=await bridge.render(spec,id);assert.equal(rendered.native,true);assert.deepEqual(rendered.warnings,[],id);
  const file=`Designer-Extention-v07-${id}-${fingerprint.slice(0,7)}.pptx`;
  await fs.copyFile(path.join(bridge.artifactRoot,rendered.artifactId,'presentation.pptx'),path.join(out,file),fs.constants.COPYFILE_EXCL);
  results.push({id,fingerprint,artifact:rendered.artifactId,file,slides:spec.slides.length,warnings:rendered.warnings});await fs.writeFile(report,JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));
}
const latest=(id:string)=>results.filter(r=>r.id===id).at(-1)!;
await fs.writeFile(path.join(root,'docs','icons-charts.html'),`<!doctype html><html lang="ja"><meta charset="utf-8"><title>アイコンとグラフの拡張</title><style>body{font:16px 'Yu Gothic',sans-serif;margin:32px;color:#172D4A;background:#f4f5f5}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{background:white;padding:16px}img{width:100%;display:block}p{line-height:1.8}@media(max-width:800px){main{grid-template-columns:1fr}}</style><h1>48種類のアイコンと7種類のグラフ</h1><p>数値は説明用の架空データです。アイコンは通常の図形、グラフはデータを編集できるPowerPointのグラフです。</p><p><a href="../samples/generated/${latest('business').file}">明るいテーマの見本</a> / <a href="../samples/generated/${latest('midnight').file}">暗いテーマの見本</a></p><main>${deck.slides.slice(1).map((s,i)=>`<article><h2>${s.title}</h2><img src="../runtime/artifacts/${latest('business').artifact}/slide-${i+2}.png" alt="${s.title}"></article>`).join('')}</main></html>`);
