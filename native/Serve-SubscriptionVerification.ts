/** Offline browser verification. Production data and providers are never loaded. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app';
import {SettingsStore} from '../server/settings';
import {demoOutline,demoDeck} from '../server/demo';

const root=fileURLToPath(new URL('..',import.meta.url));
const dataDir=path.join(root,'runtime','qa-v090','web');
const port=4321,authToken=randomBytes(32).toString('hex');
await fs.mkdir(dataDir,{recursive:true});
await (await new SettingsStore(dataDir,'').load()).update({provider:'chat',chatService:'chatgpt',model:'chat-session',mode:'reading',slideCount:3});
const outline=demoOutline('月額連携の検証（模擬データ）','reading',[],3);
const deck=demoDeck(outline);
await fs.writeFile(path.join(dataDir,'outline-fixture.json'),JSON.stringify({kind:'outline',outline}));
await fs.writeFile(path.join(dataDir,'deck-fixture.json'),JSON.stringify(deck));
await fs.writeFile(path.join(dataDir,'revision-fixture.json'),JSON.stringify({...deck.slides[1],title:'比較の要点を簡潔に（模擬修正）'}));
const app=await createApp({authToken,port,dataDir,webRoot:path.join(root,'dist','web'),artifactRoot:path.join(dataDir,'artifacts'),environmentKey:'',nativeAvailable:()=>false,
  render:async()=>{throw new Error('Native rendering disabled in browser verification.');},
  providerFactory:()=>{throw new Error('Model calls are prohibited during verification.');}});
const server=app.listen(port,'127.0.0.1',async()=>{
  await fs.writeFile(path.join(dataDir,'server.json'),JSON.stringify({pid:process.pid,url:`http://localhost:${port}/?token=${authToken}`}));
  console.log('Offline subscription-mode verification ready.');
});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
