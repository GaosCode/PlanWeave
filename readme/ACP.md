# ACP runners

PlanWeave supports two alternative transports for the same agent identity. CLI runners start a command-line turn and may expose tmux monitoring. ACP runners use a structured conversation/session protocol; they are not terminal attachments and never expose tmux controls.

Existing manifests remain valid. Legacy `*-exec` profiles normalize to the canonical CLI runner shape. Built-in names `codex`, `opencode`, `claude-code`, and `pi` select CLI. Explicit names `codex-acp`, `opencode-acp`, `claude-code-acp`, and `pi-acp` select ACP. PlanWeave does not switch transports after preflight or execution failure.

## Setup and trust

Install and configure the selected agent using its own instructions. Login, subscription, provider selection, quota, and optional provider API-key mode belong to that agent. PlanWeave does not ask for, collect, or store a separate provider API key for ACP mode.

```bash
planweave executors test codex-acp --json
planweave run --once --executor codex-acp --timeout 120000 --json
planweave run-status --follow --json
```

Versioned built-in registry ACP profiles launch without additional project trust. Package-authored ACP profiles, including profiles that override a built-in name, still require `planweave trust executor <name>`; that trust is exact to the resolved local command and arguments. A missing executable, changed command, failed authentication, incompatible protocol, unsupported capability, quota failure, or provider failure stops that profile; it does not fall back to CLI or another agent.

For authentication errors, complete login in the agent itself and rerun `executors test`. For protocol failures, record the agent version, PlanWeave version, selected profile, failure code, and redacted diagnostic. Do not paste credentials or raw private prompts into an issue.

## Interaction and observability

Headless CLI/Skill execution is default-safe: it never auto-approves permissions or authentication and cancels unsupported interaction. Desktop may broker a live permission decision. Form elicitation is optional Preview behavior and is not required for ACP support; Desktop may present it only when negotiated.

ACP produces bounded `protocol.ndjson`, normalized `events.ndjson`, and conversation projections. `run-status --follow --json` and `run-session <id> --json` are the supported observation paths. Logs are redacted before persistence, but redaction is defense in depth: secrets fragmented across unrelated payloads or encoded in an unknown form may not be detected. Keep prompts free of credentials and inspect evidence before sharing it.

## Mock and live evidence

The repository's deterministic mock ACP tests prove PlanWeave profile routing, session/event handling, Desktop subscription/rendering, intervention, artifact submission, cleanup, and replay behavior without provider credentials or installed third-party agents. Mock success does **not** prove that any real agent/version/provider combination is supported.

Release interoperability is owned by the non-optional `ACP-GATE`. Run the live-smoke program once for every explicit profile:

```bash
node scripts/acp-live-smoke.mjs --profile codex-acp --evidence /tmp/codex-acp.json
node scripts/acp-live-smoke.mjs --profile claude-code-acp --evidence /tmp/claude-code-acp.json
node scripts/acp-live-smoke.mjs --profile opencode-acp --evidence /tmp/opencode-acp.json
node scripts/acp-live-smoke.mjs --profile pi-acp --evidence /tmp/pi-acp.json
```

Each command is a two-stage gate. Prepare an isolated disposable PlanWeave package with at least two runnable blocks in deterministic order. The first block must instruct the real agent to complete and submit a strict artifact. The second must be a safe, deliberately long-running turn that can be bounded by the smoke timeout without changing external state. The program first runs the artifact block with the normal execution bound, then independently runs the long block with `--cancellation-timeout` (default `3000` ms).

The second stage does not depend on a provider-specific permission API. It passes only when the bounded run fails or cancels after a distinct PlanWeave session has reached the ACP runner's `running` lifecycle, persisted a failed/cancelled terminal event, and reached terminal cleanup. Both stages bind every persisted runner event and the terminal cursor's canonical identity to the outer PlanWeave session id, preventing a stale latest-record projection from passing. The program reopens the cancellation session twice and requires the terminal cursor and event stream to remain identical. A timeout during CLI argument validation, claim selection, or ACP initialization is therefore not sufficient evidence. Increase `--cancellation-timeout` if a provider needs more time to enter `running`; keep the second prompt long enough that it cannot finish successfully within that bound.

Evidence must validate against `readme/acp-live-smoke-evidence.schema.json`. Version 2 records both session identities plus the provider-neutral bounded stage's structured terminal reason and cleanup status; a passing record requires `timed_out` or `cancelled` with successful cleanup. Version 1 permission-oriented evidence is not accepted by the new gate. A skipped, unavailable, unauthenticated, prematurely completed, or failed profile does not pass `ACP-GATE` and must not be advertised as verified support.
