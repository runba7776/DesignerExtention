import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Outline,Settings} from '../shared/contracts.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {emptyUsage,type CompletionRequest} from '../server/providers.js';
import {freeSystemPrompt} from '../server/free-prompts.js';

const usage={...emptyUsage(),calls:1};
const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string)=>({t:'text',x,y,w,h,text,size,...(role?{role}:{})});
const outlineOf=(name:string,count=2):Outline=>({title:name,mode:'presentation',palette:{name,background:'#FFFFFF',text:'#1F2937',muted:'#6B7280',accent:'#225588',accent2:'#AA5522'},visualStyle:`${name}の見せ方`,assumptions:[],
  slides:Array.from({length:count},(_,i)=>({id:`slide-${i+1}`,title:i?`${name}の本文${i}`:name,intent:i?'本文':'表紙',layoutId:i?'free':'cover',keyPoints:[]}))} as Outline);
const proposal=(name:string,typicality:number,count=2)=>({direction:name,difference:`${name}の違い`,typicality,outline:outlineOf(name,count)});
const offer=(...items:ReturnType<typeof proposal>[])=>({kind:'proposals',candidates:[{direction:'定番',typicality:.6},{direction:'変わり種',typicality:.1}],proposals:items});

async function fixture(settingsPatch:Partial<Settings>={},reply:(request:any,call:number)=>unknown=()=>offer(proposal('定番の流れ',.55),proposal('問いから始める',.15),proposal('歴史をたどる',.1))){
  const dir=await mkdtemp(path.join(tmpdir(),'de-proposals-'));
  const settings=await new SettingsStore(dir,'').load();
  await settings.update({provider:'subscription',subscriptionService:'claude',slideCount:2,mode:'presentation',...settingsPatch});
  const plans:any[]=[],systems:string[]=[];
  const engine=new SessionEngine({settings,dataDir:dir,subscriptionBinding:()=>'account',render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{
    const req=JSON.parse(r.content).request;
    if(!req.targetSlides){plans.push(req);systems.push(r.system);return {text:JSON.stringify(reply(req,plans.length)),usage};}
    return {text:JSON.stringify({mode:'presentation',id:'d',title:'資料',slides:req.targetSlides.map((s:any)=>({id:s.id,title:s.title,layoutId:s.layoutId,notes:'',sources:[],design:{elements:s.layoutId==='cover'?[t(64,160,832,100,s.title,40)]:[t(56,28,848,52,s.title,28,'title')]}}))}),usage};
  }})});
  return {engine,settings,plans,systems,dispose:()=>rm(dir,{recursive:true,force:true})};
}

