import { describe, expect, it } from "vitest";
import {
  acpRunRecoveryLineageSchema,
  evaluateAcpRunRecovery,
  renderAcpRunRecoveryPrompt,
  type AcpRunRecoveryEligibilityInput
} from "../autoRun/acpRunRecovery.js";
import {
  normalizeAcpRecoveryToolSummary,
  normalizeAcpRecoveryToolSummaryValue
} from "../autoRun/acpRecoveryToolSummary.js";
import { utf8ByteLength } from "../autoRun/runnerEventRedaction.js";

const eligible: AcpRunRecoveryEligibilityInput = {
  latestMainRun: true,
  runnerKind: "acp",
  terminal: true,
  interruptionReason: "transport_lost",
  sourceIdentityValid: true,
  sessionId: "session-1",
  sourceAgentId: "codex",
  resolvedAgentId: "codex",
  sourceExecutorProfile: "codex-acp",
  resolvedExecutorProfile: "codex-acp",
  sourceLaunch: { command: "codex-acp", args: ["--stdio"] },
  resolvedLaunch: { command: "codex-acp", args: ["--stdio"] },
  loadSessionAvailable: true,
  blockStatus: "blocked",
  dependenciesCompleted: true,
  activeOrResumableRun: false,
  newerRecoveryChild: false,
  interactionsSettled: true
};

const lineage = acpRunRecoveryLineageSchema.parse({
  version: "planweave.acp-recovery/v1",
  kind: "session_load",
  sourceRecordId: "T-001#B-001::RUN-001",
  sourceRunId: "RUN-001",
  sourceSessionId: "session-1",
  sourceTerminalEventSequence: 12,
  requestedAt: "2026-07-17T00:00:00.000Z",
  requestedBy: "planweave-test"
});

function encodeJsonLayers(value: unknown, layers: number): string {
  let encoded = JSON.stringify(value);
  for (let layer = 1; layer < layers; layer += 1) encoded = JSON.stringify(encoded);
  return encoded;
}

