import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Session} from '../shared/contracts.js';
import {designRequest,dummyText,leakCheck,phraseLeak,sha256,type DesignPacket} from '../shared/confidential.js';
import {SettingsStore} from '../server/settings.js';
import {SessionEngine} from '../server/engine.js';
import {demoOutline} from '../server/demo.js';
import {validateSlide} from '../server/validation.js';
import type {ParsedDocument} from '../server/document-model.js';

const secret='株式会社ミライ精機の第3四半期営業利益は4,812億円で、主力のロボット事業が牽引した。';
const document:ParsedDocument={id:'doc-1',name:'ミライ精機_決算.pdf',kind:'pdf',units:1,characters:secret.length,warnings:[],sources:[{id:'doc-1:1',locator:'p.1',text:secret}]};
const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string)=>({t:'text',x,y,w,h,text,size,...(role?{role}:{})});
const slides=(titles:string[])=>titles.map((title,i)=>validateSlide(i===0?{id:'slide-1',title,layoutId:'cover',notes:'',sources:[],design:{elements:[t(64,160,800,120,title,40)]}}
  :{id:`slide-${i+1}`,title,layoutId:'free',notes:'話す内容：ロボット事業が牽引',sources:[{documentId:'doc-1',locator:'p.1'}],design:{elements:[t(56,28,848,52,title,28,'title'),t(56,120,400,40,'営業利益4,812億円',24,'number',),t(56,180,600,60,'主力のロボット事業が牽引した',16,'body'),{t:'chart',x:500,y:120,w:400,h:300,chart:{type:'column',categories:['前期','当期'],series:[{name:'営業利益',values:[4100,4812]}],unit:'億円'}}]}},`slide-${i+1}`));
/** What a design AI would return for a packet: every slot placed once, nothing else written. */
function designFor(packet:DesignPacket,options:{skip?:string;extraText?:string;tiny?:string}={}){
  return {slides:packet.slides.map(slide=>{
    let y=24;const elements:any[]=[];
    for(const slot of slide.slots){if(slot.id===options.skip)continue;const size=slot.role==='title'?28:16,lines=Math.ceil(slot.chars*size/800)||1,h=slot.id===options.tiny?10:lines*size*1.35+8;elements.push({t:'text',slot:slot.id,x:56,y,w:820,h,size,role:slot.role});y+=h+8;}
    slide.charts.forEach(c=>{elements.push({t:'chart',slot:c.id,x:500,y:200,w:400,h:250});});
    if(options.extraText)elements.push({t:'text',x:56,y:460,w:300,h:30,text:options.extraText,size:14});
    return {id:slide.id,design:{background:'surface',elements}};
  })};
}

