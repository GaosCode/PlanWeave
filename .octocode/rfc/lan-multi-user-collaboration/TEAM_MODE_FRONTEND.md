# Team Mode — Desktop Frontend Design Specification

> Product direction for the collaboration feature in `RFC.md`. This document specifies user experience and information architecture; it does not change the server contract or replace `RFC.md` scope.

## Product framing

**Team Mode is a separate workspace, not a local project with extra tabs.**

Local Mode answers: “What can I run and edit in this workspace?”

Team Mode answers: “What does this team need to decide, own, deliver, and merge next?”

The entry is a deliberate mode switch in the app's project launcher. Once opened, Team Mode has its own shell, lifecycle indicator, and navigation. It reuses the existing graph canvas only for execution mapping. This avoids blending private local file operations with shared server state.

## Primary users and jobs

| User | Main job in Team Mode | Needs to see first |
|---|---|---|
| Contributor | Turn an idea or assigned task into a reviewed commit | My next action, assignment boundary, branch/check state |
| Maintainer | Move the team from ambiguity to a safe merged result | Decision blockers, review/merge risk, queue state |
| Approver | Assess one coherent proposal revision | Revision summary, source evidence, unresolved questions, approval state |
| Project owner | Keep people, scope, and delivery healthy | Project phase, participation, blocked work, auditability |

## Entry and shell

### App launcher

The project launcher presents two explicit choices:

```text
[ Open local project ]       files, canvases, local execution
[ Enter Team Mode ]          server, people, shared decisions, delivery
```

For a server project, selecting the project opens Team Mode by default. A compact “Open local checkout” secondary action remains available only when the user has one.

### Team Mode shell

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ PlanWeave  /  Team Mode  /  Atlas API                         ● Synced  ◉  │
├──────────────┬────────────────────────────────────────────────────────────┤
│ PROJECT       │  [Stage rail: Explore — Agree — Execute — Merge]           │
│ Overview      │                                                            │
│ Discussions   │  Active view                                                │
│ Proposal      │                                                            │
│ Work          │                                                            │
│ Execution Map │                                                            │
│ Merge Queue   │                                                            │
│ Activity      │                                                            │
├──────────────┤                                                            │
│ 7 members     │                                                            │
│ 4 online      │                                                            │
│ [Members]     │                                                            │
└──────────────┴────────────────────────────────────────────────────────────┘
```

The top bar always contains: project name, `Team Mode` label, project phase, sync/connection state, unread activity count, and the current user avatar/menu. It never contains local path or file-watch status; those are Local Mode concepts.

The stage rail is a status model, not a navigation menu:

```text
Explore → Agree → Execute → Merge
```

It explains why a primary action is unavailable. Example: “Execution is locked until 2 required approvals arrive.” Clicking a stage opens its relevant view.

## Navigation and page architecture

| View | Stage | Primary user question | Primary action |
|---|---|---|---|
| Overview | All | What needs attention now? | Open the highest-priority blocker |
| Discussions | Explore | What evidence and ideas did the team add? | Add thought or reference |
| Proposal | Agree | What exactly are we approving? | Approve this revision / request changes |
| Work | Execute | What should I or the team do next? | Claim or open assigned work |
| Execution Map | Execute | How do people, tasks, dependencies and locks relate? | Inspect a task boundary |
| Merge Queue | Merge | What is safe to integrate next? | Review queue entry / resolve failure |
| Activity | All | What changed, by whom, and why? | Open source action |

Settings, server connection, and member administration are reached from the top-right project menu, rather than consuming a primary collaboration navigation slot.

## The Overview — the Team Mode home page

This is the default page. It is a calm triage screen, not an analytics dashboard.

```text
Project phase: AGREE                                  Last synced just now
“Atlas API — security-first ingestion service”
2 decisions block execution                                      [View proposal]

NEXT FOR YOU                         TEAM PULSE
• Review API boundary proposal       5 of 7 members active
  Required by today                  2 approvals still needed
  [Open review]                      3 tasks ready after approval

RECENTLY DECIDED                     DELIVERY WATCH
• Storage: SQLite WAL                No merge candidates yet
• Auth: per-device identity          1 task ownership conflict resolved
  [See decision log]                 [Open activity]
