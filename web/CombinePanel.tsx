import { useEffect, useMemo, useState } from 'react';
import type {
  ChatService,
  ChoiceStats,
  CombinePick,
  DeckVariant,
  SendRecord,
  SubscriptionService,
} from '../shared/contracts';
import { api } from './api';
import { chatServices } from './ChatHandoffPanel';
import { Icon } from './ui';

const letter = (index: number) => String.fromCharCode(65 + index);
/** Compare drafts made by different AIs and combine them page by page: whose
 * content and whose design. Combining runs locally; no AI is called. */
export function CombinePanel({
  variants,
  busy,
  canAlternate,
  connected,
  automatic,
  currentId,
  onAlternate,
  onCombine,
  onRemove,
  onDesign,
}: {
  variants: DeckVariant[];
  busy: boolean;
  canAlternate: boolean;
  connected: SubscriptionService[];
  automatic: boolean;
  currentId?: string;
  onAlternate: (service: ChatService, direct?: boolean) => void;
  onCombine: (picks: CombinePick[], themeFrom: string) => void;
  onRemove: (variantId: string) => void;
  onDesign: (input: {
    variantId: string;
    service: ChatService;
    level: 'structure' | 'topic';
    topic?: string;
    direct?: boolean;
  }) => void;
}) {
  const sources = variants.filter(v => v.origin?.kind !== 'combined'),
    combined = variants.find(v => v.origin?.kind === 'combined');
  const pages = variants[0]?.deck.slides ?? [];
  const [service, setService] = useState<ChatService>('claude');
  // A connected monthly AI receives the request directly: no copying, retries handled by the app.
  const direct = (id: ChatService) => connected.includes(id as SubscriptionService);
  const directChoices = connected.filter(id => !variants.some(v => v.origin?.ai === chatServices[id].name));
  const [directService, setDirectService] = useState<SubscriptionService>();
  const directPick = directService && directChoices.includes(directService) ? directService : directChoices[0];
  const [picks, setPicks] = useState<CombinePick[]>([]);
  const [themeFrom, setThemeFrom] = useState('');
  const [stats, setStats] = useState<ChoiceStats>();
  const [designService, setDesignService] = useState<ChatService>('claude'),
    [level, setLevel] = useState<'structure' | 'topic'>('structure'),
    [topic, setTopic] = useState(''),
    [log, setLog] = useState<SendRecord[]>();
  const base = variants.find(v => v.id === currentId) ?? variants[0];
  function showLog() {
    if (log) {
      setLog(undefined);
      return;
    }
    api<{ records: SendRecord[] }>('/send-log')
      .then(r => setLog(r.records))
      .catch(() => setLog([]));
  }
  const ids = sources.map(v => v.id).join(',');
  useEffect(() => {
    setPicks(pages.map(() => ({ content: sources[0]?.id ?? '', design: sources[0]?.id ?? '' })));
    setThemeFrom(sources[0]?.id ?? '');
  }, [ids, pages.length]);
  useEffect(() => {
    const controller = new AbortController();
    api<ChoiceStats>('/choices', { signal: controller.signal })
      .then(setStats)
      .catch(() => {});
    return () => controller.abort();
  }, [combined?.id]);
  const name = (id: string) => {
    const index = variants.findIndex(v => v.id === id);
    return index < 0 ? '' : `${letter(index)}（${variants[index].label}）`;
  };
  const share = (counts: Record<string, number>) => {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ai, n]) => `${ai} ${Math.round((n / total) * 100)}%`)
      .join('・');
  };
  const mixed = useMemo(
    () => picks.some(p => p.content !== p.design) || new Set(picks.map(p => p.content)).size > 1,
    [picks],
  );
  return (
    <section className="combine-panel" aria-label="AIの案を比べて組み合わせる">
      <div className="combine-head">
        <h3>AIの案を比べる・組み合わせる</h3>
        <p>
          同じ構成をほかのAIでも作り、ページごとに「どの案の内容」を「どの案のデザイン」で使うかを選べます。組み合わせはこのPCで行い、AIは呼び出しません。
        </p>
      </div>
      <ul className="combine-variants">
        {variants.map((variant, index) => (
          <li key={variant.id}>
            <span>
              <strong>{letter(index)} 案</strong> {variant.label}
              {variant.origin?.kind === 'restyle' ? '（同じ内容・別の見た目）' : ''}
            </span>
            {variants.length > 1 && (
              <button className="text-link" disabled={busy} onClick={() => onRemove(variant.id)}>
                削除
              </button>
            )}
          </li>
        ))}
      </ul>
      {automatic && !canAlternate && variants.length < 3 && directPick && (
        <div className="combine-alternate">
          <label className="field compact">
            <span>別のAIでも作る</span>
            <select
              value={directPick}
              disabled={busy}
              onChange={event => setDirectService(event.target.value as SubscriptionService)}
            >
              {directChoices.map(id => (
                <option key={id} value={id}>
                  {chatServices[id].name}（接続済み）
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary small" disabled={busy} onClick={() => onAlternate(directPick, true)}>
            <Icon name="compare" size={13} />
            {chatServices[directPick].name}で作る
          </button>
          <small>
            同じ構成のまま、{chatServices[directPick].name}
            に指示・資料・会話を直接送って別の案を作ります。今の案はそのまま残ります。
          </small>
        </div>
      )}
      {canAlternate && variants.length < 3 && (
        <div className="combine-alternate">
          <label className="field compact">
            <span>別のAIでも作る</span>
            <select value={service} disabled={busy} onChange={event => setService(event.target.value as ChatService)}>
              {(Object.keys(chatServices) as ChatService[]).map(id => (
                <option key={id} value={id}>
                  {chatServices[id].name}
                </option>
              ))}
            </select>
          </label>
          <button className="button secondary small" disabled={busy} onClick={() => onAlternate(service)}>
            <Icon name="compare" size={13} />
            この構成で作る
          </button>
          <small>承認済みの構成と同じページで、選んだAIへの指示を用意します。今の案はそのまま残ります。</small>
        </div>
      )}
      {variants.length < 3 && base && (
        <div className="design-only">
          <h4>内容を送らずにデザインだけ頼む</h4>
          <p>
            選択中の案（{name(base.id)}
            ）の文章・数値・資料は送りません。送るのは、文字の枠の役割と文字数（〇・0・xで伏せた見本）、グラフと表の形、色の名前だけです。返ってきたデザインに、このPCで内容を入れて新しい案にします。ローカルLLMで作った資料にも使えます。
          </p>
          <div className="combine-alternate">
            <label className="field compact">
              <span>デザインを頼むAI</span>
              <select
                value={designService}
                disabled={busy}
                onChange={event => setDesignService(event.target.value as ChatService)}
              >
                {(Object.keys(chatServices) as ChatService[]).map(id => (
                  <option key={id} value={id}>
                    {chatServices[id].name}
                    {direct(id) ? '（直接送る）' : '（コピーして渡す）'}
                  </option>
                ))}
              </select>
            </label>
            <label className="field compact">
              <span>送る範囲</span>
              <select
                value={level}
                disabled={busy}
                onChange={event => setLevel(event.target.value as 'structure' | 'topic')}
              >
                <option value="structure">骨組みのみ（推奨）</option>
                <option value="topic">骨組み＋話題名</option>
              </select>
            </label>
            {level === 'topic' && (
              <label className="field compact">
                <span>送ってよい話題名（40文字以内）</span>
                <input
                  value={topic}
                  maxLength={40}
                  disabled={busy}
                  placeholder="例：四半期の業績報告"
                  onChange={event => setTopic(event.target.value)}
                />
              </label>
            )}
            <button
              className="button secondary small"
              disabled={busy || (level === 'topic' && !topic.trim())}
              onClick={() =>
                onDesign({
                  variantId: base.id,
                  service: designService,
                  level,
                  ...(level === 'topic' ? { topic: topic.trim() } : {}),
                  ...(direct(designService) ? { direct: true } : {}),
                })
              }
            >
              <Icon name="shield" size={13} />
              デザインを頼む
            </button>
          </div>
          <small>
            送る前に、指示の全体を資料・本文・会話と照合し、同じ文字が1つでもあれば作成を止めます。照合結果と指示の記録（SHA-256）はこのPCに残ります。
            {level === 'topic' ? '話題名は、入力した文字がそのまま送られます。' : ''}
          </small>
          <button className="text-link" onClick={showLog}>
            {log ? '送信記録を閉じる' : '送信記録を見る'}
          </button>
          {log &&
            (log.length ? (
              <ul className="send-log">
                {log.map(r => (
                  <li key={r.sha256 + r.at}>
                    <span>{new Date(r.at).toLocaleString('ja-JP')}</span>
                    <span>
                      {chatServices[r.service as ChatService]?.name ?? r.service}・
                      {r.level === 'masked'
                        ? `伏せ字（${r.masked ?? 0}件）・${r.task}`
                        : r.level === 'topic'
                          ? `話題名「${r.topic ?? ''}」`
                          : '骨組みのみ'}
                      {r.slides ? `・${r.slides}枚` : ''}・{r.characters.toLocaleString()}文字
                    </span>
                    <span>
                      一致 {r.hits}件（照合 {r.checkedCharacters.toLocaleString()}文字）・
                      <code>{r.sha256.slice(0, 12)}…</code>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="combine-stats">まだ送信記録はありません。</p>
            ))}
        </div>
      )}
      {sources.length >= 2 && (
        <>
          <div className="combine-table" role="table" aria-label="ページごとの組み合わせ">
            <div className="combine-row header" role="row">
              <span role="columnheader">ページ</span>
              <span role="columnheader">内容</span>
              <span role="columnheader">デザイン</span>
            </div>
            {pages.map((page, i) => (
              <div className="combine-row" role="row" key={page.id}>
                <span role="cell" className="combine-page">
                  <strong>{String(i + 1).padStart(2, '0')}</strong>
                  {page.title}
                </span>
                {(['content', 'design'] as const).map(kind => (
                  <span role="cell" key={kind}>
                    <select
                      aria-label={`${i + 1}枚目の${kind === 'content' ? '内容' : 'デザイン'}`}
                      value={picks[i]?.[kind] ?? ''}
                      disabled={busy}
                      onChange={event =>
                        setPicks(previous =>
                          previous.map((p, j) => (j === i ? { ...p, [kind]: event.target.value } : p)),
                        )
                      }
                    >
                      {sources.map(v => (
                        <option key={v.id} value={v.id}>
                          {name(v.id)}
                        </option>
                      ))}
                    </select>
                  </span>
                ))}
              </div>
            ))}
          </div>
          <div className="combine-actions">
            <label className="field compact">
              <span>テーマ・書体</span>
              <select value={themeFrom} disabled={busy} onChange={event => setThemeFrom(event.target.value)}>
                {sources.map(v => (
                  <option key={v.id} value={v.id}>
                    {name(v.id)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary small"
              disabled={busy || !mixed}
              onClick={() => onCombine(picks, themeFrom)}
            >
              <Icon name="check" size={13} />
              組み合わせて新しい案を作る
            </button>
          </div>
          {!mixed && <small>同じ案だけを選んでいます。ページごとに別の案を選ぶと組み合わせられます。</small>}
        </>
      )}
      {combined?.origin?.notes?.length ? (
        <div className="combine-notes" role="status">
          <strong>組み合わせの結果</strong>
          <ul>
            {combined.origin.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {stats && stats.decisions > 0 && (
        <p className="combine-stats">
          これまでの選択（{stats.decisions}回）：内容 {share(stats.content)}／デザイン {share(stats.design)}
        </p>
      )}
    </section>
  );
}
