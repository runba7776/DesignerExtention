import type { Session } from '../../shared/contracts';
import { Icon } from '../ui';

/** The start screen's heading, before a presentation is begun. */
export function Intro() {
  return (
    <div className="intro">
      <div className="eyebrow">FROM THOUGHT TO SLIDE</div>
      <h1>
        伝えたいことを、
        <br />
        伝わるスライドに。
      </h1>
      <p>
        資料からも、ひとつのアイデアからも。
        <br />
        対話で構成を整え、見やすいプレゼンテーションへ。
      </p>
    </div>
  );
}

/** The heading of the presentation being made, with the three stages and a way to start over. */
export function SessionHeading({
  title,
  session,
  busy,
  onReset,
}: {
  title?: string;
  session: Session;
  busy: boolean;
  onReset: () => void;
}) {
  const phase = session.phase,
    generating = session.recovery?.task === 'generate';
  return (
    <>
      <div className="active-header">
        <div>
          <div className="eyebrow">YOUR PRESENTATION</div>
          <h1>{title ?? '伝える順序を、一緒に整える。'}</h1>
          <p>
            {phase === 'ready'
              ? 'スライドを選んで拡大。気になる部分は、指示して修正できます。'
              : session.recovery
                ? '指示と資料を保持しています。下の案内から再開できます。'
                : phase === 'outline'
                  ? '構成を確認してください。変更したいところは、プロンプトから伝えられます。'
                  : 'より伝わる資料にするために、少しだけ確認させてください。'}
          </p>
        </div>
        <button type="button" className="button ghost small" onClick={onReset} disabled={busy}>
          <Icon name="plus" size={14} />
          新しく作成
        </button>
      </div>
      <div className="stage-line" aria-label="作成の進捗">
        <span className={phase === 'clarifying' ? 'current' : 'done'}>01 内容を整理</span>
        <i />
        <span
          className={phase === 'outline' && !generating ? 'current' : phase === 'ready' || generating ? 'done' : ''}
        >
          02 構成を確認
        </span>
        <i />
        <span className={phase === 'ready' || generating ? 'current' : ''}>03 スライドを作成</span>
      </div>
    </>
  );
}
