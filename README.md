# Project Context Protocol v0.2

一个面向任意 Git 工程的本地优先上下文控制协议。它用一个入口 Skill，让新聊天、新模型、新分支、新工作树或新设备在有限读取内恢复当前事实，并把本次开发留成下一次可复用的状态。

它解决的是“如何可信地继续”，不规定“模型必须怎样解决”。诊断方法、代码方案、工具、测试策略、文件顺序和是否并行协作仍由当前模型结合风险自行决定。

## 一个入口 Skill

只需要调用：

```text
$project-context-protocol
```

原先独立的诊断、验收和发布记录 Skill 已合并为这个 Skill 的按需参考文件，避免上下文拥挤时在多个 Skill 间漏路由或误路由。

## 安装、升级与卸载

要求 Node.js `>=20.9.0` 和 Git。克隆后可直接用 `node` 运行；若希望使用裸命令，在仓库根目录建立本机链接：

```powershell
npm install
npm link
contextctl --help
context-adapter --help
```

`npm link` 只安装命令行入口，不会自动注册 Codex Skill。还需要把仓库内唯一 Skill 链接到该设备的 Codex `skills` 目录；把下面的示例路径替换为当前设备实际的 Codex 数据目录：

```powershell
$contextSkillSource = (Resolve-Path '.\skills\project-context-protocol').Path
$codexSkillsDirectory = 'H:\Codex\data\skills'
$contextSkillTarget = Join-Path $codexSkillsDirectory 'project-context-protocol'
New-Item -ItemType Junction -Path $contextSkillTarget -Target $contextSkillSource
Test-Path (Join-Path $contextSkillTarget 'SKILL.md')
```

最后一个命令必须返回 `True`。重新启动 Codex 或开启一个新任务，确认可用 Skill 列表中出现 `project-context-protocol`。若目标已经存在，先核对它是否已经指向本仓库；不要在未确认目标的情况下覆盖或删除。新设备重复 CLI 与 Skill 两部分安装。升级使用 `git pull --ff-only` 后重新执行 `npm install`、`npm link` 和 `npm run verify`；Junction 会继续指向更新后的仓库。卸载裸命令使用 `npm unlink --global project-context-protocol`；这不会删除用户选择的上下文目录，也不会自动删除 Codex Skill 链接。

## 每次会话先确认两个值

在读取任何历史状态前，Agent 必须询问当前用户：

1. 本次使用的绝对存储路径；
2. 记录布局：`vault`、`markdown` 或 `hybrid`。

三种布局都保留完整机器权威（代际、运行、事件和证据）。区别在于人类阅读入口，而不是删减机器记录；并发控制、哈希链、身份绑定和过期检测无法只靠自由文本可靠实现。

| 布局 | 主要用途 | 人类可读记录 | 机器权威 | 跨设备特点 |
|---|---|---|---|---|
| `vault` | 本机严格审计 | 派生 Markdown | 完整 JSON 代际与事件链 | 同步整个选定目录 |
| `markdown` | 优先让人和模型快速阅读 | 独立 `records/` 记录包 | 完整 JSON 代际、事件与证据链 | 同步整个选定目录；先读 `records/`，再核验机器权威 |
| `hybrid` | 严格状态与便携交接并存 | `portable/` 脱敏边界镜像 | 完整 JSON 代际、事件与证据链 | 新设备先读便携镜像，再重关联机器状态 |

协议本身不上传目录，也不默认任何盘符或路径。`--vault` 仍作为兼容别名，但新用法推荐 `--store`。

## 冷启动

```powershell
node skills/project-context-protocol/scripts/context-adapter.mjs session-start `
  --repo H:\YourProject `
  --store H:\YourSelectedContextStore `
  --store-confirmed-by-user `
  --record-layout hybrid `
  --task "当前唯一任务"
