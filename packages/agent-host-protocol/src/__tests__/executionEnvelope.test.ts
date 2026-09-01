import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson } from "../canonicalJson.js";
import {
  LEGACY_WORKSPACE_CANVAS_EXECUTION_CAPABILITY,
  WORKSPACE_CANVAS_EXECUTION_CAPABILITY
} from "../capabilities.js";
import {
  executionEnvelopeDigestPrefix,
  executionEnvelopeSchema,
  isExecutionEnvelopeDigest,
  parseExecutionEnvelope
} from "../executionEnvelope.js";
import { hashExecutionEnvelope, parseAndHashExecutionEnvelope } from "../executionEnvelopeHash.js";
import {
  exampleExecutionEnvelopeDigest,
  exampleExecutionEnvelopeInput,
  exampleExecutionEnvelopeV1Digest,
  exampleExecutionEnvelopeV1Input
} from "../fixtures/executionEnvelope.js";
import {
  ACCEPTANCE_MAX_COUNT,
  DEPENDENCY_SUMMARY_MAX_COUNT,
  EXECUTION_ENVELOPE_MAX_BYTES,
  INPUT_ARTIFACT_MAX_COUNT,
  RENDERED_PROMPT_MAX_LENGTH
} from "../limits.js";

function expectRejects(parse: () => unknown): void {
  expect(parse).toThrow();
}

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...structuredClone(exampleExecutionEnvelopeInput),
    ...overrides
  };
}

