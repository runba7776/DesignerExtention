/** Offline native QA and reviewable examples; never calls an AI provider. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {compileDeck,listLayouts,registerLayout} from '../shared/layouts';
import {sampleDeck,sampleSlide} from '../shared/layout-samples';
import {iconCatalog} from '../shared/icons';
import {createRenderBridge} from '../server/render-bridge';
import type {DeckSpec,IconId,SlideSpec,SourceRef} from '../shared/contracts';

const root=fileURLToPath(new URL('..',import.meta.url)),bridge=createRenderBridge(root),qa=path.join(root,'runtime','qa-v06'),out=path.join(root,'samples','generated');
await fs.mkdir(qa,{recursive:true});await fs.mkdir(out,{recursive:true});
const original=JSON.parse(await fs.readFile(path.join(bridge.artifactRoot,'76c0a23e-1f77-46ff-a3ce-719fa743fdd5','scene.json'),'utf8'));
const designIds=listLayouts().filter(l=>l.id.startsWith('design_')).map(l=>l.id);
registerLayout({id:'qa_icons',name:'意味を表す12種類のアイコン',description:'ネイティブ描画の検証用',maxItems:12,autoSelect:false,render(c){
  (Object.entries(iconCatalog) as [IconId,string][]).slice(0,12).forEach(([icon,label],i)=>{const x=68+i%6*145,y=172+Math.floor(i/6)*153;c.icon({label,icon},{x:x+34,y,w:62,h:62});c.text(label,{x,y:y+82,w:128,h:65},17,c.theme.foreground,false,'center');});
}});
const catalog=sampleDeck([sampleSlide('cover'),...designIds.map(id=>sampleSlide(id)),sampleSlide('qa_icons')]);
catalog.slides=catalog.slides.map((s,i)=>({...s,id:`slide-${i+1}`,items:s.items.map((item,n)=>({...item,icon:(['document','chart','people','globe'] as IconId[])[n%4]}))}));
catalog.slides[0].title='主張・数値・説明に強弱を付ける';catalog.slides[0].headline='文字と図形の改善例 / AI呼び出しなし';
const sources=(index:number):SourceRef[]=>{
  const section=original.slides[index].notes.split('出典:\n')[1]?.split('\n\n内容:')[0]??'';
  return [...section.matchAll(/(2027_1q_summary_jp\.pdf) (p\.\d+)/g)].map(m=>({documentId:'provided-deck',documentName:m[1],locator:m[2]}));
};
const s=(index:number,title:string,layoutId:string,items:SlideSpec['items'],other:Partial<SlideSpec>={}):SlideSpec=>({id:`slide-${index+1}`,title,layoutId,items,sources:sources(index),notes:original.slides[index].notes+'\n\n添付PPTXの表示内容を使った配置の改善例。原文の数値・比較条件を保持。元PDFの再検証は行っていません。',...other});
const finance:DeckSpec={id:'provided-deck-style',title:'添付資料の配置改善例',mode:'presentation',themeId:'business',slides:[
 s(0,'トヨタ自動車\n2027年3月期 第1四半期 決算要旨','cover',[],{headline:'IFRS連結 / 添付資料の配置改善例'}),
 s(1,'税引前・当期利益が増加、営業利益は減少','design_metric_grid',[
  {label:'営業収益',value:'13兆5,254億円',description:'前年同期比+10.4%'},
  {label:'営業利益',value:'1兆634億円',description:'前年同期比△8.8%'},
  {label:'税引前四半期利益',value:'1兆9,638億円',description:'前年同期比+56.8%（営業外収益増）'},
  {label:'親会社帰属四半期利益',value:'1兆4,770億円',description:'前年同期比+75.6%、EPS120.69円'}]),
 s(2,'営業利益は前年同期比△1,026億円（△8.8%）','design_icon_rows',[
  {label:'為替変動の影響',description:'+3,450億円（押し上げ）'},
  {label:'諸経費増減・低減努力',description:'△1,900億円（押し下げ）'},
  {label:'その他',description:'△2,426億円（押し下げ）',icon:'none'},
  {label:'原価改善の努力',description:'△850億円（押し下げ）',icon:'coins'}]),
 s(3,'地域によって営業利益の増減が異なる','table_full',[],{table:{headers:['地域','営業収益（億円）','営業利益（億円）','営業利益の前年同期比'],rows:[['日本','58,245','5,401','△16.3%'],['北米','61,057','1,854','+2,066億円（増益）'],['欧州','18,798','1,072','+10.6%'],['アジア','23,363','2,083','△3.4%'],['その他の地域','12,721','925','△1.6%']]}}),
 s(4,'資産・資本・現金は前期末比で減少','design_metric_grid',[
  {label:'資産合計',value:'102兆6,351億円',description:'前期末比△2.7%'},
  {label:'資本合計',value:'38兆2,289億円',description:'前期末比△6.8%、持分比率36.4%'},
  {label:'現金及び現金同等物',value:'10兆3,430億円',description:'前期末比△18.3%'},
  {label:'財務活動CF',value:'△4兆3,391億円',description:'自己株式取得3兆6,569億円が主因'}]),
 s(5,'本業の費用吸収力とCF創出力を継続確認','design_icon_tiles',[
  {label:'自動車事業利益',description:'諸経費増で△21.0%減益',icon:'coins'},
  {label:'日本・アジア減益',description:'諸経費増加等が要因と記載',icon:'globe'},
  {label:'自己株式取得',description:'3,657億円で資本減少',icon:'coins'},
  {label:'営業CF減少',description:'5,365億円へ急減',icon:'coins'}])
]};
const math:DeckSpec={id:'math-style',title:'数学の見方が変わる',themeId:'classroom',mode:'presentation',slides:[
 {id:'slide-1',title:'奇数を足すと\n正方形が現れる',layoutId:'cover',headline:'数の並びを、形として眺める',items:[],sources:[],notes:'一般的な数学の説明。'},
 {id:'slide-2',title:'3つの奇数の和は3の平方になる',layoutId:'design_equation',equation:{text:'1 + 3 + 5 = 9',explanation:'最初の3個の正の奇数を足した例。'},items:[{label:'数の並び',description:'正の奇数を小さい順に足す。',icon:'calculator'},{label:'平方との対応',description:'3 × 3 と同じ値になる。',icon:'calculator'}],sources:[],notes:'この一例だけで一般の場合の証明とはしない。'},
 {id:'slide-3',title:'観察・予想・証明で理解を深める',layoutId:'design_process_badges',items:[{label:'観察',description:'いくつかの例を確かめる。'},{label:'予想',description:'共通する規則を考える。'},{label:'証明',description:'全ての場合で説明する。'}],sources:[],notes:'順序を説明するために工程図を使用。'},
 {id:'slide-4',title:'例から生まれた予想を証明につなぐ',layoutId:'design_statement',headline:'例を確かめ、\n規則を証明する',body:'数や図形の見方を切り替える。',items:[{label:'計算で確かめる',description:'まずは具体的な数で試す。'},{label:'図形で考える',description:'数の関係を形で説明する。'}],sources:[],notes:'結論を一つに絞り、その根拠を右に添える。'}
]};
type Result={id:string;fingerprint:string;artifact:string;file:string;slides:number;warnings:string[]};
const reportPath=path.join(qa,'design-results.json'),results:Result[]=await fs.readFile(reportPath,'utf8').then(JSON.parse,()=>[]);
for(const [id,deck] of [['patterns-business',{...catalog,themeId:'business'}],['patterns-midnight',{...catalog,themeId:'midnight',mode:'reading'}],['source-improved',finance],['mathematics',math]] as [string,DeckSpec][]){
  const scene=compileDeck(deck),fingerprint=createHash('sha256').update(JSON.stringify(scene)).digest('hex');
  assert.deepEqual(scene.slides.flatMap(s=>s.textIssues??[]),[],id);
  const existing=results.find(r=>r.id===id&&r.fingerprint===fingerprint);if(existing){console.log(JSON.stringify({reused:existing}));continue;}
  const render=await bridge.render(deck,id);assert.deepEqual(render.warnings,[],id);assert.equal(render.native,true);
  const file=`Designer-Extention-v06-${id}-${fingerprint.slice(0,7)}.pptx`;
  await fs.copyFile(path.join(bridge.artifactRoot,render.artifactId,'presentation.pptx'),path.join(out,file),fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(qa,id+'.json'),JSON.stringify(deck,null,2));
  results.push({id,fingerprint,artifact:render.artifactId,file,slides:deck.slides.length,warnings:render.warnings});await fs.writeFile(reportPath,JSON.stringify(results,null,2));console.log(JSON.stringify(results.at(-1)));
}
const latest=(id:string)=>results.filter(r=>r.id===id).at(-1)!;
const financial=latest('source-improved'),patterns=latest('patterns-business'),mathematics=latest('mathematics');
const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Designer Extention 文字と図形の改善</title><style>body{font:16px 'Yu Gothic',sans-serif;margin:32px;background:#f3f5f5;color:#172d4a;line-height:1.8}main{display:grid;grid-template-columns:1fr 1fr;gap:24px}article{background:white;padding:16px}img{width:100%;display:block}h2{font-size:22px}a{color:#245da8}@media(max-width:800px){main{grid-template-columns:1fr}}</style><h1>主張・数値・説明に強弱を付ける</h1><p>添付版の金額・条件はそのまま使い、表示方法を変えた例です。原文と出典はノートに保持しています。記事の公開見本から、関係の選び方と文字の強弱を参考にしました。</p><p><a href="../samples/generated/${financial.file}">添付資料の改善例を開く</a> / <a href="../samples/generated/${patterns.file}">新しい配置と12種類のアイコン</a> / <a href="../samples/generated/${mathematics.file}">数学の発表例</a></p><main>${Array.from({length:6},(_,i)=>`<article><h2>${i+1}枚目：変更前</h2><img src="../runtime/artifacts/76c0a23e-1f77-46ff-a3ce-719fa743fdd5/slide-${i+1}.png" alt="元のスライド"></article><article><h2>${i+1}枚目：変更後</h2><img src="../runtime/artifacts/${financial.artifact}/slide-${i+1}.png" alt="改善例"></article>`).join('')}</main><p><a href="https://cone-c-slide.com/see-sla/blog/design-pattern/">参考記事：c-slide デザインパターン集</a> / <a href="design-principles.md">設計基準</a></p></html>`;
await fs.writeFile(path.join(root,'docs','design-improvements.html'),html);
