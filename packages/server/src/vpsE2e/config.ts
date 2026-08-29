import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { VpsE2eGate, VpsE2ePrecondition } from "./gate.js";
import { precondition } from "./gate.js";

const MAX_REMOTE_CONFIG_BYTES = 64 * 1024;

const absolutePathSchema = z.string().min(1).max(4096).refine(isAbsolute, "Path must be absolute.");

/**
 * External remote-VPS operator config.
 * Lives outside the repository; never commit real endpoints/tokens.
 */
export const remoteVpsE2eConfigSchema = z
  .object({
    version: z.literal("planweave.vps-e2e-config/v1"),
    environmentClass: z.literal("remote-vps"),
    coordinatorUrl: z.url(),
    /** Name of the env var that holds the operator bearer token (not the token itself). */
    operatorTokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
      .default("PLANWEAVE_VPS_OPERATOR_TOKEN"),
    caCertificatePath: absolutePathSchema.optional(),
    hostConfigPath: absolutePathSchema,
    projectId: z.string().min(1).max(256),
    canvasId: z.string().min(1).max(128).default("default"),
    blockRef: z.string().min(1).max(256).default("T-001#B-001"),
    contentRevision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    graphFingerprint: z.string().regex(/^pkg-[a-f0-9]{64}$/),
    /** Optional absolute path for evidence JSON (also overridable via CLI --evidence). */
    evidencePath: absolutePathSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const url = new URL(config.coordinatorUrl);
    if (url.protocol !== "https:" && url.protocol !== "wss:") {
      context.addIssue({
        code: "custom",
        path: ["coordinatorUrl"],
        message: "remote_vps_requires_https"
      });
    }
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      context.addIssue({
        code: "custom",
        path: ["coordinatorUrl"],
        message: "remote_vps_url_must_be_origin"
      });
    }
  });

export type RemoteVpsE2eConfig = z.infer<typeof remoteVpsE2eConfigSchema>;

export type ResolvedVpsE2eTarget =
  | { kind: "local-tls-fixture" }
  | { kind: "remote-vps"; config: RemoteVpsE2eConfig; operatorToken: string }
  | { kind: "precondition"; precondition: VpsE2ePrecondition };

export async function resolveVpsE2eTarget(
  gate: VpsE2eGate,
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<ResolvedVpsE2eTarget> {
  if (!gate.enabled) {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "gate_disabled",
        "VPS e2e gate is disabled. Set PLANWEAVE_VPS_E2E=1 (soft) or PLANWEAVE_VPS_E2E_REQUIRE=1 (hard)."
      )
    };
  }

  if (gate.profileId === "local-tls-fixture") {
    return { kind: "local-tls-fixture" };
  }

  if (!gate.configPath) {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_config_missing",
        "remote-vps profile requires PLANWEAVE_VPS_E2E_CONFIG absolute path outside the repository."
      )
    };
  }
  if (!isAbsolute(gate.configPath)) {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_config_invalid",
        "PLANWEAVE_VPS_E2E_CONFIG must be an absolute path."
      )
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(gate.configPath);
  } catch {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_config_missing",
        "Remote VPS e2e config file is unreadable."
      )
    };
  }
  if (bytes.byteLength > MAX_REMOTE_CONFIG_BYTES) {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_config_invalid",
        "Remote VPS e2e config exceeds size limit."
      )
    };
  }

  let config: RemoteVpsE2eConfig;
  try {
    config = remoteVpsE2eConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_config_invalid",
        "Remote VPS e2e config failed schema validation."
      )
    };
  }

  const operatorToken = env[config.operatorTokenEnv];
  if (!operatorToken || operatorToken.trim().length === 0) {
    return {
      kind: "precondition",
      precondition: precondition(
        gate.mode,
        "remote_token_missing",
        `Operator token env ${config.operatorTokenEnv} is unset (token never read from config file).`
      )
    };
  }

  return { kind: "remote-vps", config, operatorToken: operatorToken.trim() };
}
