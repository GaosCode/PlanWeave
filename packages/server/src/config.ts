import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import {
  OUTPUT_MAX_ARTIFACT_BYTES,
  opaqueIdentifierSchema
} from "@planweave-ai/agent-host-protocol";
import { deploymentEndpointSchema } from "@planweave-ai/collaboration-protocol/deployment";
import {
  collaborationServerOriginSchema,
  isLoopbackHostname
} from "@planweave-ai/collaboration-protocol/connection";
import {
  RUNNER_EVENT_RETENTION_MAX_BYTES,
  RUNNER_EVENT_RETENTION_MAX_EVENTS
} from "@planweave-ai/runtime";
import { z } from "zod";
import { operatorCredentialSchema } from "./operatorAuth.js";
import { trustedRuntimeProjectSchema } from "./runtimeProjectRegistry.js";
import { isPrivateNetworkAddress } from "./insecureTransport.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const DEFAULT_OPERATOR_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MIN_OPERATOR_SESSION_TTL_MS = 60 * 60 * 1_000;
const MAX_OPERATOR_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1_000;
const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute, "Path must be absolute.");
const bindHostSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => isIP(value) !== 0, {
    message: "Bind host must be an IPv4 or IPv6 literal."
  });
const serverConfigV1TopologySchema = z.enum(
  ["loopback_http", "loopback_https", "lan_https", "public_https"],
  { error: "server_config_v1_deployment_topology_invalid" }
);
const serverConfigV1TlsTrustSchema = z.enum(["not_applicable", "system_ca", "configured_ca"]);
const serverConfigV1AllowedClientOriginsSchema = z
  .array(collaborationServerOriginSchema)
  .min(1)
  .max(32)
  .superRefine((origins, context) => {
    if (new Set(origins).size !== origins.length) {
      context.addIssue({ code: "custom", message: "duplicate_allowed_client_origin" });
    }
  });

const serverConfigV1DeploymentEndpointSchema = z
  .object({
    topology: serverConfigV1TopologySchema,
    serverOrigin: collaborationServerOriginSchema,
    allowedClientOrigins: serverConfigV1AllowedClientOriginsSchema,
    tlsTrust: serverConfigV1TlsTrustSchema
  })
  .strict()
  .superRefine((value, context) => {
    const url = new URL(value.serverOrigin);
    const loopback = isLoopbackHostname(url.hostname);
    if (value.topology === "loopback_http") {
      if (
        url.protocol !== "http:" ||
        !loopback ||
        value.tlsTrust !== "not_applicable" ||
        value.allowedClientOrigins.some((origin) => {
          const client = new URL(origin);
          return client.protocol !== "http:" || !isLoopbackHostname(client.hostname);
        })
      ) {
        context.addIssue({
          code: "custom",
          message: "loopback_http_requires_loopback_http_origins_without_tls",
          path: ["serverOrigin"]
        });
      }
      return;
    }
    if (value.topology === "loopback_https") {
      if (
        url.protocol !== "https:" ||
        !loopback ||
        value.tlsTrust === "not_applicable" ||
        value.allowedClientOrigins.some((origin) => {
          const client = new URL(origin);
          return client.protocol !== "https:" || !isLoopbackHostname(client.hostname);
        })
      ) {
        context.addIssue({
          code: "custom",
          message: "loopback_https_requires_trusted_loopback_https_origins",
          path: ["serverOrigin"]
        });
      }
      return;
    }
    if (
      url.protocol !== "https:" ||
      loopback ||
      value.tlsTrust === "not_applicable" ||
      value.allowedClientOrigins.some((origin) => {
        const client = new URL(origin);
        return client.protocol !== "https:" || isLoopbackHostname(client.hostname);
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "network_topology_requires_trusted_non_loopback_https_origins",
        path: ["serverOrigin"]
      });
    }
    if (value.topology === "public_https" && Number(url.port || "443") !== 443) {
      context.addIssue({
        code: "custom",
        message: "public_https_requires_direct_tls_port_443",
        path: ["serverOrigin"]
      });
    }
  });

