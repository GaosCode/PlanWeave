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
  type ConnectivityValidationView,
  type DeploymentBundleExportView
} from "@planweave-ai/collaboration-protocol/deployment";
import { operatorTokenSchema } from "@planweave-ai/agent-host-protocol";
import {
  hashOperatorToken,
  restoreServerDataScript,
  serverConfigFileInput,
  serverConfigSchema,
  type ServerConfig
} from "@planweave-ai/server";
import { basename, resolve } from "node:path";
import { deploymentArchiveFailureCodes as archiveFailureCodes } from "../../shared/deploymentArchiveFailureCodes.js";
import {
  buildDeploymentArchive,
  deploymentArchiveError,
  resolveDeploymentArchiveWorkerEntry
} from "./deploymentArchiveClient.js";
import type { DeploymentArchiveInput } from "./deploymentArchiveMessages.js";
import { publishDeploymentArchive } from "./deploymentArchivePublisher.js";
import { writeDesktopConnectionScript } from "./writeDesktopConnectionScript.js";

const composePreview =
  "test -f tls/server.crt && test -f tls/server.key && docker compose -f compose.yaml up --build --detach --wait";

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
  archiveWorkerEntry?: URL;
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
  private readonly archiveWorkerEntry: URL;
  private readonly archiveShutdown = new AbortController();
  private exportInProgress = false;
  private activeArchiveExport?: Promise<DeploymentBundleExportView>;
  private readonly resolveBundleSource?: (
    target: DeploymentTargetDraft
  ) => Promise<DeploymentBundleSource>;
  private readonly showSaveDialog?: DeploymentActionsOptions["showSaveDialog"];

  constructor(options: DeploymentActionsOptions = {}) {
    this.request = options.request ?? fetch;
    this.writeClipboard = options.writeClipboard;
    this.now = options.now ?? (() => new Date());
    this.resourceDirectory = options.resourceDirectory;
    this.archiveWorkerEntry = options.archiveWorkerEntry ?? resolveDeploymentArchiveWorkerEntry();
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
    const signal = this.archiveShutdown.signal;
    signal.throwIfAborted();
    if (this.exportInProgress) {
      throw deploymentArchiveError(archiveFailureCodes.exportInProgress);
    }

    this.exportInProgress = true;
    try {
      const save = await this.showSaveDialog({
        defaultPath: "planweave-self-host-bundle.zip",
        filters: [{ name: "PlanWeave self-host bundle", extensions: ["zip"] }]
      });
      signal.throwIfAborted();
      if (save.canceled || !save.filePath) {
        return deploymentBundleExportViewSchema.parse({
          state: "cancelled",
          fileName: null,
          tls: "required_after_export"
        });
      }
      this.activeArchiveExport = this.publishBundle(
        save.filePath,
        this.resourceDirectory,
        target,
        this.resolveBundleSource
      );
      return await this.activeArchiveExport;
    } finally {
      this.activeArchiveExport = undefined;
      this.exportInProgress = false;
    }
  }

  async shutdown(): Promise<void> {
    this.archiveShutdown.abort(deploymentArchiveError(archiveFailureCodes.shuttingDown));
    await Promise.allSettled([this.activeArchiveExport]);
  }

  private async publishBundle(
    destination: string,
    resourceDirectory: string,
    target: DeploymentTargetDraft,
    resolveBundleSource: NonNullable<DeploymentActionsOptions["resolveBundleSource"]>
  ): Promise<DeploymentBundleExportView> {
    const signal = this.archiveShutdown.signal;
    try {
      const source = await resolveBundleSource(target);
      signal.throwIfAborted();
      const archive = await buildDeploymentArchive(
        this.archiveWorkerEntry,
        prepareArchiveInput(resourceDirectory, source, target),
        signal
      );
      signal.throwIfAborted();
      if (!archive) return unavailableBundleView("invalid_project");
      await publishDeploymentArchive(destination, archive);
    } catch (error) {
      if (error instanceof DeploymentBundleUnavailableError) {
        return unavailableBundleView(error.state);
      }
      throw error;
    }
    return deploymentBundleExportViewSchema.parse({
      state: "exported",
      fileName: basename(destination),
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

function prepareArchiveInput(
  resourceDirectory: string,
  source: DeploymentBundleSource,
  target: DeploymentTargetDraft
): DeploymentArchiveInput {
  const result = serverConfigSchema.safeParse(source.config);
  if (!result.success) throw deploymentArchiveError("deployment_bundle_config_invalid");
  const config = result.data;
  if (
    config.transport.mode !== "direct_https" ||
    config.trustedProjects.length !== 0 ||
    config.deployment?.serverOrigin !== target.endpoint.serverOrigin
  ) {
    throw new DeploymentBundleUnavailableError(
      "invalid_project",
      "deployment_bundle_scope_invalid"
    );
  }
  const credential = operatorTokenSchema.safeParse(source.operatorToken);
  if (!credential.success) throw deploymentArchiveError("deployment_bundle_operator_invalid");
  const operatorToken = credential.data;
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
  const connectionScript = writeDesktopConnectionScript.endsWith("\n")
    ? writeDesktopConnectionScript
    : `${writeDesktopConnectionScript}\n`;
  const restoreScript = restoreServerDataScript.endsWith("\n")
    ? restoreServerDataScript
    : `${restoreServerDataScript}\n`;
  return {
    resourceDirectory: resolve(resourceDirectory),
    serverJson: `${JSON.stringify(serverConfigFileInput(config))}\n`,
    operatorTokenFile: `${operatorToken}\n`,
    connectionScript,
    restoreScript
  };
}
