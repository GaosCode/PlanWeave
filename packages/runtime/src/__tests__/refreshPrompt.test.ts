import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { refreshPrompt } from "../prompt/refreshPrompt.js";
import { createPackageWorkspace } from "./promptTestHelpers.js";

describe("refreshPrompt", () => {
  it("refreshes managed sections while preserving task-body", async () => {
    const { root, init } = await createPackageWorkspace();

    const result = await refreshPrompt({ projectRoot: root, taskId: "T-001" });
    const written = await readFile(result.path, "utf8");

    expect(result.markdown).toContain("<!-- planweave:managed:start header -->");
    expect(result.markdown).toContain("<!-- planweave:managed:start graph-context -->");
    expect(result.markdown).toContain("planweave submit-result T-001");
    expect(result.markdown).not.toContain("planweave submit-review");
    expect(result.markdown).toContain("Keep this body.");
    expect(written).toBe(result.markdown);
    expect(result.path).toContain(init.workspace.packageDir);
    delete process.env.PLANWEAVE_HOME;
  });

  it("does not invent a missing task-body user section", async () => {
    const { root } = await createPackageWorkspace(undefined, "No user section\n");

    await expect(refreshPrompt({ projectRoot: root, taskId: "T-001" })).rejects.toThrow("task-body");
    delete process.env.PLANWEAVE_HOME;
  });

  it("diagnoses malformed managed section boundaries before refresh", async () => {
    const { root, init } = await createPackageWorkspace();
    await writeFile(
      `${init.workspace.packageDir}/nodes/T-001.prompt.md`,
      [
        "<!-- planweave:managed:start header -->",
        "Broken header.",
        "<!-- planweave:user:start task-body -->",
        "Keep this body.",
        "<!-- planweave:user:end task-body -->"
      ].join("\n"),
      "utf8"
    );

    await expect(refreshPrompt({ projectRoot: root, taskId: "T-001" })).rejects.toThrow("prompt_section_boundary_invalid");
    delete process.env.PLANWEAVE_HOME;
  });

  it("rejects package-internal symlinks that point outside the package before writing", async () => {
    const { root, init } = await createPackageWorkspace();
    const outside = await mkdtemp(join(tmpdir(), "planweave-outside-"));
    const outsidePrompt = join(outside, "T-001.prompt.md");
    await writeFile(
      outsidePrompt,
      "<!-- planweave:user:start task-body -->\nExternal body.\n<!-- planweave:user:end task-body -->\n",
      "utf8"
    );
    await rm(join(init.workspace.packageDir, "nodes", "T-001.prompt.md"));
    await symlink(outsidePrompt, join(init.workspace.packageDir, "nodes", "T-001.prompt.md"));

    await expect(refreshPrompt({ projectRoot: root, taskId: "T-001" })).rejects.toThrow("must stay inside");
    await expect(readFile(outsidePrompt, "utf8")).resolves.toContain("External body.");
    delete process.env.PLANWEAVE_HOME;
  });
});
