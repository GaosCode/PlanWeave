import { describe, expect, it, vi } from "vitest";
import {
  collaborationDiagnosticErrorCode,
  createCollaborationCoordinationQueue,
  runCollaborationDiagnosticsNotification
} from "../main/collaboration/collaborationCoordinationQueue.js";

describe("collaboration coordination queue", () => {
  it("serializes authority mutations and continues after a rejected operation", async () => {
    const run = createCollaborationCoordinationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = run.run(
      "first.operation",
      () =>
        new Promise<void>((resolve) => {
          events.push("first:start");
          releaseFirst = () => {
            events.push("first:end");
            resolve();
          };
        })
    );
    const secondOperation = vi.fn(async () => {
      events.push("second:start");
      throw { kind: "timeout", code: "server_timeout" };
    });
    const thirdOperation = vi.fn(async () => {
      events.push("third:start");
      return "done";
    });
    const second = run.run("second.operation", secondOperation);
    const third = run.run("third.operation", thirdOperation);

    await vi.waitFor(() => expect(events).toEqual(["first:start"]));
    expect(run.getDiagnostics()).toMatchObject({
      active: { name: "first.operation", phase: "running" },
      queued: [
        { name: "second.operation", phase: "queued" },
        { name: "third.operation", phase: "queued" }
      ],
      depth: 3
    });
    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst?.();
    await first;
    await expect(second).rejects.toMatchObject({ code: "server_timeout" });
    await expect(third).resolves.toBe("done");
    expect(events).toEqual(["first:start", "first:end", "second:start", "third:start"]);
    expect(run.getDiagnostics()).toMatchObject({
      active: null,
      queued: [],
      depth: 0,
      recent: [
        { name: "third.operation", phase: "succeeded", errorCode: null },
        { name: "second.operation", phase: "failed", errorCode: "collaboration_timeout" },
        { name: "first.operation", phase: "succeeded", errorCode: null }
      ]
    });
  });

  it("returns diagnostics immediately while an operation never resolves", async () => {
    const run = createCollaborationCoordinationQueue();
    void run.run("blocked.operation", () => new Promise<void>(() => undefined));

    await vi.waitFor(() => expect(run.getDiagnostics().active?.name).toBe("blocked.operation"));
    expect(run.getDiagnostics()).toMatchObject({
      active: { name: "blocked.operation", phase: "running" },
      depth: 1
    });
  });

  it("does not expose raw errors or sensitive operation input", async () => {
    const run = createCollaborationCoordinationQueue();
    await expect(
      run.run("workspace.connect", async () => {
        throw new Error("Bearer pw_hdev_secret https://private.example.com");
      })
    ).rejects.toThrow();

    const serialized = JSON.stringify(run.getDiagnostics());
    expect(serialized).toContain("operation_failed");
    expect(serialized).not.toContain("pw_hdev_secret");
    expect(serialized).not.toContain("private.example.com");
  });

  it("does not expose token-shaped error messages or codes", async () => {
    const run = createCollaborationCoordinationQueue();
    const token = "pwsecretabcdefghijklmnopqrstuvwxyz0123456789";
    await expect(
      run.run("message.failure", async () => Promise.reject(new Error(token)))
    ).rejects.toThrow(token);
    await expect(
      run.run("code.failure", async () => Promise.reject({ code: token }))
    ).rejects.toMatchObject({ code: token });

    const serialized = JSON.stringify(run.getDiagnostics());
    expect(serialized).not.toContain(token);
    expect(run.getDiagnostics().recent.map((entry) => entry.errorCode)).toEqual([
      "operation_failed",
      "operation_failed"
    ]);
  });

  it("rejects prototype-chain keys as diagnostic error kinds", () => {
    expect(collaborationDiagnosticErrorCode({ kind: "toString" })).toBe("operation_failed");
    expect(collaborationDiagnosticErrorCode({ kind: "constructor" })).toBe("operation_failed");
    expect(collaborationDiagnosticErrorCode({ kind: "__proto__" })).toBe("operation_failed");
  });

  it("keeps direct diagnostic notifications no-throw", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() =>
      runCollaborationDiagnosticsNotification(() => {
        throw new Error("renderer unavailable");
      })
    ).not.toThrow();

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("keeps business execution independent from diagnostic notification failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onChange = vi.fn(() => {
      throw new Error("diagnostic listener failed");
    });
    const run = createCollaborationCoordinationQueue({ onChange });
    const operation = vi.fn(async () => "done");

    await expect(run.run("safe.operation", operation)).resolves.toBe("done");

    expect(operation).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(run.getDiagnostics()).toMatchObject({
      active: null,
      queued: [],
      depth: 0,
      recent: [{ name: "safe.operation", phase: "succeeded" }]
    });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
