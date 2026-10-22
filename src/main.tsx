import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './home.css';

document.addEventListener('contextmenu', event => event.preventDefault(), { capture: true });

createRoot(document.getElementById('root')!).render(<App />);
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* 在线使用不依赖离线缓存。 */ }); });
}
