import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createApp } from './app';
import { createRenderBridge } from './render-bridge';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtime=path.join(projectRoot,'runtime');
const port=Number(process.env.DESIGNER_PORT || 4317);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('DESIGNER_PORT must be a port from 1024 to 65535.');
const taskPanePort=4318;
if(!Number.isInteger(taskPanePort)||taskPanePort<1024||taskPanePort>65535||taskPanePort===port)throw new Error('DESIGNER_TASKPANE_PORT must be a different port from 1024 to 65535.');
const authToken=randomBytes(32).toString('hex');
await fs.mkdir(runtime,{recursive:true});
const bridge=createRenderBridge(projectRoot);
const app=await createApp({authToken,port,taskPanePort,dataDir:runtime,webRoot:path.join(projectRoot,'dist','web'),...bridge});
const tlsDirectory=path.join(runtime,'office-taskpane');
// "localhost" resolves to ::1 or 127.0.0.1 depending on the client. Office,
// WebView2 and PowerShell do not agree, so the task pane listens on both
// loopback addresses; a single 'localhost' bind left 127.0.0.1 refusing.
const taskPaneServers:ReturnType<typeof createHttpsServer>[]=[];
try{
  const [pfx,passphrase]=await Promise.all([fs.readFile(path.join(tlsDirectory,'localhost.pfx')),fs.readFile(path.join(tlsDirectory,'passphrase.txt'),'utf8')]);
  for(const address of ['127.0.0.1','::1']){
    const listener=createHttpsServer({pfx,passphrase:passphrase.trim()},app);
    listener.on('error',(err:NodeJS.ErrnoException)=>{
      // IPv6 may be disabled on the PC; IPv4 loopback alone is enough then.
      if(address==='::1'&&(err.code==='EADDRNOTAVAIL'||err.code==='EAFNOSUPPORT'))return;
      console.error(`PowerPoint task pane could not start on ${address}:${taskPanePort}: ${err.code==='EADDRINUSE'?'the port is used by another program':err.message}. The browser interface remains available.`);
    });
    listener.listen(taskPanePort,address,()=>console.log(`PowerPoint task pane is ready on https://localhost:${taskPanePort}/ (${address}).`));
    taskPaneServers.push(listener);
  }
}catch(error:any){console.error(error?.code==='ENOENT'?'PowerPoint task pane certificate is missing. Run Setup-DesignerExtension.cmd to enable the PowerPoint task pane.':`PowerPoint task pane certificate could not be loaded: ${error.message}. Run Setup-Office-TaskPane.ps1 again.`);}
const server=app.listen(port,'127.0.0.1',async()=> {
  await fs.writeFile(path.join(runtime,'server.json'),JSON.stringify({pid:process.pid,port,taskPanePort,url:`http://127.0.0.1:${port}/?token=${authToken}`,taskPaneUrl:`https://localhost:${taskPanePort}/taskpane.html?taskpane=1`,startedAt:new Date().toISOString()}),'utf8');
  console.log(`Designer Extention is ready on 127.0.0.1:${port}. Open Start-DesignerExtension.ps1 to launch.`);
});
server.on('error',(err:NodeJS.ErrnoException)=> {
  console.error(err.code==='EADDRINUSE'?'このポートは使用中です。既に起動しているアプリを利用してください。':err.message);
  process.exitCode=1;
});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{for(const listener of taskPaneServers)listener.close();server.close(()=>process.exit(0));});
