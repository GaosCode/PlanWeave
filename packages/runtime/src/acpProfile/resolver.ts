import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join } from "node:path";
import { registeredAgentDefinitions } from "../autoRun/agentRegistry.js";
import type { RunnerCapability } from "../autoRun/runnerContractSchemas.js";
import { agentProcessPath } from "../process/agentProcessEnv.js";
import { resolveWslExecutable, type WslExecutionOptions } from "../process/wslExecutionHost.js";
import type { ExecutionHost } from "../types/executor.js";
import type { PackageWorkspaceRef } from "../types/workspace.js";
import type { AcpProfileStore } from "./store.js";
import {
  acpAgentIdSchema,
  acpProfileCanonicalKey,
  acpProfileDescriptorSchema,
  DEFAULT_ACP_SHUTDOWN_POLICY,
  type AcpCapabilityPolicy,
  type AcpConnectionPolicy,
  type AcpEnvironmentRequirement,
  type AcpProfileDescriptor,
  type AcpSessionDefaults,
  type AcpShutdownPolicy
} from "./schema.js";

export type AcpProfileReference = {
  agentId: string;
  profileId?: string;
};

export type ResolvedAcpProfile = {
  readonly profileId: string;
  readonly agentId: string;
  readonly displayName: string;
  readonly host: ExecutionHost;
  readonly launch: { readonly command: string; readonly args: readonly string[] };
  readonly environment: readonly AcpEnvironmentRequirement[];
  readonly sessionDefaults?: AcpSessionDefaults;
  readonly shutdown: AcpShutdownPolicy;
  readonly capabilities: AcpCapabilityPolicy;
  readonly connection: AcpConnectionPolicy;
  readonly source: "builtin" | "local-user";
  readonly fingerprint: string;
};

export type AcpProfileResolutionContext = {
  projectRoot: PackageWorkspaceRef;
  host: ExecutionHost;
  requireCommandTrust?: boolean;
};

export interface AcpProfileResolver {
  resolve(
    reference: AcpProfileReference,
    context: AcpProfileResolutionContext
  ): Promise<ResolvedAcpProfile>;
}

export type AcpProfileResolutionErrorCode =
  | "profile_unavailable"
  | "profile_untrusted"
  | "profile_host_unavailable"
  | "profile_environment_missing"
  | "profile_changed"
  | "profile_identity_mismatch";

export class AcpProfileResolutionError extends Error {
  constructor(
    readonly code: AcpProfileResolutionErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "AcpProfileResolutionError";
  }
}

export interface AcpHostCommandResolver {
  resolve(command: string, host: ExecutionHost): Promise<string>;
}

export type AcpLocalProfileTrustVerifier = (input: {
  projectRoot: PackageWorkspaceRef;
  profile: AcpProfileDescriptor;
  resolvedCommand: string;
  fingerprint: string;
}) => Promise<boolean>;

const displayNames: Readonly<Record<string, string>> = {
  codex: "Codex",
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  pi: "Pi",
  grok: "Grok"
};

const builtinEnvironment: Readonly<Record<string, readonly AcpEnvironmentRequirement[]>> = {
  grok: [{ name: "XAI_API_KEY", required: false }]
};

function sameHost(left: ExecutionHost, right: ExecutionHost): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === "native" || (right.kind === "wsl" && left.distribution === right.distribution))
  );
}

function executableCandidates(command: string, environment: Readonly<NodeJS.ProcessEnv>): string[] {
  if (process.platform !== "win32") return [command];
  const extension = extname(command)
    ? [""]
    : (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";");
  return extension.map((value) => `${command}${value.toLowerCase()}`);
}

export class NativeAcpHostCommandResolver implements AcpHostCommandResolver {
  constructor(private readonly environment: Readonly<NodeJS.ProcessEnv> = process.env) {}