```

返回内容包括有预算上限的 Recovery Card、项目 ID、仓库/工作区/分支/HEAD、唯一任务、PRD 绑定、独立进度层、阻塞项、允许/禁止边界和下一步。

没有可信 Harness Hook 时，适配器会明确报告捕获降级；Skill 元数据本身不能保证所有模型或工具都自动触发。

## 常用命令

查看全局或单命令契约：

```powershell
node skills/project-context-protocol/scripts/contextctl.mjs --help
node skills/project-context-protocol/scripts/contextctl.mjs daily --help
```

恢复与开始：

```powershell
contextctl resume --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown
contextctl begin --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown --task "当前唯一任务"
```

读取或更新项目简介：

```powershell
contextctl profile --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown
contextctl profile --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown --save --run RUN-... --session SESSION-... --project-purpose "项目目的"
```

用户按需生成当天总结（不会安装定时任务）：

```powershell
contextctl daily --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown --date 2026-08-10 --timezone Asia/Shanghai
contextctl daily --repo H:\YourProject --store H:\ContextStore --store-confirmed-by-user --record-layout markdown --date 2026-08-10 --timezone Asia/Shanghai --save --run RUN-... --session SESSION-...
```

第一次 `--save` 会固化当天的事件/状态快照和 `page-size`（每页 1–10 条事件）；以后读取同一日期返回这份已校验快照，不会被未来开发状态改写，也不能用另一页大小覆盖既有页。`--live` 可用另一页大小预览当前派生结果，但不写文件、不会冒充已保存快照。保存时会重新生成该快照的全部有界页面，第 2 页写为 `YYYY-MM-DD.page-2.md`。`verify` 会逐页校验，`verify --repair-views` 可从密封 JSON 恢复被误改的日报视图。

新设备或新克隆读取已转移的目录后重关联：

```powershell
contextctl relink --repo H:\NewClone --store H:\TransferredContext `
  --store-confirmed-by-user --record-layout hybrid --project-id project-... `
  --reason "更换设备" --authority "当前用户允许重关联" --current-session-authority
```

重关联会创建新的工作区状态；旧运行不会变成新设备上的活动会话，版本相关结论在代码不一致时会标记为过期。若同一 `projectId` 有多个来源，命令会拒绝猜测，必须从 `profile`/Recovery Card 取得精确 `stateHash` 并传入 `--source-state-hash`。

## 记录与证据原则

- 实时 Git 是仓库、分支、HEAD、索引和工作区状态的事实来源。
- 机器 JSON 与不可变运行事件是协议权威；Markdown 是人类视图。
- `analyzed`、`implemented`、`verified`、`reviewed`、`committed`、`pushed`、`deployed`、`accepted` 独立记录，不能互相推断。
- 旧授权只属于历史；提交、推送、部署、删除和披露仍由当前用户与宿主平台授权。
- 路由凭据只证明状态绑定和新鲜度，不授予操作权限；`valid` 只回答凭据与当前事实是否一致。
- `executable` 只表示协议进程自身是否会执行该动作；`recordingReady` 表示当前运行是否具备记录宿主动作的前置条件。高风险宿主动作可出现 `valid=true`、`recordingReady=true`、`executable=false`；真正执行仍由当前用户和宿主平台授权，协议不限制模型选择诊断或实现路径。
- 每次运行留下事实、假设、尝试、失败路径、文件变更、证据、阻塞、踩坑、捕获缺口和唯一下一步；不保存隐藏思维链。

## 验证

```powershell
npm run validate:skills
npm test
npm run verify
```

完整生命周期测试在 Windows 上包含大量真实 Git/子进程隔离场景，通常会运行数分钟到十几分钟。每个测试子进程默认有 120 秒上限；仅在已确认较慢环境后，可为本次测试设置 `CONTEXT_PROTOCOL_TEST_CHILD_TIMEOUT_MS`。发布前必须让 `npm run verify` 完整退出 0；超时不能算通过。

## 兼容与边界

- 当前实现要求 Git worktree。
- 新 `--store` 接口每次都要求显式 `--record-layout`；旧 `--vault` / `--vault-confirmed-by-user` 参数仍可用并兼容默认 `vault`。
- 产品版本是 `0.2.x`；机器状态 schema 是 `2`；`project-context/v1` 是为兼容已有文件保留的线协议标识，三者不是同一个版本号。
- schema 1 会只读兼容加载，并在下一次经会话认证的状态写入后升级为 schema 2；旧状态缺少的新 Project Profile 在升级前由 `verify` 报迁移提示而不是伪造文件。
- `docs/项目上下文控制协议_Skills使用指南.pdf` 是此前版本的视觉指南；以本 README、当前 `SKILL.md` 和可执行 `--help` 为最新契约。
- 选定目录中的敏感信息仍可能在 Agent 被要求读取时进入模型上下文；本地保存不等于禁止披露。