test('a design packet holds roles, lengths and dummy samples only; the leak check proves it',()=>{
  assert.equal(dummyText('営業利益 4,812億円（△8.8%）Inc.'),'〇〇〇〇 0,000〇〇〇〇0.0〇〇xxx.');
  const deck={id:'d',title:'ミライ精機の決算',mode:'presentation' as const,themeId:'business',slides:slides(['ミライ精機の決算','第3四半期の営業利益'])};
  const {packet,contents}=designRequest(deck,['slide-1','slide-2'],'structure');
  const sent=JSON.stringify(packet);
  for(const word of ['ミライ','営業利益','4,812','4812','ロボット','牽引','前期','当期','億円'])assert.ok(!sent.includes(word),word);
  assert.deepEqual(packet.slides[1].slots.map(s=>[s.id,s.role,s.chars]),[['t','title',10],['s1','number',11],['s2','body',14]]);
  assert.deepEqual(packet.slides[1].charts,[{id:'c1',type:'column',categories:2,series:1}]);
  assert.equal(contents['slide-2'].texts.s1.text,'営業利益4,812億円');
  const corpus=[secret,...deck.slides.flatMap(s=>[s.title,s.notes])];
  assert.deepEqual(leakCheck(packet,corpus).hits,[]);
  // The check would stop a packet that carried wording or numbers.
  assert.deepEqual(leakCheck({...packet,note:'ロボット事業 4812'},corpus).hits.sort(),['4812','ロボ','ボッ','ット','ト事','事業'].sort());
  assert.deepEqual(leakCheck({...packet,topic:'ロボット事業'},corpus,['ロボット事業']).hits,[],'an approved topic is allowed');
  assert.equal(phraseLeak(['slide-2のs2が配置されていません。'],corpus),false);assert.equal(phraseLeak(['s2に「主力のロボット事業」と入れて'],corpus),true);assert.equal(phraseLeak(['値は4812です'],corpus),true);
  assert.equal(sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('design-only request: nothing of the content is in the instruction; the design comes back filled on this PC',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-confidential-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'chat',chatService:'chatgpt',mode:'presentation',slideCount:3});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'/x.pptx',thumbnails:[],warnings:[],native:false}),providerFactory:()=>{throw new Error('no provider');}});
    const outline=demoOutline('ミライ精機の決算','presentation',[],3);outline.slides=outline.slides.map((s,i)=>({...s,title:['ミライ精機の決算','第3四半期の営業利益','ロボット事業の役割'][i],layoutId:i?'free':'cover'}));
    const reply=(session:Session,value:unknown)=>engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify(value)});
    const session=await engine.create({prompt:'ミライ精機の決算を社内向けに説明'},[document]);
    await reply(session,{kind:'outline',outline});await engine.generate(session.id);
    await reply(session,{mode:'presentation',themeId:'business',id:'d',title:outline.title,slides:slides(outline.slides.map(s=>s.title))});
    assert.equal(session.phase,'ready');const base=session.variants[0];
    await assert.rejects(engine.requestDesign(session.id,{variantId:base.id,service:'claude',level:'topic'}),/話題名/);
    await engine.requestDesign(session.id,{variantId:base.id,service:'claude',level:'structure'});
    const handoff=session.chatHandoff!;assert.equal(handoff.task,'design');assert.equal(handoff.service,'claude');
    for(const word of ['ミライ','精機','営業利益','4,812','4812','ロボット','牽引','前期','当期','社内向け','決算'])assert.ok(!handoff.instruction.includes(word),`instruction must not contain ${word}`);
    assert.equal(handoff.privacy?.hits,0);assert.ok(handoff.privacy!.checkedCharacters>secret.length);assert.equal(handoff.privacy?.sha256,sha256(handoff.instruction));
    const log=(await readFile(path.join(dir,'send-log.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(log.at(-1).sha256,handoff.privacy!.sha256);assert.equal(log.at(-1).hits,0);assert.ok(!JSON.stringify(log).includes('ミライ'));
    const packet=JSON.parse(handoff.instruction.split('\n\n').at(-2)!).request as DesignPacket;
    // A missing slot, invented text and a box too small are sent back by slot name only.
    await reply(session,designFor(packet,{skip:'s2'}));
    assert.match(session.chatHandoff!.validationIssues!.join(),/s2.*配置されていません/);
    await reply(session,designFor(packet,{extraText:'売上が伸びた理由'}));
    assert.match(session.chatHandoff!.validationIssues!.join(),/slotのない文字/);
    await reply(session,designFor(packet,{tiny:'s1'}));
    const fix=session.chatHandoff!.validationIssues!.join();assert.match(fix,/s1/);assert.ok(!/ロボット|牽引/.test(fix),'the correction names slots, not wording');
    assert.ok(!session.chatHandoff!.instruction.includes('ロボット'));
    await reply(session,designFor(packet));
    assert.equal(session.chatHandoff,undefined);assert.equal(session.variants.length,2);
    const designed=session.variants[1];assert.equal(designed.label,'デザイン：Claude');assert.match(designed.origin!.notes!.join(),/内容を送らず/);
    const texts=designed.deck.slides[1].design!.elements.filter(e=>e.t==='text').map(e=>(e as any).text);
    assert.deepEqual(texts,['第3四半期の営業利益','営業利益4,812億円','主力のロボット事業が牽引した']);
    assert.equal(designed.deck.slides[1].design!.background,'surface');
    assert.deepEqual((designed.deck.slides[1].design!.elements.find(e=>e.t==='chart') as any).chart.series[0].values,[4100,4812]);
    assert.equal(designed.deck.slides[1].notes,base.deck.slides[1].notes);
    assert.equal((await engine.sendLog()).records.length,4);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('a deck made by any provider (here the sample) can ask a chat AI for a design without sending content',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-confidential-demo-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'demo',mode:'presentation',slideCount:4});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'/x.pptx',thumbnails:[],warnings:[],native:false})});
    const session=await engine.create({prompt:'社外秘の検討'},[document]);await engine.message(session.id,'おまかせ');await engine.generate(session.id);
    await engine.requestDesign(session.id,{service:'chatgpt',level:'topic',topic:'業務改善の検討'});
    const handoff=session.chatHandoff!;assert.equal(handoff.task,'design');assert.match(handoff.instruction,/業務改善の検討/);
    assert.ok(!handoff.instruction.includes('社外秘'));assert.ok(!handoff.instruction.includes('ミライ'));
    for(const slide of session.variants[0].deck.slides)assert.ok(!handoff.instruction.includes(slide.title),slide.title);
    await engine.cancelChat(session.id);assert.equal(session.chatHandoff,undefined);assert.equal(session.phase,'ready');
  }finally{await rm(dir,{recursive:true,force:true});}
});
