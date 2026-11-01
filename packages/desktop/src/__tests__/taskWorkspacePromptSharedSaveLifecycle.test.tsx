/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  sharedPromptSessionHarness as harness,
  sharedPromptLabels as labels
} from "./helpers/taskWorkspacePromptSharedSessionHarness";

afterEach(cleanupRendererTestEnvironment);

it.each([
  "task",
  "block"
] as const)("uses the real session's confirmed %s projection to drain AB before React readback", async (kind) => {
  const h = await harness(kind);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.commands).toEqual(["A"]));
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => h.hide());
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.commands).toEqual(["A", "AB"]));
  expect(h.markdown()).toBe("AB");
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
});

it("reports the real session's external C without overwriting it or losing AB", async () => {
  const h = await harness("task", "external");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => h.hide());
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.markdown()).toBe("C"));
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  expect(screen.getByRole("alert")).toHaveTextContent("changed before its save was confirmed");
  expect(h.commands).toEqual(["A"]);
});

it("keeps AB available after the real session retires its pending command", async () => {
  const h = await harness("task", "retired");
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  fireEvent.change(h.input(), { target: { value: "AB" } });
  fireEvent.blur(h.input());
  act(() => {
    h.hide();
    h.retire();
  });
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.commands).toEqual(["A"]));
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  expect(screen.queryByText(labels.saved)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: labels.savePrompt })).toBeEnabled();
});

it.each([
  ["task", "session"],
  ["block", "session"],
  ["task", "permission"],
  ["block", "permission"]
] as const)("retires an unsubmitted %s autosave across a real %s generation", async (kind, retirement) => {
  const h = await harness(kind);
  fireEvent.change(h.input(), { target: { value: "AB" } });
  if (retirement === "session") {
    act(() => h.hide());
    act(() => h.retire());
    await act(async () => {
      h.resume();
      await Promise.resolve();
    });
  } else {
    act(() => h.setWritable(false));
    await act(async () => {
      h.setWritable(true);
      await Promise.resolve();
    });
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 850));
  });
  expect(h.commands).toEqual([]);
  act(() => h.show());
  expect(h.input()).toHaveValue("AB");
  const markdown = kind === "task" ? "AB" : "ABC";
  if (kind === "task") fireEvent.click(screen.getByRole("button", { name: labels.savePrompt }));
  else fireEvent.change(h.input(), { target: { value: markdown } });
  await waitFor(() => expect(h.commands).toEqual([markdown]));
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await waitFor(() => expect(h.markdown()).toBe(markdown));
});
