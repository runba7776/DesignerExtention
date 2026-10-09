import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import ExcelJS from 'exceljs';
import { createApp } from '../server/app.js';
import { parseDocument, documentContext, DOCUMENT_LIMITS, verifyZipBudget } from '../server/documents.js';
import { createProvider, parseJsonResponse, emptyUsage, type CompletionRequest } from '../server/providers.js';
import { validateDeck, validateOutline } from '../server/validation.js';
import { SettingsStore, validateLocalEndpoint } from '../server/settings.js';
import { SessionEngine } from '../server/engine.js';
import { demoDeck, demoOutline } from '../server/demo.js';
import type { RenderResult } from '../shared/contracts.js';

const rendered: RenderResult = { artifactId: 'artifact-test', pptxUrl: '/api/artifacts/artifact-test/presentation.pptx', thumbnails: [], native: false, warnings: [] };

test('CSV preserves cells, row locators, zero and leading zeros without truncation', async () => {
  const doc = await parseDocument('企業.csv', Buffer.from('企業,売上,コード\nA,0,0012\nB,"1,250",0098\n'));
  assert.equal(doc.kind, 'csv');
  assert.equal(doc.units, 3);
  assert.equal(doc.sources[1].locator, '行 2');
  assert.match(doc.sources[1].text, /B2="0"/);
  assert.match(doc.sources[1].text, /C2="0012"/);
  assert.match(doc.sources[2].text, /1,250/);
  assert.equal(documentContext([doc])[0].units.length, 3);
});

test('XLSX preserves sheet/cell provenance, cached formula result, rich text and missing result warning', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('比較');
  sheet.getCell('A1').value = { richText: [{ text: '売上' }, { text: '高' }] };
  sheet.getCell('B2').value = { formula: '2+3', result: 5 };
  sheet.getCell('C2').value = { formula: '2+3' };
  const doc = await parseDocument('sample.xlsx', Buffer.from(await book.xlsx.writeBuffer()));
  assert.match(doc.sources[0].text, /売上高/);
  assert.equal(doc.sources[1].locator, '比較!行 2');
  assert.match(doc.sources[1].text, /B2="5"/);
  assert.match(doc.warnings.join('\n'), /C2.*再計算/);
});

test('file bounds fail whole inputs, reject .xls and oversize XLSX archives', async () => {
  await assert.rejects(parseDocument('old.xls', Buffer.from('old')), /未対応/);
  await assert.rejects(parseDocument('large.txt', Buffer.alloc(DOCUMENT_LIMITS.bytes + 1)), /15 MB/);
  await assert.rejects(parseDocument('large.txt', Buffer.from('a'.repeat(DOCUMENT_LIMITS.characters + 1))), /省略/);
  const zip = Buffer.alloc(46);
  zip.writeUInt32LE(0x02014b50, 0); zip.writeUInt32LE(100_000_000, 24);
  assert.throws(() => verifyZipBudget(zip), /大きすぎ/);
  await assert.rejects(parseDocument('bad.pdf', Buffer.from('not a PDF')), /PDFファイル/);
});

