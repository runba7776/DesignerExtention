import type { PolishState, ReviewHint, ReviewReport } from '../shared/contracts';

const grade = { high: '重い', medium: '中', low: '軽い' } as const;

/** What the AI saw on the drawn pages: what was made again for a high problem (with a way back to the
 * earlier version), and the findings left to the user (medium and low ones, and high ones that could
 * not be fixed automatically). */
export function ReviewHints({
  hints,
  report,
  versions,
  busy,
  onSwitch,
  pageOf,
}: {
  hints: ReviewHint[];
  report?: ReviewReport;
  versions?: PolishState['versions'];
  busy: boolean;
  onSwitch: (slideId: string, version: 'before' | 'after') => void;
  pageOf: (slideId: string) => number;
}) {
  const unresolved = hints.some(h => h.unresolved);
  // One switch per remade page, on its first finding.
  const switchAt = new Set<number>(),
    seen = new Set<string>();
  hints.forEach((hint, index) => {
    if (hint.fixed && versions?.[hint.slideId] && !seen.has(hint.slideId)) {
      seen.add(hint.slideId);
      switchAt.add(index);
    }
  });
  return (
    <details className="review-hints" open={unresolved || seen.size > 0}>
      <summary>
        確認のヒント{report ? '（画像での見直し）' : ''}
        {hints.length ? ` · ${hints.length}件` : ''}
      </summary>
      {report && (
        <p className="review-summary">
          描画した{report.checked}枚を画像で見直し
          {report.fixed.length ? `、重い問題のあった${report.fixed.length}枚を作り直しました` : 'ました'}
          。この見直しのAI呼び出し：{report.calls}回
        </p>
      )}
      {hints.length ? (
        <ol>
          {hints.map((hint, index) => {
            const entry = versions?.[hint.slideId],
              reverted = entry?.applied === 'before';
            return (
              <li key={index} className={hint.unresolved ? 'unresolved' : hint.fixed ? 'fixed' : hint.severity}>
                <span className="review-page">{String(pageOf(hint.slideId) + 1).padStart(2, '0')}</span>
                <div>
                  <strong>
                    {hint.unresolved
                      ? '重い・自動で直せませんでした'
                      : hint.fixed
                        ? reverted
                          ? '重い・直す前に戻しました'
                          : '重い・作り直し済み'
                        : grade[hint.severity]}
                  </strong>{' '}
                  {hint.what}
                  {hint.fix && (
                    <small>
                      {hint.fixed ? '直した内容' : '直し方'}：{hint.fix}
                    </small>
                  )}
                  {switchAt.has(index) && entry && (
                    <button
                      type="button"
                      className="button ghost small review-switch"
                      disabled={busy}
                      onClick={() => onSwitch(hint.slideId, reverted ? 'after' : 'before')}
                    >
                      {reverted ? '直したページに戻す' : '直す前に戻す'}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="review-summary">気になる点は見つかりませんでした。</p>
      )}
      <small className="review-note">
        中・軽い気づきは自動では直していません。直す場合は、スライドを選んで入力欄から指示してください。
      </small>
    </details>
  );
}
