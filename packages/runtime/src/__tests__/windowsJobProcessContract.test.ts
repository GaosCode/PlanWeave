import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let helperSource = "";

function sourceBetween(start: string, end: string): string {
  const startIndex = helperSource.indexOf(start);
  const endIndex = helperSource.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex <= startIndex) {
    throw new Error(
      `Expected helper source section from ${JSON.stringify(start)} to ${JSON.stringify(end)}.`
    );
  }
  return helperSource.slice(startIndex, endIndex);
}

beforeAll(async () => {
  helperSource = await readFile(
    join(import.meta.dirname, "../process/windowsJobProcess.ps1"),
    "utf8"
  );
});

describe("Windows Job target creation contract", () => {
  it("supports launcher inheritance and explicit suspended assignment through one target creator", () => {
    const createJob = sourceBetween(
      "public static IntPtr CreateOwnedJob",
      "public static IntPtr OpenOwnedJob"
    );
    const createTarget = sourceBetween(
      "private static ManagedTarget CreateTarget",
      "public static ManagedTarget CreateSuspendedTarget"
    );

    expect(createJob).toContain(
      "assignCurrentProcess && !AssignProcessToJobObject(job, GetCurrentProcess())"
    );
    expect(createTarget).toContain("suspendAndAssign ? CREATE_SUSPENDED : 0");
    expect(createTarget).toContain(
      "suspendAndAssign && !AssignProcessToJobObject(job, process.hProcess)"
    );
    expect(createTarget.indexOf("CreateProcess(")).toBeLessThan(
      createTarget.indexOf("AssignProcessToJobObject(job, process.hProcess)")
    );
    expect(helperSource.match(/private static ManagedTarget CreateTarget/g)).toHaveLength(1);
  });

  it("fails closed for target setup, resume, and inherited target wait failures", () => {
    const createTarget = sourceBetween(
      "private static ManagedTarget CreateTarget",
      "public static ManagedTarget CreateSuspendedTarget"
    );
    const abortTarget = sourceBetween(
      "public static void AbortTarget",
      "public static uint StartAndWaitTarget"
    );
    const waitTarget = sourceBetween(
      "public static uint StartAndWaitTarget",
      "public static void Terminate"
    );

    expect(createTarget).toContain("TerminateProcess(process.hProcess, 1)");
    expect(createTarget).toContain("CloseHandle(process.hThread)");
    expect(createTarget).toContain("CloseHandle(process.hProcess)");
    expect(abortTarget).toContain("TerminateProcess(target.ProcessHandle, 1)");
    expect(waitTarget).toContain("ResumeThread(target.ThreadHandle)");
    expect(waitTarget).toContain("if (resumed || !target.RequiresResume)");
    expect(waitTarget).toContain("Terminate(job)");
    expect(waitTarget).toContain("AbortTarget(target)");
  });
});

describe("Windows Job ownership handoff contract", () => {
  it("starts the keeper before the default suspended target is resumed", () => {
    const defaultLaunch = sourceBetween(
      "} else {\n      $target = [PlanWeaveWindowsJob]::CreateSuspendedTarget(",
      "    }\n    [Environment]::Exit"
    );

    expect(defaultLaunch.indexOf("CreateSuspendedTarget(")).toBeLessThan(
      defaultLaunch.indexOf("Start-JobKeeper")
    );
    expect(defaultLaunch.indexOf("Start-JobKeeper")).toBeLessThan(
      defaultLaunch.indexOf("StartAndWaitTarget(")
    );
  });

  it("joins the launcher first and hands inherited descendants to a keeper after root exit", () => {
    const launchMode = sourceBetween(
      "$launcherJobInheritance = $jobLaunchStrategy -eq",
      "} catch {\n  [Console]::Error.WriteLine"
    );
    const inheritedLaunch = sourceBetween(
      "if ($launcherJobInheritance) {",
      "} else {\n      $target = [PlanWeaveWindowsJob]::CreateSuspendedTarget("
    );

    expect(launchMode.indexOf("CreateOwnedJob($JobName, $launcherJobInheritance)")).toBeLessThan(
      launchMode.indexOf("CreateInheritedTarget(")
    );
    expect(inheritedLaunch.indexOf("CreateInheritedTarget(")).toBeLessThan(
      inheritedLaunch.indexOf("StartAndWaitTarget(")
    );
    expect(inheritedLaunch.indexOf("StartAndWaitTarget(")).toBeLessThan(
      inheritedLaunch.indexOf("ActiveProcesses($job) -gt 1")
    );
    expect(inheritedLaunch.indexOf("ActiveProcesses($job) -gt 1")).toBeLessThan(
      inheritedLaunch.indexOf("Start-JobKeeper")
    );
  });

  it("keeps the named Job alive while excluding an in-Job keeper from the active floor", () => {
    const keepMode = sourceBetween(
      'if ($Mode -eq "keep")',
      "if ([string]::IsNullOrWhiteSpace($Payload))"
    );

    expect(keepMode).toContain("[PlanWeaveWindowsJob]::OpenOwnedJob($JobName)");
    expect(keepMode).toContain("CurrentProcessBelongsToJob($job)");
    expect(keepMode).toContain(
      "while ([PlanWeaveWindowsJob]::ActiveProcesses($job) -gt $ownedProcessFloor)"
    );
    expect(keepMode.indexOf("OpenOwnedJob($JobName)")).toBeLessThan(
      keepMode.indexOf("$readyEvent.Set()")
    );
  });
});
