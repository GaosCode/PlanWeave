import {
  agentHostIdSchema,
  humanPrincipalIdSchema,
  timestampSchema,
  workspaceIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { z } from "zod";
import type { SqliteDatabase } from "../sqlite.js";
import { remoteAgentAccessModeSchema, type RemoteAgentAccessMode } from "./schema.js";

export const hostRemoteAgentDefaultsSchema = z
  .object({
    hostId: agentHostIdSchema,
    ownerHumanPrincipalId: humanPrincipalIdSchema,
    accessMode: remoteAgentAccessModeSchema,
    createWorkspaceGrant: z.boolean(),
    grantWorkspaceId: workspaceIdSchema.nullable(),
    updatedAt: timestampSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.createWorkspaceGrant && value.grantWorkspaceId === null) {
      context.addIssue({
        code: "custom",
        message: "create_workspace_grant_requires_workspace",
        path: ["grantWorkspaceId"]
      });
    }
  });

export type HostRemoteAgentDefaults = z.infer<typeof hostRemoteAgentDefaultsSchema>;

function sqliteToggle(value: unknown): boolean {
  const flag = Number(value);
  if (flag !== 0 && flag !== 1) {
    throw new Error("host_remote_agent_defaults_invalid");
  }
  return flag === 1;
}

export function readHostRemoteAgentDefaults(
  database: SqliteDatabase,
  hostId: string
): HostRemoteAgentDefaults | undefined {
  const parsedHostId = agentHostIdSchema.parse(hostId);
  const row = database
    .prepare("SELECT * FROM agent_host_remote_agent_defaults WHERE host_id=?")
    .get(parsedHostId);
  if (!row) return undefined;
  if (row.owner_human_principal_id === null || row.access_mode === null) return undefined;
  return hostRemoteAgentDefaultsSchema.parse({
    hostId: row.host_id,
    ownerHumanPrincipalId: row.owner_human_principal_id,
    accessMode: row.access_mode,
    createWorkspaceGrant: sqliteToggle(row.create_workspace_grant),
    grantWorkspaceId: row.grant_workspace_id,
    updatedAt: row.updated_at
  });
}

export function writeHostRemoteAgentDefaults(
  database: SqliteDatabase,
  input: {
    hostId: string;
    ownerHumanPrincipalId: string;
    accessMode: RemoteAgentAccessMode;
    createWorkspaceGrant: boolean;
    grantWorkspaceId: string | null;
    updatedAt: string;
  }
): HostRemoteAgentDefaults {
  const parsed = hostRemoteAgentDefaultsSchema.parse(input);
  database
    .prepare(
      `INSERT INTO agent_host_remote_agent_defaults(
         host_id, owner_human_principal_id, access_mode, create_workspace_grant,
         grant_workspace_id, updated_at
       ) VALUES (?,?,?,?,?,?)
       ON CONFLICT(host_id) DO UPDATE SET
         owner_human_principal_id=excluded.owner_human_principal_id,
         access_mode=excluded.access_mode,
         create_workspace_grant=excluded.create_workspace_grant,
         grant_workspace_id=excluded.grant_workspace_id,
         updated_at=excluded.updated_at`
    )
    .run(
      parsed.hostId,
      parsed.ownerHumanPrincipalId,
      parsed.accessMode,
      parsed.createWorkspaceGrant ? 1 : 0,
      parsed.grantWorkspaceId,
      parsed.updatedAt
    );
  const stored = readHostRemoteAgentDefaults(database, parsed.hostId);
  if (!stored) throw new Error("host_remote_agent_defaults_invalid");
  return stored;
}

export function copyHostRemoteAgentDefaults(
  database: SqliteDatabase,
  input: { fromHostId: string; toHostId: string; updatedAt: string }
): HostRemoteAgentDefaults | undefined {
  const previous = readHostRemoteAgentDefaults(database, input.fromHostId);
  if (!previous) return undefined;
  return writeHostRemoteAgentDefaults(database, {
    hostId: input.toHostId,
    ownerHumanPrincipalId: previous.ownerHumanPrincipalId,
    accessMode: previous.accessMode,
    createWorkspaceGrant: previous.createWorkspaceGrant,
    grantWorkspaceId: previous.grantWorkspaceId,
    updatedAt: input.updatedAt
  });
}
