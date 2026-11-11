// @vitest-environment jsdom

import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { selection, workspaceLayoutHarness } from "./helpers/workspaceLayoutIntentsHarness";

describe("Workspace layout intent ownership", () => {
  it("persists every dragged node when the current graph no longer marks them selected", async () => {
    const h = await workspaceLayoutHarness();
    const save = h.drag(1, 600, [{ task: 2, x: 600 }]);
    expect(h.pending).toHaveLength(1);
    expect(h.payload(0, 1)).toBe(600);
    expect(h.payload(0, 2)).toBe(600);
    expect(h.payload(0, 3)).toBe(80);
    await h.finish(0);
    await save;
    expect(h.position(1)).toBe(600);
    expect(h.position(2)).toBe(600);
    expect(h.position(3)).toBe(80);
    h.unmount();
  });

  it("resets a Workspace graph without a local project through real layout submission and confirmation", async () => {
    const h = await workspaceLayoutHarness();
    h.drag(1, 600);
    await h.finish(0);
    let reset!: Promise<void>;
    act(() => {
      reset = h.result.current.actions.resetLayout();
    });
    expect(h.pending[1].input.intent.kind).toBe("update_layout");
    expect(h.payload(1, 1)).toBe(80);
    expect(h.payload(1, 2)).toBe(80);
    expect(h.payload(1, 3)).toBe(80);
    const last = await h.finish(1);
    await reset;
    expect(h.position(1)).toBe(80);
    expect(h.result.current.commands.layout).toEqual(last.replica.content.layout);
    h.unmount();
  });

  it("keeps the second drag visible across the first signal and out of a third stale full-layout capture", async () => {
    const h = await workspaceLayoutHarness();
    h.drag(1, 100);
    h.drag(2, 900);
    const first = h.accepted(0);
    h.signal(first);
    expect(h.result.current.commands.projection?.revision).toBe(2);
    expect(h.result.current.commands.projection?.content.layout.nodes[1].x).toBe(80);
    expect(h.position(2)).toBe(900);
    h.drag(3, 1200);
    await h.finish(0, first);
    expect(h.payload(1, 2)).toBe(900);
    expect(h.payload(1, 3)).toBe(80);
    await h.finish(1);
    expect(h.payload(2, 1)).toBe(100);
    expect(h.payload(2, 2)).toBe(900);
    expect(h.payload(2, 3)).toBe(1200);
    const last = await h.finish(2);
    expect(h.position(2)).toBe(900);
    expect(h.result.current.commands.layout).toEqual(last.replica.content.layout);
    expect(h.result.current.commands.projection).toEqual(last.replica);
    const remote = structuredClone(last);
    remote.replica.revision += 1;
    remote.replica.contentDigest = "f".repeat(64);
    remote.replica.content.layout.nodes[1].x = 990;
    h.signal(remote);
    expect(h.position(2)).toBe(990);
    h.unmount();
  });

  it("preserves an unrelated newer client update while an older accepted return arrives", async () => {
    const h = await workspaceLayoutHarness();
    h.drag(1, 100);
    h.drag(2, 900);
    const first = h.accepted(0);
    h.signal(first);
    const other = structuredClone(first);
    other.replica.revision = 3;
    other.replica.contentDigest = "3".repeat(64);
    other.replica.content.layout.nodes[2].x = 700;
    h.signal(other);
    expect(h.position(2)).toBe(900);
    expect(h.position(3)).toBe(700);
    await act(async () => {
      h.pending[0].done.resolve(first);
    });
    expect(h.payload(1, 3)).toBe(700);
    expect(h.result.current.commands.projection?.revision).toBe(3);
    const last = await h.finish(1);
    expect(h.result.current.commands.layout).toEqual(last.replica.content.layout);
    expect(h.position(3)).toBe(700);
    h.unmount();
  });

  it.each([
    "rejected",
    "throw"
  ] as const)("replays the next drag after %s and does not publish the old operation error", async (failure) => {
    const h = await workspaceLayoutHarness();
    h.drag(1, 100);
    h.drag(2, 900);
    if (failure === "rejected") {
      const rejected = structuredClone(h.accepted(0));
      rejected.status = "rejected";
      rejected.rejectCode = "permission_denied";
      rejected.replica.revision = 1;
      rejected.replica.contentDigest = "1".padStart(64, "0");
      rejected.replica.content.layout.nodes[0].x = 80;
      h.signal(rejected);
      expect(h.result.current.commands.snapshot.lastError).toBeNull();
      await h.finish(0, rejected);
    } else {
      await act(async () => {
        h.pending[0].done.reject(Error("old failure"));
      });
    }
    expect(h.position(1)).toBe(80);
    expect(h.position(2)).toBe(900);
    expect(h.payload(1, 1)).toBe(80);
    expect(h.setError).not.toHaveBeenCalled();
    await h.finish(1);
    h.drag(3, 1200);
    await act(async () => {
      h.pending[2].done.reject(Error("current failure"));
    });
    expect(h.position(3)).toBe(80);
    expect(h.setError).toHaveBeenLastCalledWith("current failure");
    h.drag(3, 1300);
    const last = await h.finish(3);
    expect(h.position(3)).toBe(1300);
    expect(h.result.current.commands.layout).toEqual(last.replica.content.layout);
    expect(h.setError).toHaveBeenLastCalledWith(null);
    h.unmount();
  });

  it.each([
    "canvas",
    "authority",
    "disconnect"
  ] as const)("retires queued intent across %s changes and recovers from late completion", async (change) => {
    const h = await workspaceLayoutHarness();
    h.drag(1, 100);
    h.drag(2, 900);
    const old = h.accepted(0);
    if (change === "canvas") h.rerender({ ...selection, canvasId: "canvas-b" });
    if (change === "authority") h.rerender({ ...selection, authority: "authority-b" });
    if (change === "disconnect") h.rerender({ ...selection, connected: false });
    await h.ready();
    expect(h.position(2)).toBe(80);
    await act(async () => {
      h.pending[0].done.reject(Error("retired failure"));
    });
    expect(h.pending).toHaveLength(1);
    expect(h.setError).not.toHaveBeenCalled();
    h.rerender(selection);
    await h.ready();
    expect(h.position(2)).toBe(80);
    h.signal(old);
    expect(h.position(1)).toBe(100);
    expect(h.position(2)).toBe(80);
    h.drag(2, 950);
    const last = await h.finish(1);
    expect(h.payload(1, 1)).toBe(100);
    expect(h.position(2)).toBe(950);
    expect(h.result.current.commands.layout).toEqual(last.replica.content.layout);
    h.unmount();
  });
});
