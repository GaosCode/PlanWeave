import { z } from "zod";
import { opaqueIdentifierSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { collaborationServerOriginSchema } from "@planweave-ai/collaboration-protocol/connection";

/** Redacted identity of one verified Main client; never a credential or authorization grant. */
export const collaborationOperationScopeSchema = z
  .object({
    profileId: opaqueIdentifierSchema,
    projectId: opaqueIdentifierSchema,
    serverBaseUrl: collaborationServerOriginSchema,
    sessionId: z.string().uuid()
  })
  .strict();
export type CollaborationOperationScope = z.infer<typeof collaborationOperationScopeSchema>;
export const collaborationOperationInputSchema = z.object({
  operationScope: collaborationOperationScopeSchema
});
