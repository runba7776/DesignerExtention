import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {DeckSpec,RefreshPlan,RestoredPresentation} from '../shared/contracts.js';
import {applyRefresh,formatLike,numberSpans,planRefresh,type RefreshDocument} from '../shared/refresh.js';
import {validateDeck} from '../server/validation.js';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {demoOutline} from '../server/demo.js';
import type {ParsedDocument} from '../server/document-model.js';

const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string,extra:Record<string,unknown>={})=>({t:'text',x,y,w,h,text,size,...(role?{role}:{}),...extra});
const pdf=(id:string,name:string,pages:string[]):ParsedDocument=>({id,name,kind:'pdf',units:pages.length,characters:pages.join('').length,warnings:[],sources:pages.map((text,i)=>({id:`${id}:${i+1}`,locator:`p.${i+1}`,text}))});
const sheet=(id:string,name:string,rows:string[]):ParsedDocument=>({id,name,kind:'xlsx',units:rows.length,characters:rows.join('').length,warnings:[],sources:rows.map((text,i)=>({id:`${id}:${i+1}`,locator:`KPI!行 ${i+1}`,text}))});

// Previous quarter (Q1) and the new quarter (Q2): same layout, new numbers.
const oldPdf=pdf('11111111-1111-4111-8111-111111111111','決算短信_2027_1Q.pdf',[
  '2027年3月期 第1四半期決算短信〔日本基準〕(連結)\n上場会社名 ミライ精機株式会社',
  '1. 連結業績\n売上高 13,525 4.2 12,980 3.1\n営業利益 4,812 12.5 4,277 8.0\n親会社株主に帰属する四半期純利益 3,120 △2.1 3,187 5.5',
]);
const newPdf=pdf('22222222-2222-4222-8222-222222222222','決算短信_2027_2Q.pdf',[
  '2027年3月期 第2四半期決算短信〔日本基準〕(連結)\n上場会社名 ミライ精機株式会社',
  '1. 連結業績\n売上高 27,410 3.8 26,407 2.9\n営業利益 9,105 △3.2 9,406 6.1\n親会社株主に帰属する四半期純利益 6,488 1.4 6,398 4.0',
]);
const oldKpi=sheet('33333333-3333-4333-8333-333333333333','KPI_1Q.xlsx',['B1="指標" | C1="2026年度1Q" | D1="前年同期"','B2="受注高" | C2="1520" | D2="1388"','B3="営業利益率" | C3="0.356 (表示形式: 0.0%)" | D3="0.33 (表示形式: 0.0%)"']);
// The new sheet has an extra row above, so the cells moved; the items are found by their labels.
const newKpi=sheet('44444444-4444-4444-8444-444444444444','KPI_2Q.xlsx',['B1="指標" | C1="2026年度2Q" | D1="前年同期"','B2="新規顧客数" | C2="42" | D2="37"','B3="受注高" | C3="1604" | D3="1475"','B4="営業利益率" | C4="0.332 (表示形式: 0.0%)" | D4="0.356 (表示形式: 0.0%)"']);

function deck():DeckSpec{
  return validateDeck({id:'d',title:'2027年3月期 第1四半期 決算報告',mode:'presentation',themeId:'business',slides:[
    {id:'slide-1',title:'2027年3月期 第1四半期 決算報告',layoutId:'cover',notes:'',sources:[],items:[],design:{elements:[t(64,160,832,120,'2027年3月期 第1四半期 決算報告',40),t(64,300,600,40,'ミライ精機株式会社',20)]}},
    {id:'slide-2',title:'営業利益は4,812億円',layoutId:'free',notes:'営業利益は4,812億円、前年同期比+12.5%でした。',items:[],
      sources:[{documentId:oldPdf.id,locator:'p.2'},{documentId:oldKpi.id,locator:'KPI!行 2'}],
      design:{elements:[t(56,28,848,52,'営業利益は4,812億円、前年同期比+12.5%の増益',28,'title',{refs:[1]}),
        {t:'chart',x:56,y:110,w:480,h:300,chart:{type:'column',categories:['前年同期','当期'],series:[{name:'営業利益',values:[4277,4812]}],unit:'億円'}},
        t(580,120,320,40,'受注高 1,520件',22,'number',{refs:[2]}),t(580,180,320,40,'営業利益率 35.6%',22,'number'),t(580,240,320,40,'中期計画の3つの柱',16,'body')]}},
  ]});
}

test('numbers keep the old style: commas, plus, the △ mark and percent',()=>{
  assert.equal(formatLike('4,812','9105','9,105'),'9,105');
  assert.equal(formatLike('+12.5%','-3.2','△3.2'),'△3.2%');
  assert.equal(formatLike('△2.1','1.4','1.4'),'1.4');
  assert.equal(formatLike('４，８１２','9105','9105'),'９，１０５');
  assert.deepEqual(numberSpans('2026-2027年 A-12 △3.2%').map(s=>s.raw),['2026','2027','12','△3.2%']);
});

