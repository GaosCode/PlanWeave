import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { smokeOutputFailure } from "../src/main/smokeFailureGate.js";

export type SmokeProcessResult = {
  code: number | null;
  timedOut: boolean;
  forceKilled: boolean;
};

export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const args = ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])];
    const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

export function waitForSmokeProcess(
  child: ChildProcess,
  options: {
    timeoutMs: number;
    terminationGraceMs: number;
    signalTree?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  }
): Promise<SmokeProcessResult> {
  const signalTree = options.signalTree ?? signalProcessTree;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let forceKilled = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const settle = (result: SmokeProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(result);
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalTree(child, "SIGTERM");
      graceTimer = setTimeout(() => {
        forceKilled = true;
        signalTree(child, "SIGKILL");
        // Hard budget: do not wait for `close`; descendants may keep pipes open forever.
        settle({ code: null, timedOut, forceKilled });
      }, options.terminationGraceMs);
    }, options.timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      reject(error);
    });
    child.once("close", (code) => settle({ code, timedOut, forceKilled }));
  });
}

export async function assertSmokeProcess(
  child: ChildProcess,
  readOutput: () => string,
  options: { timeoutMs: number; terminationGraceMs: number }
): Promise<void> {
  const result = await waitForSmokeProcess(child, options);
  const output = readOutput();
  if (result.timedOut) {
    throw new Error(
      `Electron smoke timed out after ${options.timeoutMs}ms (forceKilled=${String(result.forceKilled)}).\n${output}`
    );
  }
  const smokeFailure = smokeOutputFailure(output);
  if (smokeFailure !== null) {
    throw new Error(`Electron smoke observed a fatal renderer failure: ${smokeFailure}`);
  }
  if (result.code !== 0) {
    throw new Error(`Electron smoke exited with code ${String(result.code)}.\n${output}`);
  }
  if (!output.includes("PLANWEAVE_DESKTOP_SMOKE_READY")) {
    throw new Error(`Electron smoke did not report readiness.\n${output}`);
  }
}
