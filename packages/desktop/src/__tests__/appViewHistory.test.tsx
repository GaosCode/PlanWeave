/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  readAppViewHistoryAvailability,
  useAppViewHistory
} from "../renderer/hooks/useAppViewHistory";

describe("app view history", () => {
  it("keeps forward navigation available after returning to a previous app view", async () => {
    window.history.replaceState(null, "", "/");
    const { result } = renderHook(() => useAppViewHistory("graph"));

    act(() => {
      result.current[1]("canvas-map");
    });
    expect(readAppViewHistoryAvailability()).toEqual({ canGoBack: true, canGoForward: false });

    act(() => {
      window.history.back();
    });

    await waitFor(() => {
      expect(result.current[0]).toBe("graph");
    });
    expect(readAppViewHistoryAvailability()).toEqual({ canGoBack: false, canGoForward: true });
  });
});
