<h1 align="center">PlanWeave — LAN 团队协作 Fork</h1>

<p align="center">
  为 PlanWeave 增加的、服务器协调的多人协作层，配 Codex 风格的桌面端外壳。
  本 fork 在 upstream 单机文件驱动的循环之上，新增了权威状态、身份、提案、Work lease、事件流与 Git merge queue。
</p>

## 核心修改：局域网团队协作模式

这个 fork 最主要的改动，是把 PlanWeave 从“单台电脑上的 Agent 工作流”扩展为一个 **Host 权威协调、成员本地执行、全员共享同一份需求与任务状态** 的局域网协作系统。

一台电脑作为 **Host** 启动团队服务器并配置协调 Agent；其他成员从自己的 PlanWeave 加入团队，并继续使用各自在本机配置好的 Codex、Claude Code、OpenCode 或 Pi。讨论、需求基线、任务归属、事件历史和合并队列由 Host 保存；代码实现和提交前检查在成员本地完成。

### 完整协作流程

1. **Host 创建团队空间**：在桌面端选择“作为主机启动”，创建项目、启动局域网服务，并生成邀请地址与加入令牌。
2. **成员加入并配置本地 Agent**：成员在桌面端选择“作为成员加入”，连接 Host；每个人独立选择本机执行和检查任务的 Agent，密钥与本地权限不会上传到 Host。
3. **共同讨论与补充资料**：所有成员在共享规划室中提出需求、增加约束、上传文件和补充实现要求。Host 上的协调 Agent 统一消费这些消息和附件，避免关键上下文散落在不同电脑。
4. **生成需求共识看板**：协调 Agent 将有效内容整理为带来源的需求、约束、决策、风险、开放问题和验收标准；所有成员看到相同的版本化看板。
5. **人工确认并冻结基线**：成员对当前版本批准或拒绝。Agent 负责分析和整理，但不能替代人类形成共识；只有满足审批策略且不存在阻塞问题的版本才能被冻结。
6. **拆分任务与生成流程图**：协调 Agent 根据已冻结基线生成任务节点、依赖关系、可并行边界、允许修改的路径、验收命令和评审要求，并把流程图同步给所有成员。
7. **申报意向与领取任务**：成员先表达希望负责的节点，再领取正式任务。Host 使用 assignment + lease + heartbeat 保证同一任务不会被多人重复占用，并能回收长期离线的任务。
8. **本地实施与预检**：每个成员保留一份只读、带版本号的需求基线和流程图。本地 Agent 只能围绕已领取节点工作，并检查实现是否符合节点范围、上游依赖和验收标准。
9. **提交到 Host**：成员提交不可变的 base/head commit、实现说明和本地检查证据。断线期间可以继续本地工作，恢复连接后再续租、同步并提交。
10. **Host 权威复检与串行合并**：Host 重新校验提交身份、提交祖先、文件范围和验收命令，再进行 Host Agent Review 与必要的人工批准；通过的提交由 merge queue 串行合并，失败项回到原任务继续修正。
11. **状态回流到所有成员**：需求版本、任务进度、检查结果、评审反馈和合并状态都通过持久事件流同步，重连后可以从最后一个事件继续恢复。

```mermaid
flowchart LR
  A[Host 创建团队空间] --> B[成员加入并配置本地 Agent]
  B --> C[共同讨论与上传资料]
  C --> D[协调 Agent 生成需求看板]
  D --> E{成员审批并冻结基线}
  E -->|有异议| C
  E -->|达成共识| F[Agent 拆分任务与生成流程图]
  F --> G[成员申报并领取节点]
  G --> H[本地 Agent 实施与预检]
  H --> I[提交 commit 与检查证据]
  I --> J{Host 复检与终审}
  J -->|需要修改| H
  J -->|通过| K[Merge queue 串行合并]
  K --> L[事件同步到所有成员]
```

### 长期协作不变量

- **Host 是协作状态的唯一事实源**：本地缓存可以重建，需求基线、任务归属和合并结果不能由客户端单方面覆盖。
- **需求看板与任务流程图分层**：前者描述“要做什么以及如何验收”，后者描述“由谁、按什么依赖和边界实现”。
- **Agent 不代替人类审批**：Agent 可以提出、整理、拆解和评审；冻结需求与最终合并仍受明确的成员角色和审批策略约束。
- **本地检查不是合并凭证**：成员端预检用于尽早发现问题，Host 必须在受控 worktree 中重新执行权威检查。
- **所有写入可恢复、可审计**：命令具备幂等键和乐观版本控制，事件与审计记录持久化，断线重连按事件游标续传。
- **提交具有明确所有权**：任务节点必须声明允许修改的路径和验收命令；越界文件、伪造 submission、过期 lease 或陈旧目标分支都会被拒绝。
- **身份可以长期续期**：首次加入后签发设备恢复凭据；短期 session 过期时由本机安全存储自动续期，不会把同一成员重复创建成新用户。
- **Host 数据有自动备份**：启动时及每 6 小时创建 SQLite 一致性快照，滚动保留最近 30 份；中断中的 merge queue 会在重启时协调恢复。

