/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDesktopSettings } from "../renderer/settings";
import { useResizableSidebarLayout } from "../renderer/hooks/useResizableSidebarLayout";
import type { DesktopUiSettings } from "../renderer/types";

type SidebarLayout = DesktopUiSettings["layout"];

function sidebarLayout(overrides: Partial<SidebarLayout> = {}): SidebarLayout {
  return {
    ...defaultDesktopSettings.layout,
    ...overrides,
    leftSidebar: {
      ...defaultDesktopSettings.layout.leftSidebar,
      ...overrides.leftSidebar
    },
    rightSidebar: {
      ...defaultDesktopSettings.layout.rightSidebar,
      ...overrides.rightSidebar
    },
    autoRunControl: {
      ...defaultDesktopSettings.layout.autoRunControl,
      ...overrides.autoRunControl
    }
  };
}

function SidebarLayoutHarness({
  initialLayout = sidebarLayout(),
  onLayoutPatch
}: {
  initialLayout?: SidebarLayout;
  onLayoutPatch: Parameters<typeof useResizableSidebarLayout>[0]["onLayoutPatch"];
}) {
  const sidebarLayoutState = useResizableSidebarLayout({
    initialLayout,
    onLayoutPatch
  });

  return (
    <div>
      <button
        type="button"
        data-testid="left-resize"
        onPointerDown={(event) => sidebarLayoutState.startSidebarResize(event, "left")}
      >
        left resize
      </button>
      <button
        type="button"
        data-testid="right-resize"
        onPointerDown={(event) => sidebarLayoutState.startSidebarResize(event, "right")}
      >
        right resize
      </button>
      <button
        type="button"
        data-testid="left-toggle"
        onClick={() => sidebarLayoutState.setLeftSidebarCollapsedPreference((current) => !current)}
      >
        left toggle
      </button>
      <button
        type="button"
        data-testid="right-toggle"
        onClick={() => sidebarLayoutState.setRightSidebarCollapsedPreference((current) => !current)}
      >
        right toggle
      </button>
      <output data-testid="left-width">{sidebarLayoutState.leftSidebarWidth}</output>
      <output data-testid="right-width">{sidebarLayoutState.rightSidebarWidth}</output>
      <output data-testid="left-collapsed">
        {String(sidebarLayoutState.leftSidebarCollapsed)}
      </output>
      <output data-testid="right-collapsed">
        {String(sidebarLayoutState.rightSidebarCollapsed)}
      </output>
    </div>
  );
}

afterEach(() => {
  cleanup();
  window.document.body.style.cursor = "";
  window.document.body.style.userSelect = "";
  vi.restoreAllMocks();
});

