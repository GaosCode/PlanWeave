import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatSlowTestSummary,
  parseJUnitSuites
} from "../../../../scripts/report-slowest-tests.mjs";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("CI slow test summary", () => {
  it("sorts and aggregates JUnit file durations", () => {
    const suites = parseJUnitSuites(`
      <testsuites>
        <testsuite name="packages/a.test.ts" time="1.25"></testsuite>
        <testsuite name="packages/b.test.ts" time="3.5"></testsuite>
        <testsuite name="packages/a.test.ts" time="0.75"></testsuite>
      </testsuites>
    `);

    expect(formatSlowTestSummary("Integration (CLI)", suites)).toContain(
      "| 1 | `packages/b.test.ts` | 3.50 s |\n| 2 | `packages/a.test.ts` | 2.00 s |"
    );
  });

  it("rejects malformed or empty JUnit suites", () => {
    expect(() => parseJUnitSuites("<testsuites></testsuites>")).toThrow(
      "JUnit report contains no testsuite entries."
    );
    expect(() => parseJUnitSuites('<testsuite name="missing-time"></testsuite>')).toThrow(
      "JUnit testsuite entries must contain a name and non-negative time."
    );
  });

  it("appends the ten slowest files to the GitHub step summary", async () => {
    const githubStepSummaryEnv = "GITHUB_STEP_SUMMARY";
    const root = await mkdtemp(join(tmpdir(), "planweave-slowest-tests-"));
    temporaryRoots.push(root);
    const reportPath = join(root, "integration.xml");
    const summaryPath = join(root, "summary.md");
    const suites = Array.from(
      { length: 12 },
      (_, index) => `<testsuite name="file-${String(index)}.test.ts" time="${String(index)}" />`
    ).join("\n");
    await writeFile(reportPath, `<testsuites>${suites}</testsuites>`, "utf8");

    await execFileAsync(
      process.execPath,
      [resolve("scripts/report-slowest-tests.mjs"), reportPath, "Integration core"],
      {
        cwd: process.cwd(),
        env: { [githubStepSummaryEnv]: summaryPath }
      }
    );

    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("## Slowest test files: Integration core");
    expect(summary).toContain("`file-11.test.ts`");
    expect(summary).toContain("`file-2.test.ts`");
    expect(summary).not.toContain("`file-1.test.ts`");
  });
});