<!-- planweave-badges:start -->
<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.2.1-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20Claude%20Code%20%7C%20OpenCode%20%7C%20Pi-6f42c1?style=for-the-badge" />
</p>
<!-- planweave-badges:end -->

---

## 0. 相对 upstream 做了哪些改动


| 范围 | 改动 | 代码位置 |
|---|---|---|
| **新增 `packages/server`** | Node.js HTTP + `node:sqlite`（WAL）权威协调器。覆盖 `identity` / `planning` / `proposals` / `attachments` / `coordination` / `work` / `events` / `agents` / `git` / `audit`。统一使用版本化 `/api/v1` HTTP API 与 `/events` WebSocket。 | `packages/server/src/**` |
| **事务性 work 协调** | 任务、assignments、leases、heartbeat、submissions、reviews。通过 partial unique index 强制"每个任务同一时刻只有一个 active assignment"不变量。Lease 过期回收。Idempotency key + `expectedVersion` 乐观并发。 | `packages/server/src/work/` |
| **身份与会话** | 用户、设备、邀请码、可吊销的 session、项目成员。Token 化加入。 | `packages/server/src/identity/` |
| **规划室与提案** | 规划室、消息、附件元数据、不可变的提案修订、审批策略、投票、生命周期跃迁。 | `packages/server/src/{planning,proposals,attachments}/` |
| **持久事件 + WebSocket** | 仅追加的 `domain_events`，通过 `ws 8.x` 暴露 `EventEnvelopeV1` 投影。支持断线重连的 resync cursor。 | `packages/server/src/events/` |
| **Git merge queue** | 裸集成仓库 + 隔离 worktree。所有权路径校验（拒绝 `events-rogue/**` 这类前缀歧义）。串行合并，依次走身份 / 祖先 / 路径 / 检查 / Agent / 人工 评审。 | `packages/server/src/git/` |
| **Runtime parity** | `packages/runtime` 在写入边界拆出 `FileRuntimeRepository` ↔ `SqliteRuntimeRepository`，让服务端模式是 source of truth，文件模式照常工作。 | A5 commit |
| **Coordinator Agent** | artifact / checkpoint 持久化、取消、重试。可插拔 provider 接口；首个真实 provider 需等待持久化工作就绪。 | `packages/server/src/agents/` |
| **CLI 远程模式** | `planweave server start\|join\|list\|forget\|project`、`planweave remote task\|merge-queue` 等。 | `packages/cli/src/commands/remote*.ts` |
| **桌面端 Team Mode** | 内嵌 Mode 切换（Personal / Team）。Host / Member 角色选择；本机 `localTeamHost` 一键启服务；连接 profile；规划室、提案、事件同步；角色徽章。 | `packages/desktop/src/renderer/team/`、`packages/desktop/src/main/localTeamHost.ts` |
| **Codex 风格 UI 整改** | 紧凑常驻侧栏 + brand header；Personal/Team 模式切换 + 角色徽章；向上弹出 Settings 下拉（5 个分区）；可拖拽的浮动组件面板 + 悬停展开；`view-enter` 路由过渡；语义化色彩 token（亮 / 暗 / 跟随系统）。 | `packages/desktop/src/renderer/{sidebar,AppSidebars,AppSettingsRoute,views,index.css}` |
| **i18n zh-CN** | 覆盖率达到 **98.8%**，附动画。 | `packages/desktop/src/renderer/i18nZhCn.ts` |
| **worktree 残留清理延后** | `.worktrees/` 下的 A1–A9 worktree 仍在（已合入 main）。 | follow-up |

upstream 原始的 README 不再是本 fork 的真相来源。旧的 zh-CN 译文见 `readme/README.zh-CN.md`。

---

## 1. 架构

```mermaid
flowchart LR
  subgraph Local["成员本机"]
    D[桌面应用<br/>Electron + React]
    C[CLI<br/>planweave]
    R[Runtime<br/>文件驱动]
    G[本地 Git worktree]
  end

  subgraph Server["LAN 协作服务器（本 fork 新增）"]
    H[Collaboration HTTP<br/>/api/v1]
    W[WebSocket<br/>/events]
    S[(SQLite WAL<br/>权威存储)]
    CO[Coordinator Agent]
    MQ[Git merge queue<br/>+ 裸仓库]
  end

  D -->|可信 LAN: HTTP + WS| H
  C -->|可信 LAN: HTTP + WS| H
  H --> S
  W --> S
  CO --> S
  MQ -->|安全时 fast-forward；否则投影到 tracking ref| G
  G -->|不可变 Git bundle| MQ
  R -. projection .-> S
```

