import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";
import { WorkspaceExecutionStartIntents } from "../main/workspaceExecutionStartIntents.js";
import { DesktopWorkspaceExecutionSessionRepository } from "../main/workspaceExecutionDesktopSessionRepository.js";
import { ownerSessionStorage } from "../main/workspaceExecutionOwnerCanvas.js";
import { setupWorkspaceExecutionStartServer } from "./workspaceExecutionStartServerFixture.js";

it("converges a persisted pre-session Stop after its real owner process exits without settling", async () => {
  const h = await setupWorkspaceExecutionStartServer();
  const child = fork(
    fileURLToPath(new URL("./workspaceExecutionPreSessionCrashFixture.ts", import.meta.url)),
    [JSON.stringify({ root: h.root, token: h.token, input: h.input })],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] }
  );
  const messages: { kind: string; confirmed?: boolean }[] = [];
  let wake: (() => void) | undefined;
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let failure: Error | undefined;
  child.on("error", (error) => {
    failure = error;
    wake?.();
  });
  child.on("exit", (code) => {
    if (code !== 91) failure = new Error(`child_exit:${code}:${stderr}`);
    wake?.();
  });
  child.on("message", async (raw) => {
    const message = z
      .object({ kind: z.string(), confirmed: z.boolean().optional() })
      .passthrough()
      .parse(raw);
    if (message.kind === "request") {
      const request = z
        .object({
          id: z.number(),
          url: z.string(),
          method: z.string().optional(),
          body: z.string().optional()
        })
        .parse(raw);
      try {
        const response = await h.request(request.url, {
          method: request.method,
          body: request.body
        });
        child.send({
          kind: "response",
          id: request.id,
          status: response.status,
          body: await response.text()
        });
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        wake?.();
      }
      return;
    }
    messages.push(message);
    wake?.();
  });
  const next = async (kind: string) => {
    for (;;) {
      if (failure) throw failure;
      const index = messages.findIndex((message) => message.kind === kind);
      if (index >= 0) return messages.splice(index, 1)[0];
      if (messages.some((message) => message.kind === "start-error"))
        throw new Error(`child_start_failed:${JSON.stringify(messages)}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };
  try {
    await next("catalog-paused");
    const journal = new WorkspaceExecutionStartIntents(h.root);
    expect(await journal.read(h.input)).toMatchObject({ settled: false, cancellation: null });
    expect(
      await new DesktopWorkspaceExecutionSessionRepository(h.root).list(
        ownerSessionStorage(h.input.locator)
      )
    ).toMatchObject({ sessions: [] });
    child.send({ kind: "stop" });
    expect(await next("stop-persisted")).toMatchObject({ confirmed: false });
    expect((await h.create().recoverCancellations({ locator: h.input.locator })).starts).toEqual([
      h.stop
    ]);
    // A second service is not a process restart: the paused owner can still continue.
    expect(await h.create().cancelStart(h.stop)).toMatchObject({ confirmed: false });
    expect(h.launches()).toBe(0);
    const exited = once(child, "exit");
    child.send({ kind: "exit" });
    expect(await exited).toEqual([91, null]);
    expect(await journal.read(h.input)).toMatchObject({ settled: false, cancellation: h.stop });

    const restarted = h.create();
    expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([
      h.stop
    ]);
    expect(await restarted.cancelStart(h.stop)).toMatchObject({ confirmed: true });
    expect((await restarted.recoverCancellations({ locator: h.input.locator })).starts).toEqual([]);
    expect(h.launches()).toBe(0);
    await expect(restarted.start(h.input)).rejects.toThrow(
      "workspace_execution_cancel_unconfirmed"
    );
    const fresh = { ...h.input, startRequestId: "start-after-real-owner-crash" };
    await expect(restarted.start(fresh)).rejects.toMatchObject({ code: "operator_request_failed" });
    expect(h.launches()).toBe(1);
    expect(
      h.f.operations.findByIdempotencyKeyInScope({
        ...h.f.locator,
        blockRef: fresh.blockRef,
        idempotencyKey: `workspace-execution-${fresh.startRequestId}`
      })
    ).not.toBeNull();
    await expect(restarted.start(h.input)).rejects.toThrow(
      "workspace_execution_cancel_unconfirmed"
    );
    expect(h.launches()).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
}, 30_000);
