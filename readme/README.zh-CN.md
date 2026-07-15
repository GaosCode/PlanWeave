<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave 是一个文件驱动的 loop engineering 系统，面向长期运行的 Coding Agent。它把模糊计划转化为可领取任务，把任务交给实现和评审 Agent，记录每次运行，并让整个循环可恢复。
</p>
<p align="center">
  <img src="assets/planweave-readme-animation.svg" width="860" alt="PlanWeave 品牌动效。" />
</p>

<p align="center">
  <a href="../README.md">English README</a>
</p>

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


## PlanWeave 是什么

Chat 很适合发起计划，但不适合作为长期工程循环的唯一载体。

PlanWeave 可以把模糊目标或通过 Chat 生成的计划落到任务图里：任务是节点，执行步骤、检查、评审和反馈都是块。每个 block 都可以被专门的 Agent 领取，经过实现和评审，再把运行记录保存成可追踪产物。Agent 执行时拿到当前 block 和相关图上下文，项目本身则保留什么运行过、什么通过评审、什么需要继续循环的可恢复历史。

这让 PlanWeave 很适合复杂工程任务：并行实现、阶段检查、Review 出反馈、自动修复、继续执行和效率统计，都可以沉淀在同一个本地工程循环里。

## 项目优势

- **文件即节点，文档即块**：任务图不是展示层，而是项目结构本身。
- **图友好**：依赖、执行顺序、Review/Feedback 循环和状态变化都可以直接在图上观察和编辑。
- **零配置上手**：安装 CLI 和 agent skills 后，只需几个命令和 skill prompt，就能在现有项目里创建、执行和检查计划。
- **有边界的图上下文**：Agent 执行时拿到当前 block 和相关任务图上下文，需要时可以继续查看更多信息。
- **职责聚焦**：每次 claim 都把一个聚焦 block 交给一个专门的 Agent，减少无关计划、陈旧讨论和额外 token 对上下文的污染。
- **不同节点和块可指定不同 Agent**：实现块可以用 Codex，也可以把某些块交给 Claude Code、OpenCode 或 Pi，确定性检查可以交给本地命令。
- **通过 MCP 让 ChatGPT 生成计划**：把 ChatGPT 连接到 PlanWeave 本机 MCP server、headless systemd tunnel 或桌面端 secure tunnel 后，可以让它创建画布、任务、Blocks、Review Pipeline 和依赖关系。
- **任务流清晰、自由编辑**：节点、块、提示词、依赖和执行范围都可以调整。
- **全自动一站式完成任务流**：从 claim block、执行、记录报告、Review、生成反馈到继续修复，形成闭环。
- **Review 和反馈是一等公民**：Review block 可以产出结构化反馈，再回到实现 block 自动修复。
- **桌面端和 CLI 均支持**：可以用 Electron 图板操作，也可以用终端驱动同一个 runtime。
- **统计视图和搜索能力**：方便观察开发效率、运行历史、任务状态和项目 Todo。
- **本地优先、文件可审计**：prompt、运行记录、报告、metadata 和产物都留在本地工作区，便于检查、回滚和提交。
- **运行过程可监控**：每个 block run 会保留有序事件、日志、report、metadata 和可用的监控操作。

default canvas 的可检查文件位于 PlanWeave workspace 内的 `canvases/default/package`、`canvases/default/state.json` 和 `canvases/default/results`。具体本地路径以 `planweave paths --json` 返回为准。

## 快速开始

PlanWeave 目前主推 CLI。桌面应用可以测试使用，但仍是实验版，且安装包未签名。

用 npm 安装 CLI：

```bash
npm install -g @planweave-ai/cli
```

也可以用 Homebrew 安装：

```bash
brew install GaosCode/tap/planweave
```

然后运行：

```bash
planweave --help
```

同时安装 agent skills：

```bash
npx skills@latest add GaosCode/PlanWeave
```

## MCP 与 ChatGPT 网页端生成计划

PlanWeave 内置本机 HTTP MCP server，可以让 ChatGPT 等 MCP client 直接使用 PlanWeave。MCP 工具不只是只读状态查询；它也能写计划：初始化项目、创建任务画布、添加任务和 Blocks、连接依赖、编辑 prompt、配置 Review Pipeline、检查 graph quality，并导入 package draft。

如果要在浏览器里的 ChatGPT 使用 PlanWeave，VPS/headless 环境推荐使用 CLI MCP tunnel，本地可视化环境可以使用桌面端设置。你可以使用 ChatGPT Web 来制定计划：描述项目目标，让它先写出临时 draft root 下的 package-shaped draft，dry-run 校验和质量检查，预览导入，再事务式 apply。

VPS 推荐路径是 systemd。MCP server 仍只监听 loopback，OpenAI `tunnel-client` 通过出站长连接接入；PlanWeave CLI 不实现自己的 daemon、pidfile 或后台守护。