### 权威模型

- **服务器是协作状态的唯一写入者**。所有写操作都在显式 `BEGIN IMMEDIATE` 事务里跑。
- 每个聚合都带单调递增的 `version`。过期命令会以 `version_conflict` 失败。
- 每个客户端命令都带 `idempotencyKey`（16–128 个 ASCII 字符）。重放会返回缓存结果。
- 领域行写入 + idempotency 行 + `domain_events` 追加 + `audit_log` 追加共用一个事务（见 `packages/server/src/store.ts:executeIdempotent`）。
- Runtime 领域逻辑**不允许 import 服务端**。`packages/runtime` 写入边界拆为 `FileRuntimeRepository`（默认）与 `SqliteRuntimeRepository`（server 模式）。A1–A5 在每次 merge 后保持单机模式仍可跑。

### 服务端模块（`packages/server/src/`）

| 模块 | 职责 |
|---|---|
| `identity/` | 用户、设备、邀请码、session、成员、权限 |
| `planning/` | 规划室、消息、附件元数据、artifact 引用 |
| `proposals/` | 不可变修订、审批策略、投票、生命周期 |
| `work/` | 任务、assignment、lease、heartbeat、submission、review、reclaim |
| `events/` | 持久事件流、WebSocket publisher、resync cursor、HTTP 可用性 |
| `agents/` | coordinator run、输入输出、预算、取消、重试 |
| `git/` | 裸仓库、worktree 生命周期、ownership 校验、merge queue、check |
| `audit/` | 仅追加的动作历史 |
| `attachments/` | 上传元数据、digest、size 检查、BOLA 防护 |
| `collaborationApi.ts` | 八个模块的 HTTP 路由 |
| `lifecycle.ts` | `startPlanweaveServer`、启动 reconciliation、优雅关停 |
| `store.ts` | SQLite handle、migrations runner、`executeIdempotent` |
| `config.ts` | 环境变量驱动的配置、端口 / 数据目录 / join token / busy timeout |

### 桌面端分层

```
┌─────────────────────────────────────────────────────────────────┐
│  侧栏                                              │
│  ├─ PlanWeave brand 头 + 折叠 / 后退 / 前进                     │
│  ├─ Mode: Personal / Team（带角色徽章）                         │
│  ├─ Team 子导航（Team 模式时）：规划室 / 流程图 / 团队任务 /    │
│  │     提案 / 成员                                               │
│  ├─ 本地导航：新建任务 / 流程图 / 画布地图 / 待办 / 搜索 /      │
│  │     通知                                                       │
│  └─ 底部：设置（向上弹出下拉）/ 重置布局                        │
├─────────────────────────────────────────────────────────────────┤
│  主显示区                                                        │
│  ├─ Personal 模式 → WorkspaceTabs（graph / canvas / todo / …） │
│  ├─ 设置视图  → AppSettingsRoute（5 个分区）                     │
│  └─ Team 模式  → TeamModeShell（内嵌，占满主区）                │
│                  ├─ 选择 host / member 角色                      │
│                  ├─ 本机 team host 启动                          │
│                  └─ 当前项目 shell                                │
├─────────────────────────────────────────────────────────────────┤
│  浮动组件面板（可拖拽、悬停展开）                                │
└─────────────────────────────────────────────────────────────────┘
```

### 支持的部署形态

- **单机文件驱动** —— 原版 PlanWeave，照常工作。Runtime 走 `FileRuntimeRepository`，不需要 server。
- **LAN 多人协作** —— 一个项目对应一个 `packages/server` 实例。桌面 / CLI 通过 LAN 连接。SQLite WAL 提供权威存储；Git merge queue 串行化提交。

---

## 2. Git + GitHub 集成

### MCP 工具

PlanWeave 通过 MCP 协议暴露 8 个 git/GitHub 工具，Agent 可直接调用：

| 工具名 | 类型 | 用途 |
|--------|------|------|
| `git_status` | 只读 | 查看工作区状态（分支、暂存/未暂存文件、前后提交数） |
| `git_diff` | 只读 | 查看未暂存或已暂存的改动 |
| `git_log` | 只读 | 查看提交历史 |
| `git_commit` | 写入 | 暂存全部改动并创建提交 |
| `github_create_pr` | 写入 | 创建 GitHub Pull Request |
| `github_list_prs` | 只读 | 列出仓库的 Pull Request |
| `github_get_pr` | 只读 | 查看单个 PR 详情（含修改量、状态） |
| `github_merge_pr` | 写入 | 合并 PR（支持 merge/squash/rebase） |