const serverLimitsSchema = z
  .object({
    busyTimeoutMs: z.number().int().min(1).max(60_000).default(5_000),
    // Lease must comfortably outlive heartbeat jitter, Tailscale blips, and Host busy periods.
    // Soft-dropped late host events still require enough headroom to finish terminal reports.
    leaseDurationMs: z.number().int().min(1_000).max(86_400_000).default(120_000),
    canvasRuntimeAvailabilityTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    canvasRuntimeFactsTimeoutMs: z.number().int().min(1_000).max(120_000).default(15_000),
    hostOfflineAfterMs: z.number().int().min(1_000).max(86_400_000).default(240_000),
    heartbeatIntervalMs: z.number().int().min(1_000).max(3_600_000).default(15_000),
    maxArtifactBytes: z
      .number()
      .int()
      .positive()
      .max(OUTPUT_MAX_ARTIFACT_BYTES)
      .default(OUTPUT_MAX_ARTIFACT_BYTES),
    maxWebSocketPayloadBytes: z
      .number()
      .int()
      .min(1_024)
      .max(16 * 1024 * 1024)
      .default(256 * 1024),
    eventRetentionMaxEvents: z
      .number()
      .int()
      .positive()
      .max(RUNNER_EVENT_RETENTION_MAX_EVENTS)
      .default(RUNNER_EVENT_RETENTION_MAX_EVENTS),
    eventRetentionMaxBytes: z
      .number()
      .int()
      .positive()
      .max(RUNNER_EVENT_RETENTION_MAX_BYTES)
      .default(RUNNER_EVENT_RETENTION_MAX_BYTES),
    shutdownTimeoutMs: z.number().int().min(100).max(60_000).default(5_000)
  })
  .strict();

const serverConfigV1InputSchema = z
  .object({
    version: z.literal("server-config/v1"),
    bind: z
      .object({
        host: bindHostSchema.default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(7_443)
      })
      .strict()
      .default({ host: "127.0.0.1", port: 7_443 }),
    publicUrl: z.url(),
    /** Required for network deployments; keeps browser origins explicitly bounded. */
    deployment: serverConfigV1DeploymentEndpointSchema.optional(),
    tls: z
      .object({ certificatePath: absolutePathSchema, privateKeyPath: absolutePathSchema })
      .strict()
      .optional(),
    allowInsecureDevelopment: z.boolean().default(false),
    allowInsecureLan: z.boolean().default(false),
    dataDirectory: absolutePathSchema,
    trustedProjects: z.array(trustedRuntimeProjectSchema).max(256),
    operatorCredentials: z.array(operatorCredentialSchema).min(1).max(1_024),
    operatorSessionTtlMs: z
      .number()
      .int()
      .min(MIN_OPERATOR_SESSION_TTL_MS)
      .max(MAX_OPERATOR_SESSION_TTL_MS)
      .default(DEFAULT_OPERATOR_SESSION_TTL_MS),
    limits: serverLimitsSchema.default({
      busyTimeoutMs: 5_000,
      leaseDurationMs: 120_000,
      canvasRuntimeAvailabilityTimeoutMs: 15_000,
      canvasRuntimeFactsTimeoutMs: 15_000,
      hostOfflineAfterMs: 240_000,
      heartbeatIntervalMs: 15_000,
      maxArtifactBytes: OUTPUT_MAX_ARTIFACT_BYTES,
      maxWebSocketPayloadBytes: 256 * 1024,
      eventRetentionMaxEvents: RUNNER_EVENT_RETENTION_MAX_EVENTS,
      eventRetentionMaxBytes: RUNNER_EVENT_RETENTION_MAX_BYTES,
      shutdownTimeoutMs: 5_000
    })
  })
  .strict();

