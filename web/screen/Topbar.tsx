import { Icon } from '../ui';

/** The bar at the top: the project, history, favourite designs, the layout catalogue, and where the AI runs. */
export function Topbar({
  projectName,
  locked,
  updateRequired,
  provider,
  providerLabel,
  onProjects,
  onHistory,
  onDesigns,
  onLayouts,
  onSettings,
}: {
  projectName?: string;
  /** Busy or still connecting. */
  locked: boolean;
  updateRequired: boolean;
  /** What the badge shows (for example "Claude · 月額版"). */
  provider: string;
  /** The way of making, read out with the badge. */
  providerLabel: string;
  onProjects: () => void;
  onHistory: () => void;
  onDesigns: () => void;
  onLayouts: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-symbol">
          <Icon name="slides" size={20} />
        </span>
        <div>
          <div className="brand-name">Designer Extention</div>
          <div className="brand-caption">FOR POWERPOINT</div>
        </div>
      </div>
      <div className="topbar-right">
        <button
          className="project-badge"
          disabled={locked}
          onClick={onProjects}
          aria-label={`プロジェクト：${projectName ?? '選択中'}。プロジェクト管理を開く`}
        >
          {projectName ?? 'プロジェクト'}
        </button>
        <button className="button ghost small" disabled={locked || updateRequired} onClick={onHistory}>
          履歴
        </button>
        <button className="button ghost small" disabled={locked || updateRequired} onClick={onDesigns}>
          <Icon name="star" size={13} />
          お気に入り
        </button>
        <button className="button ghost small" onClick={onLayouts}>
          構図一覧
        </button>
        <button className="provider-badge" onClick={onSettings} aria-label={`処理先：${providerLabel}。設定を開く`}>
          <span className="provider-dot" />
          {provider}
        </button>
        <button className="icon-button" aria-label="設定" onClick={onSettings}>
          <Icon name="settings" size={20} />
        </button>
      </div>
    </header>
  );
}
