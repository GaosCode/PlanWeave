import { app, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { transportCapture } from "./collaborationCaptureRecorder.js";
import { captureExportSchema, captureStartSchema } from "../../shared/collaborationCapture.js";
import { collaborationCaptureChannels } from "../../shared/collaborationCaptureIpc.js";
import { summarizeCapture } from "../../shared/collaborationCaptureSummary.js";

export function registerCollaborationCaptureHandlers(): void {
  ipcMain.handle(collaborationCaptureChannels.start, (_event, input: unknown) => {
    const { captureId, scopeKey } = captureStartSchema.parse(input);
    transportCapture.start(captureId, scopeKey);
  });
  ipcMain.handle(collaborationCaptureChannels.stop, () => {
    transportCapture.stop();
    return transportCapture.snapshot();
  });
  ipcMain.handle(collaborationCaptureChannels.export, async (_event, input: unknown) => {
    const capture = captureExportSchema.parse(input);
    if (capture.renderer.stopReason === "running" || capture.transport.stopReason === "running") {
      throw new Error("capture_not_finished");
    }
    const choice = await dialog.showSaveDialog({
      defaultPath: `planweave-capture-${capture.renderer.captureId}-${process.platform}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }]
    });
    if (choice.canceled || !choice.filePath) return false;
    await writeFile(
      choice.filePath,
      JSON.stringify(
        {
          schemaVersion: "planweave.collaboration.capture/v1",
          environment: {
            platform: process.platform,
            arch: process.arch,
            appVersion: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome
          },
          interpretation: {
            clock:
              "Each trace uses its own monotonic clock. Do not subtract timestamps across traces or devices.",
            cadence:
              "Intervals include pauses in input. Group receive events by peer; gaps alone are not network latency or packet loss.",
            commit:
              "Receive-to-React-commit duration is not screen presentation latency. Frames are requestAnimationFrame intervals, not GPU frames.",
            scope:
              "Transport scopeTag hashes Server origin, project and canvas. Peer numbers are local to each trace.",
            privacy:
              "No cursor coordinates, task text, names, URLs, or credentials are recorded. Export is local only."
          },
          summary: {
            renderer: summarizeCapture(capture.renderer),
            transport: summarizeCapture(capture.transport)
          },
          ...capture
        },
        null,
        2
      ),
      "utf8"
    );
    return true;
  });
}
