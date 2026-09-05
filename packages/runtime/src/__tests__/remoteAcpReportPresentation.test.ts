import { describe, expect, it } from "vitest";
import { presentRemoteAcpReport } from "../autoRun/remoteAcpReportPresentation.js";
import type { AcpTimelineItem } from "../autoRun/acpConversationProjection.js";
const marker =
  "PLANWEAVE_FINAL_ARTIFACT " +
  JSON.stringify({
    version: "planweave.runner-artifact/v1",
    artifact: { kind: "implementation", ref: "T-1#B-1", taskId: "T-1", reportMarkdown: "Done." }
  });
const message = (content: string, role: "assistant" | "user" = "assistant"): AcpTimelineItem => ({
  sequence: 1,
  timestamp: "2030-01-01T00:00:00.000Z",
  kind: "message",
  role,
  content
});
describe("remote report presentation", () => {
  it("shows report prose and no fabricated artifact reference", () => {
    expect(presentRemoteAcpReport([message("Done.\n" + marker)])).toEqual([message("Done.")]);
    expect(presentRemoteAcpReport([message(marker)])).toEqual([message("Done.")]);
  });
  it("preserves malformed output and user text for diagnosis", () => {
    const invalid = [message("PLANWEAVE_FINAL_ARTIFACT {invalid}")];
    expect(presentRemoteAcpReport(invalid)).toBe(invalid);
    const user = [message(marker, "user")];
    expect(presentRemoteAcpReport(user)).toBe(user);
  });
});
