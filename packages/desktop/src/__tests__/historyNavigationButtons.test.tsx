/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HistoryNavigationButtons } from "../renderer/components/HistoryNavigationButtons";
import { appViewHistoryChangedEvent } from "../renderer/hooks/useAppViewHistory";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("desktop renderer component interactions", () => {
  it("disables history navigation buttons when no app history is available", () => {
    window.history.replaceState(null, "", "/");

    render(
      <HistoryNavigationButtons
        t={(key) => ({ navigateBack: "Back", navigateForward: "Forward" })[key] ?? key}
      />
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Forward" })).toBeDisabled();
  });

  it("enables app history buttons after view navigation state changes", async () => {
    window.history.replaceState(
      { planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 0 },
      "",
      "/"
    );
    const backSpy = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const forwardSpy = vi.spyOn(window.history, "forward").mockImplementation(() => undefined);

    render(
      <HistoryNavigationButtons
        t={(key) => ({ navigateBack: "Back", navigateForward: "Forward" })[key] ?? key}
      />
    );

    window.history.pushState(
      { planweaveAppView: "statistics", planweaveHistoryIndex: 1, planweaveHistoryMaxIndex: 1 },
      ""
    );
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(backSpy).toHaveBeenCalledTimes(1);

    window.history.replaceState(
      { planweaveAppView: "graph", planweaveHistoryIndex: 0, planweaveHistoryMaxIndex: 1 },
      "",
      "/"
    );
    window.dispatchEvent(new Event(appViewHistoryChangedEvent));
    await userEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(forwardSpy).toHaveBeenCalledTimes(1);
  });
});