```

The page has one dominant next action. Other content is lightweight, list-like, and linked to its source view. Do not put metrics cards across the entire screen.

### Overview states

- **Explore:** show open questions, new evidence, and “Summarize new input” as the coordinator Agent action.
- **Agree:** show current proposal revision, approval progress, and request-change count.
- **Execute:** show each user’s next task, blocked dependency, and lease urgency.
- **Merge:** show the front of the merge queue and the specific validation/review blocker.
- **Offline/reconnecting:** retain last snapshot, show timestamp and a non-destructive `Reconnect` action; disable mutations with an explanation.

## Discussions — evidence before consensus

Discussions are a two-column working surface:

```text
┌───────────────────────────┬───────────────────────────────────────────────┐
│ Channels                  │ # architecture                                │
│ • All input               │ [Add thought] [Upload reference]              │
│ • Architecture             │                                               │
│ • Product scope            │ Mei · 10:42                                   │
│ • Delivery                 │ “Use a single server first …”                 │
│                            │ [Referenced by Proposal r4]                   │
│ Evidence inbox             │                                               │
│ 3 untriaged uploads        │ Coordinator summary                            │
│                            │ “Three constraints emerged …”                 │
│                            │ Sources: Mei message · api-contract.pdf       │
└───────────────────────────┴───────────────────────────────────────────────┘
```

Requirements:

- Composer supports plain text, paste/drop upload, and a lightweight “question / decision / risk / reference” tag.
- Attachments show file name, type, size, uploader, processing state, and authorization-safe preview—not raw local paths.
- Coordinator summaries are visually distinct but never presented as a human decision. They display source count and open the cited messages/files.
- A message can be marked “consider for proposal,” but only the coordinator or a maintainer creates a proposal revision.

## Proposal — a revision-bound agreement screen

The proposal page is intentionally document-led rather than chat-led.

```text
Proposal r4                             In review · 5/7 required approvals
“Adopt single-server collaboration architecture”
Changed since r3: 3 sections · 2 new risks · 1 resolved question

Summary | Requirements | Decisions | Open questions | Sources
─────────────────────────────────────────────────────────────────
[document content with inline source chips]

Approval panel
You: Not reviewed
[Approve r4]  [Request changes]
Required: Mei ✓  Arun ✓  Jia •  Lin •
```

Requirements:

- Approval always names the exact revision (`r4`) and visibly warns that a newer revision invalidates approval.
- Approval requires a small review confirmation; `request changes` requires a comment tied to a section.
- Diff from preceding revision is available but secondary to the readable current proposal.
- Source chips open a right-side evidence drawer without losing reading position.
- The primary action is disabled only with an explicit reason: missing role, stale revision, or project frozen.

## Work — the operational team board

Use a grouped work list instead of a Kanban-first design. The key differentiator is responsibility and integration readiness, not just task status.

```text
Work                                      [My work] [Team] [Needs review]