describe("ExecutionEnvelope schema", () => {
  it("uses the shared canonical artifact media type contract", () => {
    const envelope = parseExecutionEnvelope(
      validEnvelope({
        inputArtifacts: [
          {
            artifactRef: `artifact:sha256:${"a".repeat(64)}`,
            logicalName: "input",
            mediaType: 'Text/Plain ; Charset="utf-8"'
          }
        ]
      })
    );

    expect(envelope.inputArtifacts[0]?.mediaType).toBe('text/plain; charset="utf-8"');
  });

  it("accepts a full portable envelope and round-trips producer to consumer", () => {
    const produced = parseExecutionEnvelope(exampleExecutionEnvelopeInput);
    const wire = JSON.parse(JSON.stringify(produced)) as unknown;
    const consumed = parseExecutionEnvelope(wire);

    expect(consumed).toEqual(produced);
    expect(consumed.protocolVersion).toBe(2);
    if (consumed.protocolVersion !== 2) throw new Error("execution_envelope_v2_expected");
    expect(consumed.runtimeAuthority).toBe("workspace_canvas");
    expect(consumed.workspaceId).toBe("workspace.planweave-core");
    expect(consumed.agentId).toBe("codex");
    expect(consumed.agentProfileId).toBe("acp.codex");
    expect(consumed.requiredCapabilities).toEqual(["linux", "acp.codex", "workspace.git"]);
  });

  it("rejects duplicate requiredCapabilities instead of coercing intent", () => {
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({ requiredCapabilities: ["node", "linux", "node", "acp.codex"] })
      )
    );
  });

  it("requires Runtime materialization evidence only for managed Canvas execution", () => {
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({ requiredCapabilities: [WORKSPACE_CANVAS_EXECUTION_CAPABILITY] })
      )
    );
    expect(
      parseExecutionEnvelope(
        validEnvelope({
          requiredCapabilities: [WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
          runtimeMaterialization: {
            sourceRevision: `snapshot:${"a".repeat(64)}`,
            graphFingerprint: `pkg-${"b".repeat(64)}`
          }
        })
      ).runtimeMaterialization
    ).toEqual({
      sourceRevision: `snapshot:${"a".repeat(64)}`,
      graphFingerprint: `pkg-${"b".repeat(64)}`
    });
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          runtimeMaterialization: {
            sourceRevision: `snapshot:${"a".repeat(64)}`,
            graphFingerprint: `pkg-${"b".repeat(64)}`
          }
        })
      )
    );
  });

  it("requires an explicit Server-authorized Runtime scope in v2", () => {
    const { runtimeAuthority: _runtimeAuthority, ...missingAuthority } = validEnvelope();
    expectRejects(() => parseExecutionEnvelope(missingAuthority));
    expectRejects(() =>
      parseExecutionEnvelope(validEnvelope({ runtimeAuthority: "project_canvas" }))
    );
    expect(
      parseExecutionEnvelope(validEnvelope({ runtimeAuthority: "owner_canvas" }))
    ).toMatchObject({ runtimeAuthority: "owner_canvas" });
  });

  it("keeps legacy Canvas capability semantics parseable in v2", () => {
    expect(
      parseExecutionEnvelope(
        validEnvelope({
          requiredCapabilities: [LEGACY_WORKSPACE_CANVAS_EXECUTION_CAPABILITY]
        })
      ).runtimeMaterialization
    ).toBeUndefined();
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          requiredCapabilities: [LEGACY_WORKSPACE_CANVAS_EXECUTION_CAPABILITY],
          runtimeMaterialization: {
            sourceRevision: `snapshot:${"a".repeat(64)}`,
            graphFingerprint: `pkg-${"b".repeat(64)}`
          }
        })
      )
    );
  });

  it("rejects unknown fields on the envelope and nested objects", () => {
    expectRejects(() =>
      parseExecutionEnvelope(validEnvelope({ hostPath: "/Users/coordinator/repo" }))
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          execution: {
            dispatchId: "dispatch-1",
            attemptId: "attempt-1",
            worktreePath: "/tmp/worktree"
          }
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          session: {
            modeId: "default",
            cwd: "/var/workspace"
          }
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          output: {
            reportRequired: true,
            maxArtifactBytes: 1024,
            maxArtifactCount: 1,
            mergeStrategy: "squash"
          }
        })
      )
    );
  });

  it("rejects every forbidden field category by contract shape", () => {
    const forbiddenTopLevel: Array<Record<string, unknown>> = [
      { command: "codex" },
      { args: ["exec", "-"] },
      { env: { API_KEY: "secret" } },
      { environment: { PATH: "/usr/bin" } },
      { credentials: { token: "abc" } },
      { accessToken: "tok_live" },
      { providerApiKey: "sk-test" },
      { gitBranch: "feat/x" },
      { mergeStrategy: "rebase" },
      { worktreePath: "/tmp/wt" },
      { workspacePath: "/Users/me/code" },
      { absolutePath: "/opt/planweave" },
      { executable: "/usr/bin/node" }
    ];
    for (const extra of forbiddenTopLevel) {
      expectRejects(() => parseExecutionEnvelope(validEnvelope(extra)));
    }
  });

  it("does not guess secrets or paths from ordinary rendered prompt content", () => {
    const prompt =
      "Review fields named accessToken, command, env, and /tmp/example in source code.";
    expect(parseExecutionEnvelope(validEnvelope({ renderedPrompt: prompt })).renderedPrompt).toBe(
      prompt
    );
  });

  it("rejects absolute Coordinator paths and path-like identifiers in portable id fields", () => {
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ workspaceId: "/tmp/workspace" })));
    expectRejects(() =>
      parseExecutionEnvelope(validEnvelope({ agentProfileId: "../escape-profile" }))
    );
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ projectId: "/var/projects/x" })));
    expectRejects(() =>
      parseExecutionEnvelope(validEnvelope({ sourceRevision: "/var/projects/revision" }))
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          inputArtifacts: [
            {
              artifactRef: "/var/artifacts/report.md",
              logicalName: "report"
            }
          ]
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          inputArtifacts: [
            {
              artifactRef: `artifact:sha256:${"a".repeat(64)}`,
              logicalName: "input",
              mediaType: "../../secret"
            }
          ]
        })
      )
    );
  });

  it("rejects incompatible protocol versions instead of coercing them", () => {
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ protocolVersion: 3 })));
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ protocolVersion: "1" })));
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ protocolVersion: 0 })));
  });

  it("parses the fixed historical v1 shape and rejects v2 fields as unknown", () => {
    const parsed = parseExecutionEnvelope(exampleExecutionEnvelopeV1Input);
    expect(parsed.protocolVersion).toBe(1);
    expect(parsed).not.toHaveProperty("runtimeAuthority");
    expect(() =>
      parseExecutionEnvelope({
        ...exampleExecutionEnvelopeV1Input,
        runtimeAuthority: "workspace_canvas"
      })
    ).toThrow();
  });

  it("accepts implementation and review block types whose task segment matches taskId", () => {
    expect(() =>
      parseExecutionEnvelope(validEnvelope({ blockType: "implementation" }))
    ).not.toThrow();
    expect(() => parseExecutionEnvelope(validEnvelope({ blockType: "review" }))).not.toThrow();
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ blockRef: "OTHER#B-002" })));
  });

  it("rejects filesystem and traversal forms in either blockRef segment", () => {
    for (const blockRef of [
      "FND-001#/tmp/coordinator-secret",
      "FND-001#../B-002",
      "FND-001#..\\B-002",
      "FND-001#.",
      "../FND-001#B-002"
    ]) {
      expectRejects(() => parseExecutionEnvelope(validEnvelope({ blockRef })));
    }
  });

  it("enforces size and count bounds", () => {
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          renderedPrompt: "界".repeat(Math.ceil(RENDERED_PROMPT_MAX_LENGTH / 3) + 1)
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          acceptance: Array.from({ length: ACCEPTANCE_MAX_COUNT + 1 }, (_, i) => `a${i}`)
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          dependencySummaries: Array.from({ length: DEPENDENCY_SUMMARY_MAX_COUNT + 1 }, (_, i) => ({
            blockRef: `T#B${i}`,
            outcome: "completed",
            summary: "ok"
          }))
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          inputArtifacts: Array.from({ length: INPUT_ARTIFACT_MAX_COUNT + 1 }, (_, i) => ({
            artifactRef: `artifact:sha256:${"a".repeat(64)}`,
            logicalName: `input-${i}`
          }))
        })
      )
    );
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          output: {
            reportRequired: true,
            maxArtifactBytes: 0,
            maxArtifactCount: 1
          }
        })
      )
    );
  });

  it("bounds the complete canonical envelope in UTF-8 bytes", () => {
    const oversizedAcceptance = Array.from({ length: ACCEPTANCE_MAX_COUNT }, () =>
      "x".repeat(4_000)
    );
    const oversizedDependencies = Array.from({ length: 80 }, (_, index) => ({
      blockRef: `T#B${index}`,
      outcome: "completed",
      summary: "y".repeat(4_000)
    }));
    expect(EXECUTION_ENVELOPE_MAX_BYTES).toBeLessThan(1024 * 1024);
    expectRejects(() =>
      parseExecutionEnvelope(
        validEnvelope({
          acceptance: oversizedAcceptance,
          dependencySummaries: oversizedDependencies
        })
      )
    );
  });

  it("rejects invalid block refs and capability tokens", () => {
    expectRejects(() => parseExecutionEnvelope(validEnvelope({ blockRef: "missing-hash" })));
    expectRejects(() =>
      parseExecutionEnvelope(validEnvelope({ requiredCapabilities: ["ACP", "/usr/bin/node"] }))
    );
  });
});

