/** Mock output-limit verification. No real model/credentials/network requests. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app';
import {SettingsStore} from '../server/settings';
import {OutputLimitError,emptyUsage} from '../server/providers';
import {demoOutline} from '../server/demo';
const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=path.join(root,'runtime','qa-v081','web'),port=4318,authToken=randomBytes(32).toString('hex');
await fs.mkdir(dataDir,{recursive:true});await (await new SettingsStore(dataDir,'').load()).update({provider:'local',model:'verification-mock',mode:'reading',slideCount:30});
const app=await createApp({authToken,port,dataDir,webRoot:path.join(root,'dist','web'),artifactRoot:path.join(dataDir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,render:async()=>{throw new Error('Native rendering disabled');},providerFactory:()=>({complete:async request=>{
  const body=JSON.parse(request.content);await fs.appendFile(path.join(dataDir,'mock-calls.jsonl'),JSON.stringify({maxTokens:request.maxTokens,retry:body.request.outputRetry,realApiCalls:0})+'\n');
  if(!body.request.outputRetry)throw new OutputLimitError({...emptyUsage(),calls:1,inputTokens:100,outputTokens:16_000},'{"kind":"outline","outline":{');
  return {text:JSON.stringify({kind:'outline',outline:demoOutline('模擬応答：30枚の構成を保持','reading',[],30)}),usage:{...emptyUsage(),calls:1,inputTokens:100,outputTokens:3000}};
}})});
const server=app.listen(port,'127.0.0.1',async()=>{await fs.writeFile(path.join(dataDir,'server.json'),JSON.stringify({pid:process.pid,url:`http://localhost:${port}/?token=${authToken}`}));console.log('Offline output-limit verification ready.');});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
