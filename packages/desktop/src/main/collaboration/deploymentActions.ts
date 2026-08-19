import {
  assertDeploymentViewRedacted,
  deploymentBundleExportViewSchema,
  connectivityValidationViewSchema,
  deploymentCopyHandoffViewSchema,
  deploymentOriginHeader,
  desktopDeploymentActionRequestSchema,
  deploymentGuidanceViewSchema,
  deploymentTargetDraftSchema,
  type DeploymentTargetDraft,
  type DeploymentGuidanceView,
  type ConnectivityValidationView
} from "@planweave-ai/collaboration-protocol/deployment";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import {
  hashOperatorToken,
  restoreServerDataScript,
  serverConfigFileInput,
  serverConfigSchema,
  type ServerConfig
} from "@planweave-ai/server";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { writeDesktopConnectionScript } from "./writeDesktopConnectionScript.js";

const composePreview =
  "test -f tls/server.crt && test -f tls/server.key && docker compose -f compose.yaml up --build --detach --wait";
const maxBundleInputBytes = 256 * 1024 * 1024;

export type DeploymentBundleSource = {
  config: ServerConfig;
  operatorToken: string;
};

export class DeploymentBundleUnavailableError extends Error {
  constructor(
    readonly state: "needs_project" | "invalid_project",
    message: string
  ) {
    super(message);
    this.name = "DeploymentBundleUnavailableError";
  }
}