test('local endpoints stay loopback/private and never accept public services or credentials', () => {
  assert.equal(validateLocalEndpoint('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(validateLocalEndpoint('http://192.168.2.4:8000/v1'), 'http://192.168.2.4:8000/v1');
  for (const endpoint of ['https://api.anthropic.com', 'http://169.254.169.254', 'http://user:password@localhost:8000', 'https://example.com/?next=localhost', 'file:///tmp/a', 'http://localhost.evil.test']) assert.throws(() => validateLocalEndpoint(endpoint));
});

test('paid providers and chat handoffs never create a network client; local records token counters', async () => {
  let seen: any;
  const mockFetch: typeof fetch = async (url, options) => {
    seen = { url, ...options, body: JSON.parse(String(options?.body)) };
    return new Response(JSON.stringify({ choices:[{message:{content:'{"kind":"questions","message":"対象者は？"}'}}], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
  };
  assert.throws(()=>createProvider({provider:'claude',model:'legacy',mode:'presentation'},'test-not-real',mockFetch),/有料API/);
  assert.throws(()=>createProvider({provider:'chat',model:'chat-session',mode:'presentation'},undefined,mockFetch),/指示をコピー/);
  assert.equal(Boolean(seen),false);
  const provider = createProvider({ provider: 'local', model: 'test', mode: 'presentation',endpoint:'http://127.0.0.1:11434/v1' }, undefined, mockFetch);
  const response = await provider.complete({ system: 'system', content: '資料', maxTokens: 1000 });
  assert.equal(seen.url, 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(seen.redirect, 'error');
  assert.equal(seen.body.temperature, 0.25);
  assert.equal(seen.body.top_p, undefined);
  assert.equal(seen.body.top_k, undefined);
  assert.deepEqual(response.usage, { calls: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test('local provider sends one request only to configured private endpoint and never cloud falls back', async () => {
  const urls: string[] = [];
  const provider = createProvider({ provider: 'local', model: 'my-model', mode: 'reading', endpoint: 'http://127.0.0.1:11434/v1' }, undefined, async (url) => { urls.push(String(url)); throw new Error('offline'); });
  await assert.rejects(provider.complete({ system: 'test', content: 'private', maxTokens: 10 }), /外部APIへの切り替えは行っていません/);
  assert.deepEqual(urls, ['http://127.0.0.1:11434/v1/chat/completions']);
  assert.throws(() => createProvider({ provider: 'claude', model: 'claude-sonnet-5', mode: 'presentation' }), /有料API/);
});

test('schema rejects hallucinated layouts, invalid charts and excessive slides while accepting complete demo', () => {
  const outline = demoOutline('何かを分かりやすく説明', 'presentation', []);
  const deck = demoDeck(outline);
  assert.equal(validateDeck(deck, outline).slides.length, 6);
  assert.throws(() => validateOutline({ ...outline, slides: Array.from({length:31},()=>outline.slides[1]) }), /30/);
  assert.throws(() => validateDeck({ ...deck, slides: deck.slides.map((slide, i) => i === 1 ? { ...slide, layoutId: 'execute-script' } : slide) }), /未登録/);
  const bad = structuredClone(deck); bad.slides[1].chart!.series[0].values = [1];
  assert.throws(() => validateDeck(bad), /対応/);
  assert.throws(() => parseJsonResponse('execute arbitrary code'), /形式/);
});

test('session flow preserves clarification, uses grouped generation, refreshes variants locally and stores metadata only', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'designer-engine-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'test-model' });
    const outline = demoOutline('A topic', 'presentation', []);
    const deck = demoDeck(outline);
    const results = [{ kind: 'questions', message: 'どなた向けですか？' }, { kind: 'outline', outline }, deck];
    const calls: CompletionRequest[] = [];
    const engine = new SessionEngine({ settings, dataDir: dir, render: async () => rendered, providerFactory: () => ({ complete: async (request) => { calls.push(request); return { text: JSON.stringify(results.shift()), usage: { ...emptyUsage(), calls: 1, inputTokens: 12, outputTokens: 34 } }; } }) });
    const session = await engine.create({ prompt: '原文指示を保持して説明してください' }, []);
    assert.equal(session.phase, 'clarifying');
    await engine.message(session.id, '学生向けです');
    assert.equal(session.phase, 'outline');
    assert.equal(session.messages[0].text, '原文指示を保持して説明してください');
    await engine.generate(session.id);
    assert.equal(session.phase, 'ready');
    assert.equal(calls.length, 3);
    assert.equal(session.usage.calls, 3);
    assert.equal(session.usage.inputTokens, 36);
    await engine.variants(session.id);
    assert.equal(calls.length, 3);
    assert.equal(session.variants.length, 2);
    const content=(slides:typeof session.variants[0]['deck']['slides'])=>slides.map(({layoutId,...slide})=>slide);
    assert.deepEqual(content(session.variants[0].deck.slides),content(session.variants[1].deck.slides));
    assert.notEqual(session.variants[0].deck.themeId, session.variants[1].deck.themeId);
    await engine.feedback({ sessionId: session.id, variantId: session.variants[1].id, rating: 5, reason: 'SECRET DOCUMENT CONTENT' });
    const saved = await readFile(path.join(dir, 'preferences.jsonl'), 'utf8');
    assert.doesNotMatch(saved, /SECRET|原文|A topic|学生/);
    assert.equal(JSON.parse(saved.trim()).rating, 5);
    await assert.rejects(settings.update({provider:'claude',apiKey:'secret-never-persist'}),/有料API/);
    await settings.update({ provider: 'chat', apiKey: 'secret-never-persist' });
    assert.doesNotMatch(await readFile(path.join(dir, 'settings.json'), 'utf8'), /secret-never-persist|apiKey/);
    await assert.rejects(engine.message(session.id, '修正'), /処理先が変更/);
    const manual=await engine.create({ prompt: '秘密資料' }, []);assert.equal(manual.chatHandoff?.task,'plan');assert.equal(manual.usage.calls,0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('single-slide revision updates both variants and invalidates both exports with one model call', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'designer-revision-'));
  try {
    const settings = await new SettingsStore(dir, '').load();
    await settings.update({ provider: 'local', model: 'test' });
    const outline = demoOutline('編集の検証', 'presentation', []);
    const deck = demoDeck(outline);
    const revised = { ...deck.slides[1], title: '更新した読み取り', notes: '修正後の根拠' };
    const replies = [{ kind: 'outline', outline }, deck, revised];
    const calls: CompletionRequest[] = [];
    const engine = new SessionEngine({ settings, dataDir: dir, render: async () => structuredClone(rendered), providerFactory: () => ({ complete: async request => {
      calls.push(request);
      return { text: JSON.stringify(replies.shift()), usage: { ...emptyUsage(), calls: 1 } };
    } }) });
    const session = await engine.create({ prompt: '具体例を説明してください' }, []);
    await engine.generate(session.id);
    await engine.variants(session.id);
    for (const variant of session.variants) await engine.render(session.id, variant.id);
    assert.ok(session.variants.every(v => v.render));
    const unchanged = new Map(session.variants.map(v=>[v.id,structuredClone(v.deck.slides[2])]));
    await engine.revise(session.id, { variantId: session.variants[1].id, slideId: 'slide-2', instruction: '読み取りを明確にする' });
    assert.equal(calls.length, 3);
    assert.equal(session.usage.calls, 3);
    for (const variant of session.variants) {
      assert.equal(variant.render, undefined);
      assert.equal(variant.deck.slides[1].title, revised.title);
      assert.deepEqual(variant.deck.slides[1].chart, deck.slides[1].chart);
      assert.deepEqual(variant.deck.slides[2], unchanged.get(variant.id));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid model citations are rejected before exposing ready slides', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'designer-citation-'));
  try {
    const settings = await new SettingsStore(dir, '').load(); await settings.update({ provider: 'local', model: 'test', autoRepair:false });
    const document = await parseDocument('facts.txt', Buffer.from('正しい出典の文章です。'));
    const outline = demoOutline('題名', 'presentation', []); const deck = demoDeck(outline);
    deck.slides[1].sources = [{ documentId: document.id, locator: 'p.999', quote: '捏造' }];
    const replies = [{ kind: 'outline', outline }, deck];
    const engine = new SessionEngine({ settings, dataDir: dir, render: async () => rendered, providerFactory: () => ({ complete: async () => ({ text: JSON.stringify(replies.shift()), usage: emptyUsage() }) }) });
    const session = await engine.create({ prompt: 'この資料を説明' }, [document]);
    await assert.rejects(engine.generate(session.id), /出典位置/);
    assert.equal(session.phase, 'outline');
    assert.equal(session.variants.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP boundary requires bootstrap cookie + same-origin writes; demo upload to export works without API key', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'designer-http-'));
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const token = 'a'.repeat(64);
    const app = await createApp({ authToken: token, port, dataDir: dir, webRoot: dir, artifactRoot: dir, environmentKey: '', nativeAvailable: () => false, render: async () => rendered });
    server.on('request', app);
    assert.equal((await fetch(`${origin}/api/health`)).status, 200);
    assert.equal((await fetch(`${origin}/api/settings`)).status, 401);
    const bootstrap = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' });
    assert.equal(bootstrap.status, 303);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const request = async (url: string, body?: unknown) => fetch(`${origin}${url}`, { method: body === undefined ? 'GET' : 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal((await fetch(`${origin}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(`${origin}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const settingResponse = await fetch(`${origin}/api/settings`, { method: 'PUT', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'demo', model: 'demo' }) });
    assert.equal(settingResponse.status, 200);
    const form = new FormData(); form.append('files', new Blob(['項目,値\nA,5']), 'test.csv');
    const uploaded = await fetch(`${origin}/api/documents`, { method: 'POST', headers: { Cookie: cookie, Origin: origin }, body: form });
    assert.equal(uploaded.status, 200);
    const { documents } = await uploaded.json() as any;
    const created = await request('/api/sessions', { prompt: '何でも説明できる資料', documentIds: documents.map((d: any) => d.id) });
    assert.equal(created.status, 200);
    let session: any = await created.json();
    session = await (await request(`/api/sessions/${session.id}/messages`, { text: 'おまかせ' })).json();
    assert.equal(session.phase, 'outline');
    session = await (await request(`/api/sessions/${session.id}/generate`, {})).json();
    assert.equal(session.phase, 'ready');
    assert.equal(session.usage.calls, 0);
    assert.equal((await request(`/api/sessions/${session.id}/render`, { variantId: session.variants[0].id })).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
