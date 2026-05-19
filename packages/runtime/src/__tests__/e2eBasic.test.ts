import { cp, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claimNextTask } from "../tasks/claimNext.js";
import { getPrompt } from "../prompt/getPrompt.js";
import { getStatus } from "../status/getStatus.js";
import { initWorkspace } from "../initWorkspace.js";
import { refreshPrompts } from "../prompt/refreshPrompts.js";
import { submitRunResult } from "../results/submitResult.js";
import { submitReview } from "../results/submitReview.js";
import { validatePackage } from "../validatePackage.js";

describe("basic MVP-0 loop", () => {
  it("runs init through verified using the example Plan Package", async () => {
    const home = await mkdtemp(join(tmpdir(), "planweave-home-"));
    const root = await mkdtemp(join(tmpdir(), "planweave-project-"));
    process.env.PLANWEAVE_HOME = home;
    const init = await initWorkspace({ projectRoot: root });
    await cp(join(process.cwd(), "examples/basic-plan-package/package"), init.workspace.packageDir, {
      recursive: true,
      force: true
    });

    expect((await validatePackage({ projectRoot: root })).ok).toBe(true);
    expect((await refreshPrompts({ projectRoot: root })).prompts).toHaveLength(1);
    expect(await claimNextTask({ projectRoot: root })).toMatchObject({ taskId: "T-001", status: "claimed" });
    expect(await getPrompt({ projectRoot: root, taskId: "T-001" })).toContain("Create a small implementation report");

    const firstImplementation = join(init.workspace.workspaceRoot, "implementation-1.md");
    const firstReview = join(init.workspace.workspaceRoot, "review-1.md");
    await writeFile(firstImplementation, "First implementation.\n", "utf8");
    await writeFile(firstReview, "Needs a test adjustment.\n", "utf8");
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: firstImplementation });
    await submitReview({ projectRoot: root, taskId: "T-001", reportPath: firstReview, status: "needs_changes" });

    const retryPrompt = await getPrompt({ projectRoot: root, taskId: "T-001" });
    expect(retryPrompt).toContain("Needs a test adjustment.");
    expect(await claimNextTask({ projectRoot: root })).toMatchObject({ taskId: "T-001", status: "claimed" });
    expect(await getPrompt({ projectRoot: root, taskId: "T-001" })).toContain("Needs a test adjustment.");

    const secondImplementation = join(init.workspace.workspaceRoot, "implementation-2.md");
    const secondReview = join(init.workspace.workspaceRoot, "review-2.md");
    await writeFile(secondImplementation, "Second implementation.\n", "utf8");
    await writeFile(secondReview, "Passed.\n", "utf8");
    await submitRunResult({ projectRoot: root, taskId: "T-001", reportPath: secondImplementation });
    await submitReview({ projectRoot: root, taskId: "T-001", reportPath: secondReview, status: "passed" });

    const status = await getStatus({ projectRoot: root });
    expect(status.counts.verified).toBe(1);
    delete process.env.PLANWEAVE_HOME;
  });
});
