import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderKind, Settings } from '../shared/contracts.js';
import { AppError } from './errors.js';
import { MAX_SLIDES } from '../shared/contracts.js';
import { themes, TEMPLATE_THEME_ID } from '../shared/themes.js';
import {typographyProfiles} from '../shared/typography.js';
import {DEFAULT_PROJECT_ID} from './projects.js';

export function validateLocalEndpoint(endpoint: string): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AppError(400, 'ローカルLLMの接続先URLを確認してください。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const octets = host.split('.').map(Number);
  const ipv4 = octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n < 256);
  const privateIp = ipv4 && (octets[0] === 127 || octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
  if (!['http:', 'https:'].includes(url.protocol) || !(privateIp || host === 'localhost' || host === '::1') || url.username || url.password || url.search || url.hash) {
    throw new AppError(400, '接続先はlocalhost、127.0.0.1、または社内のプライベートIPv4アドレスを指定してください。公開URL・認証情報入りURLは使用できません。');
  }
  return url.toString().replace(/\/$/, '');
}

export class SettingsStore {
  private value: Settings = { provider: 'chat', model: 'chat-session', chatService:'chatgpt', mode: 'presentation', endpoint: 'http://127.0.0.1:11434/v1', themeId:'auto', slideCount:'auto',autoRepair:true,activeProjectId:DEFAULT_PROJECT_ID };
  private keys: Partial<Record<ProviderKind, string>> = {};
  constructor(private directory: string, _environmentKey = process.env.ANTHROPIC_API_KEY) { /* Paid API credentials are deliberately not loaded. */ }
  async load() {
    try {
      const value = JSON.parse(await readFile(path.join(this.directory, 'settings.json'), 'utf8'));
      // Old cloud settings are migrated without importing their credentials.
      const migrated=value.provider==='claude'?{...value,provider:'chat',model:'chat-session',chatService:'claude'}:value;
      this.value = this.validate({ ...this.value, ...migrated });
    } catch { /* First launch or invalid config: use safe defaults, never import stored credentials. */ }
    return this;
  }
  get(): Settings { return { ...this.value, hasKey: Boolean(this.keys[this.value.provider]) }; }
  secret(provider: ProviderKind): string | undefined { return this.keys[provider]; }
  async update(input: unknown) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, '設定の形式が正しくありません。');
    const candidate = input as Record<string, unknown>;
    const provider = candidate.provider ?? this.value.provider;
    const subscriptionServiceChanged = provider === 'subscription' && candidate.subscriptionService !== undefined && candidate.subscriptionService !== this.value.subscriptionService;
    const modelDefault = provider !== this.value.provider || subscriptionServiceChanged ? provider === 'subscription' ? 'auto' : provider === 'local' ? 'local-model' : provider === 'demo' ? 'demo' : 'chat-session' : this.value.model;
    const next = this.validate({ ...this.value, ...candidate, model: candidate.model ?? modelDefault });
    if (candidate.apiKey !== undefined && (typeof candidate.apiKey !== 'string' || candidate.apiKey.length > 1000 || /[\r\n]/.test(candidate.apiKey))) throw new AppError(400, 'APIキーの形式が正しくありません。');
    if (candidate.clearKey === true) delete this.keys[next.provider];
    if (next.provider==='local'&&typeof candidate.apiKey === 'string' && candidate.apiKey.trim()) this.keys.local = candidate.apiKey.trim();
    this.value = next;
    await mkdir(this.directory, { recursive: true });
    await writeFile(path.join(this.directory, 'settings.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
    return this.get();
  }
  private validate(value: Record<string, unknown>): Settings {
    if(value.provider==='claude')throw new AppError(400,'有料APIはこの版では使用しません。月額版との連携、またはローカルLLMを選んでください。','PAID_API_DISABLED');
    if (!['subscription', 'chat', 'local', 'demo'].includes(String(value.provider))) throw new AppError(400, '処理先が正しくありません。');
    if (!['presentation', 'reading'].includes(String(value.mode))) throw new AppError(400, '表示モードが正しくありません。');
    if (typeof value.model !== 'string' || !/^[\w.\-/:]{1,140}$/.test(value.model)) throw new AppError(400, 'モデル名を入力してください（英数字・-・_・.・/・:）。');
    const endpoint = validateLocalEndpoint(typeof value.endpoint === 'string' ? value.endpoint : 'http://127.0.0.1:11434/v1');
    const themeId=value.themeId ?? 'auto', slideCount=value.slideCount ?? 'auto';
    if(themeId!=='auto' && themeId!==TEMPLATE_THEME_ID && (typeof themeId!=='string' || !Object.hasOwn(themes,themeId))) throw new AppError(400,'テーマを一覧から選んでください。');
    if(slideCount!=='auto' && (typeof slideCount!=='number' || !Number.isInteger(slideCount) || slideCount<2 || slideCount>MAX_SLIDES)) throw new AppError(400,`枚数は表紙込みで2〜${MAX_SLIDES}枚、またはAIにおまかせを選んでください。`);
    const typographyId=value.typographyId??'auto';
    if(typographyId!=='auto'&&(typeof typographyId!=='string'||!Object.hasOwn(typographyProfiles,typographyId)))throw new AppError(400,'書体を一覧から選んでください。');
    if(value.autoRepair!==undefined&&typeof value.autoRepair!=='boolean')throw new AppError(400,'自動対処はオン・オフで指定してください。');
    const chatService=value.chatService??'chatgpt';
    if(!['chatgpt','claude','gemini','copilot','other'].includes(String(chatService)))throw new AppError(400,'連携するAIを一覧から選んでください。');
    const subscriptionService=value.subscriptionService??'chatgpt';
    if(!['chatgpt','claude'].includes(String(subscriptionService)))throw new AppError(400,'接続する月額サービスを一覧から選んでください。');
    if(value.preferredDesignId!==undefined&&(typeof value.preferredDesignId!=='string'||(value.preferredDesignId!==''&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.preferredDesignId))))throw new AppError(400,'保存したデザインの識別子が正しくありません。');
    const activeProjectId=value.activeProjectId??DEFAULT_PROJECT_ID;
    if(typeof activeProjectId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(activeProjectId))throw new AppError(400,'現在のプロジェクトを選び直してください。');
    return { provider: value.provider as ProviderKind, model: value.model, mode: value.mode as Settings['mode'], endpoint, themeId:themeId as string, typographyId:typographyId as string, slideCount:value.slideCount as Settings['slideCount'],autoRepair:value.autoRepair!==false,chatService:chatService as Settings['chatService'],subscriptionService:subscriptionService as Settings['subscriptionService'],activeProjectId,...(value.preferredDesignId?{preferredDesignId:String(value.preferredDesignId)}:{}) };
  }
}
