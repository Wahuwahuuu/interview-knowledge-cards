# JSON v1 与机器接口

多用户范围：网页导入只作用于当前登录用户的题库。现有机器服务凭证只绑定管理员账号；普通用户可让 AI 生成 JSON 文件，登录自己的账号上传。网页和 AI 普通导入都直接入库，不需要人工确认。机器凭证不读取其他用户资料，也不能管理账号、删除资料或恢复整个题库。

网页默认提供人工填写：在「维护与备份 → 导入问题」选择或新建题库，填写多道题的标题、问题、口述提纲和详细答案，点击「导入题目」直接保存。成功后清空本次表单，失败保留填写内容。JSON 上传后自动解析并直接导入；完整备份在独立的「备份与恢复」页面上传，保留预览及二次确认。

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

`revision`、`updated_at` 由服务器维护。新增对象可以省略；更新已有对象必须先读取最新题库，保留全部字段及这两个当前值，再修改指定内容。缺失或过期会返回 `409 IMPORT_TARGET_CONFLICT`，应重新读取、核对内容并用新批次提交。遗漏可选字段会采用默认值，不是局部补丁。已有来源的 `original_markdown` 和已有出现记录的原始问答及归属不可被普通导入修改。

单个请求最多 8 MB；每批最多 2000 张卡、2000 个来源、2000 个知识点、1000 个项目、5000 个出现记录或关系。详细 JSON Schema 可从机器接口读取。

## 机器接口

使用自己题库的 HTTPS 网址，每个请求携带 Cloudflare Access 的 `CF-Access-Client-Id`、`CF-Access-Client-Secret`。凭证只放进当前进程的安全环境，不写入源码、网页、JSON 内容或聊天。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | /api/v1/agent/library | 读取现有 ID、当前答案、来源与关系；不返回历史快照 |
| GET | /api/v1/agent/schema | 获取 JSON v1 的 JSON Schema |
| POST | /api/v1/agent/imports/submit | 校验并直接入库，返回导入记录（含 id、status、applied_at、preview） |
| POST | /api/v1/agent/imports/preview | 旧路径兼容；行为同 submit，也会直接入库 |
| GET | /api/v1/agent/imports/{id} | 查看导入结果、失败原因及差异 |

机器身份不能调用人工编辑、删除、历史恢复、确认恢复或完整恢复接口。AI 导入仅支持 merge 模式。成功记录为 `applied`，入库失败记录为 `failed`，`error` 给出原因；原有 `pending` 和 `cancelled` 记录继续保留。结构无效的 JSON 直接返回字段错误，不生成记录。

已提供 `scripts/agent-import.mjs`，它从进程环境读取 `CARDS_SITE_URL`、`CF_ACCESS_CLIENT_ID`、`CF_ACCESS_CLIENT_SECRET`，从参数指定的文件读取 JSON 并直接导入。文件必须带稳定的 `batch_id`，网络超时可原样重试，或按批次查询结果。输出仅含批次、变化标题及状态；以 `applied` 为成功依据。

在本 Windows 电脑完成 `配置私人登录.cmd` 后，也可直接使用本机加密的 AI 服务凭证，无需每次粘贴密钥。加密文件仅能由同一 Windows 用户读取；复制源码到其他设备时仍需由账户本人配置服务凭证。本机脚本不会显示解密后的密钥，也不会把它写入 JSON 导入内容。

本机工具会沿用 Windows 已设置的系统网络代理，不修改系统设置。本机凭证只发送到原题库；不能通过改网址把保存的密钥发到其他站点。

```powershell
node scripts/agent-import.mjs examples/your-import.json
```

## 人工维护接口

网站账号密码会话访问 `/api/v1/library`、项目/卡片/来源/知识点/关系列表，以及 `/api/v1/graph?project_id=…`，读取和写入都限定当前用户。

单条写入使用 `PUT /api/v1/{类型}/{id}`，JSON 包含 `expected_revision`（当前全库版本）和 `value`（完整对象）。表单组合写入使用 `POST /api/v1/changes`，包含 `expected_revision` 和 `changes`（JSON v1 导入结构）。

普通导入：`POST /api/v1/imports/submit`，请求为 JSON v1 merge 对象，响应包含 `batch`、更新后的 `library`、`already_applied`。`POST /api/v1/imports/{id}/retry` 可重试未完成的普通导入。`GET /api/v1/imports` 和 `GET /api/v1/imports/{id}` 只读记录；看记录不会触发导入。历史 pending 记录需主动点击「导入这条记录」，不会在升级时自动执行。

服务端对同一批次的相同内容只提交一次；不同内容复用 ID 返回 `409 BATCH_ID_REUSED`。保存使用事务，失败不会留下部分题目。无关题目的并发更新有限重试（最多 4 次尝试），被更新对象本身变化则报错并记录，避免自动覆盖。表单和同一页面的文件重试复用批次 ID；跨页面或脚本重试建议在文件中明确提供 batch_id。

导入记录内可展开题目的标题、问题、复习提纲、完整答案和重点标记；内容按 Markdown 排版，更新提供前后对照。知识点、来源、问题关联及系统字段保留在折叠的「其他导入资料」中。记录不再要求确认。

完整备份恢复仍使用 `POST /api/v1/imports/preview`（restore）→ 核对差异和二次确认 → `POST /api/v1/imports/{id}/apply`（包含 expected_revision）。题库变化时重新预览并再次确认，`/cancel` 可取消未执行的恢复。旧的人工 merge preview/apply 接口保留兼容，但当前网页和机器入口不再走人工确认流程。直接导入和重试接口拒绝 restore。

完整导出：`GET /api/v1/export`；阅读版：`?format=markdown`。项目快照：`GET /api/v1/projects/{id}/snapshot`。网站卡片已移除版本管理入口，旧历史快照和既有历史接口继续用于兼容原备份；内部 `revision` 校验仍用于避免覆盖并发修改。

删除卡片：`DELETE /api/v1/cards/{id}`，JSON 包含 `expected_revision`。只作用于当前登录账号，同时移除该卡片的出现关联、问题关系及历史记录，保留来源原文和其他卡片。网页提供独立的二次确认弹窗；机器身份仍无删除权限。删除后的完整备份和项目快照不再含该题，删除前的完整备份可恢复原有资料。

删除项目：`DELETE /api/v1/projects/{id}`，JSON 同样包含 `expected_revision`，仅限当前登录账号。项目及其全部卡片（包含归档卡片）、出现关联、问题关系和历史一起移除；跨项目连线随之移除，其他项目中的卡片、共用知识点与来源原文保留。机器身份无此权限。网页先显示项目名与卡片数量，人工再次确认后才请求删除；版本冲突刷新后仍需再次确认。

422 表示数据或引用错误，409 表示版本冲突或批次 ID 被复用，401/403 表示未登录或无对应权限。错误响应包含 `error.code`、`error.message`，字段错误还会列出 `details`。
