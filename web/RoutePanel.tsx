import type { AiTarget, ProviderKind, SendScope, Settings, SubscriptionStatus } from '../shared/contracts';

/** The three ways to make a deck, as the user chooses them before writing the request. */
export type Route = 'auto' | 'chat' | 'demo';
export const targetNames: Record<AiTarget, string> = { claude: 'Claude', chatgpt: 'ChatGPT', local: 'ローカルLLM' };
export interface AiChoice {
  targets: AiTarget[];
  scope: SendScope;
}

/** Which AIs can write now: monthly services connected in settings, and a local LLM with a model set. */
export function availableTargets(settings: Settings, connections?: SubscriptionStatus) {
  const connected = (service: 'claude' | 'chatgpt') =>
    connections?.services.some(s => s.service === service && s.canGenerate) ?? false;
  const local = !!(settings.localModel ?? (settings.provider === 'local' ? settings.model : ''));
  return { claude: connected('claude'), chatgpt: connected('chatgpt'), local } as Record<AiTarget, boolean>;
}
/** The AIs chosen last time when they are still available, else the one of the current setting. */
export function defaultChoice(settings: Settings, available: Record<AiTarget, boolean>, masked: boolean): AiChoice {
  const saved = (settings.targets ?? []).filter(t => available[t]);
  const primary: AiTarget = settings.provider === 'local' ? 'local' : (settings.subscriptionService ?? 'chatgpt');
  return {
    targets: saved.length
      ? saved
      : available[primary]
        ? [primary]
        : (Object.keys(available) as AiTarget[]).filter(t => available[t]).slice(0, 1),
    scope: masked ? 'masked' : 'full',
  };
}
export function routeOf(provider: ProviderKind): Route {
  return provider === 'chat' || provider === 'claude' ? 'chat' : provider === 'demo' ? 'demo' : 'auto';
}

const ROUTES: { id: Route; label: string; badge: string; tone: 'cloud' | 'paste' | 'none'; description: string }[] = [
  {
    id: 'auto',
    label: '自動で作る',
    badge: 'AIに直接送る',
    tone: 'cloud',
    description: '接続したClaude・ChatGPTの月額版、またはこのPCのローカルLLMが、構成から見直しまで自動で作ります。',
  },
  {
    id: 'chat',
    label: 'AIチャットに貼り付ける',
    badge: '貼るまで送らない',
    tone: 'paste',
    description:
      '指示をコピーしてChatGPT・Claude・Geminiなどのチャットに貼り、返答を取り込みます。APIキーは要りません。',
  },
  {
    id: 'demo',
    label: 'サンプル体験',
    badge: 'AIを使わない',
    tone: 'none',
    description: '実際にAIで作った記録を再生して、作成の流れを試します。入力や資料は使いません。',
  },
];
const SCOPES: { id: SendScope; label: string; description: string }[] = [
  { id: 'full', label: 'そのまま送る', description: '指示・資料の抽出内容・会話をそのまま渡します。' },
  {
    id: 'masked',
    label: '伏せ字にして送る',
    description:
      '社名・人名・連絡先・数値を【社名1】のような記号に置き換えて渡し、返ってきた答えをこのPCで元に戻します。',
  },
  {
    id: 'design',
    label: '内容は送らない',
    description:
      '文章と数値はこのPCのローカルLLMが書き、外部のAIには文字の枠の役割と文字数・グラフと表の形だけを渡してデザインを頼みます。',
  },
];

/** One sentence each for where the material goes and what goes there, for the chosen way of making. */
export function routeSummary(
  route: Route,
  options: { cloud: string[]; scope: SendScope; local: boolean; hosted: boolean },
) {
  if (route === 'demo') return { to: 'なし（記録の再生）', what: '何も送りません' };
  if (route === 'chat')
    return {
      to: 'あなたが貼り付けるAIチャット',
      what:
        options.scope === 'masked'
          ? '社名・数値などを伏せ字にした指示と資料（貼り付けるまで、このアプリからは送りません）'
          : '指示と資料の抽出内容（貼り付けるまで、このアプリからは送りません）',
    };
  if (!options.cloud.length)
    return {
      to: options.hosted ? '設定した接続先のローカルLLM' : 'このPCのローカルLLM',
      what: 'このPC（または社内の接続先）の外には出しません',
    };
  const to = `${options.cloud.join('・')}（月額版）${options.local ? '・ローカルLLM' : ''}`;
  return {
    to,
    what:
      options.scope === 'design'
        ? '内容は送らず、文字の枠の役割と文字数・グラフと表の形だけ'
        : options.scope === 'masked'
          ? '社名・数値などを伏せ字にした指示・資料・会話'
          : '指示・資料の抽出内容・会話',
  };
}

/** Before a deck is made: how it is made (which AI, or a chat the user pastes into, or the sample) and what may
 * leave this PC, with one line that says where the material goes. Replaces settings hunting for both choices. */
