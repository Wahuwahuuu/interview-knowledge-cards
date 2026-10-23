import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { KeyRound, ShieldCheck } from 'lucide-react';
import type { Account } from '../shared/accounts';
import { AccountView, AdminView } from './AccountView';
import { Modal } from './Editors';
import { runtimeMode } from './local-replica';
import { SyncView } from './SyncView';
import { UpdateView } from './UpdateView';

type SettingsTab = 'account' | 'users' | 'sync' | 'updates';

export function SettingsWindow({ account, offline, notify, onClose }: {
  account: Account;
  offline: boolean;
  notify: (text: string) => void;
  onClose: () => void;
}) {
  const hasSync = runtimeMode() !== 'cloud';
  const [activeTab, setActiveTab] = useState<SettingsTab>(hasSync ? 'sync' : 'account');
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const id = useId();
  const hasUpdates = runtimeMode() === 'desktop' && account.role === 'admin';
  const tabs: SettingsTab[] = [...(hasSync ? ['sync' as const] : []), 'account', ...(account.role === 'admin' ? ['users' as const] : []), ...(hasUpdates ? ['updates' as const] : [])];
  const selected = tabs.includes(activeTab) ? activeTab : 'account';

  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, tab: SettingsTab) {
    const position = tabs.indexOf(tab);
    let next: SettingsTab | undefined;
    if (event.key === 'ArrowRight') next = tabs[(position + 1) % tabs.length];
    else if (event.key === 'ArrowLeft') next = tabs[(position + tabs.length - 1) % tabs.length];
    else if (event.key === 'Home') next = tabs[0];
    else if (event.key === 'End') next = tabs.at(-1);
    if (!next) return;
    event.preventDefault();
    setActiveTab(next);
    tabRefs.current[next]?.focus();
  }

  return <Modal title="设置" onClose={onClose} wide>
    <div className="settings-window">
      <div className="settings-tabs" role="tablist" aria-label="设置项目">
        {tabs.map(tab => <button
          type="button"
          key={tab}
          ref={element => { tabRefs.current[tab] = element; }}
          id={`${id}-${tab}-tab`}
          role="tab"
          aria-selected={selected === tab}
          aria-controls={`${id}-${tab}-panel`}
          tabIndex={selected === tab ? 0 : -1}
          onClick={() => setActiveTab(tab)}
          onKeyDown={event => navigateTabs(event, tab)}
        >{tab === 'account' ? <KeyRound size={18} /> : <ShieldCheck size={18} />}{tab === 'account' ? '账户与密码' : tab === 'sync' ? '本机与同步' : tab === 'updates' ? '软件更新' : '用户管理'}</button>)}
      </div>
      <div id={`${id}-account-panel`} role="tabpanel" aria-labelledby={`${id}-account-tab`} className="settings-panel" hidden={selected !== 'account'} tabIndex={selected === 'account' ? 0 : -1}>
        <AccountView account={account} offline={offline} notify={notify} />
      </div>
      {account.role === 'admin' && <div id={`${id}-users-panel`} role="tabpanel" aria-labelledby={`${id}-users-tab`} className="settings-panel" hidden={selected !== 'users'} tabIndex={selected === 'users' ? 0 : -1}>
        {selected === 'users' && <AdminView offline={offline} notify={notify} />}
      </div>}
      {hasSync && <div id={`${id}-sync-panel`} role="tabpanel" aria-labelledby={`${id}-sync-tab`} className="settings-panel" hidden={selected !== 'sync'}>{selected === 'sync' && <SyncView notify={notify} />}</div>}
      {hasUpdates && <div id={`${id}-updates-panel`} role="tabpanel" aria-labelledby={`${id}-updates-tab`} className="settings-panel" hidden={selected !== 'updates'}>{selected === 'updates' && <UpdateView />}</div>}
    </div>
  </Modal>;
}
