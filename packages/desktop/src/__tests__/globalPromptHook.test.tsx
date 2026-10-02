/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGlobalPrompt } from "../renderer/hooks/useGlobalPrompt";

const bridgeMock = vi.hoisted(() => ({
  readGlobalPrompt: vi.fn(),
  updateGlobalPrompt: vi.fn()
}));

vi.mock("../renderer/bridge", () => ({ bridge: bridgeMock }));

afterEach(() => {
  cleanup();
  bridgeMock.readGlobalPrompt.mockReset();
  bridgeMock.updateGlobalPrompt.mockReset();
});

describe("useGlobalPrompt", () => {
  it("reloads the prompt when the active PlanWeave Home changes", async () => {
    bridgeMock.readGlobalPrompt
      .mockResolvedValueOnce("Home A policy")
      .mockResolvedValueOnce("Home B policy");
    const setError = vi.fn();
    const { result, rerender } = renderHook(
      ({ planweaveHome }) => useGlobalPrompt(setError, planweaveHome),
      { initialProps: { planweaveHome: "/planweave/a" } }
    );

    await waitFor(() => expect(result.current.globalPromptMarkdown).toBe("Home A policy"));
    rerender({ planweaveHome: "/planweave/b" });
    await waitFor(() => expect(result.current.globalPromptMarkdown).toBe("Home B policy"));

    expect(bridgeMock.readGlobalPrompt).toHaveBeenCalledTimes(2);
    expect(setError).not.toHaveBeenCalled();
  });

  it("reports read and write failures through the desktop error surface", async () => {
    bridgeMock.readGlobalPrompt.mockRejectedValueOnce(new Error("read failed"));
    bridgeMock.updateGlobalPrompt.mockRejectedValueOnce(new Error("write failed"));
    const setError = vi.fn();
    const { result } = renderHook(() => useGlobalPrompt(setError, "/planweave/a"));

    await waitFor(() => expect(setError).toHaveBeenCalledWith("read failed"));
    await act(async () => {
      await expect(result.current.updateGlobalPrompt("Updated policy")).rejects.toThrow(
        "write failed"
      );
    });

    expect(setError).toHaveBeenCalledWith("write failed");
  });
});