describe("useResizableSidebarLayout", () => {
  it("resizes the left sidebar and commits the final width on pointerup", () => {
    const onLayoutPatch = vi.fn();
    render(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({ leftSidebar: { collapsed: false, width: 280 } })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    fireEvent.pointerDown(screen.getByTestId("left-resize"), { clientX: 100 });
    expect(window.document.body.style.cursor).toBe("col-resize");
    expect(window.document.body.style.userSelect).toBe("none");

    fireEvent.pointerMove(window, { clientX: 150 });
    expect(screen.getByTestId("left-width")).toHaveTextContent("330");
    expect(onLayoutPatch).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);
    expect(onLayoutPatch).toHaveBeenCalledWith({ leftSidebar: { width: 330 } });
    expect(window.document.body.style.cursor).toBe("");
    expect(window.document.body.style.userSelect).toBe("");
  });

  it("resizes the right sidebar by dragging left and commits on pointercancel", () => {
    const onLayoutPatch = vi.fn();
    render(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({ rightSidebar: { collapsed: false, width: 300 } })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    fireEvent.pointerDown(screen.getByTestId("right-resize"), { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 350 });

    expect(screen.getByTestId("right-width")).toHaveTextContent("350");

    fireEvent.pointerCancel(window);
    expect(onLayoutPatch).toHaveBeenCalledWith({ rightSidebar: { width: 350 } });
    expect(window.document.body.style.cursor).toBe("");
    expect(window.document.body.style.userSelect).toBe("");
  });

  it("clamps sidebar widths to their configured bounds", () => {
    const onLayoutPatch = vi.fn();
    render(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 280 },
          rightSidebar: { collapsed: false, width: 300 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    fireEvent.pointerDown(screen.getByTestId("left-resize"), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window);
    expect(onLayoutPatch).toHaveBeenCalledWith({ leftSidebar: { width: 520 } });

    fireEvent.pointerDown(screen.getByTestId("right-resize"), { clientX: 400 });
    fireEvent.pointerMove(window, { clientX: 1000 });
    fireEvent.pointerUp(window);
    expect(onLayoutPatch).toHaveBeenCalledWith({ rightSidebar: { width: 240 } });
  });

  it("persists left and right collapsed preferences", () => {
    const onLayoutPatch = vi.fn();
    render(<SidebarLayoutHarness onLayoutPatch={onLayoutPatch} />);

    fireEvent.click(screen.getByTestId("left-toggle"));
    fireEvent.click(screen.getByTestId("right-toggle"));

    expect(screen.getByTestId("left-collapsed")).toHaveTextContent("true");
    expect(screen.getByTestId("right-collapsed")).toHaveTextContent("true");
    expect(onLayoutPatch).toHaveBeenCalledWith({ leftSidebar: { collapsed: true } });
    expect(onLayoutPatch).toHaveBeenCalledWith({ rightSidebar: { collapsed: true } });
  });

  it("updates sidebar state when async settings layout changes before local interaction", () => {
    const onLayoutPatch = vi.fn();
    const { rerender } = render(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 280 },
          rightSidebar: { collapsed: false, width: 300 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    rerender(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: true, width: 360 },
          rightSidebar: { collapsed: true, width: 420 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    expect(screen.getByTestId("left-width")).toHaveTextContent("360");
    expect(screen.getByTestId("right-width")).toHaveTextContent("420");
    expect(screen.getByTestId("left-collapsed")).toHaveTextContent("true");
    expect(screen.getByTestId("right-collapsed")).toHaveTextContent("true");
    expect(onLayoutPatch).not.toHaveBeenCalled();
  });

  it("keeps local sidebar fields dirty without blocking unrelated async layout fields", () => {
    const onLayoutPatch = vi.fn();
    const { rerender } = render(<SidebarLayoutHarness onLayoutPatch={onLayoutPatch} />);

    fireEvent.click(screen.getByTestId("left-toggle"));
    rerender(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 360 },
          rightSidebar: { collapsed: true, width: 420 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    expect(screen.getByTestId("left-collapsed")).toHaveTextContent("true");
    expect(screen.getByTestId("left-width")).toHaveTextContent("360");
    expect(screen.getByTestId("right-collapsed")).toHaveTextContent("true");
    expect(screen.getByTestId("right-width")).toHaveTextContent("420");
  });

  it("does not overwrite a locally resized sidebar width while syncing the other side", () => {
    const onLayoutPatch = vi.fn();
    const { rerender } = render(<SidebarLayoutHarness onLayoutPatch={onLayoutPatch} />);

    fireEvent.pointerDown(screen.getByTestId("left-resize"), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    fireEvent.pointerUp(window);
    rerender(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 280 },
          rightSidebar: { collapsed: true, width: 420 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    expect(screen.getByTestId("left-width")).toHaveTextContent("330");
    expect(screen.getByTestId("right-collapsed")).toHaveTextContent("true");
    expect(screen.getByTestId("right-width")).toHaveTextContent("420");
  });

  it("syncs the opposite sidebar width while a resize is active", () => {
    const onLayoutPatch = vi.fn();
    const { rerender } = render(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 280 },
          rightSidebar: { collapsed: false, width: 300 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    fireEvent.pointerDown(screen.getByTestId("left-resize"), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    rerender(
      <SidebarLayoutHarness
        initialLayout={sidebarLayout({
          leftSidebar: { collapsed: false, width: 280 },
          rightSidebar: { collapsed: false, width: 420 }
        })}
        onLayoutPatch={onLayoutPatch}
      />
    );

    expect(screen.getByTestId("left-width")).toHaveTextContent("330");
    expect(screen.getByTestId("right-width")).toHaveTextContent("420");
    expect(onLayoutPatch).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);
    expect(onLayoutPatch).toHaveBeenCalledWith({ leftSidebar: { width: 330 } });
  });

  it("removes pointer listeners and restores body styles when unmounted during resize", () => {
    const onLayoutPatch = vi.fn();
    const { unmount } = render(<SidebarLayoutHarness onLayoutPatch={onLayoutPatch} />);

    fireEvent.pointerDown(screen.getByTestId("left-resize"), { clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });

    unmount();
    fireEvent.pointerUp(window);

    expect(onLayoutPatch).not.toHaveBeenCalled();
    expect(window.document.body.style.cursor).toBe("");
    expect(window.document.body.style.userSelect).toBe("");
  });
});
