import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  collaborationConnectionProfileSchema,
  workspaceConnectionProfileSchema
} from "@planweave-ai/collaboration-protocol/connection";
import { humanDeviceTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import { WorkspaceExecutionCliError } from "./errors.js";

export const WORKSPACE_EXECUTION_CREDENTIAL_ENV = "PLANWEAVE_COLLABORATION_DEVICE_TOKEN";

export type CliWorkspaceConnection = {
  profileId: string;
  serverOrigin: string;
  workspaceId: string;
  projectId: string;
};

type JsonDocument = { profiles?: unknown; activeProfileId?: unknown };

async function optionalJson(path: string): Promise<JsonDocument> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof value !== "object" || value === null) throw new Error("invalid document");
    return value as JsonDocument;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new WorkspaceExecutionCliError("workspace_connection_invalid", 3, false, {
      cause: error
    });
  }
}

function records(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class CliWorkspaceConnectionProvider {
  constructor(
    private readonly paths: {
      collaborationProfiles: string;
      workspaceProfiles: string;
    } = (() => {
      const directory = join(resolvePlanweaveHome(), "desktop", "collaboration");
      return {
        collaborationProfiles: join(directory, "profiles.json"),
        workspaceProfiles: join(directory, "workspace-profiles.json")
      };
    })()
  ) {}

  async list(): Promise<CliWorkspaceConnection[]> {
    const [collaboration, workspaces] = await Promise.all([
      optionalJson(this.paths.collaborationProfiles),
      optionalJson(this.paths.workspaceProfiles)
    ]);
    const projects = new Map<
      string,
      ReturnType<typeof collaborationConnectionProfileSchema.parse>
    >();
    for (const raw of records(collaboration.profiles)) {
      if (typeof raw !== "object" || raw === null || !("connectionState" in raw)) continue;
      if ((raw as { connectionState?: unknown }).connectionState !== "ready") continue;
      const record = raw as Record<string, unknown>;
      const parsed = collaborationConnectionProfileSchema.safeParse({
        profileId: record.profileId,
        displayName: record.displayName,
        serverBaseUrl: record.serverBaseUrl,
        projectId: record.projectId,
        allowInsecureTransport: record.allowInsecureTransport,
        endpoint: record.endpoint
      });
      if (parsed.success) projects.set(parsed.data.profileId, parsed.data);
    }
    const result: CliWorkspaceConnection[] = [];
    for (const raw of records(workspaces.profiles)) {
      if (typeof raw !== "object" || raw === null) continue;
      if ((raw as { membershipActive?: unknown }).membershipActive !== true) continue;
      const record = raw as Record<string, unknown>;
      const parsed = workspaceConnectionProfileSchema.safeParse({
        schemaVersion: record.schemaVersion,
        profileId: record.profileId,
        displayName: record.displayName,
        serverBaseUrl: record.serverBaseUrl,
        workspaceId: record.workspaceId,
        allowInsecureTransport: record.allowInsecureTransport
      });
      if (!parsed.success) continue;
      const project = projects.get(parsed.data.profileId);
      if (!project) continue;
      if (new URL(project.serverBaseUrl).origin !== new URL(parsed.data.serverBaseUrl).origin) {
        throw new WorkspaceExecutionCliError("workspace_connection_invalid", 3);
      }
      result.push({
        profileId: project.profileId,
        serverOrigin: new URL(project.serverBaseUrl).origin,
        workspaceId: parsed.data.workspaceId,
        projectId: project.projectId
      });
    }
    return result.sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  async resolve(profileId?: string): Promise<CliWorkspaceConnection> {
    const candidates = await this.list();
    if (profileId) {
      const selected = candidates.find((candidate) => candidate.profileId === profileId);
      if (!selected) throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
      return selected;
    }
    if (candidates.length === 0) {
      throw new WorkspaceExecutionCliError("workspace_connection_required", 3);
    }
    if (candidates.length !== 1) {
      throw new WorkspaceExecutionCliError("workspace_connection_selection_required", 3);
    }
    return candidates[0]!;
  }
}

export class ProcessMemoryWorkspaceCredentialProvider {
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env) {}

  get(): string {
    const raw = this.environment[WORKSPACE_EXECUTION_CREDENTIAL_ENV];
    if (!raw) throw new WorkspaceExecutionCliError("workspace_credential_required", 4);
    const parsed = humanDeviceTokenSchema.safeParse(raw);
    if (!parsed.success) throw new WorkspaceExecutionCliError("workspace_credential_invalid", 4);
    return parsed.data;
  }
}