  async resolve(command: string, host: ExecutionHost): Promise<string> {
    if (host.kind !== "native") {
      throw new Error(
        `No WSL ACP command resolver is configured for distribution '${host.distribution}'.`
      );
    }
    if (!isAbsolute(command) && (command.includes("/") || command.includes("\\"))) {
      throw new Error("Native ACP commands must be absolute paths or executable names on PATH.");
    }
    const candidates = isAbsolute(command)
      ? [command]
      : agentProcessPath({ env: { ...this.environment } })
          .split(delimiter)
          .filter(Boolean)
          .flatMap((directory) => executableCandidates(join(directory, command), this.environment));
    for (const candidate of candidates) {
      try {
        await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        return await realpath(candidate);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["EACCES", "ENOENT", "ENOTDIR"].includes(String(error.code))
        ) {
          throw error;
        }
      }
    }
    throw new Error(`ACP command '${command}' is not executable on the native host.`);
  }
}

export class ExecutionHostAcpCommandResolver implements AcpHostCommandResolver {
  private readonly native: NativeAcpHostCommandResolver;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv> = process.env,
    private readonly wslOptions: WslExecutionOptions = {}
  ) {
    this.native = new NativeAcpHostCommandResolver(environment);
  }

  resolve(command: string, host: ExecutionHost): Promise<string> {
    return host.kind === "native"
      ? this.native.resolve(command, host)
      : resolveWslExecutable(command, host.distribution, this.wslOptions);
  }
}

function builtinDescriptors(host: ExecutionHost): readonly AcpProfileDescriptor[] {
  return registeredAgentDefinitions().flatMap((definition) => {
    if (!definition.acp.launch) return [];
    const profileId = Object.entries(definition.builtinProfiles).find(
      ([, profile]) => profile.runner.transport === "acp"
    )?.[0];
    if (!profileId) return [];
    return [
      acpProfileDescriptorSchema.parse({
        version: "planweave.acp-profile/v1",
        id: profileId,
        agentId: definition.agent,
        displayName: displayNames[definition.agent] ?? definition.agent,
        host,
        launch: {
          command: definition.acp.launch.command,
          args: definition.acp.launch.args
        },
        environment: builtinEnvironment[definition.agent] ?? [],
        shutdown: DEFAULT_ACP_SHUTDOWN_POLICY,
        capabilities: {
          required: definition.acp.capabilities,
          optional: definition.acp.optionalCapabilities
        },
        connection: { mode: "dedicated" }
      })
    ];
  });
}

export function builtinAcpProfileCatalog(host: ExecutionHost): readonly AcpProfileDescriptor[] {
  return builtinDescriptors(host);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fingerprint(profile: AcpProfileDescriptor, resolvedCommand: string): string {
  const environment = [...profile.environment].sort((left, right) =>
    compareCodeUnits(left.name, right.name)
  );
  const sessionDefaults = profile.sessionDefaults
    ? {
        modeId: profile.sessionDefaults.modeId,
        configOptions: Object.fromEntries(
          Object.entries(profile.sessionDefaults.configOptions).sort(([left], [right]) =>
            compareCodeUnits(left, right)
          )
        )
      }
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: profile.version,
        id: acpProfileCanonicalKey(profile.id),
        agentId: profile.agentId,
        host: profile.host,
        launch: { command: resolvedCommand, args: profile.launch.args },
        environment,
        sessionDefaults,
        shutdown: profile.shutdown,
        capabilities: {
          required: [...profile.capabilities.required].sort(compareCodeUnits),
          optional: [...profile.capabilities.optional].sort(compareCodeUnits)
        },
        connection: profile.connection
      })
    )
    .digest("hex");
}

function immutableResolvedProfile(input: {
  profile: AcpProfileDescriptor;
  resolvedCommand: string;
  source: ResolvedAcpProfile["source"];
  fingerprint: string;
}): ResolvedAcpProfile {
  const profile = input.profile;
  return Object.freeze({
    profileId: profile.id,
    agentId: profile.agentId,
    displayName: profile.displayName,
    host: Object.freeze({ ...profile.host }),
    launch: Object.freeze({
      command: input.resolvedCommand,
      args: Object.freeze([...profile.launch.args])
    }),
    environment: Object.freeze(profile.environment.map((entry) => Object.freeze({ ...entry }))),
    ...(profile.sessionDefaults
      ? {
          sessionDefaults: Object.freeze({
            modeId: profile.sessionDefaults.modeId,
            configOptions: Object.freeze({ ...profile.sessionDefaults.configOptions })
          })
        }
      : {}),
    shutdown: Object.freeze({ ...profile.shutdown }),
    capabilities: Object.freeze({
      required: Object.freeze([...profile.capabilities.required]) as readonly RunnerCapability[],
      optional: Object.freeze([...profile.capabilities.optional]) as readonly RunnerCapability[]
    }),
    connection: Object.freeze({ ...profile.connection }),
    source: input.source,
    fingerprint: input.fingerprint
  });
}

