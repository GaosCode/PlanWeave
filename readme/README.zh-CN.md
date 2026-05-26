<p align="center">
  <img src="assets/planweave-logo.png" width="128" alt="PlanWeave logo" />
</p>

<h1 align="center">PlanWeave</h1>

<p align="center">
  PlanWeave 是一个文件驱动的协调系统，可以把项目计划转化为可领取、可评审、可恢复的任务，并交给本地或远端 Coding Agent 协作完成。
</p>
<p align="center">
  <img src="assets/planweave-readme-animation.svg" width="860" alt="PlanWeave 品牌动效。" />
</p>

<p align="center">
  <a href="../README.md">English README</a>
</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.0.0-orange?style=for-the-badge" />
  <img alt="license" src="https://img.shields.io/badge/license-MIT-yellow.svg?style=for-the-badge" />
  <img alt="language" src="https://img.shields.io/badge/language-TypeScript-3178c6?style=for-the-badge" />
  <img alt="runtime" src="https://img.shields.io/badge/runtime-Node.js-43853d?style=for-the-badge" />
  <img alt="desktop" src="https://img.shields.io/badge/desktop-Electron-47848f?style=for-the-badge" />
  <img alt="agents" src="https://img.shields.io/badge/agents-Codex%20%7C%20OpenCode-6f42c1?style=for-the-badge" />
</p>


## PlanWeave 是什么

PlanWeave 不是从一段聊天记录开始组织工作，而是从任务本身开始。

它把项目拆成可编辑的任务图：任务是节点，执行步骤、检查、评审和反馈都是块。每个块都是可以被读取、运行、评审和追踪的文档单元。Agent 执行时拿到的不只是当前提示词，而是围绕任务流、依赖关系、项目提示词、运行记录和 Review 状态组成的完整上下文。

这让 PlanWeave 很适合复杂工程任务：并行实现、阶段检查、Review 出反馈、自动修复、继续执行、统计效率，都可以在同一个本地工作流里完成。

## 项目优势

- **文件即节点，文档即块**：任务图不是展示层，而是项目结构本身。
- **图友好**：依赖、执行顺序、Review/Feedback 循环和状态变化都可以直接在图上观察和编辑。
- **Agent 天然拥有全局视野**：执行块时能看到任务图和上下文，不只是孤立 prompt。
- **不同节点和块可指定不同 Agent**：实现块可以用 Codex，某些块可以用 OpenCode，确定性检查可以交给本地命令。
- **任务流清晰、自由编辑**：节点、块、提示词、依赖和执行范围都可以调整。
- **全自动一站式完成任务流**：从 claim block、执行、记录报告、Review、生成反馈到继续修复，形成闭环。
- **Review 和反馈是一等公民**：Review block 可以产出结构化反馈，再回到实现 block 自动修复。
- **桌面端和 CLI 均支持**：可以用 Electron 图板操作，也可以用终端驱动同一个 runtime。
- **统计视图和搜索能力**：方便观察开发效率、运行历史、任务状态和项目 Todo。
- **本地优先、文件可审计**：prompt、运行记录、报告、metadata 和产物都留在本地工作区，便于检查、回滚和提交。
- **运行过程可监控**：每个 block run 会保留 stdout、stderr、report、metadata，并在可用时提供 tmux 监控入口。

## 仓库结构

```text
packages/runtime   核心任务图、包结构、执行器、自动运行和桌面 bridge
packages/cli       planweave 命令行工具
packages/desktop   Electron 桌面图板
examples           示例 PlanWeave package
scripts            仓库检查脚本
```

## 快速开始

安装依赖并构建：

```bash
pnpm install
pnpm -r build
```

启动桌面端：

```bash
pnpm --dir packages/desktop start
```

## 早期测试版本

PlanWeave 目前按早期测试版本分发。macOS 安装包暂未使用 Apple Developer ID 签名，也暂未经过 Apple notarization 公证。如果你从 GitHub Releases 下载 DMG，首次打开时 macOS 可能会提示无法验证开发者。

早期测试时可以通过 **右键 -> 打开** 启动应用，并在系统提示里确认。等项目准备面向更多用户分发后，再补正式签名和公证流程。

