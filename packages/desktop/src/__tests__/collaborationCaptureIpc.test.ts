import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  save: vi.fn(),
  write: vi.fn()
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "test" },
  dialog: { showSaveDialog: mocks.save },
  ipcMain: {
    handle: (name: string, fn: (event: unknown, input: unknown) => unknown) =>
      mocks.handlers.set(name, fn)
  }
}));
vi.mock("node:fs/promises", () => ({ writeFile: mocks.write }));
import { registerCollaborationCaptureHandlers } from "../main/collaboration/collaborationCapture.js";
import { transportCapture } from "../main/collaboration/collaborationCaptureRecorder.js";
import { collaborationCaptureChannels as channels } from "../shared/collaborationCaptureIpc.js";
import type { CaptureExport } from "../shared/collaborationCapture.js";

afterEach(() => {
  transportCapture.stop();
  transportCapture.bind(null);
  vi.clearAllMocks();
});

describe("collaboration capture IPC", () => {
  function setup(): CaptureExport {
    registerCollaborationCaptureHandlers();
    transportCapture.bind("scope", "b".repeat(64));
    mocks.handlers.get(channels.start)!({}, { captureId: "two-devices", scopeKey: "scope" });
    transportCapture.record("socket_send", { pointer: true });
    mocks.handlers.get(channels.stop)!({}, undefined);
    const trace = transportCapture.snapshot()!;
    return { renderer: trace, transport: trace, longTaskSupported: false };
  }
  it("exports only validated traces after an explicit save and surfaces disk errors", async () => {
    const capture = setup();
    mocks.save.mockResolvedValue({ canceled: false, filePath: "/test/capture.json" });
    mocks.write.mockResolvedValue(undefined);
    expect(await mocks.handlers.get(channels.export)!({}, capture)).toBe(true);
    const report = JSON.parse(mocks.write.mock.calls[0][1]);
    expect(report.schemaVersion).toBe("planweave.collaboration.capture/v2");
    expect(report.summary.transport[0].count).toBe(1);
    mocks.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(mocks.handlers.get(channels.export)!({}, capture)).rejects.toThrow("disk full");
  });
  it("does not write on cancel or accept injected secret fields and mismatched runs", async () => {
    const capture = setup();
    mocks.save.mockResolvedValue({ canceled: true });
    expect(await mocks.handlers.get(channels.export)!({}, capture)).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
    await expect(
      mocks.handlers.get(channels.export)!({}, { ...capture, token: "private" })
    ).rejects.toThrow();
    await expect(
      mocks.handlers.get(channels.export)!(
        {},
        { ...capture, transport: { ...capture.transport, captureId: "other" } }
      )
    ).rejects.toThrow();
  });
});
