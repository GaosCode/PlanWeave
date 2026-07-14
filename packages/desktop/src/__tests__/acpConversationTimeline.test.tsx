/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AcpConversationTimeline } from "../renderer/inspector/AcpConversationTimeline";
import { createTranslator } from "../renderer/i18n";
import { cleanupRendererTestEnvironment } from "./helpers/rendererTestEnvironment";

afterEach(cleanupRendererTestEnvironment);

describe("Block Inspector ACP conversation timeline", () => {
  it("keeps empty structured tool payloads visible", () => {
    render(
      <AcpConversationTimeline
        changeKey={2}
        timeline={[
          {
            sequence: 1,
            timestamp: "2026-07-13T00:00:00.000Z",
            kind: "tool",
            callId: "empty-structures",
            title: "Inspect empty structures",
            toolKind: "read",
            status: "completed",
            input: "{}",
            output: "[]"
          },
          {
            sequence: 2,
            timestamp: "2026-07-13T00:00:00.000Z",
            kind: "tool",
            callId: "empty-string",
            title: "Inspect empty string",
            toolKind: "read",
            status: "completed",
            input: "\"\"",
            output: null
          }
        ]}
        t={createTranslator("en")}
      />
    );

    const tool = screen.getByText("Inspect empty structures").closest("details");
    expect(tool).toHaveClass("ml-10", "rounded-lg", "border", "bg-background", "shadow-sm");
    expect(screen.getByText("{}")).toBeInTheDocument();
    expect(screen.getByText("[]")).toBeInTheDocument();
    expect(screen.getByText("Empty string")).toBeInTheDocument();
  });
});
