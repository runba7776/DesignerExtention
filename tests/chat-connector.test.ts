import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ChatConnector,handleConnector,connectorTools} from '../server/chat-connector.js';

const sessionId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',token='a'.repeat(64);
async function state(url=`http://localhost:4321/?token=${token}`){const dir=await mkdtemp(path.join(tmpdir(),'designer-connector-'));await writeFile(path.join(dir,'server.json'),JSON.stringify({url}));return dir;}

test('local connector uses only authenticated loopback routes and returns no auth material',async()=>{
  const dir=await state(),requests:{url:string;body:any}[]=[];
  const fetcher:typeof fetch=async(url,options)=>{
    assert.equal(new URL(String(url)).hostname,'localhost');assert.equal(options?.redirect,'error');
    assert.equal(new Headers(options?.headers).get('Cookie'),`designer_session=${token}`);assert.equal(new Headers(options?.headers).get('Origin'),'http://localhost:4321');
    requests.push({url:String(url),body:options?.body?JSON.parse(String(options.body)):undefined});
    const route=new URL(String(url)).pathname;
    const handoff={requestId,task:'plan',service:'claude',instruction:'指定された構成をJSONで返してください。'};
    return new Response(JSON.stringify(route==='/api/chat-tasks'?{sessions:[{id:sessionId,title:'資料',phase:'clarifying',task:'plan'}]}:route.endsWith('chat-response')?{id:sessionId,provider:'chat',phase:'outline',messages:[{role:'assistant',text:'構成を確認してください。'}],warnings:[],variants:[]}:{id:sessionId,provider:'chat',phase:'clarifying',chatHandoff:handoff}));
  };
  try{
    const client=new ChatConnector(dir,fetcher),task=await client.task();assert.equal(task.sessionId,sessionId);assert.equal(task.paidApiCalls,0);
    const result=await handleConnector(client,{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'designer_submit_reply',arguments:{sessionId,requestId,response:'{"kind":"outline"}'}}});
    assert.equal(result!.result!.isError,false);assert.equal(JSON.parse(result!.result!.content[0].text).accepted,true);
    assert.equal(requests.at(-1)!.body.requestId,requestId);assert.equal(requests.at(-1)!.body.response,'{"kind":"outline"}');
    assert.ok(!JSON.stringify(result).includes(token));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('connector refuses public/credential/redirect-shaped startup addresses before any request',async()=>{
  let calls=0;
  for(const url of ['https://api.anthropic.com/?token='+token,'http://localhost.evil.test:4321/?token='+token,'http://user:pass@localhost:4321/?token='+token,'http://localhost:4321/redirect?token='+token,'http://localhost:4321/?token='+token+'&next=https://example.com','http://localhost:4321/?token=short']){
    const dir=await state(url);try{const client=new ChatConnector(dir,async()=>{calls++;throw new Error('must not send');});await assert.rejects(client.tasks(),/起動情報/);}finally{await rm(dir,{recursive:true,force:true});}
  }
  assert.equal(calls,0);
});

test('connector does not expose offline sessions, choose ambiguous work, or accept path-like IDs',async()=>{
  const dir=await state();let mode='multiple',calls=0;
  const client=new ChatConnector(dir,async url=>{calls++;const route=new URL(String(url)).pathname;return new Response(JSON.stringify(route==='/api/chat-tasks'?{sessions:mode==='multiple'?[{id:sessionId,task:'plan'},{id:requestId,task:'generate'}]:[]}:{id:sessionId,provider:'local',designMode:'template',chatHandoff:{requestId,instruction:'private'}}));});
  try{
    await assert.rejects(client.task(),/複数/);mode='none';await assert.rejects(client.task(),/開始/);
    await assert.rejects(client.task(sessionId),/ローカルLLM/);const prior=calls;
    await assert.rejects(client.task('../../settings.json'),/形式/);
    await assert.rejects(client.reply({sessionId,requestId,response:'x'.repeat(800_001)}),/80万/);
    assert.equal(calls,prior);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('stdio protocol reports supported tools, keeps init offline, and conceals transport errors',async()=>{
  const client=new ChatConnector('unused',async()=>{throw new Error('secret-token-transport');});
  const init=await handleConnector(client,{jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18'}});assert.equal(init!.result!.protocolVersion,'2025-06-18');
  const list=await handleConnector(client,{jsonrpc:'2.0',id:1,method:'tools/list'});assert.deepEqual(list!.result!.tools,connectorTools);
  assert.equal(await handleConnector(client,{jsonrpc:'2.0',method:'notifications/initialized'}),undefined);
  const missing=await handleConnector(client,{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'execute_shell'}});assert.equal(missing!.error!.code,-32602);
  const failure=await handleConnector(client,{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'designer_list_tasks'}});assert.equal(failure!.result!.isError,true);assert.ok(!JSON.stringify(failure).includes('secret-token-transport'));
});
