/** Below the conversation: saving to the history, where this deck's material goes, and how many AI calls it took. */
export function SessionStatus({
  ready,
  busy,
  savedAt,
  saveError,
  route,
  usage,
  onSave,
}: {
  ready: boolean;
  busy: boolean;
  savedAt?: string;
  saveError?: string;
  route?: { to: string; what: string };
  /** One line on the AI calls, or nothing to show yet. */
  usage?: string;
  onSave: () => void;
}) {
  return (
    <>
      {ready && (
        <div className="history-save">
          <button className="button secondary small" disabled={busy} onClick={onSave}>
            履歴に保存
          </button>
          <span role={saveError ? 'alert' : 'status'}>
            {saveError ??
              (savedAt
                ? `このPCに自動保存 · ${new Date(savedAt).toLocaleTimeString('ja-JP')}`
                : '履歴の保存状況を確認してください')}
          </span>
        </div>
      )}
      {route && (
        <p className="route-summary compact" aria-label="この資料の送り先">
          <span>
            <strong>送り先</strong>
            {route.to}
          </span>
          <span>
            <strong>渡すもの</strong>
            {route.what}
          </span>
        </p>
      )}
      {usage && <p className="workspace-note">{usage}</p>}
    </>
  );
}
