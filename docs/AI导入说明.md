# JSON v1 与机器接口

多用户范围：网页上传和人工确认只作用于当前登录用户的题库。现有机器服务凭证只绑定管理员账号；普通用户可让 AI 生成 JSON 文件，登录自己的账号上传。机器凭证不读取其他用户资料，也不能管理账号或正式应用草稿。

网页默认提供人工填写：在「维护与备份 → 导入问题」选择或新建题库，填写多道题的标题、问题、口述提纲和详细答案，程序生成内部 ID 后提交预览。页面保留 JSON 模板下载和文件上传，上传后自动解析；完整备份在独立的「备份与恢复」页面上传。机器接口与 JSON v1 契约保持不变。

## 导入结构

顶层 `schema_version` 固定为 1，`mode` 为 `merge`（默认）或 `restore`。`batch_id` 建议使用新 UUID 或本批次的稳定业务标识；同一 ID 的同一内容可重复提交，不重复入库；不同内容不得复用批次 ID。

顶层数组：`projects`、`topics`、`cards`、`sources`、`occurrences`、`relations`。未提供的数组视为空，merge 模式不会因为遗漏而删除已有内容。

| 数组 | 必需字段 | 主要可选字段 |
| --- | --- | --- |
| projects | id, name | description |
| topics | id, name | — |
| cards | id, project_id, title, question | summary_md, answer_md, topic_ids, important, favorite, mastery, archived |
| sources | id, name, kind | date, company, job, round, notes, source_path, original_markdown |
| occurrences | id, card_id, source_id, asked_question | original_answer_md, section, notes |
| relations | id, from_card_id, to_card_id, kind | — |

来源 kind：`real` 真实面试、`mock` 模拟面试、`note` 问答整理。关系 kind：`followup`（起点问题的追问是终点问题）、`related`（无向关系）。掌握状态 mastery：`review` 或 `mastered`。日期为有效的 `YYYY-MM-DD` 或空字符串。

`important` 是独立的重点标记，值为 `true` 或 `false`，与 `favorite` 收藏互不影响。没有填写时默认不标重点；旧题目标题开头的装饰星号会自动清理并转换为重点，明确填写的布尔值优先。标题或问题中的行内代码、加粗等 Markdown 会正常排版；SQL 中的 `SELECT *` 不会被当成装饰星号。

卡片页面和填写表单已移除「实现边界与待核实」「源码与文档依据」。旧的 `limitations_md`、`source_baseline`、`evidence` 字段仍可在 JSON 备份中保留并恢复，兼容已有资料。更新旧卡片时保留这些字段即可，无需新增。源码 evidence 为数组，每项可包含 `label`（必需）、`path`、`line`（正整数）、`url`。

ID 长度 1–128，使用字母、数字、点、下划线、冒号或短横线，首字符为字母或数字。引用的项目、知识点、卡片或来源必须在题库中存在，或包含在同一批导入里。同名问题按不同 ID 保留，不做语义合并。知识点复用已有 ID，避免不必要的重名节点。

`revision`、`updated_at` 由服务器维护。更新已有对象请先读取题库，保留已有字段，再改需要修改的字段；遗漏可选字段会采用默认值，不是局部补丁。已有来源的 `original_markdown` 和已有出现记录的原始问答及归属不可被普通导入修改。

单个请求最多 8 MB；每批最多 2000 张卡、2000 个来源、2000 个知识点、1000 个项目、5000 个出现记录或关系。详细 JSON Schema 可从机器接口读取。

## 机器接口

使用自己题库的 HTTPS 网址，每个请求携带 Cloudflare Access 的 `CF-Access-Client-Id`、`CF-Access-Client-Secret`。凭证只放进当前进程的安全环境，不写入源码、网页、JSON 内容或聊天。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /api/v1/agent/library | 读取现有 ID、当前答案、来源与关系；不返回历史快照 |
| GET | /api/v1/agent/schema | 获取 JSON v1 的 JSON Schema |
| POST | /api/v1/agent/imports/preview | 校验数据并保存待确认草稿，返回差异及批次 ID |
| GET | /api/v1/agent/imports/{id} | 查看草稿状态及差异 |

机器身份不能调用人工编辑、历史恢复、确认导入或完整恢复接口。AI 草稿只能使用 merge 模式。

已提供 `scripts/agent-import.mjs`，它从进程环境读取 `CARDS_SITE_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`，从参数指定的文件读取 JSON，只提交草稿。输出仅含批次、变化标题及状态。

在本 Windows 电脑完成 `配置私人登录.cmd` 后，也可直接使用本机加密的 AI 服务凭证，无需每次粘贴密钥。加密文件仅能由同一 Windows 用户读取；复制源码到其他设备时仍需由账户本人配置服务凭证。本机脚本不会显示解密后的密钥，也不会把它写入 JSON 导入内容。

本机工具会沿用 Windows 已设置的系统网络代理，不修改系统设置。本机凭证只发送到原题库；不能通过改网址把保存的密钥发到其他站点。

```powershell
node scripts/agent-import.mjs examples/your-import.json
```

## 人工维护接口

网站账号密码会话访问 `/api/v1/library`、项目/卡片/来源/知识点/关系列表，以及 `/api/v1/graph?project_id=…`，读取和写入都限定当前用户。

单条写入使用 `PUT /api/v1/{类型}/{id}`，JSON 包含 `expected_revision`（当前全库版本）和 `value`（完整对象）。表单组合写入使用 `POST /api/v1/changes`，包含 `expected_revision` 和 `changes`（JSON v1 导入结构）。

人工导入：`POST /api/v1/imports/preview` → 查看差异 → `POST /api/v1/imports/{id}/apply`，确认请求包含 `expected_revision`。草稿过期时使用 `/repreview`，不要直接覆盖。`/cancel` 可取消尚未应用的草稿。

网页打开待确认草稿时会自动重新预览。确认时若遇到 `409 REVISION_CONFLICT`，网页会更新预览并在确认按钮旁提示重新核对；这一轮不会自动再次调用确认接口。普通失败也会在按钮旁显示，不能将点击按钮视为导入成功，应以批次显示「已应用」为准。

网页默认只需要核对题目的标题、问题、复习提纲、完整答案和重点标记；内容会按 Markdown 排版，更新内容提供前后对照。知识点、原始来源、出现记录、问题关联以及 ID、版本等系统字段统一收进默认折叠的「其他导入资料」。折叠只改变展示，整批校验、人工确认、版本冲突与完整导入范围保持一致。完整恢复涉及的移除会另外提示；只有附属资料变化时也会明确说明，不会显示为“没有变化”。

完整导出：`GET /api/v1/export`；阅读版：`?format=markdown`。项目快照：`GET /api/v1/projects/{id}/snapshot`。历史：`GET /api/v1/cards/{id}/history`。恢复卡片：`POST /api/v1/cards/{id}/restore`，包含 `expected_revision` 和 `card_revision`。

422 表示数据或引用错误，409 表示版本冲突或批次 ID 被复用，401/403 表示未登录或无对应权限。错误响应包含 `error.code`、`error.message`，字段错误还会列出 `details`。