export type DeploymentActionsOptions = {
  request?: typeof fetch;
  writeClipboard?: (value: string) => void;
  now?: () => Date;
  resourceDirectory?: string;
  resolveBundleSource?: (target: DeploymentTargetDraft) => Promise<DeploymentBundleSource>;
  showSaveDialog?: (options: {
    defaultPath: string;
    filters: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{ canceled: boolean; filePath?: string }>;
};

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function requirements(target: DeploymentTargetDraft) {
  return {
    durableState: "required" as const,
    healthcheck: { required: true as const },
    publicIngress:
      target.endpoint.topology === "public_https"
        ? { tls: "direct" as const, port: 443 as const }
        : null
  };
}

function handoff(target: DeploymentTargetDraft) {
  if (target.endpoint.topology === "loopback_http") {
    return {
      state: "not_applicable" as const,
      copyAction: null,
      preview: null,
      exportAction: null,
      configInputPath: null,
      tlsDirectory: null,
      projectsRoot: null,
      projectsMountTarget: null,
      trustedProjectRootPattern: null
    };
  }
  return {
    state: "supported" as const,
    copyAction: "copy_supported_compose_handoff" as const,
    preview: composePreview,
    exportAction: "export_supported_compose_bundle" as const,
    configInputPath: "./server.json" as const,
    tlsDirectory: "./tls" as const,
    projectsRoot: "./projects" as const,
    projectsMountTarget: "/var/lib/planweave/projects" as const,
    trustedProjectRootPattern: "/var/lib/planweave/projects/<project-id>" as const
  };
}

function assertGuidanceCapability(target: DeploymentTargetDraft): void {
  if (!target.capabilities.includes("deployment_guidance")) {
    throw new Error("deployment_guidance_not_supported");
  }
}

const tlsFailureCodes = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

function isKnownTlsFailure(error: unknown): boolean {
  const candidates = [
    error,
    error && typeof error === "object" && "cause" in error ? error.cause : null
  ];
  return candidates.some((candidate) =>
    Boolean(
      candidate &&
        typeof candidate === "object" &&
        "code" in candidate &&
        typeof candidate.code === "string" &&
        tlsFailureCodes.has(candidate.code)
    )
  );
}

function targetFromAction(
  input: unknown,
  expectedAction:
    | "request_deployment_guidance"
    | "copy_supported_compose_handoff"
    | "export_supported_compose_bundle"
    | "validate_connectivity"
): DeploymentTargetDraft {
  const action = desktopDeploymentActionRequestSchema.parse(input);
  if (action.action !== expectedAction) throw new Error("deployment_action_mismatch");
  return deploymentTargetDraftSchema.parse(action.target);
}

function unavailableBundleView(state: "needs_project" | "invalid_project") {
  return deploymentBundleExportViewSchema.parse({
    state,
    fileName: null,
    tls: "required_after_export"
  });
}

/** Main-owned deployment actions. The renderer supplies only a validated, non-secret target draft. */
export class DeploymentActions {
  private readonly request: typeof fetch;
  private readonly writeClipboard?: (value: string) => void;
  private readonly now: () => Date;
  private readonly resourceDirectory?: string;
  private readonly resolveBundleSource?: (
    target: DeploymentTargetDraft
  ) => Promise<DeploymentBundleSource>;
  private readonly showSaveDialog?: DeploymentActionsOptions["showSaveDialog"];

  constructor(options: DeploymentActionsOptions = {}) {
    this.request = options.request ?? fetch;
    this.writeClipboard = options.writeClipboard;
    this.now = options.now ?? (() => new Date());
    this.resourceDirectory = options.resourceDirectory;
    this.resolveBundleSource = options.resolveBundleSource;
    this.showSaveDialog = options.showSaveDialog;
  }

  guidance(input: unknown): DeploymentGuidanceView {
    const target = targetFromAction(input, "request_deployment_guidance");
    assertGuidanceCapability(target);
    const view = deploymentGuidanceViewSchema.parse({
      schemaVersion: "deployment-target-draft/v1",
      target,
      state: "ready",
      requirements: requirements(target),
      handoff: handoff(target),
      generatedAt: nowIso(this.now),
      unavailableReason: null
    });
    assertDeploymentViewRedacted(view);
    return view;
  }

  copyComposeHandoff(input: unknown): { state: "copied"; copiedAt: string } {
    const target = targetFromAction(input, "copy_supported_compose_handoff");
    assertGuidanceCapability(target);
    const generated = handoff(target);
    if (generated.copyAction === null || generated.preview === null) {
      throw new Error("deployment_compose_handoff_not_supported");
    }
    if (!this.writeClipboard) throw new Error("deployment_clipboard_unavailable");
    this.writeClipboard(generated.preview);
    return deploymentCopyHandoffViewSchema.parse({ state: "copied", copiedAt: nowIso(this.now) });
  }

  async exportComposeBundle(input: unknown) {
    const target = targetFromAction(input, "export_supported_compose_bundle");
    assertGuidanceCapability(target);
    if (handoff(target).state !== "supported") {
      throw new Error("deployment_compose_handoff_not_supported");
    }
    if (!this.resolveBundleSource || !this.resourceDirectory || !this.showSaveDialog) {
      return unavailableBundleView("needs_project");
    }
    const save = await this.showSaveDialog({
      defaultPath: "planweave-self-host-bundle.zip",
      filters: [{ name: "PlanWeave self-host bundle", extensions: ["zip"] }]
    });
    if (save.canceled || !save.filePath) {
      return deploymentBundleExportViewSchema.parse({
        state: "cancelled",
        fileName: null,
        tls: "required_after_export"
      });
    }
    let source: DeploymentBundleSource;
    try {
      source = await this.resolveBundleSource(target);
    } catch (error) {
      if (error instanceof DeploymentBundleUnavailableError)
        return unavailableBundleView(error.state);
      throw error;
    }
    try {
      const archive = await createBundleArchive({
        resourceDirectory: this.resourceDirectory,
        source,
        target
      });
      await writeFile(save.filePath, archive, { mode: 0o600 });
    } catch (error) {
      if (error instanceof DeploymentBundleUnavailableError)
        return unavailableBundleView(error.state);
      throw error;
    }
    return deploymentBundleExportViewSchema.parse({
      state: "exported",
      fileName: basename(save.filePath),
      tls: "required_after_export"
    });
  }

  async validateConnectivity(input: unknown): Promise<ConnectivityValidationView> {
    const parsed = desktopDeploymentActionRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new Error("deployment_connection_invalid_configuration");
    }
    if (parsed.data.action !== "validate_connectivity") {
      throw new Error("deployment_action_mismatch");
    }
    const target = deploymentTargetDraftSchema.parse(parsed.data.target);
    const checkedAt = nowIso(this.now);
    const base = {
      schemaVersion: "deployment-target-draft/v1" as const,
      target,
      endpoint: target.endpoint,
      checkedAt
    };
    if (!target.capabilities.includes("connectivity_validation")) {
      return connectivityValidationViewSchema.parse({
        ...base,
        status: "invalid_configuration",
        failureCode: "connectivity_validation_not_supported"
      });
    }
    const origin = deploymentOriginHeader(target.endpoint);
    if (!origin) {
      return connectivityValidationViewSchema.parse({
        ...base,
        status: "invalid_origin",
        failureCode: "allowed_client_origin_missing"
      });
    }
    try {
      const response = await this.request(new URL("/readyz", target.endpoint.serverOrigin), {
        headers: { Origin: origin },
        signal: AbortSignal.timeout(5_000)
      });
      if (!response.ok) {
        return connectivityValidationViewSchema.parse({
          ...base,
          status: "unreachable",
          failureCode: "http_not_ready"
        });
      }
      const view = connectivityValidationViewSchema.parse({
        ...base,
        status: "reachable",
        failureCode: null
      });
      assertDeploymentViewRedacted(view);
      return view;
    } catch (error) {
      const view = connectivityValidationViewSchema.parse({
        ...base,
        status: isKnownTlsFailure(error) ? "invalid_tls" : "unreachable",
        failureCode: isKnownTlsFailure(error) ? "tls_certificate_invalid" : "connection_failed"
      });
      assertDeploymentViewRedacted(view);
      return view;
    }
  }
}

async function archiveDirectory(
  root: string,
  prefix: string,
  output: Record<string, Uint8Array>,
  total: { bytes: number }
): Promise<void> {
  const resolvedRoot = resolve(root);
  if (!isAbsolute(resolvedRoot)) {
    throw new DeploymentBundleUnavailableError("invalid_project", "deployment_bundle_root_invalid");
  }
  const entries = await readdir(resolvedRoot, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(resolvedRoot, entry.name);
    if (relative(resolvedRoot, path).startsWith("..")) {
      throw new DeploymentBundleUnavailableError(
        "invalid_project",
        "deployment_bundle_path_escape"
      );
    }
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new DeploymentBundleUnavailableError(
        "invalid_project",
        "deployment_bundle_symlink_rejected"
      );
    }
    const name = `${prefix}/${entry.name}`;
    if (metadata.isDirectory()) {
      await archiveDirectory(path, name, output, total);
      continue;
    }
    if (!metadata.isFile()) {
      throw new DeploymentBundleUnavailableError(
        "invalid_project",
        "deployment_bundle_entry_invalid"
      );
    }
    total.bytes += metadata.size;
    if (total.bytes > maxBundleInputBytes) {
      throw new DeploymentBundleUnavailableError("invalid_project", "deployment_bundle_too_large");
    }
    output[name] = new Uint8Array(await readFile(path));
  }
}

