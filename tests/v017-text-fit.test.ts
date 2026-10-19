import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Outline} from '../shared/contracts.js';
import {SessionEngine} from '../server/engine.js';
import {SettingsStore} from '../server/settings.js';
import {emptyUsage,type CompletionRequest} from '../server/providers.js';
import {applySummaries,fitProblems} from '../server/text-fit.js';
import {validateDeck} from '../server/validation.js';

const t=(x:number,y:number,w:number,h:number,text:string,size:number,role?:string)=>({t:'text',x,y,w,h,text,size,...(role?{role}:{})});
const usage={...emptyUsage(),calls:1};
const outline:Outline={title:'文字の収まり',mode:'presentation',themeId:'business',assumptions:[],slides:[{id:'slide-1',title:'文字の収まり',intent:'表紙',layoutId:'cover',keyPoints:[]},{id:'slide-2',title:'要点',intent:'本文',layoutId:'free',keyPoints:[]}]};
const words='あ'.repeat(40);
/** A page whose body text is hemmed in (a chart on the right, a text below): neither room nor 75% type is enough. */
const tight=(body=words,boxes={w:300,h:48})=>({id:'slide-2',title:'要点',layoutId:'free',notes:'',sources:[],design:{elements:[t(56,28,848,52,'要点',28,'title'),t(56,120,boxes.w,boxes.h,body,20,'body'),t(56,172,300,40,'次の文',16,'body'),{t:'chart',x:360,y:110,w:500,h:300,chart:{type:'column',categories:['A'],series:[{name:'売上',values:[1200]}]}}]}});
const cover={id:'slide-1',title:'文字の収まり',layoutId:'cover',notes:'',sources:[],design:{elements:[t(64,160,832,100,'文字の収まり',40)]}};

async function fixture(relayout:(request:any,count:number)=>unknown){
  const dir=await mkdtemp(path.join(tmpdir(),'de-text-fit-'));
  const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'local',model:'mock',slideCount:2,mode:'presentation',themeId:'business'});
  const calls:string[]=[];let relayouts=0;
  const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>({complete:async(r:CompletionRequest)=>{
    const req=JSON.parse(r.content).request;
    if(req.targetSlide){calls.push('relayout');return {text:JSON.stringify(relayout(req,++relayouts)),usage};}
    if(req.targetSlides){calls.push('generate');return {text:JSON.stringify({mode:'presentation',themeId:'business',id:'d',title:outline.title,slides:[cover,tight()]}),usage};}
    if(req.slides){calls.push('summarize');return {text:'{"replacements":[]}',usage};}
    calls.push('plan');return {text:JSON.stringify({kind:'outline',outline}),usage};
  }})});
  return {engine,calls,dispose:()=>rm(dir,{recursive:true,force:true})};
}

test('an AI-designed page that does not fit is laid out again with the same words, not summarized',async()=>{
  const f=await fixture((req,count)=>{
    assert.match(req.instruction,/文章・数値・グラフと表の内容は一字も変えず/);
    // First reply changes the wording (refused), the second gives the text a taller box.
    if(count===1)return tight('あ'.repeat(30));
    return {...tight(),design:{elements:[t(56,28,848,52,'要点',28,'title'),t(56,120,300,90,words,20,'body'),t(56,220,300,40,'次の文',16,'body'),{t:'chart',x:360,y:110,w:500,h:300,chart:{type:'column',categories:['A'],series:[{name:'売上',values:[1200]}]}}]}};
  });
  try{
    const session=await f.engine.create({prompt:'2枚'},[]);await f.engine.generate(session.id);
    assert.equal(session.phase,'ready',JSON.stringify(session.recovery));assert.deepEqual(f.calls,['plan','generate','relayout','relayout']);
    const page=session.variants[0].deck.slides[1];assert.equal((page.design!.elements[1] as any).text,words);assert.equal((page.design!.elements[1] as any).h,90);
    assert.match(session.repairReport!.steps[0].reason,/図形・ページ・図表の仕様に不備/);
  }finally{await f.dispose();}
});

test('when fitting stops, the deck is finished with smaller text and no AI call; nothing is lost',async()=>{
  const f=await fixture(()=>tight());
  try{
    const session=await f.engine.create({prompt:'2枚'},[]);await f.engine.generate(session.id);
    assert.equal(session.recovery?.stage,'text-fit');assert.equal(session.recovery?.completedSlides,2);
    const before=f.calls.length;
    await f.engine.finishSmaller(session.id);
    assert.equal(f.calls.length,before,'no AI call');assert.equal(session.phase,'ready');
    const body=session.variants[0].deck.slides[1].design!.elements[1] as any;
    assert.equal(body.text,words);assert.ok(body.size<15&&body.size>=10,String(body.size));
    assert.deepEqual(fitProblems(session.variants[0].deck),[]);assert.ok(session.warnings.some(w=>w.includes('2枚目は、文字を小さくして枠に収めました')));
    await assert.rejects(f.engine.finishSmaller(session.id),/止まった作成・修正がありません/);
  }finally{await f.dispose();}
});

test('summaries compare values, not spelling; valid replacements are used even when another one is not',()=>{
  const deck=validateDeck({id:'d',title:'x',mode:'presentation',themeId:'business',slides:[cover,{id:'slide-2',title:'業績',layoutId:'free',notes:'',sources:[],design:{elements:[t(56,28,848,52,'業績は前年同期比 +99.3%増、売上高は１，２００億円',28,'title'),t(56,120,300,48,'前年同期比 +99.3%増。Switch 2の販売が牽引しました。',16,'body')]}}]});
  const next=applySummaries(deck,{replacements:[
    {slideId:'slide-2',path:'design.elements.0.text',text:'業績は99.3%増、売上高1,200億円'},
    {slideId:'slide-2',path:'design.elements.1.text',text:'前年同期比99.4%増'}]},['slide-2']);
  const page=next.slides[1];
  assert.equal((page.design!.elements[0] as any).text,'業績は99.3%増、売上高1,200億円');assert.equal(page.title,'業績',"a page name that was not the title's text stays");
  assert.equal((page.design!.elements[1] as any).text,'前年同期比 +99.3%増。Switch 2の販売が牽引しました。','a changed number is refused');
  assert.throws(()=>applySummaries(deck,{replacements:[{slideId:'slide-2',path:'design.elements.1.text',text:'前年同期比99.4%増'}]},['slide-2']),/数値が変更/);
});

test('manual chat: while the AI is asked to shorten text, the deck can be finished with smaller text instead',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'de-text-fit-chat-'));
  try{
    const settings=await new SettingsStore(dir,'').load();await settings.update({provider:'chat',mode:'presentation',slideCount:2,themeId:'business'});
    const engine=new SessionEngine({settings,dataDir:dir,render:async()=>({artifactId:'x',pptxUrl:'x',thumbnails:[],warnings:[],native:false}),providerFactory:()=>{throw new Error('no provider');}});
    const session=await engine.create({prompt:'2枚'},[]);
    await engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify({kind:'outline',outline})});
    await engine.generate(session.id);
    await engine.chatResponse(session.id,{requestId:session.chatHandoff!.requestId,response:JSON.stringify({mode:'presentation',themeId:'business',id:'d',title:outline.title,slides:[cover,tight()]})});
    assert.equal(session.chatHandoff?.task,'summarize');
    await engine.finishSmaller(session.id);
    assert.equal(session.phase,'ready');assert.equal(session.chatHandoff,undefined);
    assert.equal((session.variants[0].deck.slides[1].design!.elements[1] as any).text,words);assert.deepEqual(fitProblems(session.variants[0].deck),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
