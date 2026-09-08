import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
import {
  captureStartSchema,
  captureTraceSchema,
  captureExportSchema,
  type CollaborationCaptureApi
} from "../shared/collaborationCapture.js";
import { collaborationCaptureChannels } from "../shared/collaborationCaptureIpc.js";

export function exposeCollaborationCapture(): void {
  const api: CollaborationCaptureApi = {
    start: async (input) => {
      await ipcRenderer.invoke(collaborationCaptureChannels.start, captureStartSchema.parse(input));
    },
    stop: async () =>
      captureTraceSchema
        .nullable()
        .parse(await ipcRenderer.invoke(collaborationCaptureChannels.stop)),
    export: async (input) =>
      z
        .boolean()
        .parse(
          await ipcRenderer.invoke(
            collaborationCaptureChannels.export,
            captureExportSchema.parse(input)
          )
        )
  };
  contextBridge.exposeInMainWorld("planweaveCollaborationCapture", api);
}