const serverConfigV1Schema = serverConfigV1InputSchema
  .extend({ databasePath: absolutePathSchema })
  .strict()
  .superRefine((config, context) => {
    const publicUrl = new URL(config.publicUrl);
    if (
      publicUrl.username ||
      publicUrl.password ||
      publicUrl.pathname !== "/" ||
      publicUrl.search ||
      publicUrl.hash
    ) {
      context.addIssue({ code: "custom", message: "server_public_url_must_be_origin" });
    }
    if (config.allowInsecureLan) {
      if (
        !config.allowInsecureDevelopment ||
        config.bind.host !== "0.0.0.0" ||
        publicUrl.protocol !== "http:" ||
        !isPrivateNetworkAddress(publicUrl.hostname) ||
        config.tls ||
        config.deployment
      ) {
        context.addIssue({
          code: "custom",
          message: "server_insecure_lan_requires_private_http"
        });
      }
    } else if (config.allowInsecureDevelopment) {
      if (
        !["127.0.0.1", "::1"].includes(config.bind.host) ||
        publicUrl.protocol !== "http:" ||
        !literalLoopback(publicUrl.hostname) ||
        config.tls
      ) {
        context.addIssue({
          code: "custom",
          message: "server_insecure_development_requires_literal_loopback"
        });
      }
      if (
        config.deployment &&
        (config.deployment.topology !== "loopback_http" ||
          new URL(config.deployment.serverOrigin).origin !== publicUrl.origin)
      ) {
        context.addIssue({
          code: "custom",
          message: "server_loopback_deployment_mismatch",
          path: ["deployment"]
        });
      }
    } else {
      if (publicUrl.protocol !== "https:" || !config.tls) {
        context.addIssue({ code: "custom", message: "server_tls_configuration_required" });
      }
      if (!config.deployment) {
        context.addIssue({
          code: "custom",
          message: "server_deployment_configuration_required",
          path: ["deployment"]
        });
      } else if (
        config.deployment.topology === "loopback_http" ||
        new URL(config.deployment.serverOrigin).origin !== publicUrl.origin
      ) {
        context.addIssue({
          code: "custom",
          message: "server_deployment_endpoint_mismatch",
          path: ["deployment"]
        });
      }
      const publicPort = Number(publicUrl.port || "443");
      if (publicPort !== config.bind.port) {
        context.addIssue({ code: "custom", message: "server_public_url_port_mismatch" });
      }
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.hostOfflineAfterMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_offline" });
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.leaseDurationMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_lease" });
    }
    const exactScopes = new Set(
      config.trustedProjects.map(
        (project) =>
          `${project.workspaceId}\0${project.projectId}\0${project.trustAllDeclaredCanvases ? "*" : project.canvasId}`
      )
    );
    if (exactScopes.size !== config.trustedProjects.length) {
      context.addIssue({ code: "custom", message: "server_trusted_project_duplicate" });
    }
    const projectModes = new Map<string, Set<"all" | "exact">>();
    for (const project of config.trustedProjects) {
      const projectKey = `${project.workspaceId}\0${project.projectId}`;
      const modes = projectModes.get(projectKey) ?? new Set<"all" | "exact">();
      modes.add(project.trustAllDeclaredCanvases ? "all" : "exact");
      projectModes.set(projectKey, modes);
    }
    if ([...projectModes.values()].some((modes) => modes.size > 1)) {
      context.addIssue({ code: "custom", message: "server_trusted_project_scope_overlap" });
    }
    if (config.databasePath !== join(config.dataDirectory, "planweave-server.sqlite")) {
      context.addIssue({ code: "custom", message: "server_database_path_mismatch" });
    }
  });

function literalLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]";
}

const listenerPortSchema = z.number().int().min(1).max(65_535);
const httpListenerSchema = z
  .object({ protocol: z.literal("http"), host: bindHostSchema, port: listenerPortSchema })
  .strict();
const directHttpsListenerSchema = z
  .object({
    protocol: z.literal("https"),
    host: bindHostSchema,
    port: listenerPortSchema,
    tls: z
      .object({ certificatePath: absolutePathSchema, privateKeyPath: absolutePathSchema })
      .strict()
  })
  .strict();

const loopbackHttpTransportSchema = z
  .object({
    mode: z.literal("loopback_http"),
    listener: httpListenerSchema,
    advertisedOrigin: collaborationServerOriginSchema
  })
  .strict();
const lanHttpTransportSchema = z
  .object({
    mode: z.literal("lan_http"),
    listener: httpListenerSchema,
    advertisedOrigin: collaborationServerOriginSchema,
    acknowledgeInsecureLan: z.literal(true)
  })
  .strict();
const reverseProxyHttpsTransportSchema = z
  .object({
    mode: z.literal("reverse_proxy_https"),
    listener: httpListenerSchema,
    advertisedOrigin: collaborationServerOriginSchema
  })
  .strict();
const directHttpsTransportSchema = z
  .object({
    mode: z.literal("direct_https"),
    listener: directHttpsListenerSchema,
    advertisedOrigin: collaborationServerOriginSchema
  })
  .strict();

export const serverTransportSchema = z.discriminatedUnion("mode", [
  loopbackHttpTransportSchema,
  lanHttpTransportSchema,
  reverseProxyHttpsTransportSchema,
  directHttpsTransportSchema
]);
export type ServerTransport = z.infer<typeof serverTransportSchema>;

