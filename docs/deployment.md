# 部署指南

## 准备账户和配置

需要自己的 Cloudflare 账户。仓库提供的 `wrangler.example.jsonc` 和 `wrangler.local.example.jsonc` 不含部署账户或登录凭证。运行 `npm run setup` 生成本机配置，并在 `wrangler.jsonc` 填写管理员 `OWNER_EMAIL`；真实配置不受 Git 跟踪。

使用 Node.js 24，先运行 `npm ci`、`npm run build`。Windows 可以双击「授权Cloudflare部署.cmd」；其他系统使用：

```sh
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_routes:write d1:write offline_access
npm run deploy -- --bootstrap
```

部署工具在自己的账户创建独立 Worker 和 D1，保存 `.cloudflare-deployment.json`，后续更新复用这些资源。若可用账户不止一个，在配置中明确 `account_id`；工具不会自行选择其他账户。首次创建前需要设置真实管理员邮箱。所有 Token 和密码都应由账户本人在官方页面或本机窗口填写。

## 管理员验证与机器入口

先在 Cloudflare Zero Trust 开通计划、设置团队域名，并启用 One-time PIN。开通要求以 [官方页面](https://developers.cloudflare.com/cloudflare-one/setup/) 为准；涉及支付信息时由账户本人完成。

首次创建两个 self-hosted Access 应用：

| 应用 | 保护范围 | 策略 |
| --- | --- | --- |
| 人工初始化 | 初始为完整题库主机名 | Allow 仅包含 `OWNER_EMAIL`，One-time PIN |
| AI | `题库主机名/api/v1/agent/*` | Service Auth 仅包含题库独立服务凭证 |

复制人工和 AI 应用的 AUD 到 `ACCESS_AUD`、`AGENT_ACCESS_AUD`，团队完整域名到 `ACCESS_TEAM_DOMAIN`。`APP_ENV` 必须保持 `production`。机器服务身份不能加入人工 Allow 策略。

Windows 自动配置：先在配置中填写团队域名，创建仅限当前账户的临时 API Token，具有 **Access: Identity Providers、Access: Apps and Policies、Access: Service Tokens** 编辑权限。双击「配置私人登录.cmd」，在隐藏输入中粘贴 Token。脚本只在此次进程使用临时 Token；AI 服务凭证单独通过 Windows 当前用户加密保存。Linux/macOS 使用上述手动设置，把服务凭证保存在自己的安全环境中。

```sh
npm run deploy
```

管理员打开部署网址，通过原邮箱验证，在网站上自行设置密码。无需把密码交给部署工具。

## 开放网站登录和注册

管理员设置好密码后，把原人工 Access 应用的保护范围改为 `题库主机名/bootstrap-admin/*`，保留仅本人邮箱策略，AI 应用保持原样。此后主页公开显示登录表单，私人题库 API 必须有网站自己的密码会话。

Windows 可运行「开放账号注册.cmd」，提供仅限当前账户、只有 **Access: Apps and Policies** 编辑权限的临时 Token。有效的原 Token 可以复用，但工具没有保存它；输入窗口不会显示 Token。脚本先检查管理员密码、账户和原访问策略，再调整范围。完成后可撤销临时 Token。

手动修改 Access 范围时，完成后运行 `node scripts/sync-access-mode.mjs`，核对公开登录页与受保护的题库、管理员、机器入口，更新本机配置记录。

## 验证和后续更新

检查匿名不能读取题库、管理员能登录、新用户得到独立空题库、机器凭证不能正式应用导入，以及自己 iPhone 的实际登录与离线复习。导入只在网页预览确认后生效。

以后更新：

```sh
npm ci
npm run build
npm run deploy
```

无需重复创建 Access 应用或数据库。部署前按 [备份指南](backup-restore.md) 导出个人题库；D1 schema 升级另保留完整数据库备份。发布工具拒绝 `APP_ENV=local`。GitHub CI 仅构建与本地验证，不部署，不使用生产凭证。

费用和额度以 [Workers](https://developers.cloudflare.com/workers/platform/pricing/) 与 [D1](https://developers.cloudflare.com/d1/platform/pricing/) 当前规则为准；脚本不自动开通付费计划。
