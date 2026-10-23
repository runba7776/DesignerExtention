import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp, type AppOptions } from '../server/app.js';
import { demoOutline, demoDeck } from '../server/demo.js';
import { emptyUsage, type CompletionRequest } from '../server/providers.js';
import type {
  Settings,
  SubscriptionConnection,
  SubscriptionService,
  SubscriptionStatus,
  Session,
} from '../shared/contracts.js';

type Manager = NonNullable<AppOptions['subscriptionManager']>;
class FakeManager implements Manager {
  private credential = 'FAKE_PRIVATE_CREDENTIAL_NEVER_RETURN';
  private active: Partial<Record<SubscriptionService, string>> = {};
  private revisions: Partial<Record<SubscriptionService, number>> = {};
  operations: { operation: string; service: SubscriptionService; input?: unknown }[] = [];
  calls: { settings: Settings; request: CompletionRequest }[] = [];
  async status(): Promise<SubscriptionStatus> {
    return { services: [await this.connection('chatgpt'), await this.connection('claude')] };
  }
  async connect(
    service: SubscriptionService,
    input: { accountId?: unknown; newAccount?: unknown } = {},
  ): Promise<SubscriptionConnection> {
    this.operations.push({ operation: 'connect', service, input });
    this.active[service] =
      typeof input.accountId === 'string' ? input.accountId : input.newAccount ? 'account-b' : 'account-a';
    this.revisions[service] = (this.revisions[service] ?? 0) + 1;
    return this.connection(service);
  }
  async refresh(service: SubscriptionService) {
    this.operations.push({ operation: 'refresh', service });
    return this.connection(service);
  }
  async disconnect(service: SubscriptionService) {
    this.operations.push({ operation: 'disconnect', service });
    delete this.active[service];
    this.revisions[service] = (this.revisions[service] ?? 0) + 1;
    return this.connection(service);
  }
  binding(service: SubscriptionService) {
    return this.active[service] ? `${service}:${this.active[service]}:${this.revisions[service]}` : undefined;
  }
  createProvider(settings: Settings) {
    assert.equal(settings.provider, 'subscription');
    assert.ok(this.credential);
    assert.ok(this.binding(settings.subscriptionService ?? 'chatgpt'));
    return {
      complete: async (request: CompletionRequest) => {
        this.calls.push({ settings: { ...settings }, request });
        const input = JSON.parse(request.content).request;
        const outline = demoOutline('サブスクリプションの連携確認', 'presentation', [], 6),
          deck = demoDeck(outline);
        const value = input.targetSlides
          ? {
              ...deck,
              slides: deck.slides.filter(slide => input.targetSlides.some((target: any) => target.id === slide.id)),
            }
          : input.targetSlide
            ? { ...input.targetSlide, title: '修正後の説明' }
            : { kind: 'outline', outline };
        return { text: JSON.stringify(value), usage: { ...emptyUsage(), calls: 1, inputTokens: 10, outputTokens: 20 } };
      },
    };
  }
  private async connection(service: SubscriptionService): Promise<SubscriptionConnection> {
    const accountId = this.active[service];
    return {
      service,
      state: accountId ? 'connected' : 'disconnected',
      message: accountId ? '接続済み' : '未接続',
      ...(accountId ? { account: { id: accountId, label: 'テスト用アカウント', active: true } } : {}),
      accounts: accountId ? [{ id: accountId, label: 'テスト用アカウント', active: true }] : [],
      models: [{ id: 'mock-model', name: 'テスト用モデル' }],
      canGenerate: Boolean(accountId),
      canConnect: true,
    };
  }
}

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'de-subscription-http-')),
    server = createServer(),
    manager = new FakeManager();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port,
    origin = `http://127.0.0.1:${port}`,
    token = 'b'.repeat(64);
  try {
    const app = await createApp({
      authToken: token,
      port,
      dataDir: directory,
      webRoot: directory,
      artifactRoot: directory,
      environmentKey: 'FAKE_ENV_NEVER_LOAD',
      subscriptionManager: manager,
      nativeAvailable: () => false,
      render: async () => ({
        artifactId: 'fake',
        pptxUrl: '/api/artifacts/fake/presentation.pptx',
        thumbnails: [],
        warnings: [],
        native: false,
      }),
    });
    server.on('request', app);
    const boot = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' });
    assert.equal(boot.status, 303);
    const cookie = boot.headers.get('set-cookie')!.split(';')[0];
    const request = async (url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
      const response = await fetch(`${origin}/api${url}`, {
        method,
        headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: (await response.json()) as any };
    };
    return {
      directory,
      manager,
      origin,
      cookie,
      request,
      dispose: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

test('subscription HTTP routes require a local authenticated origin and return public connection metadata only', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.origin}/api/subscriptions`)).status, 401);
    assert.equal(
      (
        await fetch(`${f.origin}/api/subscriptions/chatgpt/connect`, {
          method: 'POST',
          headers: { Origin: f.origin, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${f.origin}/api/subscriptions/chatgpt/connect`, {
          method: 'POST',
          headers: { Cookie: f.cookie, Origin: 'https://outside.example', 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${f.origin}/api/subscriptions/chatgpt/disconnect`, {
          method: 'POST',
          headers: { Cookie: f.cookie, 'Content-Type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal((await f.request('/subscriptions/untrusted/connect', {})).status, 400);
    assert.equal(f.manager.operations.length, 0);
    const before = await f.request('/subscriptions');
    assert.equal(before.status, 200);
    assert.equal(before.body.services.length, 2);
    const connected = await f.request('/subscriptions/chatgpt/connect', { newAccount: true });
    assert.equal(connected.status, 200);
    assert.equal(connected.body.state, 'connected');
    assert.equal(connected.body.account.id, 'account-b');
    assert.equal((await f.request('/subscriptions/chatgpt/refresh', {})).status, 200);
    assert.equal((await f.request('/subscriptions/claude/connect', {})).status, 200);
    const status = await f.request('/subscriptions');
    assert.doesNotMatch(
      JSON.stringify(status.body),
      /FAKE_PRIVATE|FAKE_ENV|accessToken|refreshToken|idToken|apiKey|binding|credential/,
    );
    const disconnected = await f.request('/subscriptions/chatgpt/disconnect', {});
    assert.equal(disconnected.body.state, 'disconnected');
    assert.equal(disconnected.body.canGenerate, false);
    assert.deepEqual(
      f.manager.operations.map(operation => `${operation.service}:${operation.operation}`),
      ['chatgpt:connect', 'chatgpt:refresh', 'claude:connect', 'chatgpt:disconnect'],
    );
    assert.equal(f.manager.calls.length, 0);
  } finally {
    await f.dispose();
  }
});

test('mock login provider completes create, generate and revise through HTTP, with consent and changed-account guards', async () => {
  const f = await fixture();
  try {
    const selected = await f.request(
      '/settings',
      {
        provider: 'subscription',
        subscriptionService: 'chatgpt',
        autoRepair: false,
        designMode: 'template',
        apiKey: 'FAKE_UNUSED_API_SECRET',
      },
      'PUT',
    );
    assert.equal(selected.status, 200);
    assert.equal(selected.body.model, 'auto');
    assert.equal(selected.body.hasKey, false);
    let response = await f.request('/sessions', { prompt: '入力から分かりやすく説明', documentIds: [] });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CLOUD_CONSENT_REQUIRED');
    response = await f.request('/sessions', {
      prompt: '入力から分かりやすく説明',
      documentIds: [],
      cloudConsent: true,
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SUBSCRIPTION_CONNECTION_REQUIRED');
    assert.equal(f.manager.calls.length, 0);
    await f.request('/subscriptions/chatgpt/connect', {});
    response = await f.request('/sessions', {
      prompt: '入力から分かりやすく説明',
      documentIds: [],
      cloudConsent: true,
    });
    assert.equal(response.status, 200);
    let session = response.body as Session;
    assert.equal(session.phase, 'outline');
    assert.equal(session.subscriptionService, 'chatgpt');
    assert.equal(session.chatHandoff, undefined);
    response = await f.request(`/sessions/${session.id}/generate`, {});
    assert.equal(response.status, 200);
    session = response.body;
    assert.equal(session.phase, 'ready');
    assert.equal(session.variants[0].deck.slides.length, 6);
    response = await f.request(`/sessions/${session.id}/revise`, {
      slideId: 'slide-2',
      variantId: session.variants[0].id,
      instruction: '見出しを分かりやすく変更',
    });
    assert.equal(response.status, 200);
    session = response.body;
    assert.equal(session.variants[0].deck.slides[1].title, '修正後の説明');
    assert.equal(f.manager.calls.length, 3);
    assert.equal(session.usage.calls, 3);
    assert.equal(session.usage.inputTokens, 30);
    const history = await f.request(`/history/${session.historyId}/open`, {});
    assert.equal(history.status, 200);
    assert.equal(history.body.session.cloudConsentRequired, true);
    const restoredId = history.body.session.id;
    response = await f.request(`/sessions/${restoredId}/messages`, { text: 'さらに説明を変更' });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'CLOUD_CONSENT_REQUIRED');
    assert.equal(f.manager.calls.length, 3);
    assert.equal((await f.request(`/sessions/${restoredId}/cloud-consent`, { cloudConsent: true })).status, 200);
    await f.request('/subscriptions/chatgpt/connect', { accountId: 'account-b' });
    response = await f.request(`/sessions/${restoredId}/messages`, { text: '別アカウントには送信しない' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SUBSCRIPTION_ACCOUNT_CHANGED');
    assert.equal(f.manager.calls.length, 3);
    await f.request('/subscriptions/chatgpt/disconnect', {});
    response = await f.request(`/sessions/${session.id}/revise`, { slideId: 'slide-2', instruction: '切断後の指示' });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'SUBSCRIPTION_CONNECTION_REQUIRED');
    assert.equal(f.manager.calls.length, 3);
    const persisted = await readFile(path.join(f.directory, 'settings.json'), 'utf8');
    assert.doesNotMatch(persisted, /FAKE_UNUSED|FAKE_PRIVATE|FAKE_ENV|apiKey|refreshToken|accessToken/);
    for (const call of f.manager.calls) {
      assert.equal(call.settings.provider, 'subscription');
      assert.equal(call.settings.subscriptionService, 'chatgpt');
    }
  } finally {
    await f.dispose();
  }
});
