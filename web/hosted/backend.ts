// The first import installs Buffer/process before any server module runs.
import './polyfills';
import { initFileSystem } from './shims/fs';
import { DOCUMENT_LIMITS, documentSummary, type ParsedDocument } from '../../server/document-model';
import { AppError } from '../../server/errors';
import { SettingsStore } from '../../server/settings';
import { DEFAULT_PROJECT_ID, ProjectStore } from '../../server/projects';
import { SessionEngine } from '../../server/engine';
import { AssistService } from '../../server/assist';
import { createProvider } from '../../server/providers';
import { apiRoutes, matchRoute, type Route } from '../../server/routes';
import { renderInBrowser } from './pptx-renderer';

/** No-install build: the same engine, validation, history and favorites run in
 * this browser tab. Settings/history live in this browser's storage; documents
 * are read here; AI work goes only to the chat the user copies into, or to the
 * local LLM URL the user configured. */
interface Backend {
  routes: Route[];
  documents: Map<string, { document: ParsedDocument; createdAt: number }>;
}
let backend: Promise<Backend> | undefined;
const DATA_DIR = '/data';

async function create(): Promise<Backend> {
  await initFileSystem();
  const settings = await new SettingsStore(DATA_DIR, '').load();
  const projects = await new ProjectStore(DATA_DIR).load();
  if (!projects.list().some(project => project.id === settings.get().activeProjectId))
    await settings.update({ activeProjectId: DEFAULT_PROJECT_ID });
  if (settings.get().provider === 'subscription') await settings.update({ provider: 'chat' });
  const providerFactory = localLlmProvider;
  // The sample experience replays a recorded creation published with this page.
  const showcase = async () => {
    const response = await fetch(new URL('./showcase/showcase.json', location.href));
    if (!response.ok) throw new Error('no showcase');
    return response.json();
  };
  const engine = new SessionEngine({
    settings,
    projects,
    dataDir: DATA_DIR,
    render: renderInBrowser,
    providerFactory,
    showcase,
  });
  await engine.loadPreferences();
  const assist = new AssistService({ settings, projects, providerFactory, render: renderInBrowser });
  const documents = new Map<string, { document: ParsedDocument; createdAt: number }>();
  return {
    routes: apiRoutes({ engine, settings, projects, assist, documents, nativeAvailable: () => false, hosted: true }),
    documents,
  };
}

/** A public page reaching this PC's LLM (127.0.0.1 etc.) is a "local network
 * access" request. Chromium browsers ask the user for permission on a normal
 * page and block it inside PowerPoint for the web (the add-in frame is created
 * by Office), so the connection error explains what to do instead. */
function localLlmProvider(...args: Parameters<typeof createProvider>): ReturnType<typeof createProvider> {
  const provider = createProvider(...args);
  return {
    async complete(request) {
      try {
        return await provider.complete(request);
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'PROVIDER_CONNECTION') throw error;
        const insideWebPowerPoint =
          (window as Window & { Office?: { context?: { platform?: string } } }).Office?.context?.platform ===
          'OfficeOnline';
        throw new AppError(
          502,
          insideWebPowerPoint
            ? 'PowerPoint for the webの中からは、ブラウザーの安全機能（ローカル ネットワーク アクセスの制限）により、このPCのローカルLLMに接続できません。設定で「手動チャット連携」を選ぶか、デスクトップ版PowerPointまたはこのページをブラウザーで直接開いて使ってください。'
            : 'ローカルLLMに接続できません。①アドレスバーの表示から「ローカル ネットワーク上のデバイスへの接続」を許可したか、②LLMサーバーが公開ページからの接続（CORS：OllamaはOLLAMA_ORIGINS、LM Studioは「CORSを有効化」）を許可しているか、③起動状態・接続先・モデル名を確認してください。外部APIへの切り替えは行っていません。',
          'PROVIDER_CONNECTION',
        );
      }
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value ?? {}), { status, headers: { 'Content-Type': 'application/json' } });

async function upload(state: Backend, body: unknown) {
  if (!(body instanceof FormData)) throw new AppError(400, '資料を選択してください。');
  const files = body.getAll('files').filter((file): file is File => file instanceof File);
  if (!files.length) throw new AppError(400, '資料を選択してください。');
  if (files.length > DOCUMENT_LIMITS.files) throw new AppError(413, '資料は1件15 MB以内、最大8件までです。');
  for (const file of files) {
    if (!/\.(pdf|csv|xlsx|pptx|txt|md)$/i.test(file.name))
      throw new AppError(
        415,
        '対応形式はPDF / CSV / XLSX / PPTX / TXT / MDです。.xlsは.xlsx、.pptは.pptxとして保存してください。',
      );
    if (file.size > DOCUMENT_LIMITS.bytes) throw new AppError(413, '資料は1件15 MB以内、最大8件までです。');
  }
  for (const [id, item] of state.documents)
    if (Date.now() - item.createdAt > 2 * 60 * 60 * 1000) state.documents.delete(id);
  if (state.documents.size + files.length > 40)
    throw new AppError(429, '読み込んだ資料が上限に達しました。ページを再読み込みしてください。');
  // PDF/Excel/PowerPoint readers are loaded only when a document is added.
  const { parseDocument } = await import('../../server/documents');
  const parsed: ParsedDocument[] = [];
  for (const file of files) parsed.push(await parseDocument(file.name, Buffer.from(await file.arrayBuffer())));
  const sum =
    [...state.documents.values()].reduce((total, item) => total + item.document.characters, 0) +
    parsed.reduce((total, doc) => total + doc.characters, 0);
  if (sum > 600_000)
    throw new AppError(
      413,
      '読み込んだ資料の合計量が上限を超えました。資料を削除するかページを再読み込みしてください。',
    );
  for (const document of parsed) state.documents.set(document.id, { document, createdAt: Date.now() });
  return { documents: parsed.map(documentSummary) };
}

/** fetch()-compatible entry used by web/api.ts in the no-install build. */
export async function hostedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const signal = init.signal;
  const abort = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const work = (async () => {
    const state = await (backend ??= create());
    const url = new URL(path, 'https://designer.invalid/'),
      method = (init.method ?? 'GET').toUpperCase();
    try {
      if (url.pathname === '/documents' && method === 'POST') return json(await upload(state, init.body));
      const match = matchRoute(state.routes, method, url.pathname);
      if (!match) throw new AppError(404, 'この操作は存在しません。');
      let body: unknown;
      if (typeof init.body === 'string' && init.body) {
        try {
          body = JSON.parse(init.body);
        } catch {
          throw new AppError(400, '入力形式が正しくありません。');
        }
      }
      const result = await match.route.handler({
        params: match.params,
        query: Object.fromEntries(url.searchParams),
        body,
      });
      return json(result, match.route.status ?? 200);
    } catch (error) {
      if (!(error instanceof AppError)) console.error(error);
      return json(
        {
          error:
            error instanceof AppError
              ? error.message
              : '処理を完了できませんでした。入力と実行環境を確認してください。',
          code: error instanceof AppError ? error.code : 'SERVER_ERROR',
        },
        error instanceof AppError ? error.status : 500,
      );
    }
  })();
  return Promise.race([work, abort]);
}
