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

describe("Windows Job process helper contract", () => {
  beforeAll(async () => {
    helperSource = await readFile(
      join(import.meta.dirname, "../process/windowsJobProcess.ps1"),
      "utf8"
    );
  });

  it("keeps the launcher outside the managed Job and explicitly assigns a suspended target", () => {
    const createJob = sourceBetween(
      "public static IntPtr CreateOwnedJob",
      "public static IntPtr OpenOwnedJob"
    );
    const createTarget = sourceBetween(
      "public static SuspendedTarget CreateSuspendedTarget",
      "private static void CloseTargetHandles"
    );

    expect(createJob).not.toContain("AssignProcessToJobObject");
    expect(helperSource).not.toContain("private static extern IntPtr GetCurrentProcess");
    expect(helperSource).not.toContain("AssignProcessToJobObject(job, GetCurrentProcess())");
    expect(createTarget).toContain("CREATE_SUSPENDED");
    expect(createTarget).toContain("AssignProcessToJobObject(job, process.hProcess)");
    expect(createTarget.indexOf("CreateProcess(")).toBeLessThan(
      createTarget.indexOf("AssignProcessToJobObject(job, process.hProcess)")
    );
  });

  it("terminates the suspended target and closes both handles when setup or resume fails", () => {
    const createTarget = sourceBetween(
      "public static SuspendedTarget CreateSuspendedTarget",
      "private static void CloseTargetHandles"
    );
    const abortTarget = sourceBetween(
      "public static void AbortSuspendedTarget",
      "public static uint ResumeAndWaitTarget"
    );
    const resumeTarget = sourceBetween(
      "public static uint ResumeAndWaitTarget",
      "public static void Terminate"
    );

    expect(createTarget).toContain("TerminateProcess(process.hProcess, 1)");
    expect(createTarget).toContain("CloseHandle(process.hThread)");
    expect(createTarget).toContain("CloseHandle(process.hProcess)");
    expect(abortTarget).toContain("TerminateProcess(target.ProcessHandle, 1)");
    expect(abortTarget).toContain("CloseTargetHandles(target)");
    expect(resumeTarget).toContain("ResumeThread(target.ThreadHandle)");
    expect(resumeTarget).toContain("AbortSuspendedTarget(target)");
  });

  it("hands ownership to an out-of-Job keeper before resuming the target", () => {
    const launchMode = sourceBetween(
      "$target = [PlanWeaveWindowsJob]::CreateSuspendedTarget(",
      "} catch {\n  [Console]::Error.WriteLine"
    );

    const createTargetIndex = launchMode.indexOf("CreateSuspendedTarget(");
    const startKeeperIndex = launchMode.indexOf("Start-Process -FilePath $powershell");
    const keeperReadyIndex = launchMode.indexOf("$readyEvent.WaitOne(20)");
    const resumeTargetIndex = launchMode.indexOf("ResumeAndWaitTarget(");
    expect(createTargetIndex).toBeLessThan(startKeeperIndex);
    expect(startKeeperIndex).toBeLessThan(keeperReadyIndex);
    expect(keeperReadyIndex).toBeLessThan(resumeTargetIndex);
  });

  it("keeps the named Job alive exactly while it has active managed processes", () => {
    const keepMode = sourceBetween(
      'if ($Mode -eq "keep")',
      "if ([string]::IsNullOrWhiteSpace($Payload))"
    );

    expect(keepMode).toContain("[PlanWeaveWindowsJob]::OpenOwnedJob($JobName)");
    expect(keepMode).toContain("while ([PlanWeaveWindowsJob]::ActiveProcesses($job) -gt 0)");
    expect(keepMode).not.toContain("ownedProcessFloor");
    expect(keepMode.indexOf("OpenOwnedJob($JobName)")).toBeLessThan(
      keepMode.indexOf("$readyEvent.Set()")
    );
  });
});
