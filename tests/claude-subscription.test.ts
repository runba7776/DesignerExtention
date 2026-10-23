import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ClaudeSubscription,
  claudeEnvironment,
  runClaude,
  type ClaudeRun,
  type ClaudeRunResult,
  type ClaudeRunner,
} from '../server/claude-subscription.js';
import { AppError } from '../server/errors.js';
import { OutputLimitError } from '../server/providers.js';

const help =
  '--safe-mode --setting-sources --tools --disallowedTools --no-session-persistence --permission-prompts --output-format --model --strict-mcp-config --mcp-config';
const auth = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'pro',
  email: 'student@example.test',
  orgId: 'personal',
};
const request = { system: '日本語のJSONを返す。', content: '機密文書 $(secret) `code` --console', maxTokens: 16000 };
const response = (value: unknown, exitCode = 0): ClaudeRunResult => ({ stdout: JSON.stringify(value), exitCode });
async function setup(override?: (run: ClaudeRun) => Promise<ClaudeRunResult> | ClaudeRunResult) {
  const cwd = await mkdtemp(path.join(tmpdir(), 'designer-claude-')),
    calls: ClaudeRun[] = [];
  const runner: ClaudeRunner = async run => {
    calls.push(run);
    if (run.args.includes('--version')) return { stdout: '2.1.291 (Claude Code)', exitCode: 0 };
    if (run.args.includes('--help')) return { stdout: help, exitCode: 0 };
    return override
      ? override(run)
      : run.args.includes('status')
        ? response(auth)
        : response({ result: '{"kind":"outline"}', usage: { input_tokens: 120, output_tokens: 45 } });
  };
  const client = new ClaudeSubscription({
    cwd,
    command: { file: 'official-claude', args: ['original-cli.js'] },
    runner,
    env: {
      PATH: 'safe-path',
      USERPROFILE: 'private-home',
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_AUTH_TOKEN: 'test-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'test-oauth',
      NODE_OPTIONS: '--import malicious.js',
      APP_SECRET: 'hidden',
    },
  });
  return { client, calls, cwd, close: () => rm(cwd, { recursive: true, force: true }) };
}

