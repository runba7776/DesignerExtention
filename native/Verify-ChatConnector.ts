/** Exercises the real stdio connector against the isolated browser QA server. No AI calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const root=fileURLToPath(new URL('..',import.meta.url));
const dataDir=path.join(root,'runtime','qa-v090','web');
const child=spawn(process.execPath,[path.join(root,'node_modules','tsx','dist','cli.mjs'),path.join(root,'server','mcp.ts')],{
  cwd:root,windowsHide:true,env:{...process.env,DESIGNER_CONNECTOR_DATA_DIR:dataDir},stdio:['pipe','pipe','pipe']});
let sequence=0;
const waiting=new Map<number,{resolve:(result:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
const lines=createInterface({input:child.stdout});
lines.on('line',line=>{
  const payload=JSON.parse(line),entry=waiting.get(payload.id);
  if(!entry)return;
  clearTimeout(entry.timer);waiting.delete(payload.id);
  if(payload.error)entry.reject(new Error('Connector protocol error.'));else entry.resolve(payload.result);
});
child.on('error',()=>{for(const entry of waiting.values())entry.reject(new Error('Connector did not start.'));});
function rpc(method:string,params?:unknown):Promise<any>{
  return new Promise((resolve,reject)=>{
    const id=++sequence,timer=setTimeout(()=>{waiting.delete(id);reject(new Error('Connector timed out.'));},35_000);
    waiting.set(id,{resolve,reject,timer});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
}
async function tool(name:string,args:unknown={}){
  const result=await rpc('tools/call',{name,arguments:args});
  assert.equal(result.isError,false,'Connector rejected the verification request.');
  return JSON.parse(result.content[0].text);
}
try{
  const init=await rpc('initialize',{protocolVersion:'2025-06-18',clientInfo:{name:'isolated-verification',version:'1.0'},capabilities:{}});
  assert.equal(init.serverInfo.version,'0.10.0');
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const list=await rpc('tools/list');assert.equal(list.tools.length,4);
  const tasks=await tool('designer_list_tasks');
  const pending=tasks.sessions.filter((s:any)=>s.task==='revise');assert.equal(pending.length,1);
  const task=await tool('designer_get_task',{sessionId:pending[0].id});
  const revision=JSON.parse(await fs.readFile(path.join(dataDir,'revision-fixture.json'),'utf8'));
  revision.title='直接連携から修正を反映（接続検証）';
  const result=await tool('designer_submit_reply',{sessionId:task.sessionId,requestId:task.handoff.requestId,response:JSON.stringify(revision)});
  assert.equal(result.accepted,true);assert.equal(result.phase,'ready');assert.equal(result.paidApiCalls,0);assert.equal(result.handoff,undefined);
  assert.equal(result.slides[1].title,revision.title);
  const designs=await tool('designer_list_designs');assert.ok(designs.entries.length>=1);
  const metadata={version:init.serverInfo.version,protocol:init.protocolVersion,tools:list.tools.length,accepted:true,phase:result.phase,slides:result.slides.length,paidApiCalls:0,realMonthlyAccountUsed:false};
  await fs.writeFile(path.join(root,'runtime','qa-v090','connector-verification.json'),JSON.stringify(metadata,null,2));
  console.log(JSON.stringify(metadata));
}finally{
  for(const entry of waiting.values())clearTimeout(entry.timer);
  lines.close();child.stdin.end();child.kill();
}