```bash
sudo mkdir -p /etc/planweave /srv/planweave
sudo chmod 700 /etc/planweave

planweave mcp tunnel download
planweave mcp tunnel configure --tunnel-id tunnel_xxx
planweave mcp tunnel print-systemd \
  --planweave-home /srv/planweave \
  --env-file /etc/planweave/mcp-tunnel.env
```

把 Runtime API key 写入 systemd environment file，不写入 PlanWeave 的普通 JSON 配置：

```bash
PLANWEAVE_HOME=/srv/planweave
OPENAI_RUNTIME_API_KEY=...
```

这个文件应只允许服务所属用户读取：

```bash
sudo chmod 600 /etc/planweave/mcp-tunnel.env
```

把打印出来的 service 安装为 `planweave-mcp-tunnel.service` 后运行：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now planweave-mcp-tunnel
journalctl -u planweave-mcp-tunnel -f
```

本地桌面端路径：

1. 在桌面应用打开 **Settings -> MCP Tunnel**。
2. 下载或选择 OpenAI [`tunnel-client`](https://github.com/openai/tunnel-client)。
3. 填入 Tunnel ID 和 Runtime API key，然后启动 secure tunnel。
4. 在 ChatGPT 中用 Tunnel 连接方式添加 PlanWeave。

连接完成后，ChatGPT 可以读取 PlanWeave authoring rules 和 schema，用 `list_tool_groups` 发现推荐工具路径，用 `get_graph_summary` / `get_graph_slice` 查看有界图视图，用 `validate_graph_quality` 检查图质量，并通过 path/ref 内容工具定点读取大内容。大型计划推荐 MCP 流程是 `validate_package_draft`、`preview_package_import`，然后用 `import_package_draft` 且传入 `apply: true`。

默认 MCP discovery 会隐藏旧别名和 heavy/debug 工具。仍依赖 `get_project_graph`、`get_block_detail`、`refresh_prompts`、`export_plan_package` 或 `import_plan_package` 等旧别名的 MCP client，需要用 `PLANWEAVE_MCP_TOOL_DISCOVERY=compat` 启动 server。新 client 应保持默认 discovery 并使用有界工具；`get_block_detail_full_debug`、`refresh_prompts_full_debug`、`export_plan_package_full` 这类 heavy/debug 工具需要显式调用。

源码级 MCP server 配置见 [Development](../DEVELOPMENT.md)。

## Agent 执行方式

PlanWeave 支持 executor profile，因此同一张任务图里可以混合使用不同执行器。目前支持 Codex、Claude Code、OpenCode、Pi、Local Review 命令和 Review/Feedback 自动循环。

每次 block run 都会写入可追踪产物，包括 prompt、stdout、stderr、report、metadata 和可用的监控命令。

## Agent Skills

仓库在 `skills/` 下提供了几个职责明确的 agent skill：

- `plan-maker`：从模糊目标或少量代码上下文设计 PlanWeave package-shaped draft；用户要求 materialize 时，通过 draft validate/import 写入。
- `plan-importer`：从强 source docs 创建 PlanWeave package draft，再通过 draft validate、preview 和 import 写入。
- `plan-auditor`：审查已经写好的 PlanWeave plan，检查目标覆盖、对象生命周期、契约漂移、弱 prompt 和不可验证完成条件。
- `plan-coordinator`：作为主 agent 持续推进整个 PlanWeave 执行循环，分发实现、评审和恢复任务。
- `plan-runner`：执行一个 implementation block，并产出完成报告。
- `plan-reviewer`：执行一个 review gate，并产出结构化 `passed` 或 `needs_changes` 结果。
- `plan-recovery`：诊断和恢复 stale current refs、state/results drift、blocked/diverged work 和 submit retry 混乱。

可以用 `skills` CLI 安装：

```bash
npx skills@latest add GaosCode/PlanWeave
```

## Agent 工作流

安装 skills 后，在目标项目里按这个流程使用：

1. 让 agent 创建或导入计划。

```text
Use skill: plan-maker
Create a PlanWeave plan for this project from the goal below...
```

如果已经有 PRD、roadmap、issue 或架构说明，用 `plan-importer`。`plan-maker` 不再把 Markdown-only 报告交给 `plan-importer` 二次转译；materialize 时应直接写出 package-shaped draft 并运行：

```bash
planweave package-draft validate --draft-root <draft> --json
planweave package-draft quality --draft-root <draft> --json
planweave package import --from <draft> --dry-run --json
planweave package import --from <draft> --apply --json
```

2. 让 coordinator 执行计划。

```text
Use skill: plan-coordinator
Run the current PlanWeave package. Route implementation to plan-runner, review gates to plan-reviewer, and recovery work to plan-recovery.
```

3. 让 coordinator 分发聚焦任务。

coordinator 应该一次只分配一个明确 block。实现类 agent 用 `plan-runner`；评审类 agent 用 `plan-reviewer`；异常状态或 submit retry 问题用 `plan-recovery`。

4. 需要排查时用 CLI 查看状态。

```bash
planweave status
planweave current
planweave explain <ref>
planweave graph inspect --view summary --json
planweave graph quality --json
planweave doctor
```

简单任务可以由一个 agent 直接使用 `plan-runner` 完成。复杂计划建议用 `plan-coordinator` 作为主控 agent，再把子任务分给 `plan-runner`、`plan-reviewer` 或 `plan-recovery`。

## Auto Run

Auto Run 会领取 ready work、调用所选 executor、提交产物、继续 review-feedback 循环，并把每次运行记录为 session。

```bash
planweave run --once --json
planweave run --parallel --step-limit 20 --timeout 120000 --json
planweave run --scope task --task T-001 --once --json
planweave run --scope block --block T-001#B-001 --once --json
```

executor 按 block、task 和 package 默认配置解析。使用 `--executor <profile>` 显式覆盖本次运行，使用 `--canvas <canvas-id>` 选择 canvas。

PlanWeave Desktop 提供范围化运行控制、实时进度和 session 历史。CLI 用户可以用以下命令查看同一份 runtime state：

```bash
planweave run-status --follow --json
planweave run-sessions --json
planweave run-session <session-id> --json
```

### ACP runners

Codex、Claude Code、OpenCode 和 Pi 提供显式 ACP profile：

```text
codex-acp
claude-code-acp
opencode-acp
pi-acp
```

安装并登录所选 Agent，然后检查并运行 profile：

```bash
planweave executors test codex-acp --json
planweave run --once --executor codex-acp --timeout 120000 --json
```

ACP run 提供结构化消息、工具更新、产物、usage snapshot 和交互请求。PlanWeave Desktop 会显示当前 run 可用的 follow-up、cancel、permission、elicitation 和 retry 操作。Run record 保存标准化事件和协议诊断，可用于检查与回放。

Plan Package 自定义 profile 需要对解析后的命令和参数进行精确信任：

```bash
planweave trust executor <profile>
```

遇到认证或 provider 错误时，完成 Agent 的登录和 provider 配置，再运行 `executors test`。开发验证命令见 [Development](../DEVELOPMENT.md#acp-verification)。

## 手动 CLI 工作流

多数用户应该通过 skills 驱动 PlanWeave。手动 CLI loop 更适合调试、演示或自己接入 agent：

```bash
planweave init --json
planweave validate --json
planweave current
planweave claim-next --dry-run
planweave prompt T-001#B-001
planweave submit-result --canvas default T-001#B-001 --report report.md
```

Review gate 和 feedback loop 也可以手动提交：

```bash
planweave submit-review --canvas default T-001#R-001 --result review-result.json
planweave submit-feedback --canvas default --report feedback-report.md
```

PlanWeave 默认从当前 shell 目录解析目标项目 root。包管理器可能设置 `INIT_CWD`，PlanWeave 会优先使用它，再使用 `cwd`。如果需要从其他目录操作目标项目，把全局选项放在子命令前：

```bash
planweave --project-root /path/to/project status --json
planweave --project-root /path/to/project claim-next --canvas desktop
```

当调度原因不清楚时，先用 `planweave explain <ref>`、`planweave why-not <ref>` 和 `planweave doctor` 诊断，再考虑修改 package 或 state 文件。

## 实验性桌面应用

桌面应用目前是实验性版本，适合试用可视化任务图谱、配置给 ChatGPT 使用的 MCP tunnel，并在执行前检查生成出来的计划；正式工作流仍建议优先使用 CLI。

<p align="center">
  <img src="assets/planweave-desktop-canvas.png" width="860" alt="PlanWeave 桌面端任务画布，展示 Agent 任务图、实现块和评审块。" />
</p>

可以直接安装 GitHub Releases 里的安装包。当前桌面安装包未签名。macOS 可能提示无法验证开发者，Windows 可能提示未知发布者或 SmartScreen 风险。macOS 早期测试时可以通过 **右键 -> 打开** 启动应用，并在系统提示里确认。

仓库结构、源码开发、测试和本地打包命令见 [Development](../DEVELOPMENT.md)。

## 未来方向

PlanWeave 还处在早期阶段，后续可以从几个方向继续提升基于计划的 Agent 工作流体验：

- **多人协作任务图板**：让多人可以共同编辑同一个任务画板，一起调整计划结构，并把协作形成的计划决策转化为可执行 block。
- **跨主机协调**：PlanWeave 现在已经支持把不同 block 路由给不同的本地 agent 或 executor profile。未来的 coordinator 可以让远端 Agent Host 注册能力、通过 lease 领取计划块、上报 heartbeat，并安全提交产物，从而让前端、评审、runtime、文档等专业 agent 跑在不同机器上。

## 开发

贡献者环境、仓库结构、测试命令和本地打包说明见 [Development](../DEVELOPMENT.md)。

## License

MIT。详见 [LICENSE](../LICENSE)。
