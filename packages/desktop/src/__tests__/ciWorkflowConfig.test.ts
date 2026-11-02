import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const desktopRoot = resolve(repoRoot, "packages/desktop");
const junitWorkflowVerificationTimeoutMs = 60_000;

function occurrenceCount(source: string, value: string): number {
  return source.split(value).length - 1;
}

function workflowJob(workflow: string, id: string): string {
  const job = workflow.split(`\n  ${id}:\n`)[1]?.split(/\n {2}[a-z][\w-]*:\n/)[0];
  if (!job) throw new Error(`missing_ci_job:${id}`);
  return job;
}

describe("CI workflow configuration", () => {
  it("preserves failed test reports after an earlier step fails", async () => {
    const workflow = await readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const testSteps = ["unit", "integration", "performance", "platform"] as const;

    for (const step of testSteps) {
      expect(workflow).toContain(`if: always() && steps.${step}-tests.outcome == 'failure'`);
      expect(workflow).toContain(
        `if: always() && steps.${step}-tests.outcome == 'failure' && steps.redact-${step}.outcome == 'success'`
      );
    }
  });
  it("keeps parallel test, performance, platform, and packaged gates explicit", async () => {
    const [
      workflow,
      desktopSmokeWorkflow,
      packageSource,
      packagedVerifier,
      packagedStartupSmoke,
      desktopMain,
      redactor
    ] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repoRoot, ".github/workflows/desktop-smoke.yml"), "utf8"),
      readFile(resolve(desktopRoot, "package.json"), "utf8"),
      readFile(resolve(desktopRoot, "scripts/verify-packaged-app.mjs"), "utf8"),
      readFile(resolve(desktopRoot, "src/main/smoke.ts"), "utf8"),
      readFile(resolve(desktopRoot, "src/main/main.ts"), "utf8"),
      readFile(resolve(repoRoot, "scripts/redact-ci-test-artifacts.mjs"), "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as { scripts: Record<string, string> };

    expect(workflow).toContain("group: ci-${{ github.workflow }}-${{ github.ref }}");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(occurrenceCount(workflow, '      - "README.md"')).toBe(2);
    expect(occurrenceCount(workflow, '      - "readme/**"')).toBe(2);
    expect(occurrenceCount(workflow, '      - "DEVELOPMENT.md"')).toBe(2);
    expect(occurrenceCount(workflow, '      - "CONTRIBUTING.md"')).toBe(2);
    expect(workflow).toContain("dorny/paths-filter@v3");
    expect(workflow).toContain("needs.changes.outputs.desktop");
    expect(workflow).toContain("needs.changes.outputs.wsl");
    expect(workflow).toContain("needs.changes.outputs.server_host");
    expect(workflow).not.toContain('"**/*.md"');
    expect(workflow).toContain("name: Ubuntu build, lint, and unit tests");
    expect(workflow).toContain("pnpm test:unit --maxWorkers=2");
    expect(workflow).not.toContain("pnpm test:unit -- --maxWorkers=2");
    expect(workflow).toContain("name: Integration tests (${{ matrix.label }})");
    expect(workflow).toContain(
      "pnpm test:integration:${{ matrix.shard }} --maxWorkers=${{ matrix.max_workers }}"
    );
    expect(workflow).not.toContain("pnpm test:integration --maxWorkers=2");
    // Distributed realProcess multi-process suites must stay on the required CI shard
    // and run serially (max_workers: 1) so loopback ports and process trees stay stable.
    expect(workflow).toContain("shard: distributed");
    expect(workflow).toContain("label: Server and Agent Host");
    expect(workflow).toMatch(/shard:\s*distributed[\s\S]*?max_workers:\s*1/);
    expect(workflow).toMatch(/shard:\s*cli[\s\S]*?max_workers:\s*2/);
    expect(workflow).toMatch(/shard:\s*core[\s\S]*?max_workers:\s*2/);
    expect(workflow).toContain("name: Block Run Index performance regression");
    expect(workflow).toContain("pnpm test:performance --maxWorkers=1");
    expect(workflow).not.toContain("pnpm test:performance --maxWorkers=2");
    expect(workflow).toContain("name: Platform tests (${{ matrix.os }})");
    expect(workflow).toContain("- ubuntu-latest");
    expect(workflow).toContain("- macos-latest");
    expect(workflow).toContain("- windows-latest");
    expect(workflow).toContain("pnpm test:platform --maxWorkers=2");
    expect(workflow).not.toContain("pnpm test:platform -- --maxWorkers=2");
    expect(workflow).toContain("name: Windows WSL execution-host integration");
    expect(workflow).toContain("runs-on: windows-2025");
    expect(workflow).toContain('PLANWEAVE_REQUIRE_WSL_TESTS: "1"');
    expect(workflow).toContain('PLANWEAVE_PROCESS_TREE_LOG: "1"');
    expect(workflow).toMatch(
      /windows-wsl-integration:[\s\S]*?name: Build protocol packages[\s\S]*?pnpm --filter @planweave-ai\/agent-host-protocol build && pnpm --filter @planweave-ai\/collaboration-protocol build[\s\S]*?name: Run WSL execution-host integration test/
    );
    expect(workflow).toContain("function Invoke-WslCommand");
    expect(workflow).toContain("$startInfo.UseShellExecute = $false");
    expect(workflow).toContain("$startInfo.ArgumentList.Add($argument)");
    expect(workflow).toContain("$startInfo.StandardOutputEncoding = $OutputEncoding");
    expect(workflow).toContain("$startInfo.StandardErrorEncoding = $OutputEncoding");
    expect(workflow).toContain("$managementEncoding = [Text.Encoding]::Unicode");
    expect(workflow).toContain(
      'Invoke-WslCommand -Arguments @("--set-default-version", "1") -OutputEncoding $managementEncoding'
    );
    expect(workflow).toContain(
      'Invoke-WslCommand -Arguments @("--install", "--distribution", "Ubuntu", "--version", "1", "--no-launch", "--web-download") -OutputEncoding $managementEncoding'
    );
    expect(workflow).not.toContain('Invoke-WslCommand -Arguments @("--set-version"');
    expect(workflow).toContain(
      'Invoke-WslCommand -Arguments @("--list", "--verbose") -OutputEncoding $managementEncoding'
    );
    expect(workflow).toContain(
      'Invoke-WslCommand -Arguments @("--distribution", "Ubuntu", "--exec", "sh", "-lc", $probeScript) -OutputEncoding ([Text.Encoding]::UTF8)'
    );
    expect(workflow).toContain("function Get-WslFailureSummary");
    expect(workflow).not.toContain("$initialInstallFailure");
    expect(workflow).not.toContain("cmd.exe /d /u /c");
    expect(workflow).toContain("PLANWEAVE_WSL_CI_SENTINEL");
    expect(workflow).toContain('test "$WSL_DISTRO_NAME" = "Ubuntu"');
    expect(workflow).toContain(
      "pnpm exec vitest run packages/runtime/src/__tests__/executorEnvironment.test.ts --config vitest.integration-core.config.ts"
    );
    expect(workflow).toContain(
      '--testNamePattern="does not import a sentinel Windows credential named by WSLENV"'
    );
    expect(workflow).toContain("PLANWEAVE_WSL_DIAGNOSTIC_DIR: reports/wsl-cancel");
    expect(workflow).toContain(
      'throw "Failed to install the Ubuntu WSL distribution: $(Get-WslFailureSummary $installUbuntu)"'
    );
    expect(workflow).toContain('throw "Ubuntu WSL execution probe failed:');
    expect(workflow).toContain("name: Windows unsigned packaged smoke");
    expect(workflow).toContain("pnpm --dir packages/desktop build");
    expect(workflow).toContain("pnpm --dir packages/desktop pack:win");
    expect(workflow).toContain("pnpm --dir packages/desktop smoke:packaged:win");
    expect(workflow).toContain('CSC_IDENTITY_AUTO_DISCOVERY: "false"');
    expect(workflow).toContain("PLANWEAVE_CI_REPORT_PATH: reports/windows-packaged-smoke.json");
    expect(workflow).not.toContain("secrets.");
    const testJobs = [
      "ubuntu-tests",
      "integration-tests",
      "integration-tests-distributed",
      "performance-tests",
      "platform-tests"
    ];
    const artifactJobs = [...testJobs, "windows-wsl-integration", "windows-packaged-smoke"];
    for (const id of [...artifactJobs, "dependency-audit", "node-22-13-compatibility"]) {
      const job = workflowJob(workflow, id);
      expect(job).toContain("timeout-minutes:");
      expect(job).toContain("cache: pnpm");
      expect(job).toContain("pnpm install --frozen-lockfile");
    }
    for (const id of testJobs) {
      expect(workflowJob(workflow, id)).toContain("node scripts/report-slowest-tests.mjs");
    }
    for (const id of artifactJobs) {
      const job = workflowJob(workflow, id);
      expect(job).toContain("node scripts/redact-ci-test-artifacts.mjs reports");
      expect(job).toContain("actions/upload-artifact@v4");
    }
    expect(workflow).toContain("if: failure() && steps.redact-packaged-smoke.outcome == 'success'");
    expect(desktopSmokeWorkflow).not.toContain("windows-latest");
    expect(desktopSmokeWorkflow).toContain("push:");
    expect(desktopSmokeWorkflow).toContain(
      "group: desktop-smoke-${{ github.workflow }}-${{ github.ref }}"
    );
    expect(desktopSmokeWorkflow).toContain("cancel-in-progress: true");
    expect(desktopSmokeWorkflow).toContain("name: macOS packaged smoke");
    expect(desktopSmokeWorkflow).not.toContain("docker run");

    expect(packageJson.scripts["smoke:packaged:win"]).toBe("node scripts/verify-packaged-app.mjs");
    expect(packageJson.scripts["smoke:packaged:win"]).not.toMatch(/^\s*[A-Z][A-Z0-9_]*=/);
    expect(packagedVerifier).toContain("spawnManagedProcess");
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke timeout")');
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke early exit")');
    expect(packagedVerifier).toContain('tree.terminate("packaged startup smoke complete")');
    expect(packagedVerifier).toContain('termination.outcome === "already_exited"');
    expect(packagedVerifier).toContain("managedProcessTreeTerminated: true");
    expect(packagedVerifier).not.toContain("normalProcessExit");
    expect(packagedVerifier).toContain('child.once("close"');
    expect(packagedVerifier).not.toContain("await tree.exited");
    expect(packagedVerifier).not.toContain('child.kill("SIGTERM")');
    expect(packagedVerifier).toContain(
      "buildSmokeEnvironment(smokeHome, smokeUserData, startupReportPath)"
    );
    expect(packagedVerifier).toContain("maxCapturedOutputBytes");
    expect(packagedVerifier).toContain("redactCiText");
    expect(packagedVerifier).not.toContain("...process.env");
    expect(packagedVerifier).not.toContain("process.stdout.write(text)");
    expect(packagedVerifier).not.toContain("process.stderr.write(text)");
    const packagedStartupSection = packagedStartupSmoke.split("function wait(ms: number)")[0] ?? "";
    expect(packagedStartupSection).toContain('document.getElementById("root")');
    expect(packagedStartupSection).toContain('typeof runtimeBridge.listProjects !== "function"');
    expect(packagedStartupSection).not.toMatch(/[\u3400-\u9fff]/);
    const startupMainSection = desktopMain.split("if (isStartupSmoke)")[1]?.split("return;")[0];
    expect(startupMainSection).toContain("runPackagedStartupSmoke(window)");
    expect(desktopMain).toContain("PLANWEAVE_DESKTOP_STARTUP_SMOKE_REPORT_PATH");
    expect(desktopMain).toContain("PLANWEAVE_DESKTOP_STARTUP_SMOKE_ERROR");
    expect(startupMainSection).toContain("writeStartupSmokeReport(result)");
    expect(startupMainSection).not.toContain("app.exit(0)");
    expect(redactor).toContain("descriptor|endpoint|hostname|password|secret|token");
    expect(redactor).toContain("<redacted-user-path>");
  });

  it(
    "forwards package-script worker and JUnit options to Vitest",
    async () => {
      const reportDirectory = await mkdtemp(join(tmpdir(), "planweave-ci-junit-options-"));
      const reportPath = resolve(reportDirectory, "unit.xml");
      try {
        await execFileAsync(
          "pnpm",
          [
            "test:unit",
            "packages/runtime/src/__tests__/runnerInteractionContract.test.ts",
            "--maxWorkers=1",
            "--reporter=default",
            "--reporter=junit",
            `--outputFile.junit=${reportPath}`
          ],
          { cwd: repoRoot, env: process.env }
        );

        const report = await readFile(reportPath, "utf8");
        expect(report).toContain("<testsuites");
        expect(report).toContain("runnerInteractionContract.test.ts");
      } finally {
        await rm(reportDirectory, { recursive: true, force: true });
      }
    },
    junitWorkflowVerificationTimeoutMs
  );

  it("shares the security audit command and preserves the required Ubuntu gate", async () => {
    const [workflow, packageSource] = await Promise.all([
      readFile(resolve(repoRoot, ".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(repoRoot, "package.json"), "utf8")
    ]);
    const { scripts } = JSON.parse(packageSource) as { scripts: Record<string, string> };
    expect(scripts["audit:security"]).toContain("pnpm@11.4.0 audit --audit-level=moderate");
    expect(scripts["audit:security"]).not.toMatch(/--(?:prod(?:uction)?|dev)(?:\s|$)/);
    expect(scripts["verify:push"]).toContain("pnpm audit:security &&");
    const audit = workflowJob(workflow, "dependency-audit");
    expect(audit).toContain("run: pnpm audit:security");
    expect(audit).not.toContain("needs:");
    expect(audit).not.toContain("continue-on-error");
    const ubuntu = workflowJob(workflow, "ubuntu-tests");
    expect(ubuntu).not.toContain("pnpm audit:security");
    const gate = workflowJob(workflow, "ubuntu-gate");
    expect(gate).toContain("name: Ubuntu build, lint, and unit tests");
    expect(gate).toMatch(/needs:\s+- dependency-audit\s+- ubuntu-tests/);
    expect(gate).toContain("if: ${{ always() }}");
    expect(gate).toContain("AUDIT_RESULT: ${{ needs.dependency-audit.result }}");
    expect(gate).toContain("UBUNTU_RESULT: ${{ needs.ubuntu-tests.result }}");
    expect(gate).toContain(
      'if [[ "$AUDIT_RESULT" != "success" || "$UBUNTU_RESULT" != "success" ]]; then'
    );
    expect(gate).toContain("exit 1");
  });
});
