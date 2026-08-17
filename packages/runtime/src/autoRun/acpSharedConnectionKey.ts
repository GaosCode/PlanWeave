import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { ClientSideConnection } from "@agentclientprotocol/sdk";
import type { ExecutionHost } from "../types/executor.js";
import type { AcpSharedPoolIdentity } from "./acpConnectionProvider.js";
import type { TrustedAcpLaunch } from "./acpConnection.js";

export type AcpSharedConnectionKeyInput = {
  readonly cwd: string;
  readonly launch: TrustedAcpLaunch;
  readonly env: Readonly<Record<string, string>>;
  readonly clientCapabilities?: Parameters<
    ClientSideConnection["initialize"]
  >[0]["clientCapabilities"];
  readonly poolIdentity?: AcpSharedPoolIdentity;
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function normalizeProjectRoot(projectRoot: string): string {
  return resolve(projectRoot);
}

function hostKey(host: ExecutionHost): string {
  return host.kind === "wsl"
    ? stableJson({ kind: "wsl", distribution: host.distribution })
    : stableJson({ kind: "native" });
}

export function digestAcpSharedEnv(env: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(env).sort(compareCodeUnits)) {
    hash.update(name);
    hash.update("\0");
    hash.update(env[name] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function acpSharedConnectionKey(input: AcpSharedConnectionKeyInput): string {
  const identity = input.poolIdentity;
  return stableJson({
    projectRoot: normalizeProjectRoot(identity?.projectRoot ?? input.cwd),
    profileFingerprint: identity?.profileFingerprint ?? "",
    host: hostKey(identity?.host ?? { kind: "native" }),
    launch: { command: input.launch.command, args: [...input.launch.args] },
    clientCapabilities: input.clientCapabilities ?? {},
    envDigest: digestAcpSharedEnv(input.env)
  });
}