const serverConfigCommonInputSchema = serverConfigV1InputSchema.omit({
  version: true,
  bind: true,
  publicUrl: true,
  deployment: true,
  tls: true,
  allowInsecureDevelopment: true,
  allowInsecureLan: true
});

const serverConfigV2InputSchema = serverConfigCommonInputSchema
  .extend({
    version: z.literal("server-config/v2"),
    transport: serverTransportSchema,
    deployment: deploymentEndpointSchema.nullable(),
    allowedClientOrigins: z.array(collaborationServerOriginSchema).min(1).max(32).nullable()
  })
  .strict();

function originPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function validateNormalizedTransport(
  config: z.infer<typeof serverConfigV2InputSchema>,
  context: z.RefinementCtx
): void {
  const advertised = new URL(config.transport.advertisedOrigin);
  if (
    advertised.username ||
    advertised.password ||
    advertised.pathname !== "/" ||
    advertised.search ||
    advertised.hash
  ) {
    context.addIssue({ code: "custom", message: "server_advertised_origin_must_be_origin" });
    return;
  }
  const { transport, deployment } = config;
  if (transport.mode === "loopback_http") {
    if (
      !["127.0.0.1", "::1"].includes(transport.listener.host) ||
      advertised.protocol !== "http:" ||
      !literalLoopback(advertised.hostname) ||
      originPort(advertised) !== transport.listener.port
    ) {
      context.addIssue({ code: "custom", message: "server_loopback_http_transport_invalid" });
    }
    if (
      !deployment ||
      deployment.topology !== "loopback_http" ||
      new URL(deployment.serverOrigin).origin !== advertised.origin
    ) {
      context.addIssue({ code: "custom", message: "server_loopback_deployment_mismatch" });
    }
    return;
  }
  if (transport.mode === "lan_http") {
    if (
      transport.listener.host !== "0.0.0.0" ||
      advertised.protocol !== "http:" ||
      !isPrivateNetworkAddress(advertised.hostname) ||
      literalLoopback(advertised.hostname) ||
      originPort(advertised) !== transport.listener.port ||
      deployment !== null
    ) {
      context.addIssue({ code: "custom", message: "server_insecure_lan_requires_private_http" });
    }
    return;
  }
  if (transport.mode === "reverse_proxy_https") {
    if (
      transport.listener.host !== "127.0.0.1" ||
      advertised.protocol !== "https:" ||
      !deployment ||
      !new Set<string>(["private_https", "public_https"]).has(deployment.topology) ||
      new URL(deployment.serverOrigin).origin !== advertised.origin
    ) {
      context.addIssue({ code: "custom", message: "server_reverse_proxy_https_transport_invalid" });
    }
    return;
  }
  if (
    advertised.protocol !== "https:" ||
    originPort(advertised) !== transport.listener.port ||
    !deployment ||
    !new Set<string>(["loopback_https", "private_https", "public_https"]).has(
      deployment.topology
    ) ||
    new URL(deployment.serverOrigin).origin !== advertised.origin
  ) {
    context.addIssue({ code: "custom", message: "server_direct_https_transport_invalid" });
  }
}

const normalizedServerConfigBaseSchema = serverConfigV2InputSchema
  .extend({
    databasePath: absolutePathSchema,
    insecurePolicy: z
      .object({
        allowInsecureTransport: z.boolean(),
        allowInsecureLan: z.boolean()
      })
      .strict()
  })
  .strict();

