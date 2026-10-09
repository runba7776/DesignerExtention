import { useEffect, useRef, type ReactNode } from 'react';

export function Icon({name, size = 20, className = ''}: {name: string; size?: number; className?: string}) {
  const common = {width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, className, 'aria-hidden': true as const};
  const paths: Record<string, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6" /></>,
    chevron: <path d="m9 5 7 7-7 7" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
    file: <><path d="M14 3H5v18h14V8l-5-5Z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    settings: <><path d="m9 3-.5 2-2 .9-1.8-.5-2 3.4 1.5 1.5v2.4l-1.5 1.5 2 3.4 1.8-.5 2 .9.5 2h4l.5-2 2-.9 1.8.5 2-3.4-1.5-1.5v-2.4l1.5-1.5-2-3.4-1.8.5-2-.9-.5-2Z" /><circle cx="11" cy="11.5" r="3" /></>,
    slides: <><rect x="3" y="4" width="16" height="12" rx="1" /><path d="M7 20h16V8M7 8h8M7 12h4" /></>,
    compare: <><rect x="2" y="5" width="8" height="14" rx="1" /><rect x="14" y="5" width="8" height="14" rx="1" /></>,
    expand: <><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    edit: <><path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4" /><path d="m16 4 2-2 4 4-2 2" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15" r="1" /></>,
    cloud: <path d="M7 18a5 5 0 0 1-1-9 6 6 0 0 1 11-2 5 5 0 0 1 1 11H7Z" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v.1" /></>,
    star: <path d="m12 3 2.8 5.6 6.2.9-4.5 4.4 1.1 6.1-5.6-2.9L6.4 20l1.1-6.1L3 9.5l6.2-.9L12 3Z" />,
    reset: <><path d="M4 9a8 8 0 1 1 0 7M4 3v6h6" /></>,
    send: <><path d="m3 3 18 9-18 9 3-9-3-9Zm3 9h15" /></>,
    message: <path d="M21 15V4H3v16l5-5h13Z" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  };
  return <svg {...common}>{paths[name] ?? paths.info}</svg>;
}

export function Modal({title, children, onClose, wide = false}: {title: string; children: ReactNode; onClose: () => void; wide?: boolean}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {if (dialog?.open) dialog.close();};
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} onCancel={onClose} onClick={e => {if (e.target === ref.current) onClose();}}>
    <div className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button></div>
    <div className="modal-content">{children}</div>
  </dialog>;
}

export function Spinner() {return <span className="spinner" aria-hidden="true" />;}
