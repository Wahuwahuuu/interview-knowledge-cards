import { createRoot } from 'react-dom/client';
import App from './App';
import { useEffect, useState } from 'react';
import { getReplica, initializeRuntime, runtimeMode, synchronizePhone } from './local-replica';
import { PairPhoneView } from './SyncView';
import './styles.css';
import './home.css';

document.addEventListener('contextmenu', event => event.preventDefault(), { capture: true });

function RuntimeApp() {
  const [ready, setReady] = useState(false), [paired, setPaired] = useState(false);
  useEffect(() => { void initializeRuntime().then(() => { setPaired(Boolean(getReplica())); setReady(true); }); }, []);
  useEffect(() => {
    if (!paired) return;
    const sync = () => { if (document.visibilityState !== 'hidden') void synchronizePhone(); };
    sync(); const timer = setInterval(sync, 30000);
    let editTimer: ReturnType<typeof setTimeout>;
    const edited = () => { clearTimeout(editTimer); editTimer = setTimeout(sync, 1500); };
    window.addEventListener('replica-edit', edited);
    window.addEventListener('online', sync); window.addEventListener('focus', sync); document.addEventListener('visibilitychange', sync);
    return () => { clearInterval(timer); clearTimeout(editTimer); window.removeEventListener('replica-edit', edited); window.removeEventListener('online', sync); window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', sync); };
  }, [paired]);
  useEffect(() => {
    if (!ready || runtimeMode() !== 'desktop') return;
    let previous: number | undefined;
    const timer = setInterval(() => { if (document.visibilityState === 'hidden') return; void fetch('/api/v1/desktop/revision', { cache: 'no-store' }).then(async response => { if (!response.ok) return; const value = await response.json() as { revision: number }; if (previous !== undefined && previous !== value.revision) window.dispatchEvent(new Event('replica-library')); previous = value.revision; }).catch(() => undefined); }, 4000);
    return () => clearInterval(timer);
  }, [ready]);
  if (!ready) return <div className="pair-shell">正在打开题库…</div>;
  if (runtimeMode() === 'phone' && !paired) return <PairPhoneView onPaired={() => setPaired(true)} />;
  return <App />;
}
createRoot(document.getElementById('root')!).render(<RuntimeApp />);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* 在线使用不依赖离线缓存。 */ }); });
}
