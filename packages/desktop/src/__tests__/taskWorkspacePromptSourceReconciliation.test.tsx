/* @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  runtimePromptHarness,
  runtimePromptLabels
} from "./helpers/taskWorkspacePromptRuntimeHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => {
  cleanupRendererTestEnvironment();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  window.history.replaceState(null, "", "/");
});

it.each([
  "task",
  "block"
] as const)("reconciles the latest persisted %s source after A's delayed acknowledgement and same-source remount", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  if (kind === "block") await h.externalWrite("D");
  const latest = kind === "block" ? "D" : "C";
  expect(h.input()).toHaveValue("A");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue(latest));
  const form = h.input().closest("form");
  if (!form) throw new Error("Missing prompt form");
  expect(
    within(form).getByRole("button", { name: runtimePromptLabels.promptLabels.savePrompt })
  ).toBeDisabled();
  await h.remount();
  expect(h.input()).toHaveValue(latest);
  expect(await h.markdown()).toBe(latest);
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
});

it.each([
  "task",
  "block"
] as const)("preserves the newer %s draft and confirmed A baseline when C wins during acknowledgement", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await h.externalWrite("C");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(h.input()).toHaveValue("AB");
  expect(await h.markdown()).toBe("C");
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  await h.remount();
  expect(h.input()).toHaveValue("AB");
});

it("keeps the Task draft and visible failure when an unconfirmed acknowledgement rejects after C arrives", async () => {
  const h = await runtimePromptHarness("task", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  await act(async () => {
    h.pending.reject(new Error("Acknowledgement failed"));
    await expect(h.pending.promise).rejects.toThrow("Acknowledgement failed");
  });
  expect(h.input()).toHaveValue("A");
  expect(screen.getByRole("alert")).toHaveTextContent("Acknowledgement failed");
  await h.remount();
  expect(h.input()).toHaveValue("A");
  fireEvent.blur(h.input());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(await h.markdown()).toBe("C");
  expect(h.writes).toHaveLength(1);
});

it("reconciles the Block source after a previous project generation confirms persisted A", async () => {
  const h = await runtimePromptHarness("block", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  await h.externalWrite("C");
  await h.reactivate();
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue("C"));
  expect(await h.markdown()).toBe("C");
  expect(h.writes).toHaveLength(1);
});

it.each([
  { kind: "task", intermediate: false },
  { kind: "block", intermediate: false },
  { kind: "task", intermediate: true },
  { kind: "block", intermediate: true }
] as const)("accepts a real $kind source returning to the initial text, intermediate=$intermediate", async ({
  kind,
  intermediate
}) => {
  const h = await runtimePromptHarness(kind, "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  if (intermediate) await h.externalWrite("C");
  await h.externalWrite(h.initialMarkdown);
  expect(await h.markdown()).toBe(h.initialMarkdown);
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue(h.initialMarkdown));
  await h.remount();
  expect(h.input()).toHaveValue(h.initialMarkdown);
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
});

it.each([
  "task",
  "block"
] as const)("accepts an external %s restore to confirmed A while AB acknowledgement waits", async (kind) => {
  const h = await runtimePromptHarness(kind, "after-write", 2);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() =>
    expect(screen.getAllByText(runtimePromptLabels.promptLabels.saved)).toHaveLength(1)
  );
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  if (kind === "block") await h.externalWrite("C");
  await h.externalWrite("A");
  expect(await h.markdown()).toBe("A");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.input()).toHaveValue("A"));
  await h.remount();
  expect(h.input()).toHaveValue("A");
  expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]);
});

it("preserves confirmed A and the newer draft when its post-save source read fails", async () => {
  const h = await runtimePromptHarness("task", "after-write");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("A"));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  h.api.getTaskDetail.mockRejectedValueOnce(new Error("Source read unavailable"));
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("saved, but its current source")
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Source read unavailable");
  expect(h.input()).toHaveValue("AB");
  expect(await h.markdown()).toBe("A");
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  expect(h.writes.map((write) => ({ markdown: write.markdown, baseline: write.baseline }))).toEqual(
    [
      { markdown: "A", baseline: h.initialMarkdown },
      { markdown: "AB", baseline: "A" }
    ]
  );
});