describe("ExecutionEnvelope content addressing", () => {
  it("hashes canonical JSON with SHA-256 and stable prefix", () => {
    const envelope = parseExecutionEnvelope(exampleExecutionEnvelopeInput);
    const digest = hashExecutionEnvelope(envelope);
    const expectedHex = createHash("sha256")
      .update(canonicalizeJson(envelope), "utf8")
      .digest("hex");

    expect(digest).toBe(`${executionEnvelopeDigestPrefix}${expectedHex}`);
    expect(isExecutionEnvelopeDigest(digest)).toBe(true);
    expect(isExecutionEnvelopeDigest(`artifact:sha256:${"a".repeat(64)}`)).toBe(false);
  });

  it("produces identical digests for semantically identical key order variants", () => {
    const a = parseAndHashExecutionEnvelope(exampleExecutionEnvelopeInput);
    const reordered = {
      trace: exampleExecutionEnvelopeInput.trace,
      output: exampleExecutionEnvelopeInput.output,
      requiredCapabilities: exampleExecutionEnvelopeInput.requiredCapabilities,
      session: exampleExecutionEnvelopeInput.session,
      agentProfileId: exampleExecutionEnvelopeInput.agentProfileId,
      agentId: exampleExecutionEnvelopeInput.agentId,
      runtimeAuthority: exampleExecutionEnvelopeInput.runtimeAuthority,
      workspaceId: exampleExecutionEnvelopeInput.workspaceId,
      inputArtifacts: exampleExecutionEnvelopeInput.inputArtifacts,
      dependencySummaries: exampleExecutionEnvelopeInput.dependencySummaries,
      acceptance: exampleExecutionEnvelopeInput.acceptance,
      renderedPrompt: exampleExecutionEnvelopeInput.renderedPrompt,
      graphFingerprint: exampleExecutionEnvelopeInput.graphFingerprint,
      sourceRevision: exampleExecutionEnvelopeInput.sourceRevision,
      blockType: exampleExecutionEnvelopeInput.blockType,
      blockRef: exampleExecutionEnvelopeInput.blockRef,
      taskId: exampleExecutionEnvelopeInput.taskId,
      canvasId: exampleExecutionEnvelopeInput.canvasId,
      projectId: exampleExecutionEnvelopeInput.projectId,
      execution: {
        attemptId: exampleExecutionEnvelopeInput.execution.attemptId,
        dispatchId: exampleExecutionEnvelopeInput.execution.dispatchId
      },
      protocolVersion: exampleExecutionEnvelopeInput.protocolVersion
    };
    const b = parseAndHashExecutionEnvelope(reordered);
    expect(b.digest).toBe(a.digest);
    expect(b.envelope).toEqual(a.envelope);
  });

  it("locks the example fixture digest for cross-package contract consumers", () => {
    const { digest } = parseAndHashExecutionEnvelope(exampleExecutionEnvelopeInput);
    expect(digest).toBe(exampleExecutionEnvelopeDigest);
  });

  it("replays the fixed historical v1 canonical bytes and digest", () => {
    const { digest, envelope } = parseAndHashExecutionEnvelope(exampleExecutionEnvelopeV1Input);
    expect(envelope.protocolVersion).toBe(1);
    expect(digest).toBe(exampleExecutionEnvelopeV1Digest);
    expect(hashExecutionEnvelope(JSON.parse(canonicalizeJson(envelope)))).toBe(
      exampleExecutionEnvelopeV1Digest
    );
  });

  it("changes digest when any material field changes", () => {
    const base = parseAndHashExecutionEnvelope(exampleExecutionEnvelopeInput);
    const changed = parseAndHashExecutionEnvelope(
      validEnvelope({ renderedPrompt: `${exampleExecutionEnvelopeInput.renderedPrompt}\n# more` })
    );
    expect(changed.digest).not.toBe(base.digest);
  });

  it("exports a strict schema for direct safeParse use by Server and Agent Host", () => {
    const ok = executionEnvelopeSchema.safeParse(exampleExecutionEnvelopeInput);
    expect(ok.success).toBe(true);
    const bad = executionEnvelopeSchema.safeParse({ protocolVersion: 1 });
    expect(bad.success).toBe(false);
  });
});
