import { z } from "zod";
import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  completedContentVersionRefSchema,
  contentVersionRevisionSchema
} from "@planweave-ai/collaboration-protocol/content/version";

export const workspaceForkLineageSchemaVersion = "workspace-fork-lineage/v1" as const;

/**
 * Read-only source identity for a downloaded local fork. It never authorizes
 * writeback, session submit, or content publish to the originating Workspace.
 */
export const workspaceForkLineageSchema = z
  .object({
    schemaVersion: z.literal(workspaceForkLineageSchemaVersion),
    writeback: z.literal(false),
    source: z
      .object({
        scope: canvasScopeRefSchema,
        revision: contentVersionRevisionSchema,
        content: completedContentVersionRefSchema
      })
      .strict()
  })
  .strict();
export type WorkspaceForkLineage = z.infer<typeof workspaceForkLineageSchema>;

export const workspaceForkLineageFileName = "workspace-fork-lineage.json";

export function workspaceForkLineagePath(
  projectRoot: string,
  joinPath: (...parts: string[]) => string
) {
  return joinPath(projectRoot, workspaceForkLineageFileName);
}

export const managedContentImportModeSchema = z.enum(["replica", "fork"]);
export type ManagedContentImportMode = z.infer<typeof managedContentImportModeSchema>;
