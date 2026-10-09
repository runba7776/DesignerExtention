/** Isolated verification with no model credentials or AI calls. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app';
import {createRenderBridge} from '../server/render-bridge';
import {SettingsStore} from '../server/settings';
const root=fileURLToPath(new URL('..',import.meta.url)),dataDir=path.join(root,'runtime','qa-v08','web'),port=4318,authToken=randomBytes(32).toString('hex');
await fs.mkdir(dataDir,{recursive:true});
await (await new SettingsStore(dataDir,'').load()).update({provider:'demo',mode:'presentation',slideCount:6,themeId:'business'});
const app=await createApp({authToken,port,dataDir,webRoot:path.join(root,'dist','web'),...createRenderBridge(root),environmentKey:'',providerFactory:()=>{throw new Error('AI disabled in verification.');}});
const server=app.listen(port,'127.0.0.1',async()=>{await fs.writeFile(path.join(dataDir,'server.json'),JSON.stringify({pid:process.pid,url:`http://localhost:${port}/?token=${authToken}`}));console.log('History verification ready.');});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