构建本地未签名 macOS DMG 和 ZIP：

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --dir packages/desktop dist:mac
```

查看 CLI：

```bash
pnpm --filter @planweave/cli planweave --help
pnpm --filter @planweave/cli planweave help
```

初始化或打开项目工作区：

```bash
pnpm --filter @planweave/cli planweave init --json
pnpm --filter @planweave/cli planweave validate --json
```

自动执行一步：

```bash
pnpm --filter @planweave/cli planweave run --once
```

Auto Run 仍是实验性功能。它可以一键运行当前计划，但调度、执行器集成和异常恢复行为仍可能不稳定；不要直接把它当成无人值守的稳定执行入口，运行后应检查 `planweave run-status` 和生成的 run 产物。

查看状态：

```bash
pnpm --filter @planweave/cli planweave status
pnpm --filter @planweave/cli planweave run-status
```

## CLI 帮助

PlanWeave 内置了面向 Agent 工作流的帮助命令：

```bash
pnpm --filter @planweave/cli planweave help
pnpm --filter @planweave/cli planweave help work
pnpm --filter @planweave/cli planweave help submit
pnpm --filter @planweave/cli planweave help recovery
```

`planweave --help` 用来看原始命令列表，`planweave help <command>` 用来看单个命令参数，`planweave help <topic>` 用来看工作流说明：

- `setup`：定位或初始化 PlanWeave 工作区。
- `plan`：查看和刷新 prompt surface。
- `work`：查看当前工作、预览 claim、领取可执行 block。
- `submit`：提交实现、评审和反馈结果。
- `explain`：解释某个 block 为什么可领取或不可领取。
- `recovery`：诊断 blocked、diverged 或 state/results 不一致。
- `autorun`：查看执行器并运行受控 auto-run 步骤。

## Agent 工作流

典型的手动 Agent loop：

```bash
pnpm --filter @planweave/cli planweave current
pnpm --filter @planweave/cli planweave claim-next --dry-run
pnpm --filter @planweave/cli planweave prompt T-001#B-001
pnpm --filter @planweave/cli planweave submit-result T-001#B-001 --report report.md
```

Review gate 需要提交结构化评审结果：

```bash
pnpm --filter @planweave/cli planweave submit-review T-001#R-001 --result review-result.json
```

如果 review 返回 `needs_changes`，PlanWeave 会创建 runtime feedback work。处理完成后提交：

```bash
pnpm --filter @planweave/cli planweave submit-feedback --report feedback-report.md
```

当调度原因不清楚时，先用 `planweave explain <ref>`、`planweave why-not <ref>` 和 `planweave doctor` 诊断，再考虑修改 package 或 state 文件。

## Agent 执行方式

PlanWeave 支持 executor profile，因此同一张任务图里可以混合使用不同执行器：

- Codex：适合实现、重构、修复等工程任务。
- OpenCode：适合需要进入 OpenCode session 的任务块。
- Local Review：适合确定性检查、脚本校验和结构化 Review。
- Review/Feedback 自动循环：开启后 Review 反馈可以回到实现块继续修复。

每次 block run 都会写入可追踪产物，包括 prompt、stdout、stderr、report、metadata，以及可用时的 tmux attach 命令。

## 未来方向

PlanWeave 还处在早期阶段，后续可以从几个方向继续提升基于计划的 Agent 工作流体验：

- **优化 Auto Run 体验和稳定性**：让自动执行更容易理解、监控、暂停、恢复、排错，也更值得信任，同时提升调度正确性、失败恢复和长时间运行稳定性。
- **多人协作任务图板**：让多人可以共同编辑同一个任务画板，一起调整计划结构，并把协作形成的计划决策转化为可执行 block。
- **跨主机协调**：PlanWeave 现在已经支持把不同 block 路由给不同的本地 agent 或 executor profile。未来的 coordinator 可以让远端 Agent Host 注册能力、通过 lease 领取计划块、上报 heartbeat，并安全提交产物，从而让前端、评审、runtime、文档等专业 agent 跑在不同机器上。

## Agent Skills

仓库在 `skills/` 下提供了几个职责明确的 agent skill：

- `plan-maker`：在还没有正式 package 时，从模糊目标或少量代码上下文设计 PlanWeave 计划草案。
- `plan-importer`：从项目文档创建 PlanWeave Plan Package，并在写入前检查计划质量。
- `plan-auditor`：审查已经写好的 PlanWeave plan，检查目标覆盖、对象生命周期、契约漂移、弱 prompt 和不可验证完成条件。
- `plan-coordinator`：作为主 agent 持续推进整个 PlanWeave 执行循环，分发实现、评审和恢复任务。
- `plan-runner`：执行一个 implementation block，并产出完成报告。
- `plan-reviewer`：执行一个 review gate，并产出结构化 `passed` 或 `needs_changes` 结果。
- `plan-recovery`：诊断和恢复 stale current refs、state/results drift、blocked/diverged work 和 submit retry 混乱。

可以用 `skills` CLI 安装：

```bash
npx skills@latest add GaosCode/PlanWeave --list
npx skills@latest add GaosCode/PlanWeave -g -a codex --skill '*' -y
```

第一条命令只列出可安装的 skill。第二条命令把全部 PlanWeave skills 全局安装到 Codex。若要安装到当前项目，去掉 `-g`；若要安装到 OpenClaw，把 `codex` 换成 `openclaw`。如需关闭安装器的匿名 telemetry，可以在命令前加 `DISABLE_TELEMETRY=1`。

简单任务可以由一个 agent 直接使用 `plan-runner` 完成。复杂计划建议用 `plan-coordinator` 作为主控 agent，再把子任务分给 `plan-runner`、`plan-reviewer` 或 `plan-recovery`。命令语法以 `planweave help` 为准。

## 开发命令

运行测试：

```bash
pnpm test
```

构建全部包：

```bash
pnpm -r build
```

构建后运行桌面端 smoke test：

```bash
pnpm --filter @planweave/desktop smoke
```

## License

MIT。详见 [LICENSE](../LICENSE)。
