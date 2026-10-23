import path from 'node:path';
import type { Settings, SubscriptionConnection, SubscriptionService, SubscriptionStatus } from '../shared/contracts.js';
import type { Provider } from './providers.js';
import { ChatGptSubscription, type ChatGptSubscriptionOptions } from './chatgpt-subscription.js';
import { ClaudeSubscription } from './claude-subscription.js';
import { AppError } from './errors.js';

export class SubscriptionManager {
  private chatgpt: ChatGptSubscription;
  private claude: ClaudeSubscription;
  constructor(directory: string, options: { chatgpt?: ChatGptSubscriptionOptions; claude?: ClaudeSubscription } = {}) {
    this.chatgpt = new ChatGptSubscription(path.join(directory, 'subscription-auth'), options.chatgpt);
    this.claude = options.claude ?? new ClaudeSubscription({ cwd: path.join(directory, 'subscription-claude') });
  }
  async load() {
    await this.chatgpt.load();
    return this;
  }
  async status(): Promise<SubscriptionStatus> {
    return { services: await Promise.all([this.chatgpt.status(), this.claude.status()]) };
  }
  async connect(
    service: SubscriptionService,
    input: { accountId?: unknown; newAccount?: unknown } = {},
  ): Promise<SubscriptionConnection> {
    return service === 'chatgpt' ? this.chatgpt.connect(input) : this.claude.connect();
  }
  async refresh(service: SubscriptionService) {
    return service === 'chatgpt' ? this.chatgpt.refresh() : this.claude.status();
  }
  async disconnect(service: SubscriptionService) {
    return service === 'chatgpt' ? this.chatgpt.disconnect() : this.claude.disconnect();
  }
  binding(service: SubscriptionService) {
    return service === 'chatgpt' ? this.chatgpt.binding() : this.claude.binding();
  }
  createProvider(settings: Settings): Provider {
    if (settings.provider !== 'subscription') throw new AppError(400, 'ログイン連携の処理先を選択してください。');
    return settings.subscriptionService === 'claude'
      ? this.claude.provider(settings.model)
      : this.chatgpt.provider(settings.model);
  }
  dispose() {
    this.chatgpt.dispose();
  }
}
