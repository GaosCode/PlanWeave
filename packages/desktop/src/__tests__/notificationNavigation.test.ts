import { describe, expect, it } from "vitest";
import { defaultDesktopSettings } from "../shared/desktopSettings";
import { createTranslator } from "../renderer/i18n";
import { buildNotificationItems } from "../renderer/notifications";
import { autoRunState } from "./helpers/autoRunControlHarness";

const baseInput = {
  fileSyncDiagnostics: [],
  graph: null,
  lastFileChange: null,
  navigationContext: null,
  pendingImportRecoveries: [],
  promptConflicts: [],
  settings: defaultDesktopSettings,
  t: createTranslator("en")
};

describe("notification navigation intents", () => {
  it("keeps latest-record authority as a lookup locator", () => {
    const state = autoRunState({
      projectRoot: "/projects/authority",
      canvasId: "canvas-authority",
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/authority/results/metadata.json"
    });

    const latest = buildNotificationItems({ ...baseInput, autoRunState: state }).find((item) =>
      item.id.startsWith("latest-record:")
    );

    expect(latest?.navigationIntent).toEqual({
      kind: "run-record-lookup",
      locator: {
        projectRoot: "/projects/authority",
        canvasId: "canvas-authority",
        recordId: "T-001#B-001::RUN-001"
      }
    });
  });

  it("does not create a latest-record intent for a root canvas", () => {
    const state = autoRunState({
      canvasId: null,
      latestRecordId: "T-001#B-001::RUN-001",
      latestRecordPath: "/projects/demo/results/metadata.json"
    });

    const latest = buildNotificationItems({ ...baseInput, autoRunState: state }).find((item) =>
      item.id.startsWith("latest-record:")
    );

    expect(latest?.navigationIntent).toBeUndefined();
  });
});
