/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollapsedSidebarControls, RightPaletteSidebar } from "../renderer/AppSidebars";
import { createTranslator } from "../renderer/i18n";
import { defaultDesktopSettings } from "../renderer/settings";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

const t = createTranslator("en");

describe("app sidebar separator ownership", () => {
  it("keeps the top horizontal borders but removes the collapsed right vertical edge", () => {
    render(
      <CollapsedSidebarControls
        leftSidebarCollapsed={true}
        rightSidebarCollapsed={true}
        setLeftSidebarCollapsed={vi.fn()}
        setRightSidebarCollapsed={vi.fn()}
        t={t}
      />
    );

    const [leftButton, rightButton] = screen.getAllByRole("button", {
      name: t("expandSidebar")
    });
    expect(leftButton?.closest(".app-drag-region")).toHaveClass(
      "border-b",
      "border-border/80",
      "window-titlebar-leading"
    );
    expect(rightButton?.closest(".app-drag-region")).toHaveClass("border-b", "border-border/80");
    expect(rightButton?.closest(".app-drag-region")).not.toHaveClass("border-l");
  });

  it("keeps the top horizontal border for the expanded right sidebar", () => {
    render(
      <RightPaletteSidebar
        addPaletteComponent={vi.fn().mockResolvedValue(undefined)}
        handlePaletteDragStart={vi.fn()}
        rightSidebarCollapsed={false}
        setRightSidebarCollapsed={vi.fn()}
        settings={defaultDesktopSettings}
        t={t}
      />
    );

    const button = screen.getByRole("button", { name: t("collapseSidebar") });
    expect(button.closest(".app-drag-region")).toHaveClass("border-b", "border-border/80");
  });
});
