import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {exportJWK,SignJWT} from 'jose';
import {ChatGptSubscription,type ChatGptSubscriptionOptions} from '../server/chatgpt-subscription.js';
import type {CredentialStorage} from '../server/subscription-storage.js';
import {OutputLimitError} from '../server/providers.js';

const issuer='https://auth.openai.com',resource='https://api.openai.com/v1',clientId='oaiapp_test_registered_client';
const requiredScope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const storageFactory=()=>{let value:unknown;const writes:unknown[]=[];const storage:CredentialStorage={read:async()=>value,write:async next=>{value=structuredClone(next);writes.push(structuredClone(next));}};return {storage,writes,read:()=>value};};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function event(type:string,value:unknown){return `event: ${type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;}
async function setup(){
  const directory=await mkdtemp(path.join(tmpdir(),'designer-chatgpt-oauth-'));
  const {publicKey,privateKey}=await new Promise<{publicKey:import('node:crypto').KeyObject;privateKey:import('node:crypto').KeyObject}>((resolve,reject)=>generateKeyPair('rsa',{modulusLength:2048},(error,pub,priv)=>error?reject(error):resolve({publicKey:pub,privateKey:priv})));
  const jwk=await exportJWK(publicKey);Object.assign(jwk,{kid:'isolated-test-key',alg:'RS256',use:'sig'});
  const jwks={keys:[jwk]};let oauthCount=0,modelsCount=0,completionCount=0,revokeCount=0,failRefresh=false,clock=Date.now(),delayRevoke:(()=>Promise<void>)|undefined;
  const calls:{url:string;method:string;body:any}[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input),method=init?.method??'GET',body=typeof init?.body==='string'?Object.fromEntries(new URLSearchParams(init.body)):init?.body instanceof URLSearchParams?Object.fromEntries(init.body):undefined;
    calls.push({url,method,body});
    if(url===`${issuer}/.well-known/openid-configuration`)return json({issuer,authorization_endpoint:`${issuer}/api/accounts/authorize`,token_endpoint:`${issuer}/api/accounts/oauth/token`,jwks_uri:`${issuer}/.well-known/jwks.json`,revocation_endpoint:`${issuer}/api/accounts/oauth/revoke`});
    if(url===`${issuer}/.well-known/jwks.json`)return json(jwks);
    if(url===`${issuer}/api/accounts/oauth/token`){
      if(body?.grant_type==='authorization_code'){oauthCount++;return json({access_token:`fake-access-${oauthCount}`,refresh_token:`fake-refresh-${oauthCount}`,id_token:body.code==='other-account'?await makeToken(privateKey,'another-subject','wrong-nonce'):await makeToken(privateKey,'test-subject',body.code==='bad-nonce'? 'incorrect-nonce':String(body.nonce??'unused-nonce')),token_type:'Bearer',expires_in:3600,scope:body.scope??requiredScope});}
      if(body?.grant_type==='refresh_token'){if(failRefresh)return json({error:'invalid_grant'},400);return json({access_token:'rotated-fake-access',refresh_token:'rotated-fake-refresh',token_type:'Bearer',expires_in:30,scope:requiredScope,earliest_refresh_at:clock+60000});}
      return json({error:'unexpected grant'},400);
    }
    if(url===`${resource}/models`){modelsCount++;return json({models:[{slug:'gpt-test-model',display_name:'Mock GPT',visibility:'list'},{slug:'hidden',display_name:'Hidden',visibility:'private'}]});}
    if(url===`${resource}/responses`){completionCount++;const payload=JSON.parse(String(init?.body));assert.equal(payload.store,false);assert.equal(payload.stream,true);assert.equal(payload.max_output_tokens,undefined);assert.match(String(init?.headers&&new Headers(init.headers).get('authorization')),/^Bearer fake-/);return new Response(event('response.output_text.delta',{type:'response.output_text.delta',delta:'{"kind":"outline"}'})+event('response.completed',{type:'response.completed',response:{status:'completed',usage:{input_tokens:31,output_tokens:7},output:[{type:'message',content:[{type:'output_text',text:'{"kind":"outline"}'}]}]}}),{headers:{'Content-Type':'text/event-stream'}});}
    if(url===`${issuer}/api/accounts/oauth/revoke`){if(delayRevoke)await delayRevoke();revokeCount++;return new Response(null,{status:200});}
    throw new Error(`unexpected mock request ${method} ${url}`);
  };
  const opened:string[]=[];const memory=storageFactory();const options:ChatGptSubscriptionOptions={storage:memory.storage,fetcher,openBrowser:async url=>{opened.push(url);},now:()=>clock};
  const nonceFor=(verifier:string)=>{const challenge=createHash('sha256').update(verifier).digest('base64url');return new URL(opened.find(url=>new URL(url).searchParams.get('code_challenge')===challenge)!).searchParams.get('nonce')!;};
  const exchangeCode:(body:Record<string,string>|undefined)=>string=body=>body?.code==='bad-nonce'?'incorrect-nonce':body?.code==='other-account'?'wrong-nonce':nonceFor(body?.code_verifier??'');
  const effectiveFetcher:typeof fetch=async(input,init)=>{
    if(String(input)===`${issuer}/api/accounts/oauth/token`&&init?.method==='POST'){
      const body=Object.fromEntries(new URLSearchParams(String(init.body)));
      if(body.grant_type==='authorization_code'){
        oauthCount++;
        const subject=body.code==='other-account'?'another-subject':'test-subject';
        const token=await makeToken(privateKey,subject,exchangeCode(body));
        return json({access_token:`fake-access-${oauthCount}`,refresh_token:`fake-refresh-${oauthCount}`,id_token:token,token_type:'Bearer',expires_in:3600,scope:body.code==='no-plan-scope'?'openid profile email offline_access':requiredScope});
      }
    }
    return fetcher(input,init);
  };
  options.fetcher=effectiveFetcher;
  const client=await new ChatGptSubscription(directory,options).load();
  return {directory,client,opened,calls,memory,get oauthCount(){return oauthCount;},get modelsCount(){return modelsCount;},get completionCount(){return completionCount;},get revokeCount(){return revokeCount;},get clock(){return clock;},set clock(value:number){clock=value;},set failRefresh(value:boolean){failRefresh=value;},set delayRevoke(value:(()=>Promise<void>)|undefined){delayRevoke=value;},close:async()=>{client.dispose();await rm(directory,{recursive:true,force:true});}};
}
async function makeToken(key:import('node:crypto').KeyObject,subject:string,nonce:string){return new SignJWT({nonce,email:'local-test@example.invalid',name:'Mock User'}).setProtectedHeader({alg:'RS256',kid:'isolated-test-key'}).setIssuer(issuer).setAudience(clientId).setIssuedAt().setExpirationTime('5m').setSubject(subject).sign(key);}
async function callbackFromLogin(urlText:string,code='first-registration'){
  const authorize=new URL(urlText),redirect=new URL(authorize.searchParams.get('redirect_uri')!),callback=new URL('/auth/callback',redirect);
  callback.searchParams.set('state',authorize.searchParams.get('state')!);callback.searchParams.set('code',code);callback.searchParams.set('client_id',clientId);
  return {authorize,redirect,callback};
}

test('official ChatGPT OAuth uses PKCE loopback and validates signed identity+nonce before storing account',async()=>{
  const f=await setup();try{
    assert.equal((await f.client.status()).state,'disconnected');
    const pending=await f.client.connect({newAccount:true});assert.equal(pending.state,'pending');assert.equal(pending.canGenerate,false);
    const {authorize,callback}=await callbackFromLogin(f.opened[0]);
    assert.equal(authorize.origin,issuer);assert.equal(authorize.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(authorize.searchParams.get('resource'),resource);assert.equal(authorize.searchParams.get('response_type'),'code');assert.ok(authorize.searchParams.get('scope')?.includes('chatgpt.tokens.use.direct'));assert.equal(authorize.searchParams.get('ext_agent_host_id')?.startsWith('urn:uuid:'),true);assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');assert.match(authorize.searchParams.get('code_challenge')!,/^[A-Za-z0-9_-]{43}$/);
    const response=await fetch(callback);assert.equal(response.status,200);assert.match(await response.text(),/接続が完了しました/);
    const connected=await f.client.status();assert.equal(connected.state,'connected');assert.equal(connected.account?.email,'local-test@example.invalid');assert.equal(connected.models[0].id,'gpt-test-model');assert.equal(connected.canGenerate,true);assert.equal(JSON.stringify(connected).includes('fake-access'),false);assert.equal(JSON.stringify(f.memory.read()).includes('fake-access'),true);assert.equal(f.modelsCount,1);
    const saved=f.memory.read() as any;assert.equal(saved.accounts[0].clientId,clientId);assert.equal(saved.accounts[0].scopes.includes('chatgpt.tokens.use.direct'),true);assert.equal(saved.hostId,authorize.searchParams.get('ext_agent_host_id'));assert.equal(saved.accounts[0].refreshToken,'fake-refresh-1');
    const completion=await f.client.provider('auto').complete({system:'JSONだけ返す',content:'テスト資料',maxTokens:16000});assert.equal(completion.text,'{"kind":"outline"}');assert.equal(completion.usage.calls,1);assert.equal(completion.usage.inputTokens,31);assert.equal(completion.usage.outputTokens,7);assert.equal(f.completionCount,1);
  }finally{await f.close();}
});

test('wrong OAuth state and signed OIDC nonce never exchange or replace an active connection',async()=>{
  const f=await setup();try{
    await f.client.connect({newAccount:true});const first=await callbackFromLogin(f.opened[0]);
    const wrong=new URL(first.callback);wrong.searchParams.set('state','not-the-authorized-state');assert.equal((await fetch(wrong)).status,400);assert.equal(f.oauthCount,0);assert.equal((await f.client.status()).state,'pending');f.client.dispose();
    await f.client.connect({newAccount:true});const second=await callbackFromLogin(f.opened[1],'bad-nonce');assert.equal((await fetch(second.callback)).status,400);assert.equal(f.oauthCount,1);assert.equal((await f.client.status()).state,'error');assert.equal((f.memory.read() as any).accounts.length,0);
    assert.notEqual(first.authorize.searchParams.get('state'),second.authorize.searchParams.get('state'));
  }finally{await f.close();}
});

test('existing account reauthorization retains its client ID and refuses a different signed-in identity',async()=>{
  const f=await setup();try{
    await f.client.connect({newAccount:true});let login=await callbackFromLogin(f.opened.at(-1)!);await fetch(login.callback);
    const before=f.client.binding();await f.client.connect();login=await callbackFromLogin(f.opened.at(-1)!,'other-account');assert.equal(login.authorize.searchParams.get('client_id'),clientId);assert.equal(login.authorize.searchParams.get('agent_name_hint'),null);
    await fetch(login.callback);assert.equal(f.client.binding(),before);assert.equal((await f.client.status()).state,'error');assert.equal((f.memory.read() as any).accounts.length,1);assert.equal((f.memory.read() as any).accounts[0].subject,'test-subject');
  }finally{await f.close();}
});

test('missing plan scope disables inference and never falls back to another billing route',async()=>{
  const f=await setup();try{
    await f.client.connect({newAccount:true});await fetch((await callbackFromLogin(f.opened[0],'no-plan-scope')).callback);
    const status=await f.client.status();assert.equal(status.state,'permission_required');assert.equal(status.canGenerate,false);assert.equal(f.completionCount,0);
    assert.match(status.message,/許可/);assert.equal(JSON.stringify(f.calls).includes('api_key'),false);
  }finally{await f.close();}
});

test('refresh rotates credentials, waits for the allowed refresh time and revokes locally before disconnect returns',async()=>{
  const f=await setup();try{
    await f.client.connect({newAccount:true});await fetch((await callbackFromLogin(f.opened[0])).callback);
    const first=(f.memory.read() as any).accounts[0],refreshNow=first.expiresAt-30000;f.clock=refreshNow;await f.client.refresh();assert.equal((f.memory.read() as any).accounts[0].accessToken,'rotated-fake-access');assert.equal((f.memory.read() as any).accounts[0].refreshToken,'rotated-fake-refresh');
    const before=f.calls.length;f.clock=refreshNow+31000;await assert.rejects(f.client.provider('auto').complete({system:'system',content:'keep-local',maxTokens:100}),/まだ更新できません/);assert.equal(f.calls.length,before);
    let release!:(()=>void);f.delayRevoke=()=>new Promise(resolve=>{release=resolve;});const disconnected=f.client.disconnect();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.client.binding(),undefined);assert.equal((await f.client.status()).state,'disconnected');assert.equal((f.memory.read() as any).accounts[0].refreshToken,undefined);release();assert.equal((await disconnected).state,'disconnected');assert.equal(f.revokeCount,1);
  }finally{await f.close();}
});

test('fragmented CRLF SSE completes; output caps, failure events and missing terminal events are rejected',async()=>{
  const success=event('response.output_text.delta',{type:'response.output_text.delta',delta:'complete'})+event('response.completed',{type:'response.completed',response:{status:'completed'}});
  const {readCompletion}=await import('../server/chatgpt-subscription.js');
  const fragmented=new ReadableStream<Uint8Array>({start(controller){const bytes=new TextEncoder().encode(success);for(let i=0;i<bytes.length;i+=5)controller.enqueue(bytes.slice(i,i+5));controller.close();}});
  assert.equal((await readCompletion(new Response(fragmented))).text,'complete');
  const limited=event('response.output_text.delta',{type:'response.output_text.delta',delta:'unfinished'})+event('response.incomplete',{type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}});
  await assert.rejects(readCompletion(new Response(limited)),error=>error instanceof OutputLimitError&&error.partialText==='unfinished');
  const failed=event('response.failed',{type:'response.failed',response:{error:{code:'subscription_sharing_usage_limit_exceeded'}}});
  await assert.rejects(readCompletion(new Response(failed)),error=>Boolean(error&&typeof error==='object'&&'code'in error&&error.code==='SUBSCRIPTION_LIMIT'&&!(error as any).message.includes('api_key')));
  await assert.rejects(readCompletion(new Response(event('response.output_text.delta',{type:'response.output_text.delta',delta:'partial'}))),/完了前に切れました/);
});

test('Windows protects OAuth vault using DPAPI when available; permissions reject tampered files on other systems',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'designer-subscription-vault-'));
  try{
    const {ProtectedCredentialStorage}=await import('../server/subscription-storage.js');const store=new ProtectedCredentialStorage(directory);await store.write({secret:'mock-refresh-token'});
    const stored=await readFile(path.join(directory,'chatgpt-login.dat'));
    if(process.platform==='win32'){assert.match(stored.toString('ascii',0,7),/^DPAPI1:/);assert.doesNotMatch(stored.toString('utf8'),/mock-refresh-token/);}
    assert.deepEqual(await store.read(),{secret:'mock-refresh-token'});
    if(process.platform!=='win32'){await import('node:fs/promises').then(fs=>fs.chmod(path.join(directory,'chatgpt-login.dat'),0o644));await assert.rejects(store.read(),/権限/);}
  }finally{await rm(directory,{recursive:true,force:true});}
});