export const serverConfigSchema = normalizedServerConfigBaseSchema.superRefine(
  (config, context) => {
    validateNormalizedTransport(config, context);
    const expectedAllowedOrigins = config.deployment?.allowedClientOrigins;
    const mismatchedDeploymentOrigins =
      expectedAllowedOrigins !== undefined &&
      config.allowedClientOrigins !== null &&
      (config.allowedClientOrigins.length !== expectedAllowedOrigins.length ||
        config.allowedClientOrigins.some(
          (origin, index) => origin !== expectedAllowedOrigins[index]
        ));
    const invalidNullOrigins =
      expectedAllowedOrigins !== undefined &&
      config.allowedClientOrigins === null &&
      config.transport.mode !== "loopback_http";
    const invalidUnboundedOrigins =
      expectedAllowedOrigins === undefined &&
      config.allowedClientOrigins !== null &&
      (config.allowedClientOrigins.length !== 1 ||
        config.allowedClientOrigins[0] !== config.transport.advertisedOrigin);
    if (mismatchedDeploymentOrigins || invalidNullOrigins || invalidUnboundedOrigins) {
      context.addIssue({ code: "custom", message: "server_allowed_client_origins_mismatch" });
    }
    const expectedPolicy = {
      allowInsecureTransport:
        config.transport.mode === "loopback_http" || config.transport.mode === "lan_http",
      allowInsecureLan: config.transport.mode === "lan_http"
    };
    if (
      config.insecurePolicy.allowInsecureTransport !== expectedPolicy.allowInsecureTransport ||
      config.insecurePolicy.allowInsecureLan !== expectedPolicy.allowInsecureLan
    ) {
      context.addIssue({ code: "custom", message: "server_insecure_policy_mismatch" });
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.hostOfflineAfterMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_offline" });
    }
    if (config.limits.heartbeatIntervalMs >= config.limits.leaseDurationMs) {
      context.addIssue({ code: "custom", message: "server_heartbeat_must_precede_lease" });
    }
    const exactScopes = new Set(
      config.trustedProjects.map(
        (project) =>
          `${project.workspaceId}\0${project.projectId}\0${project.trustAllDeclaredCanvases ? "*" : project.canvasId}`
      )
    );
    if (exactScopes.size !== config.trustedProjects.length) {
      context.addIssue({ code: "custom", message: "server_trusted_project_duplicate" });
    }
    const projectModes = new Map<string, Set<"all" | "exact">>();
    for (const project of config.trustedProjects) {
      const projectKey = `${project.workspaceId}\0${project.projectId}`;
      const modes = projectModes.get(projectKey) ?? new Set<"all" | "exact">();
      modes.add(project.trustAllDeclaredCanvases ? "all" : "exact");
      projectModes.set(projectKey, modes);
    }
    if ([...projectModes.values()].some((modes) => modes.size > 1)) {
      context.addIssue({ code: "custom", message: "server_trusted_project_scope_overlap" });
    }
    if (config.databasePath !== join(config.dataDirectory, "planweave-server.sqlite")) {
      context.addIssue({ code: "custom", message: "server_database_path_mismatch" });
    }
  }
);

export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type ServerStorageConfig = Pick<ServerConfig, "dataDirectory" | "databasePath"> & {
  busyTimeoutMs: number;
};

function normalizedPolicy(mode: ServerTransport["mode"]): ServerConfig["insecurePolicy"] {
  return {
    allowInsecureTransport: mode === "loopback_http" || mode === "lan_http",
    allowInsecureLan: mode === "lan_http"
  };
}

function normalizeV1Config(config: z.infer<typeof serverConfigV1Schema>): ServerConfig {
  const advertisedOrigin = new URL(config.publicUrl).origin;
  let transport: ServerTransport;
  let deployment = config.deployment
    ? deploymentEndpointSchema.parse({
        ...config.deployment,
        topology:
          config.deployment.topology === "lan_https" ? "private_https" : config.deployment.topology
      })
    : null;
  if (config.allowInsecureLan) {
    transport = {
      mode: "lan_http",
      listener: { protocol: "http", ...config.bind },
      advertisedOrigin,
      acknowledgeInsecureLan: true
    };
  } else if (config.allowInsecureDevelopment) {
    transport = {
      mode: "loopback_http",
      listener: { protocol: "http", ...config.bind },
      advertisedOrigin
    };
    deployment ??= deploymentEndpointSchema.parse({
      topology: "loopback_http",
      serverOrigin: advertisedOrigin,
      allowedClientOrigins: [advertisedOrigin],
      tlsTrust: "not_applicable"
    });
  } else {
    if (!config.tls) throw new Error("server_tls_configuration_required");
    transport = {
      mode: "direct_https",
      listener: { protocol: "https", ...config.bind, tls: config.tls },
      advertisedOrigin
    };
  }
  const {
    bind: _bind,
    publicUrl: _publicUrl,
    tls: _tls,
    allowInsecureDevelopment: _allowInsecureDevelopment,
    allowInsecureLan: _allowInsecureLan,
    ...common
  } = config;
  return serverConfigSchema.parse({
    ...common,
    version: "server-config/v2",
    transport,
    deployment,
    allowedClientOrigins: config.deployment ? (deployment?.allowedClientOrigins ?? null) : null,
    insecurePolicy: normalizedPolicy(transport.mode)
  });
}

export type ServerConfigInputVersion = "server-config/v1" | "server-config/v2";

