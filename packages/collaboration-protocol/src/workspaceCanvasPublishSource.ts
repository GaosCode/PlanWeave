import { z } from "zod";
import { opaqueIdentifierSchema } from "./primitives.js";

/** Local canvas identity that requested a Workspace publish. */
export const workspaceCanvasPublishLocalSourceSchema = z
  .object({
    localProjectId: opaqueIdentifierSchema,
    localCanvasId: opaqueIdentifierSchema
  })
  .strict();
export type WorkspaceCanvasPublishLocalSource = z.infer<
  typeof workspaceCanvasPublishLocalSourceSchema
>;
