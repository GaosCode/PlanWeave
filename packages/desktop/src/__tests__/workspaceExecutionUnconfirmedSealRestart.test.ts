import { fork } from "node:child_process";
import { once } from "node:events";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { WorkspaceExecutionStartIntents } from "../main/workspaceExecutionStartIntents.js";
import {
  desktopWorkspaceExecutionCancellationRecoverySchema,
  desktopWorkspaceExecutionStartCancellationSchema,
  desktopWorkspaceExecutionStartInputSchema
} from "../shared/workspaceExecution.js";
import { setupPreAdmissionStop } from "./workspaceExecutionPreAdmissionStopFixture.js";

function startChild(config: object) {
  const child = fork(
    fileURLToPath(new URL("./workspaceExecutionUnconfirmedSealRestartFixture.ts", import.meta.url)),
    [JSON.stringify(config)],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const messages: unknown[] = [];
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
    wake?.();
  });
  child.on("exit", (code, signal) => {
    failure ??= new Error(`restart_child_exited:${code}:${signal}:${stderr}`);
    wake?.();
  });
  child.on("message", (raw) => {
    const message = z.object({ kind: z.string(), error: z.string().optional() }).parse(raw);
    if (message.kind === "failure") failure = new Error(message.error);
    messages.push(raw);
    wake?.();
  });
  return {
    child,
    exited,
    async next(kind: string): Promise<unknown> {
      for (;;) {
        if (failure) throw failure;
        const index = messages.findIndex(
          (message) => z.object({ kind: z.string() }).parse(message).kind === kind
        );
        if (index >= 0) return messages.splice(index, 1)[0];
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  };
}

it("recovers an unconfirmed newly sealed Stop in a different process after the sealing process exits", async () => {
  const h = await setupPreAdmissionStop();
  const input = desktopWorkspaceExecutionStartInputSchema.parse(h.input);
  const config = { root: dirname(h.sessionsRoot), sessionsRoot: h.sessionsRoot, stop: h.stop };
  const journals = new WorkspaceExecutionStartIntents(h.sessionsRoot);
  expect(await journals.read(input)).toBeNull();
  expect(h.server.countOperations()).toBe(0);

  const sealing = startChild({ ...config, mode: "seal" });
  let recovering: ReturnType<typeof startChild> | undefined;
  try {
    const sealed = z
      .object({
        kind: z.literal("sealed"),
        pid: z.number(),
        requests: z.array(z.object({ path: z.string(), method: z.string() }))
      })
      .parse(await sealing.next("sealed"));
    expect(sealed.pid).toBe(sealing.child.pid);
    expect(sealed.pid).not.toBe(process.pid);
    expect(
      sealed.requests.filter(
        (request) => request.path.endsWith("/remote-operations") && request.method === "POST"
      )
    ).toEqual([]);
    const expectedSeal = {
      input: h.input,
      settled: true,
      cancellationConfirmed: false,
      cancellation: h.stop
    };
    const sealedOnDisk = await journals.read(input);
    expect(sealedOnDisk).toEqual(expectedSeal);
    expect(h.server.countOperations()).toBe(0);
    sealing.child.send({ kind: "exit", code: 91 });
    expect(await sealing.exited).toEqual([91, null]);
    expect(await journals.read(input)).toEqual(expectedSeal);

    recovering = startChild({ ...config, mode: "recover" });
    const recovered = z
      .object({
        kind: z.literal("recovered"),
        pid: z.number(),
        before: desktopWorkspaceExecutionCancellationRecoverySchema,
        confirmation: desktopWorkspaceExecutionStartCancellationSchema,
        after: desktopWorkspaceExecutionCancellationRecoverySchema,
        repeatedStop: desktopWorkspaceExecutionStartCancellationSchema,
        repeatedRecovery: desktopWorkspaceExecutionCancellationRecoverySchema,
        oldStartBefore: z.string(),
        oldStartAfter: z.string(),
        fresh: z.object({ handle: z.object({ target: z.literal("remote") }) }),
        requests: z.array(z.object({ path: z.string(), method: z.string() }))
      })
      .parse(await recovering.next("recovered"));
    expect(recovered.pid).toBe(recovering.child.pid);
    expect(recovered.pid).not.toBe(sealed.pid);
    expect(recovered.pid).not.toBe(process.pid);
    expect(recovered.before.starts).toEqual([h.stop]);
    expect(recovered.before.sessions).toEqual([]);
    expect(recovered.confirmation.confirmed).toBe(true);
    expect(recovered.after).toMatchObject({ starts: [], sessions: [] });
    expect(recovered.repeatedStop.confirmed).toBe(true);
    expect(recovered.repeatedRecovery).toEqual(recovered.after);
    expect(recovered.oldStartBefore).toBe("workspace_execution_cancel_unconfirmed");
    expect(recovered.oldStartAfter).toBe("workspace_execution_cancel_unconfirmed");
    expect(h.server.countOperations()).toBe(1);
    expect(
      recovered.requests.filter(
        (request) => request.path.endsWith("/remote-operations") && request.method === "POST"
      )
    ).toHaveLength(1);
    const confirmedOnDisk = await journals.read(input);
    expect(confirmedOnDisk).toEqual({ ...expectedSeal, cancellationConfirmed: true });
    recovering.child.send({ kind: "exit", code: 0 });
    expect(await recovering.exited).toEqual([0, null]);
    process.stdout.write(
      `${JSON.stringify({
        parentPid: process.pid,
        sealingPid: sealed.pid,
        sealingExit: 91,
        recoveringPid: recovered.pid,
        recoveringExit: 0,
        unconfirmedSeal: sealedOnDisk,
        confirmedSeal: confirmedOnDisk,
        recoveredStarts: recovered.before.starts.length,
        remainingStarts: recovered.after.starts.length,
        sealingRequests: sealed.requests.length,
        recoveringRequests: recovered.requests.length,
        serverOperations: h.server.countOperations()
      })}\n`
    );
  } finally {
    await sealing.close();
    await recovering?.close();
  }
}, 30_000);
