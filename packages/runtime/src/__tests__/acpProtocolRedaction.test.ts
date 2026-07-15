import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { runnerIdentitySchema, runnerRunIdentitySchema } from "../autoRun/runnerContractSchemas.js";

describe("ACP protocol persistence redaction", () => {
  it("fails closed for malformed terminal authentication methods", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-auth-redaction-"));
    const store = new AcpEventStore({
      runDir,
      identity: runnerRunIdentitySchema.parse({
        projectId: "project-1",
        canvasId: "default",
        taskId: "T-003",
        blockId: "B-001",
        claimRef: "T-003#B-001",
        runId: "RUN-001",
        runOwner: "executor",
        runSessionId: null,
        desktopRunId: null,
        executorRunId: "RUN-001"
      }),
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    expect(await store.open()).toEqual([]);
    await store.appendProtocol("agent_to_client", {
      jsonrpc: "2.0",
      id: 1,
      result: {
        authMethods: [
          {
            id: "valid-terminal",
            name: "Valid terminal",
            type: "terminal",
            env: { CUSTOM_AUTH_ALPHA: "opaque-alpha" }
          },
          {
            id: "missing-name",
            type: "terminal",
            env: { CUSTOM_AUTH_BETA: "opaque-beta" }
          },
          {
            id: "null-name",
            name: null,
            type: "terminal",
            env: { CUSTOM_AUTH_GAMMA: "opaque-gamma" }
          },
          {
            name: "Missing id",
            type: "terminal",
            env: { CUSTOM_AUTH_DELTA: "opaque-delta" },
            _meta: { private: "opaque-metadata" }
          }
        ],
        ordinary: { env: { CUSTOM_RUNTIME_VALUE: "ordinary-opaque" } }
      }
    });

    const protocol = await readFile(join(runDir, "protocol.ndjson"), "utf8");
    for (const forbidden of [
      "CUSTOM_AUTH_ALPHA",
      "opaque-alpha",
      "CUSTOM_AUTH_BETA",
      "opaque-beta",
      "CUSTOM_AUTH_GAMMA",
      "opaque-gamma",
      "CUSTOM_AUTH_DELTA",
      "opaque-delta",
      "_meta",
      "opaque-metadata"
    ]) {
      expect(protocol).not.toContain(forbidden);
    }
    expect(protocol).toContain("CUSTOM_RUNTIME_VALUE");
    expect(protocol).toContain("ordinary-opaque");
  });
});
