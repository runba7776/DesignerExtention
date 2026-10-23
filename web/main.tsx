import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

const taskPaneMode = new URLSearchParams(location.search).get('taskpane') === '1';
if (taskPaneMode) document.documentElement.classList.add('taskpane');

function mount() {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

async function bootstrapTaskPane() {
  try {
    const response = await fetch('/api/taskpane-bootstrap', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    mount();
  } catch {
    const root = document.getElementById('root')!;
    root.textContent = '';
    const section = document.createElement('section');
    section.style.cssText = 'font:14px/1.8 Segoe UI,sans-serif;color:#26312f;padding:24px';
    const heading = document.createElement('h1');
    heading.textContent = 'Designer Extentionを起動できません';
    const message = document.createElement('p');
    message.textContent =
      'PowerPoint用のローカルアプリが起動しているか確認し、Start-DesignerExtension.cmdから開き直してください。';
    section.append(heading, message);
    root.append(section);
  }
}

// office.js can fail to initialise (offline CDN, an unsupported host or a
// browser preview) without ever settling onReady, which left a blank pane.
// The pane does not need Office.js to start, so wait only briefly for it.
function officeReady(timeoutMs: number) {
  const office = (window as Window & { Office?: { onReady?: () => Promise<unknown> } }).Office;
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      if (office?.onReady) office.onReady().then(done, done);
      else done();
    } catch {
      done();
    }
  });
}

// The no-install build has no local server to authenticate with.
if (!taskPaneMode) mount();
else void officeReady(3000).then(__HOSTED__ ? mount : bootstrapTaskPane);