test('official runtime uses its own subscription auth and shell-free stdin; no inherited API secrets or raw identities', async () => {
  const { client, calls, close } = await setup();
  try {
    const status = await client.status();
    assert.equal(status.canGenerate, true);
    assert.equal(status.account?.email, auth.email);
    assert.ok(client.binding());
    assert.ok(!client.binding()!.includes(auth.email));
    const completion = await client.provider('sonnet').complete(request);
    assert.equal(completion.text, '{"kind":"outline"}');
    assert.equal(completion.usage.calls, 1);
    assert.equal(completion.usage.inputTokens, 120);
    assert.equal(completion.usage.estimatedCostUsd, undefined);
    const run = calls.find(run => run.args.includes('-p'))!;
    assert.ok(!run.args.includes(request.content));
    assert.ok(!run.args.includes('--bare'));
    assert.ok(!run.args.includes('--dangerously-skip-permissions'));
    assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
    assert.equal(run.args[run.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(run.args[run.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    assert.equal(JSON.parse(run.stdin!).input, request.content);
    assert.equal(run.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '16000');
    assert.equal(run.env.PATH, 'safe-path');
    assert.equal(run.env.CLAUDE_CONFIG_DIR, path.join(run.cwd, 'config'));
    for (const secret of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'NODE_OPTIONS',
      'APP_SECRET',
    ])
      assert.equal(run.env[secret], undefined);
    assert.equal(calls.filter(run => run.args.includes('status')).length, 3);
  } finally {
    await close();
  }
});

test('API, Console, token-only, external providers, free/unknown plans and unidentifiable accounts never generate', async () => {
  for (const invalid of [
    { authMethod: 'api_key' },
    { authMethod: 'oauth_token' },
    { authMethod: 'api_key_helper' },
    { apiProvider: 'bedrock' },
    { apiKeySource: 'ANTHROPIC_API_KEY' },
    { subscriptionType: 'free' },
    { subscriptionType: 'unknown' },
    { email: undefined },
    { loggedIn: false },
  ]) {
    const { client, calls, close } = await setup(run =>
      run.args.includes('status') ? response({ ...auth, ...invalid }) : response({ result: 'must not call' }),
    );
    try {
      const status = await client.status();
      assert.equal(status.canGenerate, false);
      assert.equal(client.binding(), undefined);
      await assert.rejects(
        client.provider('sonnet').complete(request),
        error => error instanceof AppError && error.code === 'SUBSCRIPTION_CONNECTION_REQUIRED',
      );
      assert.equal(calls.filter(run => run.args.includes('-p')).length, 0);
    } finally {
      await close();
    }
  }
});

test('provider binds both identity and connection generation before any document is sent', async () => {
  let account = { ...auth };
  const { client, calls, close } = await setup(run =>
    run.args.includes('status') ? response(account) : response({ result: '{}' }),
  );
  try {
    await client.status();
    const provider = client.provider('sonnet'),
      prior = client.binding();
    account = { ...auth, email: 'other@example.test' };
    await assert.rejects(
      provider.complete(request),
      error => error instanceof AppError && error.code === 'SUBSCRIPTION_ACCOUNT_CHANGED',
    );
    assert.notEqual(client.binding(), prior);
    assert.equal(calls.filter(run => run.args.includes('-p')).length, 0);
    account = { ...auth };
    await client.status();
    const previous = client.provider('sonnet');
    await client.disconnect();
    await client.status();
    await assert.rejects(
      previous.complete(request),
      error => error instanceof AppError && error.code === 'SUBSCRIPTION_ACCOUNT_CHANGED',
    );
    assert.equal(calls.filter(run => run.args.includes('-p')).length, 0);
  } finally {
    await close();
  }
});

test('automatic model selects Sonnet and a mid-generation account switch prevents importing the result', async () => {
  let account = { ...auth };
  const { client, calls, close } = await setup(run => {
    if (run.args.includes('status')) return response(account);
    account = { ...auth, email: 'changed-during-run@example.test' };
    return response({ result: '{"must":"not-import"}', usage: { output_tokens: 30 } });
  });
  try {
    await client.status();
    await assert.rejects(
      client.provider('auto').complete(request),
      error =>
        error instanceof AppError && error.code === 'SUBSCRIPTION_ACCOUNT_CHANGED' && !error.message.includes('must'),
    );
    const generation = calls.find(run => run.args.includes('-p'))!;
    assert.equal(generation.args[generation.args.indexOf('--model') + 1], 'sonnet');
    assert.equal(calls.filter(run => run.args.includes('-p')).length, 1);
  } finally {
    await close();
  }
});

test('connect delegates official browser authentication without collecting codes or tokens, and pending login can be canceled', async () => {
  let finishLogin!: (value: ClaudeRunResult) => void;
  let pending = new Promise<ClaudeRunResult>(resolve => {
    finishLogin = resolve;
  });
  const { client, calls, close } = await setup(run =>
    run.args.includes('login') ? pending : run.args.includes('status') ? response(auth) : response({}),
  );
  try {
    const status = await client.connect();
    assert.equal(status.state, 'pending');
    assert.equal(status.canGenerate, false);
    assert.ok(status.pendingExpiresAt);
    assert.equal((await client.status()).state, 'pending');
    const login = calls.find(run => run.args.includes('login'))!;
    assert.deepEqual(login.args, ['auth', 'login']);
    assert.equal(login.stdin, undefined);
    assert.equal(login.discardOutput, true);
    assert.ok(!JSON.stringify(status).includes('token'));
    finishLogin({ stdout: 'vendor-owned-browser-flow', exitCode: 0 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await client.status()).state, 'connected');
    pending = new Promise<ClaudeRunResult>(resolve => {
      finishLogin = resolve;
    });
    await client.connect();
    const latest = calls.filter(run => run.args.includes('login')).at(-1)!;
    await client.disconnect();
    assert.equal(latest.signal!.aborted, true);
    assert.equal(client.binding(), undefined);
  } finally {
    await close();
  }
});

test('missing or older official runtimes fail closed without auth or model calls', async () => {
  for (const variant of ['missing', 'old']) {
    const cwd = await mkdtemp(path.join(tmpdir(), 'designer-claude-')),
      calls: string[][] = [];
    const runner: ClaudeRunner = async run => {
      calls.push(run.args);
      if (variant === 'missing') throw new Error('private-runtime-detail');
      return { stdout: run.args.includes('--version') ? '2.1.50 (Claude Code)' : '--output-format', exitCode: 0 };
    };
    const client = new ClaudeSubscription({ cwd, command: 'official-claude', runner });
    try {
      const status = await client.status();
      assert.equal(status.state, 'unavailable');
      assert.equal(status.canConnect, false);
      assert.ok(!status.message.includes('private-runtime-detail'));
      assert.ok(!calls.flat().includes('status'));
      assert.ok(!calls.flat().includes('-p'));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
});

test('CLI error wrappers classify limits, expired login and output limits without leaking diagnostics or auto retrying', async () => {
  for (const [failure, exitCode, code] of [
    [{ is_error: true, result: 'Rate limit reached PRIVATE-CONTENT' }, 1, 'SUBSCRIPTION_LIMIT'],
    [{ is_error: true, result: 'OAuth login expired PRIVATE-CONTENT' }, 1, 'SUBSCRIPTION_CONNECTION_REQUIRED'],
    [{ is_error: true, result: 'PRIVATE-CONTENT' }, 1, 'SUBSCRIPTION_RESPONSE'],
    [{ stop_reason: 'max_tokens', result: 'partial' }, 0, 'OUTPUT_LIMIT'],
  ] as const) {
    const { client, calls, close } = await setup(run =>
      run.args.includes('status') ? response(auth) : response(failure, exitCode),
    );
    try {
      await client.status();
      await assert.rejects(
        client.provider('sonnet').complete(request),
        error =>
          error instanceof AppError &&
          error.code === code &&
          !error.message.includes('PRIVATE-CONTENT') &&
          (code !== 'OUTPUT_LIMIT' || error instanceof OutputLimitError),
      );
      assert.equal(calls.filter(run => run.args.includes('-p')).length, 1);
    } finally {
      await close();
    }
  }
});

test('structured outputs are accepted; malformed CLI wrappers and invalid models stay bounded', async () => {
  const { client, calls, close } = await setup(run =>
    run.args.includes('status')
      ? response(auth)
      : response({ structured_output: { kind: 'outline' }, usage: { output_tokens: -1, total_cost_usd: 999 } }),
  );
  try {
    await client.status();
    assert.throws(() => client.provider('sonnet; echo hacked'), /モデル/);
    const completion = await client.provider('haiku').complete(request);
    assert.equal(completion.text, '{"kind":"outline"}');
    assert.equal(completion.usage.outputTokens, 0);
    assert.equal(completion.usage.estimatedCostUsd, undefined);
    assert.equal(calls.find(run => run.args.includes('-p'))!.maxOutputBytes, 4 * 1024 * 1024);
  } finally {
    await close();
  }
  const broken = await setup(run =>
    run.args.includes('status') ? response(auth) : { stdout: 'non-json-secret', exitCode: 1 },
  );
  try {
    await broken.client.status();
    await assert.rejects(
      broken.client.provider('sonnet').complete(request),
      error =>
        error instanceof AppError && error.code === 'SUBSCRIPTION_CONNECTION' && !error.message.includes('secret'),
    );
  } finally {
    await broken.close();
  }
});

test('active generation refuses reconnect, logout and another model call', async () => {
  let finish!: (value: ClaudeRunResult) => void;
  const pending = new Promise<ClaudeRunResult>(resolve => {
    finish = resolve;
  });
  const { client, calls, close } = await setup(run => (run.args.includes('status') ? response(auth) : pending));
  try {
    await client.status();
    const provider = client.provider('sonnet'),
      completion = provider.complete(request);
    for (let count = 0; count < 20 && !calls.some(run => run.args.includes('-p')); count++) await Promise.resolve();
    await assert.rejects(client.connect(), error => error instanceof AppError && error.code === 'SUBSCRIPTION_BUSY');
    await assert.rejects(client.disconnect(), error => error instanceof AppError && error.code === 'SUBSCRIPTION_BUSY');
    await assert.rejects(
      provider.complete(request),
      error => error instanceof AppError && error.code === 'SUBSCRIPTION_BUSY',
    );
    finish(response({ result: '{}' }));
    await completion;
  } finally {
    await close();
  }
});

test('dispose aborts only owned pending authentication and invalidates the previous account binding', async () => {
  let finish!: (value: ClaudeRunResult) => void;
  const pending = new Promise<ClaudeRunResult>(resolve => {
    finish = resolve;
  });
  const { client, calls, close } = await setup(run => (run.args.includes('login') ? pending : response(auth)));
  try {
    await client.status();
    assert.ok(client.binding());
    await client.connect();
    const login = calls.find(run => run.args.includes('login'))!;
    client.dispose();
    assert.equal(login.signal!.aborted, true);
    assert.equal(client.binding(), undefined);
    finish(response({}));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(client.binding(), undefined);
  } finally {
    await close();
  }
});

test('real local process runner uses argument arrays and rejects oversized output, timeout and cancellation; no model runtime is invoked', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'designer-runner-'));
  try {
    const base: ClaudeRun = {
      command: { file: process.execPath },
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      cwd,
      env: claudeEnvironment(process.env),
      stdin: 'literal $(not-a-command)',
      timeoutMs: 3000,
      maxOutputBytes: 2000,
    };
    const result = await runClaude(base);
    assert.equal(result.stdout, base.stdin);
    assert.equal(result.exitCode, 0);
    await assert.rejects(
      runClaude({ ...base, args: ['-e', 'process.stdout.write("x".repeat(2048))'], maxOutputBytes: 1024 }),
      /too large/,
    );
    await assert.rejects(runClaude({ ...base, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 30 }), /timeout/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runClaude({ ...base, signal: controller.signal }), /interrupted/);
    const hidden = await runClaude({ ...base, args: ['-e', 'console.log("not-returned")'], discardOutput: true });
    assert.equal(hidden.stdout, '');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the app instructions replace Claude Code's own system prompt through a private file; the input JSON is sent unescaped", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'designer-claude-file-')),
    calls: ClaudeRun[] = [];
  let seen = '';
  const runner: ClaudeRunner = async run => {
    calls.push(run);
    if (run.args.includes('--version')) return { stdout: '2.1.291 (Claude Code)', exitCode: 0 };
    if (run.args.includes('--help'))
      return { stdout: help + ' via: --system-prompt[-file], --append-system-prompt[-file]', exitCode: 0 };
    if (run.args.includes('status')) return response(auth);
    const file = run.args[run.args.indexOf('--system-prompt-file') + 1];
    seen = readFileSync(file, 'utf8');
    return response({ result: '{"kind":"outline"}', usage: { input_tokens: 50, output_tokens: 5 } });
  };
  const client = new ClaudeSubscription({
    cwd,
    command: { file: 'official-claude' },
    runner,
    env: { PATH: 'safe-path' },
  });
  try {
    await client.status();
    const input = '{"documents":[{"text":"引用 \\"原文\\""}]}';
    const completion = await client
      .provider('sonnet')
      .complete({ system: '日本語のJSONだけを返す。', content: input, maxTokens: 8000 });
    assert.equal(completion.text, '{"kind":"outline"}');
    const run = calls.find(r => r.args.includes('-p'))!,
      file = run.args[run.args.indexOf('--system-prompt-file') + 1];
    assert.equal(seen, '日本語のJSONだけを返す。');
    assert.ok(file.startsWith(path.join(cwd, 'prompts')));
    assert.equal(existsSync(file), false, 'the file is removed after the call');
    assert.ok(run.stdin!.startsWith(input), 'the input is passed as written, not escaped inside another JSON string');
    assert.ok(!run.args.includes(input) && !run.args.includes('日本語のJSONだけを返す。'));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