test('each number is looked up by its item in the new documents; ambiguity and missing items are left for review',()=>{
  const plan=planRefresh(deck(),[oldPdf,oldKpi],[newPdf,newKpi]);
  const at=(slide:string,before:string,where?:string)=>plan.entries.find(e=>e.slideId===slide&&e.before===before&&(!where||e.where.includes(where)))!;
  // Cover: the period moves from Q1 to Q2 (found in the title line of the report).
  assert.equal(at('slide-1','1').after,'2');assert.equal(at('slide-1','1').status,'changed');
  assert.equal(at('slide-1','2027').status,'same');
  // Text and chart: the row "営業利益", first and second numbers.
  assert.equal(at('slide-2','4,812','見出し').after,'9,105');
  assert.equal(at('slide-2','+12.5%').after,'△3.2%');
  assert.equal(at('slide-2','4812').after,'9105');assert.equal(at('slide-2','4277').after,'9406');
  assert.equal(at('slide-2','4,812','見出し').basis!.label,'営業利益');
  // Spreadsheet: same row label and column even though the row moved; percent cells keep their display form.
  assert.equal(at('slide-2','1,520').after,'1,604');assert.match(at('slide-2','1,520').basis!.label,/受注高/);
  assert.equal(at('slide-2','35.6%').after,'33.2%');
  // "3つの柱" is wording, not data.
  assert.ok(!plan.entries.some(e=>e.slideId==='slide-2'&&e.before==='3'));
  // The headline says 増益 but growth turned negative.
  assert.match(plan.texts.find(x=>x.slideId==='slide-2'&&x.where==='見出し')!.reason,/増減の向きが変わりました.*増益/);
  assert.equal(plan.counts.review+plan.counts.missing,0,JSON.stringify(plan.entries.filter(e=>e.status==='review'||e.status==='missing')));
});

test('CSV cells written as text ("1,520", "35.6%") are read as values of their row and column',()=>{
  const csv=(id:string,name:string,rows:string[][]):ParsedDocument=>({id,name,kind:'csv',units:rows.length,characters:0,warnings:[],sources:rows.map((cells,r)=>({id:`${id}:${r+1}`,locator:`行 ${r+1}`,text:cells.map((v,c)=>`${String.fromCharCode(65+c)}${r+1}=${JSON.stringify(v)}`).join(' | ')}))});
  const before=csv('77777777-7777-4777-8777-777777777777','KPI_1Q.csv',[['指標','2026年度1Q','前年同期'],['受注高','1,520','1,388'],['営業利益率','35.6%','33.0%']]);
  const after=csv('88888888-8888-4888-8888-888888888888','KPI_2Q.csv',[['指標','2026年度2Q','前年同期'],['受注高','1,604','1,475'],['営業利益率','33.2%','35.6%']]);
  const plan=planRefresh(deck(),[oldPdf,before],[newPdf,after]);
  assert.equal(plan.entries.find(e=>e.before==='1,520')!.after,'1,604');
  assert.equal(plan.entries.find(e=>e.before==='35.6%')!.after,'33.2%');
});

test('an item that is not in the new documents is not guessed',()=>{
  const thin=pdf('55555555-5555-4555-8555-555555555555','決算短信_2027_2Q.pdf',['2027年3月期 第2四半期決算短信','1. 連結業績\n売上高 27,410 3.8 26,407 2.9']);
  const plan=planRefresh(deck(),[oldPdf,oldKpi],[thin]);
  const profit=plan.entries.find(e=>e.before==='4,812')!;
  assert.equal(profit.status,'review');assert.equal(profit.after,'4,812');assert.match(profit.note!,/見つかりません/);
  // Two different candidates are offered, never one chosen silently.
  const twice=pdf('66666666-6666-4666-8666-666666666666','決算短信_2027_2Q.pdf',['1. 連結業績\n営業利益 9,105 △3.2','2. セグメント別\n営業利益 7,001 1.0']);
  // Both are in the cited page, and the slide's wording does not tell which one it is.
  const ambiguous=planRefresh(deck(),[pdf(oldPdf.id,oldPdf.name,['表紙','1. 連結業績 営業利益 4,812 12.5\n2. セグメント別 営業利益 4,812 12.5'])],[twice]).entries.find(e=>e.before==='4,812')!;
  assert.equal(ambiguous.status,'review');assert.deepEqual(ambiguous.candidates!.map(c=>c.value).sort(),['7,001','9,105']);
});

