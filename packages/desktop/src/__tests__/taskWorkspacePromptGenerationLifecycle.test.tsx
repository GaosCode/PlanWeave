/* @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { runtimePromptHarness } from "./helpers/taskWorkspacePromptRuntimeHarness";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(() => {
  cleanupRendererTestEnvironment();
  delete process.env.PLANWEAVE_HOME;
  delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  window.history.replaceState(null, "", "/");
});

async function debounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 850));
  });
}

it.each([
  ["task", "before", "debounce"],
  ["block", "before", "debounce"],
  ["task", "after", "debounce"],
  ["block", "after", "debounce"],
  ["task", "before", "blur"],
  ["block", "before", "blur"],
  ["task", "after", "blur"],
  ["block", "after", "blur"]
] as const)("preserves new %s %s-debounce %s intent when an old authority rejects", async (kind, timing, trigger) => {
  const h = await runtimePromptHarness(kind);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  await h.reactivate();
  fireEvent.change(h.input(), { target: { value: "AB" } });
  if (trigger === "blur") fireEvent.blur(h.input());
  if (timing === "after") await debounce();
  await act(async () => {
    h.pending.reject(new Error("Old authority rejected A"));
    await expect(h.pending.promise).rejects.toThrow("Old authority rejected A");
  });
  expect.soft(screen.queryByRole("alert")).not.toBeInTheDocument();
  if (timing === "before") await debounce();
  await waitFor(() => expect(h.writes.map((write) => write.markdown)).toEqual(["A", "AB"]));
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
  expect(h.writes[1]?.baseline).toBe(h.initialMarkdown);
  expect(h.writes.map((write) => write.concurrent)).toEqual([1, 1]);
  expect(h.input()).toHaveValue("AB");
});

it.each([
  "task",
  "block"
] as const)("stops automatic retry after a current %s authority rejects", async (kind) => {
  const h = await runtimePromptHarness(kind);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  await act(async () => {
    h.pending.reject(new Error("Current authority rejected A"));
    await expect(h.pending.promise).rejects.toThrow("Current authority rejected A");
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Current authority rejected A");
  await debounce();
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  expect(await h.markdown()).toBe(h.initialMarkdown);
  expect(h.input()).toHaveValue("AB");
  fireEvent.blur(h.input());
  await waitFor(async () => expect(await h.markdown()).toBe("AB"));
});

it.each([
  "task",
  "block"
] as const)("does not invent a new %s retry after an old authority rejects", async (kind) => {
  const h = await runtimePromptHarness(kind);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.writes).toHaveLength(1));
  await h.reactivate();
  await act(async () => {
    h.pending.reject(new Error("Old authority rejected A"));
    await expect(h.pending.promise).rejects.toThrow("Old authority rejected A");
  });
  await debounce();
  expect(h.writes.map((write) => write.markdown)).toEqual(["A"]);
  expect(await h.markdown()).toBe(h.initialMarkdown);
  expect(h.input()).toHaveValue("A");
});