export class CatalogAcpProfileResolver implements AcpProfileResolver {
  constructor(
    private readonly store: Pick<AcpProfileStore, "read">,
    private readonly commandResolver: AcpHostCommandResolver = new ExecutionHostAcpCommandResolver(),
    private readonly verifyLocalTrust?: AcpLocalProfileTrustVerifier
  ) {}

  async resolve(
    reference: AcpProfileReference,
    context: AcpProfileResolutionContext
  ): Promise<ResolvedAcpProfile> {
    return this.resolveInternal(reference, context, true);
  }

  inspect(
    reference: AcpProfileReference,
    context: AcpProfileResolutionContext
  ): Promise<ResolvedAcpProfile> {
    return this.resolveInternal(reference, context, false);
  }

  private async resolveInternal(
    reference: AcpProfileReference,
    context: AcpProfileResolutionContext,
    requireTrust: boolean
  ): Promise<ResolvedAcpProfile> {
    const agentId = acpAgentIdSchema.parse(reference.agentId);
    const profileId = reference.profileId ? acpProfileCanonicalKey(reference.profileId) : undefined;
    const builtins = builtinDescriptors(context.host);
    const catalog = await this.store.read();
    const builtin = profileId
      ? builtins.find((profile) => acpProfileCanonicalKey(profile.id) === profileId)
      : builtins.find((profile) => profile.agentId === agentId);
    const local = profileId
      ? catalog.profiles.find((profile) => acpProfileCanonicalKey(profile.id) === profileId)
      : undefined;

    if (builtin && local) {
      throw new AcpProfileResolutionError(
        "profile_identity_mismatch",
        `ACP profile id '${profileId}' conflicts with a built-in profile.`
      );
    }
    const profile = local ?? builtin;
    if (!profile) {
      throw new AcpProfileResolutionError(
        "profile_unavailable",
        profileId
          ? `ACP profile '${profileId}' is not registered.`
          : `No built-in ACP profile is registered for agent '${agentId}'.`
      );
    }
    if (profile.agentId !== agentId) {
      throw new AcpProfileResolutionError(
        "profile_identity_mismatch",
        `ACP profile '${profile.id}' belongs to agent '${profile.agentId}', not '${agentId}'.`
      );
    }
    if (!sameHost(profile.host, context.host)) {
      throw new AcpProfileResolutionError(
        "profile_host_unavailable",
        `ACP profile '${profile.id}' does not match the requested execution host.`
      );
    }

    let resolvedCommand: string;
    try {
      resolvedCommand = await this.commandResolver.resolve(profile.launch.command, context.host);
    } catch (error) {
      throw new AcpProfileResolutionError(
        "profile_host_unavailable",
        `ACP profile '${profile.id}' command is unavailable on the requested execution host.`,
        { cause: error }
      );
    }
    if (!isAbsolute(resolvedCommand)) {
      throw new AcpProfileResolutionError(
        "profile_host_unavailable",
        "ACP host command resolver must return an absolute command path."
      );
    }
    const profileFingerprint = fingerprint(profile, resolvedCommand);
    const source = local ? "local-user" : "builtin";
    if ((local || context.requireCommandTrust) && requireTrust) {
      if (!this.verifyLocalTrust) {
        throw new AcpProfileResolutionError(
          "profile_untrusted",
          `ACP profile '${profile.id}' has no project trust verifier.`
        );
      }
      if (
        !(await this.verifyLocalTrust({
          projectRoot: context.projectRoot,
          profile,
          resolvedCommand,
          fingerprint: profileFingerprint
        }))
      ) {
        throw new AcpProfileResolutionError(
          "profile_untrusted",
          `ACP profile '${profile.id}' is not trusted for this project.`
        );
      }
    }
    return immutableResolvedProfile({
      profile,
      resolvedCommand,
      source,
      fingerprint: profileFingerprint
    });
  }
}
