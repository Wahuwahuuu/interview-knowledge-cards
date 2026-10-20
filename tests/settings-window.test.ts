import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Account } from '../shared/accounts';
import { SettingsWindow } from '../src/SettingsWindow';

const account: Account = { user_id: 'fictional-user', display_name: '虚构用户', email: 'fictional@example.invalid', role: 'admin', local: false, needs_password_setup: false };
const render = (role: Account['role']) => renderToStaticMarkup(createElement(SettingsWindow, { account: { ...account, role }, offline: false, notify: () => {}, onClose: () => {} }));

describe('设置窗口', () => {
  it('管理员有两个设置入口，默认账户与密码，用户管理未激活时不挂载', () => {
    const html = render('admin');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toMatch(/role="tab" aria-selected="true"[^>]*>.*?账户与密码/);
    expect(html).toMatch(/role="tab" aria-selected="false"[^>]*>.*?用户管理/);
    expect(html).toContain('当前密码');
    expect(html).not.toContain('新用户注册');
    expect(html).not.toContain('停用账户');
  });

  it('普通用户只显示账户与密码，不渲染用户管理入口或面板', () => {
    const html = render('member');
    expect(html.match(/role="tab"/g)).toHaveLength(1);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(html).toContain('账户与密码');
    expect(html).not.toContain('用户管理');
    expect(html).not.toContain('users-panel');
  });
});
