/** Offline UI QA only. Does not load production keys or call real providers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app';
import {SettingsStore} from '../server/settings';
import {OutputLimitError,emptyUsage} from '../server/providers';
import {demoOutline,demoDeck} from '../server/demo';
const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=path.join(root,'runtime','qa-v083','web'),port=4320,authToken=randomBytes(32).toString('hex');
await fs.mkdir(dataDir,{recursive:true});await (await new SettingsStore(dataDir,'').load()).update({provider:'local',model:'verification-mock',mode:'reading',slideCount:3,autoRepair:true});
const outline=demoOutline('自動対処の検証（模擬データ）','reading',[],3),deck=demoDeck(outline),revisions=new Map<string,number>();let generation=0;
const usage={...emptyUsage(),calls:1,inputTokens:100,outputTokens:500};
const app=await createApp({authToken,port,dataDir,webRoot:path.join(root,'dist','web'),artifactRoot:path.join(dataDir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,render:async()=>{throw new Error('Native rendering disabled');},providerFactory:()=>({complete:async request=>{
  const req=JSON.parse(request.content).request;
  await fs.appendFile(path.join(dataDir,'mock-calls.jsonl'),JSON.stringify({task:req.targetSlide?'revise':req.targetSlides?'generate':'plan',maxTokens:request.maxTokens,compressionLevel:req.compressionLevel??0,targetSlideIds:req.targetSlides?.map((s:any)=>s.id)??[],realApiCalls:0})+'\n');
  if(req.targetSlide){const count=(revisions.get(req.instruction)??0)+1;revisions.set(req.instruction,count);if(count===1||req.instruction.includes('停止検証'))throw new OutputLimitError({...usage,outputTokens:8000},'{"id":"slide-2","notes":"未完');return {text:JSON.stringify({...req.targetSlide,title:'比較の要点を簡潔に（模擬修正）'}),usage};}
  if(req.targetSlides){if(generation++===0)throw new OutputLimitError({...usage,outputTokens:11500},'{"mode":"reading","themeId":"paper","slides":['+deck.slides.slice(0,2).map(s=>JSON.stringify(s)).join(',')+',{"id":"slide-3","title":"未完');return {text:JSON.stringify({...deck,slides:req.targetSlides.map((s:any)=>deck.slides.find(s2=>s2.id===s.id))}),usage};}
  return {text:JSON.stringify({kind:'outline',outline}),usage};
}})});
const server=app.listen(port,'127.0.0.1',async()=>{await fs.writeFile(path.join(dataDir,'server.json'),JSON.stringify({pid:process.pid,url:`http://localhost:${port}/?token=${authToken}`}));console.log('Offline automatic repair verification ready.');});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
