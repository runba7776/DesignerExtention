import type { LayoutIssue } from '../core/shared/contracts';

const what = {
  overflow: '文字が枠からはみ出しています',
  overlap: '文字や表が重なっています',
  edge: '文字が囲みの縁に接しているか、はみ出しています',
  notch: '矢羽根の切り欠きや先端に文字がかかっています',
} as const;

/** Text PowerPoint set differently from the plan, found once the deck was drawn: shown open after the deck is made,
 * page by page, with a way to pick the page and ask for a fix. */
export function LayoutIssues({
  issues,
  busy,
  onSelect,
}: {
  issues: LayoutIssue[];
  busy: boolean;
  onSelect: (index: number) => void;
}) {
  const pages = [...new Set(issues.map(issue => issue.slide))];
  return (
    <details className="review-hints layout-issues" open>
      <summary>
        仕上がりの確認 · 文字の重なり・はみ出しが{issues.length}か所（{pages.map(p => `${p}枚目`).join('、')}）
      </summary>
      <ol>
        {issues.map((issue, index) => (
          <li key={index} className="unresolved">
            <span className="review-page">{String(issue.slide).padStart(2, '0')}</span>
            <div>
              <strong>{what[issue.kind]}</strong> 「{issue.text}」{issue.other ? `と「${issue.other}」` : ''}
              <button
                type="button"
                className="button ghost small review-switch"
                disabled={busy}
                onClick={() => onSelect(issue.slide - 1)}
              >
                このページを選ぶ
              </button>
            </div>
          </li>
        ))}
      </ol>
      <small className="review-note">
        PowerPointで描いたときに見つかったものです（少し大きいだけの文字は自動で最大1割縮めています）。ページを選んで「文字を減らして」などと指示するか、PowerPointで直接調整してください。
      </small>
    </details>
  );
}
