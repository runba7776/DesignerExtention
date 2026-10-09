import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { DeckSpec, RenderResult } from '../shared/contracts.js';
import { DOCUMENT_LIMITS, documentSummary, parseDocument, type ParsedDocument } from './documents.js';
import { AppError } from './errors.js';
import { SessionEngine } from './engine.js';
import { SettingsStore } from './settings.js';
import { createProvider, type Provider } from './providers.js';
import type { Settings } from '../shared/contracts.js';
import { SubscriptionManager } from './subscription.js';
import {DEFAULT_PROJECT_ID,ProjectStore} from './projects.js';
import {AssistService} from './assist.js';
import {apiRoutes} from './routes.js';

export interface AppOptions {
  authToken: string; port: number; taskPanePort?: number; dataDir: string; webRoot: string; artifactRoot: string;
  nativeAvailable: () => boolean | Promise<boolean>;
  render: (deck: DeckSpec, variantId: string) => Promise<RenderResult>;
  open?: (artifactId: string) => Promise<void>;
  providerFactory?: (settings: Settings, key?: string) => Provider;
  subscriptionManager?: Pick<SubscriptionManager, 'status' | 'connect' | 'refresh' | 'disconnect' | 'binding' | 'createProvider'>;
  environmentKey?: string;
}

