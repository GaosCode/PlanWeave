import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import {
  collaborationServerOriginSchema,
  refineCollaborationTransportPolicy
} from "@planweave-ai/collaboration-protocol/connection";
import {
  humanIdentityTokenSchema,
  humanPrincipalIdSchema
} from "@planweave-ai/collaboration-protocol/core/primitives";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import { z } from "zod";
import { WorkspaceExecutionCliError } from "./errors.js";

export const OWNER_OPERATOR_TOKEN_ENV = "PLANWEAVE_OPERATOR_TOKEN";
export const OWNER_HUMAN_IDENTITY_TOKEN_ENV = "PLANWEAVE_HUMAN_IDENTITY_TOKEN";
export const OWNER_HUMAN_PRINCIPAL_ID_ENV = "PLANWEAVE_HUMAN_PRINCIPAL_ID";

export type CliOwnerConnection = {
  profileId: string;
  serverOrigin: string;
};

export type CliOwnerCredentials = {
  operatorToken: string;
  humanIdentityToken: string;
  humanPrincipalId: string;
};

const cliOperatorProfileSchema = z
  .object({
    profileId: z.string().trim().min(1).max(128),
    displayName: z.string().trim().min(1).max(128),
    serverBaseUrl: collaborationServerOriginSchema,
    allowInsecureTransport: z.boolean().default(false)
  })
  .superRefine(refineCollaborationTransportPolicy);

type JsonDocument = { profiles?: unknown };

async function optionalJson(path: string): Promise<JsonDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("invalid document");
    return value as JsonDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new WorkspaceExecutionCliError("owner_connection_invalid", 3, false, { cause: error });
  }
}

function records(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class CliOwnerConnectionProvider {
  constructor(
    private readonly paths: { operatorProfiles: string } = {
      operatorProfiles: join(resolvePlanweaveHome(), "desktop", "operator-control", "profiles.json")
    }
  ) {}

  async list(): Promise<CliOwnerConnection[]> {
    const document = await optionalJson(this.paths.operatorProfiles);
    const result: CliOwnerConnection[] = [];
    for (const raw of records(document.profiles)) {
      const parsed = cliOperatorProfileSchema.safeParse(raw);
      if (!parsed.success) continue;
      result.push({
        profileId: parsed.data.profileId,
        serverOrigin: new URL(parsed.data.serverBaseUrl).origin
      });
    }
    return result.sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  async resolve(profileId?: string): Promise<CliOwnerConnection> {
    const candidates = await this.list();
    if (profileId) {
      const selected = candidates.find((candidate) => candidate.profileId === profileId);
      if (!selected) throw new WorkspaceExecutionCliError("owner_connection_required", 3);
      return selected;
    }
    if (candidates.length === 0) {
      throw new WorkspaceExecutionCliError("owner_connection_required", 3);
    }
    if (candidates.length !== 1) {
      throw new WorkspaceExecutionCliError("owner_connection_selection_required", 3);
    }
    return candidates[0]!;
  }
}

export class ProcessMemoryOwnerCredentialProvider {
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env) {}

  get(): CliOwnerCredentials {
    const operatorRaw = this.environment[OWNER_OPERATOR_TOKEN_ENV];
    const identityRaw = this.environment[OWNER_HUMAN_IDENTITY_TOKEN_ENV];
    const principalRaw = this.environment[OWNER_HUMAN_PRINCIPAL_ID_ENV];
    if (!operatorRaw || !identityRaw || !principalRaw) {
      throw new WorkspaceExecutionCliError("owner_identity_credential_required", 4);
    }
    const operatorToken = operatorTokenSchema.safeParse(operatorRaw);
    const humanIdentityToken = humanIdentityTokenSchema.safeParse(identityRaw);
    const humanPrincipalId = humanPrincipalIdSchema.safeParse(principalRaw);
    if (!operatorToken.success || !humanIdentityToken.success || !humanPrincipalId.success) {
      throw new WorkspaceExecutionCliError("owner_identity_credential_invalid", 4);
    }
    return {
      operatorToken: operatorToken.data,
      humanIdentityToken: humanIdentityToken.data,
      humanPrincipalId: humanPrincipalId.data
    };
  }
}
