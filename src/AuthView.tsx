import { useEffect, useState } from 'react';
import { BookOpen, Eye, EyeOff, ArrowRight, ShieldCheck } from 'lucide-react';
import { api, ApiError } from './api';
import type { Account } from '../shared/accounts';

export function AuthView({ onLogin, setup }: { onLogin: () => Promise<void>; setup?: Account }) {
  const bootstrap = Boolean(setup) || window.location.pathname.startsWith('/bootstrap-admin/');
  const [mode, setMode] = useState<'login' | 'register'>('login'), [email, setEmail] = useState(setup?.email ?? ''), [name, setName] = useState(setup?.display_name ?? '');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState(''), [visible, setVisible] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [registrationOpen, setRegistrationOpen] = useState(false), [bootstrapAccount, setBootstrapAccount] = useState<Account | undefined>(setup);
  useEffect(() => {
    void api<{ registration_open: boolean }>('/auth/status').then(v => setRegistrationOpen(v.registration_open)).catch(() => undefined);
    if (bootstrap && !setup) void fetch('/bootstrap-admin/identity', { credentials: 'same-origin', redirect: 'error', cache: 'no-store' }).then(async response => {
      const value = await response.json() as Account & { error?: { message: string } }; if (!response.ok) throw new Error(value.error?.message ?? '请通过管理员验证入口进入');
      setBootstrapAccount(value); setEmail(value.email); setName(value.display_name);
      if (!value.needs_password_setup) { window.location.replace('/'); }
    }).catch(e => setError(e instanceof Error ? e.message : '管理员验证未完成'));
  }, [bootstrap]);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError('');
    if ((bootstrap || mode === 'register') && password !== confirm) { setError('两次输入的密码不一致'); return; }
    setBusy(true);
    try {
      if (localStorage.getItem('interview-pending-logout')) { await api('/auth/logout', { method: 'POST', body: '{}' }); localStorage.removeItem('interview-pending-logout'); }
      if (bootstrap) {
        const response = await fetch('/bootstrap-admin/claim', { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, display_name: name || '管理员' }) });
        const value = await response.json() as { error?: { message: string } }; if (!response.ok) throw new Error(value.error?.message ?? '设置未完成');
        window.location.replace('/'); return;
      }
      await api('/auth/' + mode, { method: 'POST', body: JSON.stringify({ email, password, ...(mode === 'register' ? { display_name: name } : {}) }) });
      localStorage.setItem('interview-account-change', crypto.randomUUID());
      setPassword(''); setConfirm(''); await onLogin();
    } catch (e) { setError(e instanceof ApiError && e.details.length ? e.details.map(d => d.message).join('；') : e instanceof Error ? e.message : '暂时无法登录'); }
    finally { setBusy(false); }
  }
  return <div className="auth-shell"><div className="auth-intro"><a className="brand" href="/"><img src="/icon.svg" alt="" /><span>面试知识卡<small>把经验，变成自己的答案</small></span></a><div><span className="eyebrow"><BookOpen size={18} />你的私人知识库</span><h1>每一次追问，<br /><em>都值得留下。</em></h1><p>按项目积累答案，沿着知识点复习。<br />电脑和手机，打开就是自己的书架。</p><div className="auth-features"><span>项目书架</span><span>翻卡自测</span><span>知识图谱</span></div></div><small>每个账号拥有独立题库。</small></div><section className="auth-panel">
    <div className="auth-heading">{bootstrap ? <ShieldCheck size={27} /> : <BookOpen size={27} />}<h2>{bootstrap ? '设置管理员密码' : mode === 'login' ? '欢迎回来' : '建立你的书架'}</h2><p>{bootstrap ? '现有问答已保留在管理员账户下。设置后用邮箱和密码登录。' : mode === 'login' ? '登录后，接着整理与复习。' : '注册后即可维护自己的项目和知识卡。'}</p></div>
    {!bootstrap && <div className="auth-tabs"><button className={mode === 'login' ? 'selected' : ''} onClick={() => { setMode('login'); setError(''); }}>登录</button><button disabled={!registrationOpen} className={mode === 'register' ? 'selected' : ''} onClick={() => { setMode('register'); setError(''); }}>注册</button></div>}
    <form onSubmit={event => void submit(event)}>
      {(mode === 'register' || bootstrap) && <label className="field"><span>称呼</span><input autoComplete="nickname" required maxLength={40} value={name} onChange={e => setName(e.target.value)} placeholder="你希望怎样被称呼" /></label>}
      <label className="field"><span>邮箱账号</span><input type="email" required maxLength={254} autoComplete="username" value={email} readOnly={bootstrap} onChange={e => setEmail(e.target.value)} placeholder="你的邮箱" /></label>
      <label className="field"><span>{bootstrap ? '设置密码' : '密码'}</span><div className="password-field"><input type={visible ? 'text' : 'password'} required minLength={bootstrap || mode === 'register' ? 12 : 1} maxLength={128} autoComplete={bootstrap || mode === 'register' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} placeholder={bootstrap || mode === 'register' ? '至少 12 个字符，可用长句子' : '输入你的密码'} /><button type="button" className="icon-button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label>
      {(bootstrap || mode === 'register') && <label className="field"><span>再次输入密码</span><input type={visible ? 'text' : 'password'} required minLength={12} maxLength={128} autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} /></label>}
      {error && <div className="notice error" role="alert">{error}</div>}
      <button type="submit" className="primary auth-submit" disabled={busy || (bootstrap && !bootstrapAccount)}>{busy ? '正在处理…' : bootstrap ? '设置密码并进入题库' : mode === 'login' ? '登录' : '注册并进入题库'}<ArrowRight size={17} /></button>
    </form>
    {!bootstrap && <><p className="microcopy">{registrationOpen ? '邮箱作为登录账号使用，请妥善保存密码。' : '新用户注册暂时关闭。'}</p><a className="text-button" href="/bootstrap-admin/">管理员首次设置</a></>}
  </section></div>;
}