const asyncRoute = (handler: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { Promise.resolve(handler(req, res)).catch(next); };

export async function createApp(options: AppOptions) {
  if (options.authToken.length < 32) throw new Error('起動トークンが短すぎます。');
  const app = express();
  app.disable('x-powered-by');
  const settings = await new SettingsStore(options.dataDir, options.environmentKey).load();
  const projects = await new ProjectStore(options.dataDir).load();
  if(!projects.list().some(project=>project.id===settings.get().activeProjectId))await settings.update({activeProjectId:DEFAULT_PROJECT_ID});
  const subscriptions = options.subscriptionManager ?? await new SubscriptionManager(options.dataDir).load();
  const providerFactory = options.providerFactory ?? ((current:Settings,key?:string) => current.provider==='subscription' ? subscriptions.createProvider(current) : createProvider(current,key));
  const engine = new SessionEngine({ settings, projects, dataDir: options.dataDir,artifactRoot:options.artifactRoot, render: options.render, open: options.open, providerFactory, subscriptionBinding:service=>subscriptions.binding(service) });
  const assist = new AssistService({ settings, projects, providerFactory, render: options.render });
  await engine.loadPreferences();
  const documents = new Map<string, { document: ParsedDocument; createdAt: number }>();
  const taskPaneOrigin=options.taskPanePort?`https://localhost:${options.taskPanePort}`:undefined;
  const origins = new Set([`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`, ...(taskPaneOrigin?[taskPaneOrigin]:[])]);
  const hosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`, ...(options.taskPanePort?[`localhost:${options.taskPanePort}`]:[])]);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    const taskPanePage=!!taskPaneOrigin&&req.secure&&req.hostname==='localhost'&&(req.path==='/taskpane.html'||(req.path==='/'&&req.query.taskpane==='1'));
    const frameAncestors=taskPanePage?"'self' https://*.office.com https://*.office365.com https://*.officeapps.live.com https://*.microsoft365.com https://*.office.net https://*.microsoft.com":"'none'";
    const officeJs=taskPanePage?' https://officeapis.public.onecdn.static.microsoft':'';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'${officeJs}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'self'; form-action 'self'`);
    if (!hosts.has(req.headers.host ?? '')) return next(new AppError(403, 'localhostから起動してください。', 'INVALID_HOST'));
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ app: 'Designer Extention', ok: true }));
  // The task-pane page is served only from this loopback HTTPS origin. Bootstrap
  // grants an HttpOnly cookie; it never exposes the bearer token to Office.js.
  app.post('/api/taskpane-bootstrap', (req,res,next)=>{
    if(!taskPaneOrigin||!req.secure||req.hostname!=='localhost'||req.headers.host!==`localhost:${options.taskPanePort}`||req.headers.origin!==taskPaneOrigin||req.headers['sec-fetch-site']==='cross-site')return next(new AppError(403,'PowerPointの作成ペインから起動してください。','INVALID_TASKPANE'));
    res.cookie('designer_taskpane_session',options.authToken,{httpOnly:true,secure:true,sameSite:'strict',path:'/'});
    res.status(204).end();
  });
  app.get('/', (req, res, next) => {
    if (typeof req.query.token === 'string') {
      if (!constantEqual(req.query.token, options.authToken)) return next(new AppError(403, '起動情報が無効です。起動用ファイルから開き直してください。'));
      res.cookie('designer_session', options.authToken, { httpOnly: true, sameSite: 'strict', path: '/' });
      return res.redirect(303, '/');
    }
    next();
  });
  app.use('/api', (req, _res, next) => {
    const cookieName=req.secure&&req.headers.host===`localhost:${options.taskPanePort}`?'designer_taskpane_session':'designer_session';
    const cookie = (req.headers.cookie ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length+1) ?? '';
    if (!constantEqual(cookie, options.authToken)) return next(new AppError(401, '起動用ファイルから画面を開き直してください。', 'AUTH_REQUIRED'));
    if (req.headers.origin && !origins.has(req.headers.origin)) return next(new AppError(403, '外部ページからの操作は受け付けません。', 'INVALID_ORIGIN'));
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.headers.origin) return next(new AppError(403, '操作元を確認できません。画面から操作してください。', 'ORIGIN_REQUIRED'));
    if (req.headers['sec-fetch-site'] === 'cross-site') return next(new AppError(403, '外部ページからの操作は受け付けません。'));
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/chat-connector-config',(_req,res)=>{
    const projectRoot=path.resolve(options.webRoot,'..','..');
    res.attachment('Designer-Extention-Claude-Desktop.json').json({mcpServers:{'designer-extension':{command:process.execPath,args:[path.join(projectRoot,'node_modules','tsx','dist','cli.mjs'),path.join(projectRoot,'server','mcp.ts')],env:{DESIGNER_CONNECTOR_DATA_DIR:options.dataDir}}}});
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: DOCUMENT_LIMITS.bytes, files: DOCUMENT_LIMITS.files, fields: 0, parts: DOCUMENT_LIMITS.files }, fileFilter: (_req, file, callback) => {
    if (!/\.(pdf|csv|xlsx|pptx|txt|md)$/i.test(file.originalname)) return callback(new AppError(415, '対応形式はPDF / CSV / XLSX / PPTX / TXT / MDです。.xlsは.xlsx、.pptは.pptxとして保存してください。'));
    callback(null, true);
  } });
  app.post('/api/documents', upload.array('files', DOCUMENT_LIMITS.files), asyncRoute(async (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (!files?.length) throw new AppError(400, '資料を選択してください。');
    for (const [id, item] of documents) if (Date.now() - item.createdAt > 2 * 60 * 60 * 1000) documents.delete(id);
    if (documents.size + files.length > 40) throw new AppError(429, 'この起動中の資料数が上限に達しました。不要な資料を削除するかサーバーを再起動してください。');
    const parsed: ParsedDocument[] = [];
    for (const file of files) {
      // Multipart names use a Latin-1 transport; recover UTF-8 filenames from browsers.
      const utfName = Buffer.from(file.originalname, 'latin1').toString('utf8');
      parsed.push(await parseDocument(utfName.includes('\uFFFD') ? file.originalname : utfName, file.buffer));
    }
    const sum = [...documents.values()].reduce((sum, item) => sum + item.document.characters, 0) + parsed.reduce((sum, doc) => sum + doc.characters, 0);
    if (sum > 600_000) throw new AppError(413, 'この起動中に保持できる資料の合計量を超えました。資料を削除するか再起動してください。');
    for (const document of parsed) documents.set(document.id, { document, createdAt: Date.now() });
    res.json({ documents: parsed.map(documentSummary) });
  }));
  const routes=apiRoutes({engine,settings,projects,assist,documents,nativeAvailable:options.nativeAvailable,subscriptions});
  for(const route of routes){
    const register=route.method==='GET'?app.get.bind(app):route.method==='POST'?app.post.bind(app):route.method==='PUT'?app.put.bind(app):app.delete.bind(app);
    register('/api'+route.path,asyncRoute(async(req,res)=>{
      const result=await route.handler({params:Object.fromEntries(Object.entries(req.params).map(([key,value])=>[key,String(value)])),query:req.query as Record<string,unknown>,body:req.body});
      for(const [name,value] of Object.entries(route.headers??{}))res.setHeader(name,value);
      res.status(route.status??200).json(result);
    }));
  }
  app.get('/api/artifacts/:id/:fileName', (req, res, next) => {
    const id = String(req.params.id), fileName = String(req.params.fileName);
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id) || !/^[a-zA-Z0-9_.-]{1,120}\.(pptx|png|svg|json)$/.test(fileName) || fileName.includes('..')) return next(new AppError(400, 'ファイル名が正しくありません。'));
    const file = path.join(options.artifactRoot, id, fileName);
    if (fileName.endsWith('.pptx')) res.setHeader('Content-Disposition', 'attachment; filename="Designer-Extention.pptx"');
    res.sendFile(file, (error) => { if (error && !res.headersSent) next(new AppError(404, '生成ファイルが見つかりません。もう一度書き出してください。')); });
  });
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'この操作は存在しません。')));
  app.use(express.static(options.webRoot, { etag: false, index: 'index.html' }));
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof AppError ? error.status : error instanceof multer.MulterError ? 413 : error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    const message = error instanceof AppError ? error.message : error instanceof multer.MulterError ? '資料は1件15 MB以内、最大8件までです。' : status === 413 ? '入力内容が大きすぎます。' : status === 400 ? '入力形式が正しくありません。' : '処理を完了できませんでした。入力と実行環境を確認してください。';
    res.status(status).json({ error: message, code: error instanceof AppError ? error.code : 'SERVER_ERROR' });
  });
  return app;
}

function constantEqual(a: string, b: string) { const first = Buffer.from(a), second = Buffer.from(b); return first.length === second.length && timingSafeEqual(first, second); }