test('the proposal instruction asks for the candidates with their typicality and mostly uncommon directions, and names no style',()=>{
  const plain=freeSystemPrompt('plan'),asked=freeSystemPrompt('plan',{proposals:3});
  assert.doesNotMatch(plain,/request\.proposals/);
  const part=asked.slice(asked.indexOf('今回はrequest.proposals=3'),asked.indexOf('JSON以外の説明'));
  assert.match(part,/candidatesに挙げ、それぞれのありがちさ（typicality）/);
  assert.match(part,/少なくとも2案は、ありがちさが0\.2以下/);
  assert.match(part,/依頼の条件（枚数・必須の内容・読み手と目的）と事実・出典の決まりを守り/);
  assert.match(part,/"kind":"proposals"/);
  assert.doesNotMatch(part,/#[0-9A-F]{6}|明朝|ゴシック|Gothic|Mincho|紺|白地/i,'no colour, font or look is suggested');
  for(const task of ['generate','revise'] as const)assert.doesNotMatch(freeSystemPrompt(task,{proposals:3}),/request\.proposals/,task);
});

test('the first outline comes as directions to pick from; one that breaks the slide count is left out; the pick becomes the outline',async()=>{
  const f=await fixture({},(req,call)=>call===1?offer(proposal('定番の流れ',.55),proposal('問いから始める',.15),proposal('枚数違い',.1,3)):{kind:'outline',outline:{...outlineOf('問いから始める'),title:'直した案'}});
  try{
    const session=await f.engine.create({prompt:'2枚の資料',cloudConsent:true},[]);
    assert.equal(f.plans[0].proposals,3);assert.match(f.systems[0],/今回はrequest\.proposals=3/);
    assert.equal(session.phase,'clarifying');assert.equal(session.outline,undefined);
    assert.deepEqual(session.proposals!.items.map(p=>[p.direction,p.typicality]),[['定番の流れ',.55],['問いから始める',.15]]);
    assert.equal(session.proposals!.candidates.length,2);
    assert.ok(session.warnings.some(w=>/1案は、条件（枚数・表示モードなど）に合わないため外しました/.test(w)));
    await assert.rejects(f.engine.generate(session.id),/先に構成案を確認してください/);
    await assert.rejects(f.engine.chooseProposal(session.id,2),/構成案を一覧から選んでください/);
    let chosen=await f.engine.chooseProposal(session.id,1);
    assert.equal(chosen.phase,'outline');assert.equal(chosen.outline!.title,'問いから始める');assert.equal(chosen.proposals!.chosen,1);
    // A change to the chosen outline is a normal single-outline request.
    const revised=await f.engine.message(session.id,'1枚目の題名を変えて');
    assert.equal(f.plans[1].proposals,undefined);assert.equal(f.plans[1].currentOutline.title,'問いから始める');assert.doesNotMatch(f.systems[1],/request\.proposals/);
    assert.equal(revised.outline!.title,'直した案');
    chosen=await f.engine.chooseProposal(session.id,0);assert.equal(chosen.outline!.title,'定番の流れ');
    const ready=await f.engine.generate(session.id);
    assert.equal(ready.phase,'ready');assert.equal(ready.variants[0].deck.slides[0].title,'定番の流れ');
    await assert.rejects(f.engine.chooseProposal(session.id,1),/スライドを作成した後は/);
  }finally{await f.dispose();}
});

test('asking again before a pick shows the earlier directions to the AI, and one usable direction becomes the outline directly',async()=>{
  const f=await fixture({},(req,call)=>call===1?offer(proposal('定番の流れ',.5),proposal('問いから始める',60)):offer(proposal('別の方向',.1),proposal('枚数違い',.1,4)));
  try{
    const session=await f.engine.create({prompt:'2枚の資料',cloudConsent:true},[]);
    assert.equal(session.proposals!.items[1].typicality,.6,'a percentage is read as a share');
    const again=await f.engine.message(session.id,'もっと違う方向で');
    assert.deepEqual(f.plans[1].previousProposals.map((p:any)=>p.direction),['定番の流れ','問いから始める']);
    assert.equal(f.plans[1].proposals,3);
    assert.equal(again.phase,'outline');assert.equal(again.outline!.title,'別の方向');
    assert.ok(again.warnings.some(w=>/条件に合う構成案が1つだけだったため/.test(w)));
  }finally{await f.dispose();}
});

test('a reply without any usable direction is retried as one outline',async()=>{
  const f=await fixture({},(req,call)=>call===1?offer(proposal('枚数違い',.2,3),proposal('枚数違い2',.1,4)):{kind:'outline',outline:outlineOf('1案だけ')});
  try{
    const session=await f.engine.create({prompt:'2枚の資料',cloudConsent:true},[]);
    assert.equal(f.plans.length,2);assert.equal(f.plans[0].proposals,3);assert.equal(f.plans[1].proposals,undefined,'the retry is shorter');
    assert.equal(session.phase,'outline');assert.equal(session.outline!.title,'1案だけ');assert.equal(session.proposals,undefined);
  }finally{await f.dispose();}
});

test('directions are offered only for AI designs through a monthly plan, and the setting turns them off',async()=>{
  for(const [patch,expected] of [[{},3],[{outlineProposals:false},undefined],[{designMode:'template' as const},undefined],[{designMode:'html' as const},3]] as const){
    const f=await fixture(patch,req=>req.proposals?offer(proposal('A',.5),proposal('B',.1)):{kind:'outline',outline:outlineOf('1案')});
    try{
      if(patch.designMode==='template'){await f.engine.create({prompt:'2枚',cloudConsent:true},[]).catch(()=>undefined);}
      else await f.engine.create({prompt:'2枚',cloudConsent:true},[]);
      assert.equal(f.plans[0]?.proposals,expected,JSON.stringify(patch));
    }finally{await f.dispose();}
  }
  const dir=await mkdtemp(path.join(tmpdir(),'de-proposals-local-'));
  try{
    const settings=await new SettingsStore(dir,'').load();
    await settings.update({provider:'local',model:'mock',slideCount:2});
    assert.equal(settings.get().outlineProposals,true,'on by default');
    await assert.rejects(settings.update({outlineProposals:'yes'} as any),/オン・オフ/);
    const plans:any[]=[];
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{plans.push(JSON.parse(r.content).request);return {text:JSON.stringify({kind:'outline',outline:outlineOf('1案')}),usage};}})});
    await engine.create({prompt:'2枚'},[]);
    assert.equal(plans[0].proposals,undefined,'not for a local LLM');
  }finally{await rm(dir,{recursive:true,force:true});}
});