export function RoutePanel({
  route,
  hosted,
  available,
  choice,
  chatScope,
  maskedTerms,
  disabled,
  onRoute,
  onChoice,
  onChatScope,
  onSettings,
  onProject,
}: {
  route: Route;
  hosted: boolean;
  available: Record<AiTarget, boolean>;
  choice?: AiChoice;
  chatScope: SendScope;
  maskedTerms: number;
  disabled: boolean;
  onRoute: (route: Route) => void;
  onChoice: (choice: AiChoice) => void;
  onChatScope: (scope: SendScope) => void;
  onSettings: () => void;
  onProject: () => void;
}) {
  const targets = route === 'auto' && !hosted ? (choice?.targets ?? []) : route === 'auto' ? ['local' as AiTarget] : [];
  const cloud = targets.filter(t => t !== 'local');
  const scope = route === 'chat' ? chatScope : (choice?.scope ?? 'full');
  const sends = route === 'chat' || cloud.length > 0;
  const summary = routeSummary(route, {
    cloud: cloud.map(t => targetNames[t]),
    scope,
    local: targets.includes('local'),
    hosted,
  });
  const toggle = (target: AiTarget) => {
    if (!choice) return;
    const next = choice.targets.includes(target)
      ? choice.targets.filter(t => t !== target)
      : [...choice.targets, target];
    if (next.length && next.length <= 3) onChoice({ ...choice, targets: next });
  };
  const chooseScope = (value: SendScope) => {
    if (route === 'chat') onChatScope(value);
    else if (choice) onChoice({ ...choice, scope: value });
  };
  const designProblem =
    route === 'auto' && scope === 'design'
      ? !targets.includes('local')
        ? '「内容は送らない」には、内容を書くローカルLLMも選んでください。'
        : !cloud.length
          ? '「内容は送らない」には、デザインを頼むClaudeかChatGPTも選んでください。'
          : ''
      : '';
  const missing = (Object.keys(available) as AiTarget[]).filter(t => !available[t] && !(hosted && t !== 'local'));
  return (
    <section className="route-panel" aria-label="作り方と資料の扱い">
      <div className="route-step">
        <span className="route-number">1</span>
        <h3>どうやって作るか</h3>
      </div>
      <div className="route-options" role="radiogroup" aria-label="作り方">
        {ROUTES.map(item => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={route === item.id}
            className={`route-option ${route === item.id ? 'selected' : ''}`}
            disabled={disabled}
            onClick={() => onRoute(item.id)}
          >
            <span className="route-option-head">
              <strong>{item.label}</strong>
              <span className={`route-badge ${item.tone}`}>{item.badge}</span>
            </span>
            <small>
              {item.id === 'auto' && hosted
                ? 'このブラウザから、PCや社内のローカルLLMに接続して自動で作ります（月額版の自動作成はローカルアプリ版で使えます）。'
                : item.description}
            </small>
          </button>
        ))}
      </div>
      {route === 'auto' && !hosted && choice && (
        <div className="route-targets" role="group" aria-label="作成するAI">
          <span className="route-label">作成するAI（複数選ぶと、AIごとの案を並べて比べられます）</span>
          <div className="ai-picker-targets">
            {(Object.keys(targetNames) as AiTarget[]).map(target => (
              <button
                key={target}
                type="button"
                className={`ai-chip ${choice.targets.includes(target) ? 'selected' : ''}`}
                aria-pressed={choice.targets.includes(target)}
                disabled={disabled || !available[target]}
                onClick={() => toggle(target)}
              >
                <span className="ai-chip-check" aria-hidden="true">
                  {choice.targets.includes(target) ? '✓' : ''}
                </span>
                {targetNames[target]}
                <small>
                  {available[target]
                    ? target === 'local'
                      ? 'このPCで処理'
                      : '接続済み'
                    : target === 'local'
                      ? '未設定'
                      : '未接続'}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      {route === 'auto' && missing.length > 0 && (
        <small className="route-note">
          {missing.map(t => targetNames[t]).join('・')}は
          <button type="button" className="text-link" onClick={onSettings}>
            設定
          </button>
          で{missing.length === 1 && missing[0] === 'local' ? '接続先とモデルを登録' : '接続・登録'}すると使えます。
        </small>
      )}
      {route !== 'demo' && (
        <>
          <div className="route-step">
            <span className="route-number">2</span>
            <h3>外部のAIに渡す内容</h3>
          </div>
          {sends ? (
            <div className="route-options scopes" role="radiogroup" aria-label="外部のAIに渡す内容">
              {SCOPES.map(item => {
                const unavailable = item.id === 'design' && route === 'chat';
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="radio"
                    aria-checked={scope === item.id}
                    className={`route-option ${scope === item.id ? 'selected' : ''}`}
                    disabled={disabled || unavailable}
                    title={unavailable ? '内容を書くローカルLLMが必要なため、「自動で作る」で選べます。' : undefined}
                    onClick={() => chooseScope(item.id)}
                  >
                    <span className="route-option-head">
                      <strong>{item.label}</strong>
                    </span>
                    <small>{item.description}</small>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="route-note">選んだAIはこのPC（または社内の接続先）で動くため、外部には何も渡しません。</p>
          )}
          {designProblem && (
            <p className="ai-picker-problem" role="alert">
              {designProblem}
            </p>
          )}
          {sends && (
            <small className="route-note">
              社外秘の資料は「伏せ字にして送る」か、ローカルLLMだけで作ってください。伏せる語（社名・製品名など）は
              <button type="button" className="text-link" onClick={onProject}>
                プロジェクト
              </button>
              で登録できます{maskedTerms ? `（登録済み ${maskedTerms}語）` : ''}。
            </small>
          )}
        </>
      )}
      <p className="route-summary" role="status">
        <span>
          <strong>送り先</strong>
          {summary.to}
        </span>
        <span>
          <strong>渡すもの</strong>
          {summary.what}
        </span>
      </p>
    </section>
  );
}