### CLI 命令

```bash
# Git 操作
planweave git status              # 查看工作区状态
planweave git diff [--staged]     # 查看改动
planweave git log [-n 10]         # 提交历史
planweave git commit -m "msg"     # 暂存全部并提交

# GitHub 认证
planweave gh login                # 打开浏览器生成 token → 粘贴保存
planweave gh logout               # 清除保存的 token
planweave gh status               # 查看当前认证状态

# GitHub 操作
planweave gh pr create -t "title" --head feat --base main [-b "body"]
planweave gh pr list [-s open|closed|all]
planweave gh pr view <number>
planweave gh pr merge <number> [--squash|--rebase]
```

### 桌面端设置面板

桌面端设置新增 **Git & GitHub** 标签页，提供：

- **仓库状态**：分支、领先/落后提交数、文件改动列表（无需离开桌面端）
- **GitHub 认证**：输入框粘贴 Token → 一键连接，显示登录身份和权限范围，一键登出

### 模块位置

```
packages/runtime/src/git/        ← Git 核心操作（execFile 封装，纯 Node）
packages/mcp/src/github/         ← GitHub API 客户端 + 认证模块
packages/mcp/src/toolHandlers/   ← MCP 工具处理器
packages/cli/src/commands/       ← CLI 命令
packages/desktop/src/main/       ← gitIntegration IPC 处理器
packages/desktop/src/renderer/   ← 设置面板 UI
```

### 认证（四级自动检测）

```
PLANWEAVE_GITHUB_TOKEN 环境变量          ← 显式覆盖，最高优先级
    ↓ 没有
~/.planweave/github-auth.json            ← planweave gh login 保存
    ↓ 没有
gh auth token / ~/.config/gh/hosts.yml   ← gh CLI 登录态
    ↓ 没有
git credential fill                      ← HTTPS remote credential helper
    ↓ 也没有
提示运行 planweave gh login
```

- **90% 用户零配置**：装了 `gh` CLI 的直接用
- **仓库识别**：通过 `git remote get-url origin` 自动解析 `owner/repo`

---

## 3. Security

### Ghost Security SAST Scan（2026-07）

对 `packages/server/` 和 `packages/mcp/` 运行了 Ghost Security 自动化 SAST 扫描，覆盖 injection、authz、authn、path-traversal、SSRF、info-disclosure 等向量。

#### 已修复

| 严重度 | 组件 | 发现 | 修复 |
|--------|------|------|------|
| **HIGH** | server | BOLA：assignment heartbeat/submit/withdraw 不校验 `actorId === assigneeUserId`，任何项目成员可操作他人 assignment | `work/services.ts` 加所属人校验 |
| **MEDIUM** | server | BFLA：viewer 角色可执行 assignment 状态变更操作 | `collaborationApi.ts` assignment 接口提权到 `contributor` |
| **MEDIUM** | server | Auth：默认 join token 硬编码为 `"planweave-local-team"`，网络可达时可被猜测 | `config.ts` 强制要求 `PLANWEAVE_SERVER_JOIN_TOKEN` 环境变量 |
| LOW | server | git branch name 未校验直接传给 git 命令 | `worktreeManager.ts` 加 regex 校验 + `--` 分隔符 |
| LOW | mcp | 错误消息可能泄露文件系统路径 | `server.ts` 错误响应不再暴露原始 `error.message` |
| LOW | mcp | X-Forwarded-* 头无条件信任，loopback 外可 spoof issuer URL | `oauthHttp.ts` 仅 `trustProxy: true` 时信任 |

#### 已确认安全

| 领域 | 评估 |
|------|------|
| SQL 注入 | 全部查询使用 `?` 参数化占位符，无拼接 |
| SSRF | 生产代码无出站 HTTP 请求 |
| 路径穿越 | `validatePathWithinScope` 校验 + 遍历序列拒绝，含测试覆盖 |
| PKCE | `timingSafeEqual` + SHA-256，OAuth redirect URI 仅允许 HTTPS / loopback HTTP |
| 配置文件权限 | 原子写入，目录 `0o700`，文件 `0o600` |
| ReDoS | 全仓正则无灾难性回溯 |

#### 已知接受的风险

| 风险 | 缓解 |
|------|------|
| CI acceptance check 命令可由 maintainer 配置并执行 | `execFile` 无 shell 注入；仅 maintainer 可配；timeout 120s + maxBuffer 限制 |
| OAuth `/register` 无鉴权（DCR 规范兼容） | loopback-only 绑定；consent page 需显式用户授权 |

---
