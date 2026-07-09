import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createManagedProjectId, createProjectId, resolveProjectWorkspace } from "../index.js";

describe("project id", () => {
  it("maps a real project path to a stable slug plus short hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "Plan Weave Test-"));

    const first = await createProjectId(root);
    const second = await createProjectId(await realpath(root));

    expect(first).toBe(second);
    expect(first).toMatch(/^plan-weave-test-[a-z0-9]+-[a-f0-9]{8}$/);
  });

  it("normalizes managed project names without edge separators", () => {
    expect(createManagedProjectId(" --Plan Weave Test-- ")).toMatch(
      /^plan-weave-test-[a-f0-9]{8}$/
    );
    expect(createManagedProjectId("!!!")).toMatch(/^project-[a-f0-9]{8}$/);
  });

  it("uses PLANWEAVE_HOME when resolving the workspace", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;

    const workspace = await resolveProjectWorkspace(root);

    expect(workspace.workspaceRoot.startsWith(join(home, "projects"))).toBe(true);
    delete process.env.PLANWEAVE_HOME;
  });
});