export function serverConfigInputVersion(input: unknown): ServerConfigInputVersion {
  if (typeof input !== "object" || input === null || !("version" in input)) {
    throw new Error("server_config_invalid_version");
  }
  if (input.version !== "server-config/v1" && input.version !== "server-config/v2") {
    throw new Error("server_config_invalid_version");
  }
  return input.version;
}

export function parseServerConfig(input: unknown): ServerConfig {
  const version = serverConfigInputVersion(input);
  if (version === "server-config/v1") {
    const parsed = serverConfigV1InputSchema.parse(input);
    const validated = serverConfigV1Schema.parse({
      ...parsed,
      databasePath: join(parsed.dataDirectory, "planweave-server.sqlite")
    });
    return normalizeV1Config(validated);
  }
  if (version === "server-config/v2") {
    const parsed = serverConfigV2InputSchema.parse(input);
    const advertisedOrigin = new URL(parsed.transport.advertisedOrigin).origin;
    return serverConfigSchema.parse({
      ...parsed,
      transport: { ...parsed.transport, advertisedOrigin },
      databasePath: join(parsed.dataDirectory, "planweave-server.sqlite"),
      insecurePolicy: normalizedPolicy(parsed.transport.mode)
    });
  }
  throw new Error("server_config_invalid_version");
}

export function serverConfigFileInput(
  config: ServerConfig
): z.infer<typeof serverConfigV2InputSchema> {
  const validated = serverConfigSchema.parse(config);
  const { databasePath: _databasePath, insecurePolicy: _insecurePolicy, ...input } = validated;
  return serverConfigV2InputSchema.parse(input);
}

export async function loadServerConfig(path: string): Promise<ServerConfig> {
  return (await loadServerConfigDocument(path)).config;
}

export type LoadedServerConfigDocument = {
  sourceVersion: ServerConfigInputVersion;
  config: ServerConfig;
};

export function parseServerConfigDocumentBytes(bytes: Buffer): LoadedServerConfigDocument {
  if (bytes.byteLength > MAX_CONFIG_BYTES) throw new Error("server_config_too_large");
  try {
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    return {
      sourceVersion: serverConfigInputVersion(input),
      config: parseServerConfig(input)
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("server_")) throw error;
    throw new Error("server_config_invalid", { cause: error });
  }
}

export async function loadServerConfigDocument(path: string): Promise<LoadedServerConfigDocument> {
  if (!isAbsolute(path)) throw new Error("server_config_path_must_be_absolute");
  return parseServerConfigDocumentBytes(await readFile(path));
}

export function resolveServerConfigPath(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const configIndex = argv.indexOf("--config");
  if (configIndex >= 0) {
    const path = argv[configIndex + 1];
    if (!path || argv.length !== 2) throw new Error("server_cli_usage");
    return absolutePathSchema.parse(path);
  }
  if (argv.length !== 0) throw new Error("server_cli_usage");
  const path = env.PLANWEAVE_SERVER_CONFIG;
  if (!path) throw new Error("server_config_path_required");
  return absolutePathSchema.parse(path);
}

export const serverConfigSummarySchema = z
  .object({
    version: z.literal("server-config/v2"),
    listener: z
      .object({
        protocol: z.enum(["http", "https"]),
        host: bindHostSchema,
        port: z.number().int().min(1).max(65_535)
      })
      .strict(),
    advertisedOrigin: z.url(),
    transportMode: z.enum(["loopback_http", "lan_http", "reverse_proxy_https", "direct_https"]),
    deployment: z
      .object({
        topology: z.enum(["loopback_http", "loopback_https", "private_https", "public_https"]),
        allowedClientOrigins: z.array(z.url()).max(32)
      })
      .nullable(),
    projectIds: z.array(opaqueIdentifierSchema).max(256)
  })
  .strict();

export function serverConfigSummary(config: ServerConfig) {
  return serverConfigSummarySchema.parse({
    version: config.version,
    listener: {
      protocol: config.transport.listener.protocol,
      host: config.transport.listener.host,
      port: config.transport.listener.port
    },
    advertisedOrigin: config.transport.advertisedOrigin,
    transportMode: config.transport.mode,
    deployment: config.deployment
      ? {
          topology: config.deployment.topology,
          allowedClientOrigins: config.deployment.allowedClientOrigins
        }
      : null,
    projectIds: [...new Set(config.trustedProjects.map((project) => project.projectId))]
  });
}
