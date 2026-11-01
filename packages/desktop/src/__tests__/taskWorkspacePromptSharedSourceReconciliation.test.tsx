/* @vitest-environment jsdom */
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";
import {
  sharedPromptSessionHarness,
  sharedPromptLabels
} from "./helpers/taskWorkspacePromptSharedSessionHarness";

afterEach(cleanupRendererTestEnvironment);

it.each([
  "task",
  "block"
] as const)("keeps the newer shared %s source when a real session publishes delayed accepted A", async (kind) => {
  const h = await sharedPromptSessionHarness(kind, undefined, true);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.markdown()).toBe("A"));
  act(() => h.publish("C"));
  expect(h.input()).toHaveValue("A");
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  expect(h.source()).toBe("C");
  expect(h.gate.snapshot.session?.revision).toBe(h.gate.projection?.revision);
  await waitFor(() => expect(h.input()).toHaveValue("C"));
  act(() => h.hide());
  act(() => h.show());
  expect(h.input()).toHaveValue("C");
  expect(h.markdown()).toBe("C");
  expect(h.commands).toEqual(["A"]);
});

it("preserves the Block draft when a real session retires before confirming A after C", async () => {
  const h = await sharedPromptSessionHarness("block", undefined, true);
  fireEvent.change(h.input(), { target: { value: "A" } });
  fireEvent.blur(h.input());
  await waitFor(() => expect(h.markdown()).toBe("A"));
  act(() => h.publish("C"));
  act(() => {
    h.hide();
    h.retire();
  });
  await act(async () => {
    h.pending.resolve();
    await h.pending.promise;
  });
  await act(async () => {
    h.resume();
    await Promise.resolve();
  });
  act(() => h.show());
  expect(h.input()).toHaveValue("A");
  expect(screen.queryByText(sharedPromptLabels.saved)).not.toBeInTheDocument();
  expect(h.markdown()).toBe("C");
  fireEvent.blur(h.input());
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("changed outside this editor")
  );
  expect(h.commands).toEqual(["A"]);
});

it("accepts same-head permission metadata and reports contradictory content at the same revision", async () => {
  const h = await sharedPromptSessionHarness("task");
  act(() => h.setWritable(false));
  expect(h.gate.projection?.canEdit).toBe(false);
  act(() => h.setWritable(true));
  expect(h.gate.projection?.canEdit).toBe(true);
  const known = h.gate.projection;
  if (!known) throw new Error("Missing connected projection");
  act(() => h.publish("Contradictory content", known.revision));
  expect(h.gate.snapshot.lastError).toContain("conflicting content at the same revision");
  expect(h.gate.projection?.contentDigest).toBe(known.contentDigest);
  expect(h.source()).not.toBe("Contradictory content");
});
