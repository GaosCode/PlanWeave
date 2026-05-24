import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../../..");

describe("agent skill contract docs", () => {
  it("documents JSON Claim Result branches and block-ref recovery commands in plan-runner", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain('kind: "block"');
    expect(skill).toContain('kind: "feedback"');
    expect(skill).toContain('kind: "batch"');
    expect(skill).toContain('kind: "blocked"');
    expect(skill).toContain("planweave submit-feedback --report");
    expect(skill).toContain("planweave unblock <block-ref>");
    expect(skill).toContain("planweave resolve-divergence <block-ref> --reason");
    expect(skill).toContain("Do not create feedback blocks");
  });

  it("documents that plan-runner may maintain editable source prompts", async () => {
    const skill = await readFile(join(repoRoot, "skills/plan-runner/SKILL.md"), "utf8");

    expect(skill).toContain("PlanWeave Global Prompt, Project Prompt, Task Node Prompt, and Block Prompt are editable source prompts");
    expect(skill).toContain("Agents may update those source prompts");
    expect(skill).toContain("Do not write rendered prompt output back into source prompt files.");
  });
});