describe("ACP interruption recovery contract", () => {
  it("accepts only a fully consistent recoverable source", () => {
    expect(evaluateAcpRunRecovery(eligible)).toEqual({ available: true, reason: null });
  });

  it.each([
    ["latestMainRun", false, "not_latest_main_run"],
    ["runnerKind", "cli", "runner_not_acp"],
    ["terminal", false, "source_not_terminal"],
    ["interruptionReason", null, "terminal_reason_not_recoverable"],
    ["sourceIdentityValid", false, "source_identity_invalid"],
    ["sessionId", null, "session_unavailable"],
    ["resolvedAgentId", "claude", "agent_mismatch"],
    ["resolvedExecutorProfile", "claude-acp", "executor_profile_mismatch"],
    ["resolvedLaunch", { command: "codex-acp", args: [] }, "launch_mismatch"],
    ["loadSessionAvailable", false, "load_session_unavailable"],
    ["blockStatus", "completed", "block_not_blocked"],
    ["dependenciesCompleted", false, "dependencies_incomplete"],
    ["activeOrResumableRun", true, "active_run_exists"],
    ["newerRecoveryChild", true, "newer_recovery_exists"],
    ["interactionsSettled", false, "interactions_pending"]
  ] as const)("rejects %s mismatch with %s", (field, value, reason) => {
    expect(evaluateAcpRunRecovery({ ...eligible, [field]: value })).toEqual({
      available: false,
      reason
    });
  });

  it("renders recovery context without treating the source attempt as successful", () => {
    const prompt = renderAcpRunRecoveryPrompt({
      renderedPrompt: "# Current Block prompt",
      lineage,
      interruptionReason: "transport_lost",
      lastToolStateSummary: "tool call was running"
    });

    expect(prompt).toContain("# Current Block prompt");
    expect(prompt).toContain("T-001#B-001::RUN-001");
    expect(prompt).toContain("do not assume its in-flight operation completed");
    expect(prompt).toContain("inspect the current workspace, `git diff`, and relevant artifacts");
    expect(prompt).toContain("pending permissions from the source attempt are invalid");
    expect(prompt).toContain("new attempt's artifact contract");
  });

  it("redacts secrets before applying the UTF-8 byte limit to recovery tool state", () => {
    const summary = normalizeAcpRecoveryToolSummary(
      `token=super-secret-value ${"工具状态".repeat(2_000)}`
    );

    expect(summary).not.toContain("super-secret-value");
    expect(summary).toContain("[REDACTED:CREDENTIAL]");
    expect(utf8ByteLength(summary)).toBeLessThanOrEqual(4096);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(summary))
    ).not.toThrow();
  });

  it.each([
    ['export OPENAI_API_KEY = "sk-openai"', "sk-openai"],
    ["GITHUB_TOKEN='ghp-token'", "ghp-token"],
    ['{"service_secret" : "json-secret"}', "json-secret"],
    ["database_PASSWORD = spaced-password", "spaced-password"]
  ])("redacts environment credential form %s", (input, secret) => {
    const summary = normalizeAcpRecoveryToolSummary(input);
    expect(summary).not.toContain(secret);
    expect(summary).toContain("[REDACTED:CREDENTIAL]");
  });

  it("truncates on code-point boundaries at the UTF-8 limit", () => {
    const boundary = normalizeAcpRecoveryToolSummary(`${"a".repeat(4093)}😀`);
    expect(boundary).toBe("a".repeat(4093));
    expect(utf8ByteLength(boundary)).toBe(4093);
    expect(() => normalizeAcpRecoveryToolSummary("\ud800")).toThrow("well-formed Unicode");

    const multilingual = normalizeAcpRecoveryToolSummary("中文🙂".repeat(1_000));
    expect(utf8ByteLength(multilingual)).toBeLessThanOrEqual(4096);
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(multilingual))).not.toThrow();
  });

  it("redacts nested and repeatedly encoded recovery tool content before prompt rendering", () => {
    const secrets = ["sk-nested", "sk-double", "array-token", "shell-password"];
    const summary = normalizeAcpRecoveryToolSummaryValue({
      title: "Inspect configuration without deleting ordinary text",
      content: JSON.stringify({ OPENAI_API_KEY: secrets[0] }),
      doubleEncoded: JSON.stringify(JSON.stringify({ SERVICE_SECRET: secrets[1] })),
      array: [JSON.stringify({ BUILD_TOKEN: secrets[2] })],
      shell: `export DATABASE_PASSWORD='${secrets[3]}'`
    });
    const prompt = renderAcpRunRecoveryPrompt({
      renderedPrompt: "# Current Block prompt",
      lineage,
      interruptionReason: "transport_lost",
      lastToolStateSummary: summary
    });

    for (const secret of secrets) expect(prompt).not.toContain(secret);
    expect(prompt).toContain("Inspect configuration without deleting ordinary text");
    expect(prompt).toContain("[REDACTED:CREDENTIAL]");
  });

  it("redacts a repeatedly encoded raw JSON summary and preserves ordinary text", () => {
    const encoded = JSON.stringify(
      JSON.stringify([{ OPENAI_API_KEY: "sk-raw" }, { SERVICE_TOKEN: "token-raw" }])
    );
    const summary = normalizeAcpRecoveryToolSummary(encoded);

    expect(summary).not.toContain("sk-raw");
    expect(summary).not.toContain("token-raw");
    expect(summary).toContain("[REDACTED:CREDENTIAL]");
    expect(normalizeAcpRecoveryToolSummary("Inspect package metadata and report status.")).toBe(
      "Inspect package metadata and report status."
    );
  });

  it("fails closed for over-depth and oversized JSON-looking strings", () => {
    const depthSecret = "five-layer-secret";
    const oversizedSecret = "oversized-secret";
    const overDepth = normalizeAcpRecoveryToolSummary(
      ` \n\t${encodeJsonLayers({ OPENAI_API_KEY: depthSecret }, 5)}`
    );
    const oversized = normalizeAcpRecoveryToolSummary(
      encodeJsonLayers(
        { SERVICE_TOKEN: oversizedSecret, padding: "x".repeat(65_536) },
        2
      )
    );

    expect(overDepth).toContain("[REDACTED:SENSITIVE_CONTENT]");
    expect(overDepth).not.toContain(depthSecret);
    expect(oversized).toContain("[REDACTED:SENSITIVE_CONTENT]");
    expect(oversized).not.toContain(oversizedSecret);
    for (const summary of [overDepth, oversized]) {
      const prompt = renderAcpRunRecoveryPrompt({
        renderedPrompt: "# Current Block prompt",
        lineage,
        interruptionReason: "transport_lost",
        lastToolStateSummary: summary
      });
      expect(prompt).not.toContain(depthSecret);
      expect(prompt).not.toContain(oversizedSecret);
    }
  });

  it("preserves supported four-layer JSON and ordinary long text", () => {
    const supportedSecret = "four-layer-secret";
    const supported = normalizeAcpRecoveryToolSummary(
      encodeJsonLayers({ BUILD_PASSWORD: supportedSecret, note: "keep-note" }, 4)
    );
    const ordinaryLongText = "ordinary recovery status ".repeat(4_000);
    const ordinary = normalizeAcpRecoveryToolSummary(ordinaryLongText);

    expect(supported).toContain("keep-note");
    expect(supported).toContain("[REDACTED:CREDENTIAL]");
    expect(supported).not.toContain(supportedSecret);
    expect(ordinary).toBe(ordinaryLongText.slice(0, 4096));
    expect(ordinary).not.toContain("[REDACTED:SENSITIVE_CONTENT]");
  });
});
