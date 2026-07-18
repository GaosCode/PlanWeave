import { afterEach, describe, expect, it } from "vitest";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import { fixture } from "./support/acpRunnerLifecycleFixture.js";

const cleanupWaveCount = 3;
const concurrentConnectionsPerWave = 4;

function environment(): Record<string, string> {
  return Object.fromEntries(
    // biome-ignore lint/style/noProcessEnv: The real child must inherit the test process environment.
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function expectProcessExited(processId: number): void {
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(`ACP cleanup integration process ${processId} is still alive.`);
}

describe("ACP connection process cleanup", () => {
  const connections: AcpConnection[] = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.dispose()));
  });

  it("reaps repeated waves of concurrent SIGTERM-resistant process trees", async () => {
    for (let wave = 0; wave < cleanupWaveCount; wave += 1) {
      const current = Array.from({ length: concurrentConnectionsPerWave }, () => {
        const connection = createAcpConnection({
          launch: { trusted: true, command: process.execPath, args: [fixture, "stubborn-pending"] },
          cwd: process.cwd(),
          env: environment(),
          clientInfo: { name: "cleanup-integration", version: "1" }
        });
        connections.push(connection);
        return connection;
      });
      // biome-ignore lint/performance/noAwaitInLoops: Each completed wave is a separate cleanup repetition.
      await Promise.all(current.map((connection) => connection.initialize()));
      const processIds = current.map((connection) => connection.processId);
      expect(processIds).toEqual(processIds.map(() => expect.any(Number)));

      await expect(Promise.all(current.map((connection) => connection.dispose()))).resolves.toEqual(
        current.map(() => undefined)
      );

      for (const processId of processIds) {
        if (processId === null) {
          throw new Error("ACP cleanup integration process id is missing.");
        }
        expectProcessExited(processId);
      }
    }
  });
});
