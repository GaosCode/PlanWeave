/* @vitest-environment jsdom */

import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";
import { describe, expect, it } from "vitest";
import { useSharedResourceHighlight } from "../renderer/hooks/useSharedResourceHighlight";
import { graph as baseGraph } from "./helpers/graphFixtures";

function graphWithActiveRefs(activeBlockRefs: string[]): DesktopGraphViewModel {
  return {
    ...baseGraph,
    sharedResourceGroups: [
      {
        name: "packages/runtime",
        memberTaskIds: ["T-ALPHA", "T-BETA"],
        memberBlockRefs: ["T-ALPHA#B-001", "T-BETA#B-001"],
        activeBlockRefs
      }
    ]
  };
}

describe("useSharedResourceHighlight", () => {
  it("pins resources and clears the active highlight with Escape", () => {
    const { result } = renderHook(() => useSharedResourceHighlight(graphWithActiveRefs([])));

    act(() => result.current.onResourcePin("packages/runtime"));
    expect(result.current.pinnedResource).toBe("packages/runtime");
    expect(result.current.activeResource).toBe("packages/runtime");

    act(() => fireEvent.keyDown(window, { key: "Escape" }));
    expect(result.current.pinnedResource).toBeNull();
    expect(result.current.activeResource).toBeNull();
  });

  it("increments the transition epoch when active members change", async () => {
    const { result, rerender } = renderHook(({ graph }) => useSharedResourceHighlight(graph), {
      initialProps: { graph: graphWithActiveRefs([]) }
    });

    rerender({ graph: graphWithActiveRefs(["T-ALPHA#B-001"]) });

    await waitFor(() => {
      expect(result.current.transitionEpochByResource["packages/runtime"]).toBe(1);
    });
  });
});
