import type { ChildProcess } from "node:child_process";

export function childClosed(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

export async function terminateChild(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return await closed;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  try {
    child.kill("SIGTERM");
    escalation = setTimeout(() => child.kill("SIGKILL"), 3_000);
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Tunnel child did not exit after termination.")),
          5_000
        );
      })
    ]);
  } finally {
    clearTimeout(timeout);
    clearTimeout(escalation);
  }
}