async function createBundleArchive(input: {
  resourceDirectory: string;
  source: DeploymentBundleSource;
  target: DeploymentTargetDraft;
}): Promise<Uint8Array> {
  const config = serverConfigSchema.parse(input.source.config);
  if (
    config.transport.mode !== "direct_https" ||
    config.trustedProjects.length !== 0 ||
    config.deployment?.serverOrigin !== input.target.endpoint.serverOrigin
  ) {
    throw new DeploymentBundleUnavailableError(
      "invalid_project",
      "deployment_bundle_scope_invalid"
    );
  }
  const operatorToken = operatorTokenSchema.parse(input.source.operatorToken);
  const tokenDigest = hashOperatorToken(operatorToken);
  if (
    !config.operatorCredentials.some(
      (credential) => credential.serverAdmin === true && credential.tokenSha256 === tokenDigest
    )
  ) {
    throw new DeploymentBundleUnavailableError(
      "invalid_project",
      "deployment_bundle_operator_mismatch"
    );
  }
  const configInput = serverConfigFileInput(config);
  const connectionScript = writeDesktopConnectionScript.endsWith("\n")
    ? writeDesktopConnectionScript
    : `${writeDesktopConnectionScript}\n`;
  const restoreScript = restoreServerDataScript.endsWith("\n")
    ? restoreServerDataScript
    : `${restoreServerDataScript}\n`;
  const files: Record<string, Uint8Array> = {
    "server.json": strToU8(`${JSON.stringify(configInput)}\n`),
    ".operator-token": strToU8(`${operatorToken}\n`),
    "write-desktop-connection.sh": strToU8(connectionScript),
    "restore-server-data.sh": strToU8(restoreScript),
    "tls/.gitkeep": new Uint8Array()
  };
  const total = {
    bytes:
      Buffer.byteLength(JSON.stringify(configInput)) +
      Buffer.byteLength(operatorToken) +
      Buffer.byteLength(connectionScript) +
      Buffer.byteLength(restoreScript)
  };
  const composePath = resolve(input.resourceDirectory, "compose.yaml");
  const composeMetadata = await lstat(composePath);
  if (composeMetadata.isSymbolicLink() || !composeMetadata.isFile()) {
    throw new DeploymentBundleUnavailableError(
      "invalid_project",
      "deployment_bundle_compose_invalid"
    );
  }
  total.bytes += composeMetadata.size;
  if (total.bytes > maxBundleInputBytes) {
    throw new DeploymentBundleUnavailableError("invalid_project", "deployment_bundle_too_large");
  }
  files["compose.yaml"] = new Uint8Array(await readFile(composePath));
  await archiveDirectory(resolve(input.resourceDirectory, "image"), "image", files, total);
  return zipSync(files, { level: 6 });
}
