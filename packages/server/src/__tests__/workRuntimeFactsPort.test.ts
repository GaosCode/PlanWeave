import { describe, expect, it, vi } from "vitest";
import { withWorkRuntimeFacts, WorkRuntimeUnavailableError } from "../work/runtimePort.js";
import type { WorkItemRef } from "../work/schemas.js";
import { runtimeFactsFromPackagePort } from "./workRuntimeFactsFixture.js";

const items: WorkItemRef[] = [
  { kind: "task", canvasId: "canvas-a", taskId: "T-001" },
  { kind: "block", canvasId: "canvas-a", blockRef: "T-001#B-001" }
];

describe("WorkRuntimePackageFactsPort", () => {
  it("acquires one batch per exact canvas and releases exactly once on success", async () => {
    const release = vi.fn();
    const base = runtimeFactsFromPackagePort(
      {
        resolveWorkItem(item) {
          return {
            ...item,
            exists: true,
            requiredCapabilities: item.kind === "block" ? ["acp.codex"] : []
          };
        },
        resolveWorkItems(requested) {
          return requested.map((item) => this.resolveWorkItem(item));
        }
      },
      release
    );
    const acquireFacts = vi.spyOn(base, "acquireFacts");
    const result = await withWorkRuntimeFacts(
      base,
      { workspaceId: "workspace-a", projectId: "project-a" },
      items,
      (snapshot) => snapshot.resolveWorkItems(items)
    );
    expect(result).toHaveLength(2);
    expect(acquireFacts).toHaveBeenCalledTimes(1);
    expect(acquireFacts.mock.calls[0]?.[0].scope.canvasId).toBe("canvas-a");
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases once when the consumer fails and fails closed without a binding", async () => {
    const release = vi.fn();
    const port = runtimeFactsFromPackagePort(
      {
        resolveWorkItem(item) {
          return { ...item, exists: true, requiredCapabilities: [] };
        },
        resolveWorkItems(requested) {
          return requested.map((item) => this.resolveWorkItem(item));
        }
      },
      release
    );
    await expect(
      withWorkRuntimeFacts(
        port,
        { workspaceId: "workspace-a", projectId: "project-a" },
        items,
        () => {
          throw new Error("consumer_failed");
        }
      )
    ).rejects.toThrow("consumer_failed");
    expect(release).toHaveBeenCalledOnce();

    await expect(
      withWorkRuntimeFacts(
        { acquireFacts: async () => undefined },
        { workspaceId: "workspace-a", projectId: "project-a" },
        items,
        () => undefined
      )
    ).rejects.toEqual(new WorkRuntimeUnavailableError("runtime_not_attached"));
  });
});