MY NEXT
T-023  Add server event stream
Ready · owned by you · lease 26m remaining
Scope: packages/server/src/events/**
Checks: server integration suite
[Open task]

WAITING ON TEAM
T-017  Server schema foundation     Mei · In review
T-021  Member session UI            Lin · Blocked by T-017

UNASSIGNED READY WORK
T-026  Merge queue audit log        2h estimate omitted; required skills shown
[Claim task]
```

Each row has a single status line and exposes details on open. Avoid permanent columns for every Git field.

### Task detail drawer

Opening a work item uses a wide right drawer rather than a new route so members retain team context. Sections:

1. Intent and acceptance criteria.
2. Ownership boundary: allowed paths and protected paths.
3. Dependencies and lock explanation.
4. Assignment: assignee, lease, reviewers, handoff action.
5. Local delivery: branch name, base commit, submit commit action/state.
6. Verification: checks, logs, review feedback.
7. Activity and audit trail.

Primary action changes by state: `Claim`, `Open local branch`, `Submit commit`, `Address review`, or `View merge status`.

## Execution Map — shared responsibility graph

This page reuses the current PlanWeave graph canvas as an execution map. It is not the first Team Mode screen.

### Node treatment

Each task node has four compact bands:

```text
T-023  Event stream
Mei · implementation · in review
Scope: server/events/**
✓ 4/4 checks   PR candidate queued
```

- Assignee avatar/name replaces the current executor prominence in Team Mode.
- Status combines work state and merge state carefully; no more than one colored status pill.
- Hover/focus reveals locks, dependencies, reviewers, and changed files.
- Node colors continue to show execution state; ownership and conflict must also have textual/icon labels for accessibility.
- Selecting a node opens the task detail drawer; editing graph topology is restricted to maintainers during approved execution.

### Map controls

Keep zoom/minimap and task focus. Replace the right “Components” palette in Team Mode with a collapsible **Team Context** panel: members, filters, active locks, and currently running reviews. Graph editing tools only appear when the current project phase and role permit structural edits.

## Merge Queue — deliberate, inspectable integration

The merge queue is a timeline/list, not a CI dashboard.

```text
Merge Queue                                      Target: main @ a18f9c

01  T-023 Event stream                 Validating
    Mei · 2 commits · checks 3/4       [View validation]

02  T-017 Server schema                Needs changes
    Review: ownership scope exceeded   [Open feedback]

03  T-026 Audit log                    Waiting for dependency
    Depends on T-017                   [View dependency]
```

An entry expands in place for check logs, review verdict, changed paths, base/head comparison, and audit history. Only maintainers see queue management actions; contributors see their own actionable feedback first.

## Activity — a trust and recovery surface

Activity replaces a generic notification inbox in Team Mode. It is chronological, filterable by `decision`, `assignment`, `review`, `merge`, and `system`, and every event links to its object.

Important events use a concise human sentence:

```text
Lin approved Proposal r4 · 4 min ago
Mei submitted T-023 at commit 8ac21d
Merge validation stopped: server integration suite failed
```

Notifications are ephemeral prompts; Activity is the durable history. Do not allow dismissing Activity events.

## Interaction rules and safety states

| Situation | UI response |
|---|---|
| User has stale data | Preserve draft, show “This changed while you were viewing it,” offer compare/reload; never silently overwrite |
| Proposal revision changed | Replace approval CTA with “Review r5”; show what changed |
| Lease nearing expiry | Non-modal countdown at 10 minutes; prominent action to renew or release |
| Lease expired | Disable submit mutation only after server confirmation; preserve branch/commit information and offer request reassignment |
| User lacks role | Show action disabled with role explanation and named person/team to contact |
| Connection lost | Read-only cached snapshot with timestamp; queue local drafts only when the backend contract supports it |
| Merge check fails | Surface the failing check and first actionable feedback; do not make the user parse raw logs first |
| Project frozen | Persistent phase banner, no accidental mutation controls, link to freeze reason/audit event |

## Visual system

Match the current PlanWeave Desktop direction visible in `readme/assets/planweave-desktop-canvas.png`:

- Keep the dense-but-calm desktop workbench, neutral surfaces, fine dividers, rounded controls, restrained shadows, and graph-centric canvas.
- Use the existing semantic status palette for system state; reserve a distinct indigo/blue accent for shared/team context, not a second rainbow of status colors.
- Use avatars sparingly: assignee, author, reviewer, approver. Do not decorate every list row with faces.
- Make project phase visually stronger than secondary metadata; make the single next action stronger than any metric.
- Prefer grouped lists with row separators over many nested cards.
- Use 14–16px body text, tabular monospace only for task IDs, commit SHAs, counters, and logs.
- Support English and Simplified Chinese with labels that do not rely on truncation for meaning.

## Accessibility

- Every status color has text and icon backup.
- Keyboard order follows page hierarchy; drawers trap focus and return it to their triggering task.
- Approval and merge actions disclose the exact revision/commit they affect.
- WebSocket updates announce meaningful changes through a restrained `aria-live` region, not every background event.
- Reduced-motion preference disables graph/status animation beyond essential focus feedback.
- Logs and diff panels retain copy/select behavior and meet contrast requirements.

## Implementation map

### New frontend units

```text
renderer/team/
  TeamModeShell.tsx
  TeamModeOverviewView.tsx
  TeamDiscussionView.tsx
  TeamProposalView.tsx
  TeamWorkView.tsx
  TeamExecutionMapView.tsx
  TeamMergeQueueView.tsx
  TeamActivityView.tsx
  TeamTaskDrawer.tsx
  teamTypes.ts
  teamViewModels.ts
  hooks/useTeamProject.ts
  hooks/useTeamEvents.ts
  hooks/useTeamMutations.ts
```

### Existing files to adapt

| Existing area | Design change |
|---|---|
| `renderer/App.tsx` | Add a top-level mode router so Team Mode has a dedicated shell/controller rather than enlarging Local Mode conditionals |
| `renderer/types.ts` | Keep `AppView` local-only; introduce separate `TeamView` union to prevent incompatible state mixing |
| `renderer/sidebar/ProjectSidebar.tsx` | Keep for Local Mode; create `TeamSidebar` rather than branching every local project action |
| `renderer/views/WorkspaceTabs.tsx` | Keep for Local Mode; create `TeamWorkspaceTabs`/Team router |
| `renderer/views/TodoView.tsx` | Reuse visual primitives only; Team Work is a new view-model and interaction model |
| `renderer/views/NotificationsView.tsx` | Reuse notification primitives; Team Activity is durable and should be separate |
| `renderer/graph/*` | Add Team node decorators and selection-to-drawer behavior behind Team Mode props, without regressing local canvas editing |
| `renderer/settings/*` | Add server/profile entry point; actual membership admin belongs in Team project menu |
| `preload/preload.ts` | Expose typed team snapshot, mutation and event APIs; renderer never accesses credentials directly |

## Delivery order for frontend work

1. **Shell and connection state:** Team Mode router, sidebar, stage rail, read-only/reconnecting states.
2. **Overview and Work:** the most valuable daily loop—see next action, claim, inspect boundary, submit.
3. **Proposal:** revision reading, sources, and approvals before enabling execution.
4. **Execution Map:** adapt current canvas only after task data/roles are stable.
5. **Merge Queue and Activity:** make delivery and audit transparent.
6. **Discussions/attachments:** add when server planning APIs and artifact citations are ready.

## Acceptance criteria for UX handoff

- A new member can identify within 10 seconds: project phase, their next action, and whether the project is safely synchronized.
- An approver can tell exactly which revision they are approving and what source evidence supports it.
- A contributor can find ownership scope, reviewer, branch, required checks, and submission state without leaving task context.
- A maintainer can explain why a merge is blocked without reading raw logs first.
- Switching between Local Mode and Team Mode never implies that local files are shared server state.