test('applying keeps every position and moves citations to the new documents',()=>{
  const original=deck(),plan=planRefresh(original,[oldPdf,oldKpi],[newPdf,newKpi]);
  const text=plan.texts.find(x=>x.slideId==='slide-2'&&x.where==='見出し')!;
  const result=applyRefresh(original,plan,{values:{},texts:{[text.id]:'営業利益は9,105億円、前年同期比△3.2%の減益'}},[newPdf,newKpi],[oldPdf,oldKpi]);
  const deck2=validateDeck(result.deck);
  const page=deck2.slides[1],elements=page.design!.elements as any[];
  assert.equal(elements[0].text,'営業利益は9,105億円、前年同期比△3.2%の減益');
  assert.deepEqual(elements[1].chart.series[0].values,[9406,9105]);
  assert.equal(elements[2].text,'受注高 1,604件');assert.equal(elements[3].text,'営業利益率 33.2%');
  assert.deepEqual(elements.map(e=>[e.x,e.y,e.w,e.h]),(original.slides[1].design!.elements as any[]).map(e=>[e.x,e.y,e.w,e.h]));
  assert.equal(page.notes,'営業利益は9,105億円、前年同期比△3.2%でした。');
  assert.equal(deck2.title,'2027年3月期 第2四半期 決算報告');assert.equal(deck2.slides[0].title,'2027年3月期 第2四半期 決算報告');
  assert.deepEqual(page.sources.map(s=>[s.documentId,s.locator]),[[newPdf.id,'p.2'],[newKpi.id,'KPI!行 3'],[newKpi.id,'KPI!行 4']]);
  assert.deepEqual(elements[0].refs,[1]);assert.deepEqual(elements[2].refs,[2]);
  assert.equal(result.edited,1);assert.ok(result.changes.some(c=>c.before==='4812'&&c.after==='9105'&&c.kind==='value'));
  assert.throws(()=>applyRefresh(original,plan,{values:{[plan.entries.find(e=>e.before==='1,520')!.id]:'1,604件'},texts:{}},[newPdf,newKpi],[oldPdf,oldKpi]),/数値だけ/);
});

test('the refreshed deck opens as a new presentation with the new documents; the previous one is kept',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-refresh-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'chat',chatService:'claude',mode:'presentation',slideCount:2});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'/x.pptx',thumbnails:[],warnings:[],native:false}),providerFactory:()=>{throw new Error('no provider');}});
    const session=await engine.create({prompt:'決算の報告'},[oldPdf,oldKpi]);
    const outline=demoOutline('決算','presentation',[],2);outline.title='2027年3月期 第1四半期 決算報告';outline.slides=outline.slides.map((s,i)=>({...s,layoutId:i?'free':'cover'}));
    await engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify({kind:'outline',outline})});
    await engine.generate(session.id);
    const original=deck();
    await engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify({...original,slides:original.slides})});
    assert.equal(session.phase,'ready');
    const plan:RefreshPlan=await engine.refreshPlan(session.id,{variantId:session.variants[0].id},[newPdf,newKpi]);
    assert.equal(plan.counts.changed>5,true);
    await assert.rejects(engine.refreshApply(session.id,{planId:'other',values:{},texts:{}}),/照合し直/);
    const opened:RestoredPresentation=await engine.refreshApply(session.id,{planId:plan.id,values:{},texts:{}});
    assert.notEqual(opened.session.id,session.id);
    assert.deepEqual(opened.documents.map(d=>d.name),['決算短信_2027_2Q.pdf','KPI_2Q.xlsx']);
    const refreshed=opened.session.variants[0];
    assert.equal(refreshed.origin!.kind,'refresh');assert.equal(refreshed.deck.title,'2027年3月期 第2四半期 決算報告');
    assert.ok(opened.session.refresh!.changes.length>5);assert.equal(opened.session.refresh!.from,'2027年3月期 第1四半期 決算報告');
    // The previous presentation is untouched, and the refreshed one is saved to history and reopens.
    assert.equal(session.variants[0].deck.title,'2027年3月期 第1四半期 決算報告');
    const reopened=await engine.restoreHistory(opened.session.historyId!);
    assert.equal(reopened.session.variants[0].deck.slides[1].design!.elements.filter(e=>e.t==='chart').length,1);
    assert.ok(reopened.session.refresh!.changes.length>5);
    const report=engine.sourceReport(opened.session.id);
    assert.ok(report.slides[1].numbers.filter(n=>n.status==='matched').length>=4,JSON.stringify(report.slides[1].numbers));
    // History keeps three drafts (the comparison limit) and where each came from.
    await engine.variants(session.id);await engine.variants(session.id);
    assert.equal(session.variants.length,3);assert.equal(session.historySaveError,undefined);
    const three=await engine.restoreHistory(session.historyId!);
    assert.deepEqual(three.session.variants.map(v=>v.origin?.kind),[undefined,'restyle','restyle'].map((k,i)=>i?k:session.variants[0].origin?.kind));
  }finally{await rm(dir,{recursive:true,force:true});}
});
