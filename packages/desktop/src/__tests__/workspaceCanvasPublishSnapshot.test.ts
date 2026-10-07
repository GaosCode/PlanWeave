import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { captureAuthorizedCanvasContent } from "@planweave-ai/runtime";
import { createTestWorkspace } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import { CollaborationClient } from "../main/collaboration/CollaborationClient.js";
import { WorkspaceCanvasPublishReceiptStore } from "../main/collaboration/WorkspaceCanvasPublishReceiptStore.js";
import { publishLocalCanvasToWorkspace } from "../main/collaboration/workspaceCanvasPublish.js";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("PLANWEAVE_HOME", process.env.PLANWEAVE_HOME ?? "");
  vi.stubEnv("PLANWEAVE_DESKTOP_SETTINGS_FILE", process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE ?? "");
  const f = await createTestWorkspace();
  roots.push(f.root, f.home);
  const origin = "http://127.0.0.1:50653";
  const client = new CollaborationClient({
    profile: {
      profileId: "profile-test",
      displayName: "Test",
      serverBaseUrl: origin,
      projectId: "server-project",
      allowInsecureTransport: true,
      endpoint: {
        topology: "loopback_http",
        serverOrigin: origin,
        allowedClientOrigins: [origin],
        tlsTrust: "not_applicable"
      }
    },
    credential: { getDeviceToken: () => undefined }
  });
  const receipts = new WorkspaceCanvasPublishReceiptStore(join(f.home, "receipts.json"));
  const rawInput = { localProjectId: f.init.workspace.id, canvasId: "default" };
  return { ...f, client, receipts, rawInput };
}
it("uploads a complete real capture with layout and authority scope after source changes", async () => {
  const f = await fixture();
  const expected = (
    await captureAuthorizedCanvasContent({
      projectRoot: f.root,
      canvasId: "default",
      authorityProjectId: f.client.projectId
    })
  ).content;
  const publish = vi.spyOn(f.client, "publishWorkspaceCanvas").mockImplementation(async (input) => {
    await fs.writeFile(
      join(f.init.workspace.packageDir, "nodes/T-001/prompt.md"),
      "changed after capture"
    );
    expect(input.content).toEqual(expected);
    expect(
      JSON.parse(input.content.members.find((member) => member.kind === "desktop_layout")!.content)
        .projectId
    ).toBe("server-project");
    return {
      outcome: "published",
      operationId: input.operationId,
      recoveryToken: `wp-${input.operationId}`,
      scope: { workspaceId: "w", projectId: "server-project", canvasId: "published" },
      revision: 1,
      content: {
        versionId: `version-${input.content.canonicalDigest}`,
        canonicalDigest: input.content.canonicalDigest,
        verification: "complete"
      },
      visibility: "private"
    };
  });
  await expect(publishLocalCanvasToWorkspace(f)).resolves.toMatchObject({
    outcome: "published",
    locator: { projectId: "server-project", canvasId: "published" },
    localSourceRetained: true
  });
  expect(publish).toHaveBeenCalledOnce();
});
it("does not publish when a real referenced file changes during capture", async () => {
  const f = await fixture();
  const publish = vi.spyOn(f.client, "publishWorkspaceCanvas");
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  let changed = false;
  vi.mocked(fs.stat).mockImplementation(async (...args: Parameters<typeof fs.stat>) => {
    const result = await Reflect.apply(actual.stat, actual, args);
    if (
      !changed &&
      String(args[0]).endsWith("/nodes/T-001/prompt.md") &&
      (args[1] as { bigint?: boolean } | undefined)?.bigint === true
    ) {
      changed = true;
      await actual.writeFile(
        f.init.workspace.manifestFile,
        `${await actual.readFile(f.init.workspace.manifestFile, "utf8")}\n`
      );
    }
    return result;
  });
  await expect(publishLocalCanvasToWorkspace(f)).rejects.toThrow("package_snapshot_conflict");
  expect(publish).not.toHaveBeenCalled();
});
