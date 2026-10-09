/** Isolated offline QA server. No production settings, credentials or API calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app';
import {SettingsStore} from '../server/settings';
import {OutputLimitError,emptyUsage} from '../server/providers';
import {demoOutline,demoDeck} from '../server/demo';
const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=path.join(root,'runtime','qa-v082','web'),port=4319,authToken=randomBytes(32).toString('hex');
await fs.mkdir(dataDir,{recursive:true});await (await new SettingsStore(dataDir,'').load()).update({provider:'local',model:'verification-mock',mode:'reading',slideCount:9});
const outline=demoOutline('本文生成の再開検証（模擬データ）','reading',[],9),deck=demoDeck(outline);
let generation=0;
const app=await createApp({authToken,port,dataDir,webRoot:path.join(root,'dist','web'),artifactRoot:path.join(dataDir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,render:async()=>{throw new Error('Native rendering disabled');},providerFactory:()=>({complete:async request=>{
  const body=JSON.parse(request.content),target=body.request.targetSlides;
  await fs.appendFile(path.join(dataDir,'mock-calls.jsonl'),JSON.stringify({maxTokens:request.maxTokens,targetSlideIds:target?.map((s:any)=>s.id)??[],realApiCalls:0})+'\n');
  if(!target)return {text:JSON.stringify({kind:'outline',outline}),usage:{...emptyUsage(),calls:1,inputTokens:100,outputTokens:500}};
  if(generation++===0)throw new OutputLimitError({...emptyUsage(),calls:1,inputTokens:100,outputTokens:14000},'{"mode":"reading","themeId":"paper","slides":['+deck.slides.slice(0,2).map(s=>JSON.stringify(s)).join(',')+',{"id":"slide-3","title":"未完');
  return {text:JSON.stringify({...deck,slides:target.map((s:any)=>deck.slides.find(slide=>slide.id===s.id))}),usage:{...emptyUsage(),calls:1,inputTokens:100,outputTokens:500}};
}})});
const server=app.listen(port,'127.0.0.1',async()=>{await fs.writeFile(path.join(dataDir,'server.json'),JSON.stringify({pid:process.pid,url:`http://localhost:${port}/?token=${authToken}`}));console.log('Offline generation recovery verification ready.');});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
