import { forwardRef } from 'react';
import type { RepairReport, Session } from '../../shared/contracts';

type Recovery = NonNullable<Session['recovery']>;

/** Work that stopped partway (an outline, pages, a revision), what was kept, and how to go on. */
export const RecoveryPanel = forwardRef<
  HTMLElement,
  { recovery: Recovery; disabled: boolean; onFinishSmaller: () => void; onRetry: () => void }
>(function RecoveryPanel({ recovery, disabled, onFinishSmaller, onRetry }, ref) {
  return (
    <section ref={ref} className="plan-recovery" role="status">
      <h2>
        {recovery.task === 'plan'
          ? '構成案の作成が途中で止まりました'
          : recovery.task === 'revise'
            ? 'スライドの修正を完了できませんでした'
            : recovery.stage === 'text-fit'
              ? '文字量の調整で止まりました'
              : 'スライド作成が途中で止まりました'}
      </h2>
      {recovery.task === 'generate' && (
        <p className="recovery-progress">
          本文を保持：{recovery.completedSlides} / {recovery.totalSlides} 枚
        </p>
      )}
      <p>{recovery.message}</p>
      <small>
        {recovery.retryAvailable
          ? '再試行すると接続したAIを呼び出します。自動対処は1回の操作で最大2回です。'
          : '再試行を停止しています。優先する条件を整理して、指示を送り直してください。'}
      </small>
      {recovery.stage === 'text-fit' && (
        <button className="button primary small" disabled={disabled} onClick={onFinishSmaller}>
          文字を小さくして仕上げる（AIは使いません）
        </button>
      )}
      {recovery.retryAvailable && (
        <button className="button secondary small" disabled={disabled} onClick={onRetry}>
          {recovery.task === 'plan'
            ? '保存した指示で構成を再試行'
            : recovery.task === 'revise'
              ? '保存した修正指示で再試行'
              : recovery.completedSlides === recovery.totalSlides
                ? '保持した本文を仕上げる'
                : '残りのスライドから再開'}
        </button>
      )}
    </section>
  );
});

/** What the app did by itself when a reply could not be used, and how many calls it took. */
export const RepairReportPanel = forwardRef<HTMLElement, { report: RepairReport }>(function RepairReportPanel(
  { report },
  ref,
) {
  return (
    <section ref={ref} className={`repair-report ${report.status}`} role="status" aria-label="自動対処の結果">
      <h2>
        {report.status === 'recovered' ? '自動で対処し、処理を完了しました' : '自動対処では完了できず、停止しました'}
      </h2>
      <ol>
        {report.steps.map((step, index) => (
          <li key={index}>
            <strong>{step.reason}</strong>
            <p>{step.adjustment}</p>
          </li>
        ))}
      </ol>
      {report.changes && (
        <p className="repair-usage">
          反映した変更：{report.changes.length ? report.changes.join('・') : '内容の変更なし'}
        </p>
      )}
      <p className="repair-usage">
        自動再試行：{report.retries} 回 · この操作のAI呼び出し：{report.apiCalls} 回
      </p>
      <small>対処内容は上記の通りです。有料APIは使用していません。</small>
    </section>
  );
});
