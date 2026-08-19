import {
  hashOperatorToken,
  LoopbackServerController,
  parseServerConfig,
  serveDistributedServer,
  type ServerConfig
} from "@planweave-ai/server";
import {
  loopbackProjectRegistrationViewSchema,
  loopbackServerProfileSchema,
  type LoopbackServerProfile,
  type LoopbackTrustedProjectScope,
  type LoopbackProjectRegistrationView
} from "@planweave-ai/collaboration-protocol/loopback";
import {
  deploymentEndpointSchema,
  type DeploymentEndpoint,
  type DeploymentTargetDraft
} from "@planweave-ai/collaboration-protocol/deployment";
import { collaborationConnectionProfileSchema } from "@planweave-ai/collaboration-protocol/connection";
import { listProjects, resolveTaskCanvasWorkspace } from "@planweave-ai/runtime";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { OperatorSafeStoragePort } from "../operatorControl/operatorCredentialVault.js";
import {
  operatorCredentialVaultPaths,
  OperatorCredentialVault
} from "../operatorControl/operatorCredentialVault.js";
import type { OperatorControlService } from "../operatorControl/operatorControlService.js";
import {
  LOCAL_OPERATOR_BACKEND_READY_TIMEOUT_MS,
  LOCAL_OPERATOR_PROFILE_ID,
  setLocalOperatorBackendPort,
  type LocalOperatorBackendSnapshot
} from "../operatorControl/localOperatorBackend.js";
import { desktopHomePaths } from "../planweaveHomePaths.js";
import {
  collaborationCurrentSelectionInputSchema,
  localCollaborationLanSharingInputSchema,
  localCollaborationServerStatusSchema,
  localCollaborationScopeSelectionInputSchema,
  isLocalCollaborationProfileId,
  type LocalCollaborationScopeCatalog,
  type LocalCollaborationServerStatus
} from "../../shared/collaboration.js";
import {
  desktopServerExposureModeInputSchema,
  desktopServerExposureViewSchema,
  type DesktopServerExposureErrorCode,
  type DesktopServerExposureView
} from "../../shared/deploymentExposure.js";
import {
  DeploymentBundleUnavailableError,
  type DeploymentBundleSource
} from "./deploymentActions.js";
import {
  LocalCollaborationScopeStore,
  type LocalCollaborationScopeStorePort
} from "./LocalCollaborationScopeStore.js";
import {
  LocalCollaborationNetworkStore,
  type LocalCollaborationNetworkStorePort
} from "./LocalCollaborationNetworkStore.js";
import { resolveLocalCollaborationLanAddress } from "./localNetworkAddress.js";
import {
  ManagedPrivateHttpsExposureError,
  TailscaleManagedPrivateHttpsAdapter,
  type ManagedPrivateHttpsExposurePort
} from "./managedPrivateHttpsExposure.js";

type ResolvedSelection = {
  desktopProjectId: string;
  authorityProjectId: string;
  canvasId: string;
  projectRoot: string;
};

type ProjectCatalogPort = {
  listProjects: typeof listProjects;
  resolveAuthorityProjectId(projectRoot: string, canvasId: string): Promise<string>;
};

type LoopbackServerControlPort = Pick<
  LoopbackServerController,
  "status" | "apply" | "listTrustedProjectScopes" | "registerTrustedProject"
>;

type LocalExposureMode = "local_only" | "private_https" | "lan_http";

const localOperatorCredentialKey = LOCAL_OPERATOR_PROFILE_ID;
const localServerProfileId = "planweave-local-server";
const localStartAttempts = 3;

function localWorkspaceIdForProject(projectId: string): string {
  return `workspace-local-${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
}

function localProfileIdForProject(projectId: string): string {
  return `planweave-local-${createHash("sha256").update(projectId).digest("hex").slice(0, 24)}`;
}

async function allocateLocalPort(host: string, preferredPort: number | null): Promise<number> {
  const listener = createServer();
  return new Promise<number>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(preferredPort ?? 0, host, () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        listener.close(() => reject(new Error("local_collaboration_port_allocation_failed")));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Main-only coordination seam: local process today, replaceable remote adapter later. */
export interface CollaborationCoordinatorControl {
  setCurrentSelection(input: unknown): Promise<void>;
  clearCurrentSelection(): Promise<void>;
  currentSelection(): { projectId: string; canvasId: string } | null;
  restore(): Promise<LocalCollaborationServerStatus>;
  status(): LocalCollaborationServerStatus;
  reconcileManagementProfile(): Promise<void>;
  start(): Promise<LocalCollaborationServerStatus>;
  stop(): Promise<LocalCollaborationServerStatus>;
  setLanSharing(input: unknown): Promise<LocalCollaborationServerStatus>;
  getExposureView(): DesktopServerExposureView;
  setExposureMode(input: unknown): Promise<DesktopServerExposureView>;
  invitationEndpoint(): DeploymentEndpoint | null;
  getScopeCatalog(): Promise<LocalCollaborationScopeCatalog>;
  setTrustedScopes(input: unknown): Promise<LocalCollaborationScopeCatalog>;
  currentSelectionIsTrusted(): boolean;
  ownsLocalProfile(profileId: string): boolean;
  recognizesLocalProfile(profileId: string): boolean;
  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[];
  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView;
  localProfile(): {
    profileId: string;
    displayName: string;
    serverBaseUrl: string;
    projectId: string;
    allowInsecureTransport: boolean;
    endpoint: DeploymentEndpoint;
  } | null;
  localProfileForId(profileId: string): {
    profileId: string;
    displayName: string;
    serverBaseUrl: string;
    projectId: string;
    allowInsecureTransport: boolean;
    endpoint: DeploymentEndpoint;
  } | null;
  registerLocalProfile(
    profileId: string,
    actor: { kind: "human"; id: string }
  ): LoopbackProjectRegistrationView;
  createSelfHostedDeploymentSource(target: DeploymentTargetDraft): Promise<DeploymentBundleSource>;
}

export class LocalCollaborationCoordinatorControl implements CollaborationCoordinatorControl {
  private selection: ResolvedSelection | null = null;
  private controller: LoopbackServerControlPort | null = null;
  private localPort: number | null = null;
  private preferredPort: number | null = null;
  private lanSharingEnabled = false;
  private lanAddress: string | null = null;
  private exposureMode: LocalExposureMode = "local_only";
  private privateHttpsOrigin: string | null = null;
  private exposureErrorCode: DesktopServerExposureErrorCode | null = null;
  private operatorToken: string | null = null;
  private readonly ownerRuntimeScopes = new Set<string>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly runningWaiters = new Set<{
    resolve: (snapshot: LocalOperatorBackendSnapshot) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly vault: OperatorCredentialVault;
  private readonly scopeStore: LocalCollaborationScopeStorePort;
  private readonly networkStore: LocalCollaborationNetworkStorePort;

  private readonly projects: ProjectCatalogPort;
  private readonly createController: (
    createConfig: (profile: LoopbackServerProfile) => ServerConfig,
    onLifecycleError: (error: unknown) => void,
    ownerTrustedProjects: ServerConfig["trustedProjects"]
  ) => LoopbackServerControlPort;
  private readonly allocatePort: (host: string, preferredPort: number | null) => Promise<number>;
  private readonly resolveLanAddress: () => string | null;
  private readonly privateHttpsExposure: ManagedPrivateHttpsExposurePort;
  private readonly syncOperatorProfile: (
    input: Parameters<OperatorControlService["ensureMainOwnedServerProfile"]>[0]
  ) => Promise<void>;

  constructor(options: {
    safeStorage: OperatorSafeStoragePort;
    credentialsPath?: string;
    projects?: ProjectCatalogPort;
    createController?: (
      createConfig: (profile: LoopbackServerProfile) => ServerConfig,
      onLifecycleError: (error: unknown) => void,
      ownerTrustedProjects: ServerConfig["trustedProjects"]
    ) => LoopbackServerControlPort;
    allocatePort?: (host: string, preferredPort: number | null) => Promise<number>;
    scopeStore?: LocalCollaborationScopeStorePort;
    networkStore?: LocalCollaborationNetworkStorePort;
    resolveLanAddress?: () => string | null;
    privateHttpsExposure?: ManagedPrivateHttpsExposurePort;
    syncOperatorProfile: (
      input: Parameters<OperatorControlService["ensureMainOwnedServerProfile"]>[0]
    ) => Promise<void>;
  }) {
    this.vault = new OperatorCredentialVault({
      safeStorage: options.safeStorage,
      ...(options.credentialsPath
        ? { paths: operatorCredentialVaultPaths(options.credentialsPath) }
        : {})
    });
    this.projects = options.projects ?? {
      listProjects,
      resolveAuthorityProjectId: async (projectRoot, canvasId) => {
        return (await resolveTaskCanvasWorkspace(projectRoot, canvasId)).id;
      }
    };
    this.privateHttpsExposure =
      options.privateHttpsExposure ?? new TailscaleManagedPrivateHttpsAdapter();
    this.createController =
      options.createController ??
      ((createConfig, onLifecycleError, ownerTrustedProjects) =>
        new LoopbackServerController({
          createConfig,
          onLifecycleError,
          serve: (config) =>
            serveDistributedServer(config, {
              createExposureLifecycle: (leases) =>
                this.privateHttpsExposure.createLifecycle(leases),
              ownerTrustedProjects
            })
        }));
    this.allocatePort = options.allocatePort ?? allocateLocalPort;
    this.scopeStore = options.scopeStore ?? new LocalCollaborationScopeStore();
    this.networkStore = options.networkStore ?? new LocalCollaborationNetworkStore();
    this.resolveLanAddress = options.resolveLanAddress ?? resolveLocalCollaborationLanAddress;
    this.syncOperatorProfile = options.syncOperatorProfile;
    setLocalOperatorBackendPort({
      getSnapshot: () => this.getLocalOperatorBackendSnapshot(),
      whenRunning: (timeoutMs) => this.whenLocalOperatorBackendRunning(timeoutMs)
    });
  }

  getLocalOperatorBackendSnapshot(): LocalOperatorBackendSnapshot {
    const running = this.status().state === "running" && this.localPort !== null;
    const loopbackBaseUrl = running ? `http://127.0.0.1:${this.localPort}/` : null;
    let advertisedOrigin: string | null = null;
    if (this.exposureMode === "private_https") {
      advertisedOrigin = this.privateHttpsOrigin;
    } else if (running && this.exposureMode === "lan_http" && this.lanAddress && this.localPort) {
      advertisedOrigin = `http://${this.lanAddress}:${this.localPort}/`;
    } else if (running && this.localPort !== null) {
      advertisedOrigin = `http://127.0.0.1:${this.localPort}/`;
    }
    return {
      running,
      loopbackBaseUrl,
      advertisedOrigin
    };
  }

  whenLocalOperatorBackendRunning(
    timeoutMs = LOCAL_OPERATOR_BACKEND_READY_TIMEOUT_MS
  ): Promise<LocalOperatorBackendSnapshot> {
    const current = this.getLocalOperatorBackendSnapshot();
    if (current.running && current.loopbackBaseUrl) return Promise.resolve(current);

    return new Promise<LocalOperatorBackendSnapshot>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.runningWaiters.delete(waiter);
        reject(new Error("operator_local_server_not_ready"));
      }, timeoutMs);
      const waiter = {
        resolve: (snapshot: LocalOperatorBackendSnapshot) => {
          clearTimeout(timer);
          this.runningWaiters.delete(waiter);
          resolve(snapshot);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          this.runningWaiters.delete(waiter);
          reject(error);
        },
        timer
      };
      this.runningWaiters.add(waiter);
      // Join the coordinator queue so an in-flight restore/start can settle waiters.
      void this.operationQueue.finally(() => {
        const snapshot = this.getLocalOperatorBackendSnapshot();
        if (snapshot.running && snapshot.loopbackBaseUrl && this.runningWaiters.has(waiter)) {
          waiter.resolve(snapshot);
        }
      });
    });
  }

  private resolveLocalOperatorBackendWaiters(): void {
    const snapshot = this.getLocalOperatorBackendSnapshot();
    if (!snapshot.running || !snapshot.loopbackBaseUrl) return;
    for (const waiter of [...this.runningWaiters]) {
      waiter.resolve(snapshot);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.catch(() => undefined).then(operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  setCurrentSelection(input: unknown): Promise<void> {
    return this.enqueue(() => this.setCurrentSelectionUnlocked(input));
  }

  private async setCurrentSelectionUnlocked(input: unknown): Promise<void> {
    const selected = collaborationCurrentSelectionInputSchema.parse(input);
    const projects = (await this.projects.listProjects()).filter(
      (project) => project.projectId === selected.projectId
    );
    if (projects.length !== 1) throw new Error("local_collaboration_project_selection_ambiguous");
    const project = projects[0];
    if (!project.taskCanvases.some((canvas) => canvas.canvasId === selected.canvasId)) {
      throw new Error("local_collaboration_canvas_selection_mismatch");
    }
    const authorityProjectId = await this.projects.resolveAuthorityProjectId(
      project.rootPath,
      selected.canvasId
    );
    const next = {
      desktopProjectId: project.projectId,
      authorityProjectId,
      canvasId: selected.canvasId,
      projectRoot: project.rootPath
    };
    this.selection = next;
    const ownerScopeKey = this.ownerRuntimeScopeKey(next);
    if (this.status().state === "running" && !this.ownerRuntimeScopes.has(ownerScopeKey)) {
      const stopped = await this.stopUnlocked();
      if (stopped.state !== "stopped") throw new Error("local_owner_runtime_reload_stop_failed");
      const restarted = await this.startUnlocked();
      if (restarted.state !== "running") throw new Error("local_owner_runtime_reload_failed");
    }
  }

  clearCurrentSelection(): Promise<void> {
    return this.enqueue(async () => {
      this.selection = null;
    });
  }

  currentSelection(): { projectId: string; canvasId: string } | null {
    return this.selection
      ? { projectId: this.selection.desktopProjectId, canvasId: this.selection.canvasId }
      : null;
  }

  status(): LocalCollaborationServerStatus {
    const lifecycle = this.controller?.status() ?? {
      profile: null,
      state: "stopped",
      startedAt: null,
      reason: null
    };
    return localCollaborationServerStatusSchema.parse({
      ...lifecycle,
      lanSharingEnabled: this.lanSharingEnabled,
      lanServerBaseUrl:
        lifecycle.state === "running" && this.lanSharingEnabled && this.lanAddress && this.localPort
          ? `http://${this.lanAddress}:${this.localPort}/`
          : null
    });
  }

  restore(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(async () => {
      await this.applyPersistedNetworkUnlocked();
      const shouldRestoreServer =
        (await this.scopeStore.read()).length > 0 || (await this.hasOwnerRuntimeCanvases());
      if (!shouldRestoreServer) return this.status();
      try {
        return await this.startUnlocked();
      } catch (error) {
        const exposureErrorCode = this.exposureCode(error);
        if (
          this.exposureMode !== "private_https" ||
          !exposureErrorCode.startsWith("PRIVATE_HTTPS_")
        ) {
          throw error;
        }
        this.exposureErrorCode = exposureErrorCode;
        return this.status();
      }
    });
  }

  /** Loads the last local access method without starting this computer's Server. */
  hydratePersistedExposure(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(async () => {
      await this.applyPersistedNetworkUnlocked();
      return this.status();
    });
  }

  private async applyPersistedNetworkUnlocked(): Promise<void> {
    const network = await this.networkStore.read();
    this.exposureMode =
      network.exposureMode ?? (network.lanSharingEnabled ? "lan_http" : "local_only");
    this.lanSharingEnabled = this.exposureMode === "lan_http";
    this.preferredPort = network.preferredPort;
  }

  start(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(() => this.startUnlocked());
  }

  reconcileManagementProfile(): Promise<void> {
    return this.enqueue(async () => {
      if (this.status().state !== "running") return;
      await this.ensureOperatorToken();
      await this.syncMainOwnedOperatorProfile();
    });
  }

  private async startUnlocked(): Promise<LocalCollaborationServerStatus> {
    await this.ensureOperatorToken();
    const current = this.status();
    if (current.state === "running") {
      await this.syncMainOwnedOperatorProfile();
      return current;
    }
    const trustedProjects = await this.resolveTrustedProjects();
    const ownerTrustedProjects = await this.resolveOwnerTrustedProjects();
    let lastStatus: LocalCollaborationServerStatus = current;
    for (let attempt = 0; attempt < localStartAttempts; attempt += 1) {
      if (this.exposureMode === "private_https") {
        try {
          this.privateHttpsOrigin = await this.privateHttpsExposure.resolveAdvertisedOrigin();
          this.exposureErrorCode = null;
        } catch (error) {
          this.exposureErrorCode = this.exposureCode(error);
          throw error;
        }
      } else {
        this.privateHttpsOrigin = null;
      }
      this.lanAddress = this.lanSharingEnabled ? this.resolveLanAddress() : null;
      if (this.lanSharingEnabled && !this.lanAddress) {
        throw new Error("local_collaboration_lan_address_unavailable");
      }
      try {
        this.localPort = await this.allocatePort(
          this.lanSharingEnabled ? "0.0.0.0" : "127.0.0.1",
          attempt === 0 ? this.preferredPort : null
        );
      } catch (error) {
        this.localPort = null;
        if (attempt === 0 && this.preferredPort !== null) continue;
        throw error;
      }
      const controller = this.createController(
        (profile) => this.createConfig(profile, trustedProjects),
        (error) => {
          console.error("Local collaboration server lifecycle failed.", error);
          this.exposureErrorCode = this.exposureCode(error);
        },
        ownerTrustedProjects
      );
      this.controller = controller;
      const status = await controller.apply({ action: "start", profile: this.serverProfile() });
      if (status.state === "running") {
        this.ownerRuntimeScopes.clear();
        for (const project of ownerTrustedProjects) {
          const canvasId = project.canvasId;
          if (!canvasId) throw new Error("local_owner_runtime_canvas_scope_required");
          this.ownerRuntimeScopes.add(this.ownerRuntimeScopeKey({ ...project, canvasId }));
        }
        this.exposureErrorCode = null;
        if (this.preferredPort !== this.localPort) {
          this.preferredPort = this.localPort;
          await this.persistNetworkState();
        }
        await this.syncMainOwnedOperatorProfile();
        this.resolveLocalOperatorBackendWaiters();
        return this.status();
      }
      lastStatus = this.status();
      this.controller = null;
      this.ownerRuntimeScopes.clear();
      this.localPort = null;
      this.lanAddress = null;
      if (status.reason !== "start_failed") return lastStatus;
    }
    return lastStatus;
  }

  stop(): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<LocalCollaborationServerStatus> {
    const status = this.status();
    if (!this.controller || status.profile === null) return status;
    const stopped = await this.controller.apply({
      action: "stop",
      profileId: status.profile.profileId
    });
    if (stopped.state === "stopped") {
      this.controller = null;
      this.ownerRuntimeScopes.clear();
      this.localPort = null;
      this.lanAddress = null;
    }
    return this.status();
  }

  setLanSharing(input: unknown): Promise<LocalCollaborationServerStatus> {
    return this.enqueue(async () => {
      const parsed = localCollaborationLanSharingInputSchema.parse(input);
      const requestedMode: LocalExposureMode = parsed.enabled ? "lan_http" : "local_only";
      if (parsed.enabled === this.lanSharingEnabled && this.exposureMode === requestedMode) {
        if (
          parsed.enabled &&
          this.status().state !== "running" &&
          ((await this.scopeStore.read()).length > 0 || (await this.hasOwnerRuntimeCanvases()))
        ) {
          return this.startUnlocked();
        }
        return this.status();
      }
      this.exposureMode = requestedMode;
      if (parsed.enabled && !this.resolveLanAddress()) {
        throw new Error("local_collaboration_lan_address_unavailable");
      }
      const wasRunning = this.status().state === "running";
      if (wasRunning) {
        const stopped = await this.stopUnlocked();
        if (stopped.state !== "stopped") throw new Error("local_collaboration_network_stop_failed");
      }
      this.lanSharingEnabled = parsed.enabled;
      await this.persistNetworkState();
      if (wasRunning) return this.startUnlocked();
      if ((await this.scopeStore.read()).length > 0 || (await this.hasOwnerRuntimeCanvases())) {
        return this.startUnlocked();
      }
      return this.status();
    });
  }

  getExposureView(): DesktopServerExposureView {
    const status = this.status();
    const running = status.state === "running";
    const topology =
      this.exposureMode === "private_https"
        ? "private_https"
        : this.exposureMode === "lan_http"
          ? "lan_http"
          : "loopback_http";
    return desktopServerExposureViewSchema.parse({
      mode: this.exposureMode,
      topology,
      provider: this.exposureMode === "private_https" ? this.privateHttpsExposure.provider : null,
      lifecycle:
        this.exposureErrorCode !== null
          ? "error"
          : status.state === "starting" || status.state === "stopping"
            ? "preparing"
            : status.state === "error"
              ? "error"
              : running
                ? "ready"
                : "stopped",
      advertisedOrigin:
        running && this.exposureMode === "private_https"
          ? this.privateHttpsOrigin
          : running && this.exposureMode === "lan_http"
            ? status.lanServerBaseUrl
            : null,
      errorCode: this.exposureErrorCode,
      canActivate: status.state !== "starting" && status.state !== "stopping",
      canInvite: running && this.invitationEndpoint() !== null
    });
  }

  setExposureMode(input: unknown): Promise<DesktopServerExposureView> {
    return this.enqueue(async () => {
      const { mode } = desktopServerExposureModeInputSchema.parse(input);
      if (mode === "custom_https") {
        return desktopServerExposureViewSchema.parse({
          mode,
          topology: null,
          provider: null,
          lifecycle: "stopped",
          advertisedOrigin: null,
          errorCode: "CUSTOM_HTTPS_CONFIGURATION_REQUIRED",
          canActivate: false,
          canInvite: false
        });
      }
      const nextMode: LocalExposureMode = mode;
      const wasRunning = this.status().state === "running";
      if (wasRunning) {
        const stopped = await this.stopUnlocked();
        if (stopped.state !== "stopped") {
          this.exposureErrorCode = "SERVER_STOP_FAILED";
          return this.getExposureView();
        }
      }
      this.exposureMode = nextMode;
      this.lanSharingEnabled = nextMode === "lan_http";
      this.exposureErrorCode = null;
      await this.persistNetworkState();
      if (
        wasRunning ||
        (await this.scopeStore.read()).length > 0 ||
        (await this.hasOwnerRuntimeCanvases())
      ) {
        try {
          await this.startUnlocked();
        } catch (error) {
          this.exposureErrorCode = this.exposureCode(error);
        }
      }
      return this.getExposureView();
    });
  }

  invitationEndpoint(): DeploymentEndpoint | null {
    const selection = this.selection;
    if (!selection || !this.isTrustedSelection(selection)) return null;
    return this.managementEndpoint();
  }

  private managementEndpoint(): DeploymentEndpoint | null {
    const status = this.status();
    if (status.state !== "running") return null;
    if (this.exposureMode === "private_https") {
      if (!this.privateHttpsOrigin) return null;
      return deploymentEndpointSchema.parse({
        topology: "private_https",
        serverOrigin: this.privateHttpsOrigin,
        allowedClientOrigins: [this.privateHttpsOrigin],
        tlsTrust: "system_ca"
      });
    }
    if (this.exposureMode === "lan_http") {
      if (!status.lanServerBaseUrl) return null;
      return deploymentEndpointSchema.parse({
        topology: "lan_http",
        serverOrigin: status.lanServerBaseUrl,
        allowedClientOrigins: [status.lanServerBaseUrl],
        tlsTrust: "not_applicable"
      });
    }
    const profile = this.serverProfile();
    return deploymentEndpointSchema.parse({
      topology: "loopback_http",
      serverOrigin: profile.serverBaseUrl,
      allowedClientOrigins: [profile.serverBaseUrl],
      tlsTrust: "not_applicable"
    });
  }

  getScopeCatalog(): Promise<LocalCollaborationScopeCatalog> {
    return this.enqueue(() => this.getScopeCatalogUnlocked());
  }

  setTrustedScopes(input: unknown): Promise<LocalCollaborationScopeCatalog> {
    return this.enqueue(async () => {
      const parsed = localCollaborationScopeSelectionInputSchema.parse(input);
      const catalog = await this.buildScopeCatalog(parsed.scopes);
      if (catalog.selectedCount !== parsed.scopes.length) {
        throw new Error("local_collaboration_scope_selection_unknown");
      }
      const wasRunning = this.status().state === "running";
      await this.scopeStore.write(parsed.scopes);
      if (wasRunning) {
        const stopped = await this.stopUnlocked();
        if (stopped.state !== "stopped") {
          throw new Error("local_collaboration_scope_reload_stop_failed");
        }
        if (parsed.scopes.length > 0 || (await this.hasOwnerRuntimeCanvases())) {
          const restarted = await this.startUnlocked();
          if (restarted.state !== "running") {
            throw new Error("local_collaboration_scope_reload_failed");
          }
        }
      } else if (parsed.scopes.length > 0) {
        const started = await this.startUnlocked();
        if (started.state !== "running") throw new Error("local_collaboration_scope_start_failed");
      } else if (await this.hasOwnerRuntimeCanvases()) {
        const started = await this.startUnlocked();
        if (started.state !== "running") throw new Error("local_owner_runtime_start_failed");
      }
      return this.getScopeCatalogUnlocked();
    });
  }

  currentSelectionIsTrusted(): boolean {
    return this.selection !== null && this.isTrustedSelection(this.selection);
  }

  ownsLocalProfile(profileId: string): boolean {
    const status = this.status();
    if (status.state !== "running" || !status.profile || !this.controller) return false;
    return this.controller
      .listTrustedProjectScopes({ profileId: status.profile.profileId })
      .some((scope) => localProfileIdForProject(scope.projectId) === profileId);
  }

  recognizesLocalProfile(profileId: string): boolean {
    return isLocalCollaborationProfileId(profileId);
  }

  listActiveTrustedScopes(): readonly LoopbackTrustedProjectScope[] {
    const profile = this.requireRunningProfile();
    return this.controller!.listTrustedProjectScopes({ profileId: profile.profileId });
  }

  registerCurrentProject(actor: { kind: "human"; id: string }): LoopbackProjectRegistrationView {
    const selection = this.requireSelection();
    const profile = this.requireRunningProfile();
    const matches = this.controller!.listTrustedProjectScopes({
      profileId: profile.profileId
    }).filter(
      (scope) =>
        scope.projectId === selection.authorityProjectId && scope.canvasId === selection.canvasId
    );
    if (matches.length !== 1) throw new Error("local_collaboration_trusted_scope_ambiguous");
    const scope = matches[0];
    return loopbackProjectRegistrationViewSchema.parse(
      this.controller!.registerTrustedProject(actor, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        profileId: profile.profileId
      })
    );
  }

  localProfile() {
    const selection = this.selection;
    if (!selection || this.localPort === null) return null;
    if (this.status().state === "running" && !this.isTrustedSelection(selection)) return null;
    const endpoint = this.invitationEndpoint();
    if (!endpoint) return null;
    const profile = this.connectionProfileFor(selection);
    return collaborationConnectionProfileSchema.parse({
      ...profile,
      serverBaseUrl: endpoint.serverOrigin,
      projectId: selection.authorityProjectId,
      allowInsecureTransport:
        endpoint.topology === "loopback_http" || endpoint.topology === "lan_http",
      endpoint
    });
  }

  localProfileForId(profileId: string) {
    const authorityProjectId = this.authorityProjectIdForLocalProfile(profileId);
    if (!authorityProjectId || this.localPort === null) return null;
    const endpoint = this.managementEndpoint();
    if (!endpoint) return null;
    const profile = this.connectionProfileFor({ authorityProjectId });
    return collaborationConnectionProfileSchema.parse({
      ...profile,
      serverBaseUrl: endpoint.serverOrigin,
      projectId: authorityProjectId,
      allowInsecureTransport:
        endpoint.topology === "loopback_http" || endpoint.topology === "lan_http",
      endpoint
    });
  }

  registerLocalProfile(
    profileId: string,
    actor: { kind: "human"; id: string }
  ): LoopbackProjectRegistrationView {
    const authorityProjectId = this.authorityProjectIdForLocalProfile(profileId);
    if (!authorityProjectId) throw new Error("local_collaboration_profile_not_hosted");
    const profile = this.requireRunningProfile();
    const scopes = this.controller!.listTrustedProjectScopes({ profileId: profile.profileId })
      .filter((scope) => scope.projectId === authorityProjectId)
      .sort((left, right) => left.canvasId.localeCompare(right.canvasId));
    const scope = scopes[0];
    if (!scope) throw new Error("local_collaboration_profile_not_hosted");
    return loopbackProjectRegistrationViewSchema.parse(
      this.controller!.registerTrustedProject(actor, {
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        canvasId: scope.canvasId,
        profileId: profile.profileId
      })
    );
  }

  async createSelfHostedDeploymentSource(
    target: DeploymentTargetDraft
  ): Promise<DeploymentBundleSource> {
    if (target.endpoint.topology === "loopback_http" || target.endpoint.topology === "lan_http") {
      throw new DeploymentBundleUnavailableError(
        "invalid_project",
        "deployment_bundle_loopback_not_supported"
      );
    }
    const profileId = `deployment-${createHash("sha256")
      .update(target.endpoint.serverOrigin)
      .digest("hex")
      .slice(0, 32)}`;
    const { getOperatorControlService } = await import(
      "../operatorControl/operatorControlHandlers.js"
    );
    const operatorService = getOperatorControlService();
    const operatorToken = await operatorService.ensureDeploymentProfile({
      profile: {
        profileId,
        displayName: `${target.displayName} operator`,
        serverBaseUrl: target.endpoint.serverOrigin,
        allowInsecureTransport: false,
        endpoint: target.endpoint,
        operatorId: "desktop-self-host-admin"
      },
      operatorId: "desktop-self-host-admin"
    });
    return {
      operatorToken,
      config: parseServerConfig({
        version: "server-config/v2",
        transport: {
          mode: "direct_https",
          listener: {
            protocol: "https",
            host: "0.0.0.0",
            port: 443,
            tls: {
              certificatePath: "/run/planweave/input/tls/server.crt",
              privateKeyPath: "/run/planweave/input/tls/server.key"
            }
          },
          advertisedOrigin: target.endpoint.serverOrigin
        },
        deployment: target.endpoint,
        allowedClientOrigins: target.endpoint.allowedClientOrigins,
        dataDirectory: "/var/lib/planweave-server",
        trustedProjects: [],
        operatorCredentials: [
          {
            operatorId: "desktop-self-host-admin",
            tokenSha256: hashOperatorToken(operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      })
    };
  }

  private requireSelection(): ResolvedSelection {
    if (!this.selection) throw new Error("local_collaboration_selection_required");
    return this.selection;
  }

  private persistNetworkState(): Promise<void> {
    return this.networkStore.write({
      lanSharingEnabled: this.exposureMode === "lan_http",
      exposureMode: this.exposureMode,
      preferredPort: this.preferredPort
    });
  }

  private requireRunningProfile(): LoopbackServerProfile {
    const status = this.status();
    if (status.state !== "running" || !status.profile)
      throw new Error("loopback_server_not_running");
    return status.profile;
  }

  private isTrustedSelection(selection: ResolvedSelection): boolean {
    const status = this.status();
    if (status.state !== "running" || !status.profile || !this.controller) return false;
    return this.controller
      .listTrustedProjectScopes({ profileId: status.profile.profileId })
      .some(
        (scope) =>
          scope.projectId === selection.authorityProjectId && scope.canvasId === selection.canvasId
      );
  }

  private serverProfile(): LoopbackServerProfile {
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    const serverBaseUrl =
      this.exposureMode === "private_https"
        ? this.privateHttpsOrigin
        : `http://127.0.0.1:${localPort}/`;
    if (!serverBaseUrl) throw new Error("private_https_advertised_origin_unavailable");
    return loopbackServerProfileSchema.parse({
      profileId: localServerProfileId,
      displayName: "Local collaboration server",
      serverBaseUrl,
      allowInsecureTransport: this.exposureMode !== "private_https"
    });
  }

  private connectionProfileFor(
    selection: Pick<ResolvedSelection, "authorityProjectId">
  ): LoopbackServerProfile {
    return loopbackServerProfileSchema.parse({
      ...this.serverProfile(),
      profileId: localProfileIdForProject(selection.authorityProjectId)
    });
  }

  private authorityProjectIdForLocalProfile(profileId: string): string | null {
    const status = this.status();
    if (status.state !== "running" || !status.profile || !this.controller) return null;
    const authorityProjectIds = new Set(
      this.controller
        .listTrustedProjectScopes({ profileId: status.profile.profileId })
        .filter((scope) => localProfileIdForProject(scope.projectId) === profileId)
        .map((scope) => scope.projectId)
    );
    return authorityProjectIds.size === 1 ? [...authorityProjectIds][0]! : null;
  }

  private async resolveTrustedProjects(): Promise<ServerConfig["trustedProjects"]> {
    const selectedScopes = await this.scopeStore.read();
    if (selectedScopes.length === 0) return [];
    const projects = await this.projects.listProjects();
    const trustedProjects = new Map<string, ServerConfig["trustedProjects"][number]>();
    for (const selected of selectedScopes) {
      const matches = projects.filter((project) => project.projectId === selected.projectId);
      if (matches.length !== 1) throw new Error("local_collaboration_scope_selection_unknown");
      const project = matches[0]!;
      if (!project.taskCanvases.some((canvas) => canvas.canvasId === selected.canvasId)) {
        throw new Error("local_collaboration_scope_selection_unknown");
      }
      const authorityProjectId = await this.projects.resolveAuthorityProjectId(
        project.rootPath,
        selected.canvasId
      );
      const workspaceId = localWorkspaceIdForProject(authorityProjectId);
      const key = `${workspaceId}\0${authorityProjectId}\0${selected.canvasId}`;
      const existing = trustedProjects.get(key);
      if (existing && existing.projectRoot !== project.rootPath) {
        throw new Error("local_collaboration_project_catalog_ambiguous");
      }
      trustedProjects.set(key, {
        workspaceId,
        projectId: authorityProjectId,
        canvasId: selected.canvasId,
        trustAllDeclaredCanvases: false,
        projectRoot: project.rootPath
      });
    }
    if (trustedProjects.size === 0) {
      throw new Error("local_collaboration_trusted_project_required");
    }
    return [...trustedProjects.values()];
  }

  private async resolveOwnerTrustedProjects(): Promise<ServerConfig["trustedProjects"]> {
    const projects = new Map<string, ServerConfig["trustedProjects"][number]>();
    for (const project of await this.projects.listProjects()) {
      for (const canvas of project.taskCanvases) {
        if (canvas.packageDir === null) continue;
        const projectId = await this.projects.resolveAuthorityProjectId(
          project.rootPath,
          canvas.canvasId
        );
        const workspaceId = localWorkspaceIdForProject(projectId);
        const key = this.ownerRuntimeScopeKey({
          workspaceId,
          projectId,
          canvasId: canvas.canvasId
        });
        const existing = projects.get(key);
        if (existing && existing.projectRoot !== project.rootPath) {
          throw new Error("local_owner_runtime_project_catalog_ambiguous");
        }
        projects.set(key, {
          workspaceId,
          projectId,
          canvasId: canvas.canvasId,
          trustAllDeclaredCanvases: false,
          projectRoot: project.rootPath
        });
      }
    }
    if (projects.size === 0) throw new Error("local_owner_runtime_project_required");
    return [...projects.values()];
  }

  private async hasOwnerRuntimeCanvases(): Promise<boolean> {
    return (await this.projects.listProjects()).some((project) =>
      project.taskCanvases.some((canvas) => canvas.packageDir !== null)
    );
  }

  private ownerRuntimeScopeKey(input: {
    workspaceId?: string;
    authorityProjectId?: string;
    projectId?: string;
    canvasId: string;
  }): string {
    const projectId = input.projectId ?? input.authorityProjectId;
    if (!projectId) throw new Error("local_owner_runtime_project_id_required");
    return `${input.workspaceId ?? localWorkspaceIdForProject(projectId)}\0${projectId}\0${input.canvasId}`;
  }

  private async getScopeCatalogUnlocked(): Promise<LocalCollaborationScopeCatalog> {
    return this.buildScopeCatalog(await this.scopeStore.read());
  }

  private async buildScopeCatalog(
    selectedScopes: readonly { projectId: string; canvasId: string }[]
  ): Promise<LocalCollaborationScopeCatalog> {
    const selected = new Set(
      selectedScopes.map((scope) => `${scope.projectId}\0${scope.canvasId}`)
    );
    const projects = (await this.projects.listProjects()).map((project) => {
      const canvases = project.taskCanvases.map((canvas) => {
        const isSelected = selected.has(`${project.projectId}\0${canvas.canvasId}`);
        return {
          canvasId: canvas.canvasId,
          name: canvas.name,
          selected: isSelected,
          current:
            this.selection?.desktopProjectId === project.projectId &&
            this.selection.canvasId === canvas.canvasId
        };
      });
      return {
        projectId: project.projectId,
        name: project.name,
        selectedCanvasCount: canvases.filter((canvas) => canvas.selected).length,
        canvases
      };
    });
    return {
      projects,
      selectedCount: projects.reduce((count, project) => count + project.selectedCanvasCount, 0)
    };
  }

  private async ensureOperatorToken(): Promise<void> {
    const storedToken = await this.vault.getOperatorToken(localOperatorCredentialKey);
    this.operatorToken = storedToken ?? null;
    if (this.operatorToken) return;
    const token = `pw_operator_${randomBytes(32).toString("base64url")}`;
    this.operatorToken = token;
    await this.vault.setOperatorToken(localOperatorCredentialKey, token, "desktop-local-admin");
  }

  private async syncMainOwnedOperatorProfile(): Promise<void> {
    const endpoint = this.managementEndpoint();
    if (!endpoint || !this.operatorToken) return;
    await this.syncOperatorProfile({
      profile: {
        profileId: localOperatorCredentialKey,
        displayName: "PlanWeave local server",
        serverBaseUrl: endpoint.serverOrigin,
        allowInsecureTransport:
          endpoint.topology === "loopback_http" || endpoint.topology === "lan_http",
        endpoint,
        operatorId: "desktop-local-admin"
      },
      operatorId: "desktop-local-admin",
      operatorToken: this.operatorToken
    });
  }

  private createConfig(
    profile: LoopbackServerProfile,
    trustedProjects: ServerConfig["trustedProjects"]
  ): ServerConfig {
    if (!this.operatorToken) throw new Error("local_collaboration_operator_credential_unavailable");
    const localPort = this.localPort;
    if (localPort === null) throw new Error("local_collaboration_port_allocation_required");
    const dataDirectory = desktopHomePaths().localCollaborationServerDir;
    if (this.exposureMode === "private_https") {
      const advertisedOrigin = this.privateHttpsOrigin;
      if (!advertisedOrigin) throw new Error("private_https_advertised_origin_unavailable");
      const endpoint = deploymentEndpointSchema.parse({
        topology: "private_https",
        serverOrigin: advertisedOrigin,
        allowedClientOrigins: [advertisedOrigin],
        tlsTrust: "system_ca"
      });
      return parseServerConfig({
        version: "server-config/v2",
        transport: {
          mode: "reverse_proxy_https",
          listener: { protocol: "http", host: "127.0.0.1", port: localPort },
          advertisedOrigin
        },
        deployment: endpoint,
        allowedClientOrigins: endpoint.allowedClientOrigins,
        dataDirectory,
        trustedProjects,
        operatorCredentials: [
          {
            operatorId: "desktop-local-admin",
            tokenSha256: hashOperatorToken(this.operatorToken),
            projectIds: [],
            serverAdmin: true
          }
        ]
      });
    }
    const advertisedOrigin =
      this.lanSharingEnabled && this.lanAddress
        ? new URL(`http://${this.lanAddress}:${localPort}/`).origin
        : new URL(profile.serverBaseUrl).origin;
    const deployment = this.lanSharingEnabled
      ? null
      : deploymentEndpointSchema.parse({
          topology: "loopback_http",
          serverOrigin: advertisedOrigin,
          allowedClientOrigins: [advertisedOrigin],
          tlsTrust: "not_applicable"
        });
    return parseServerConfig({
      version: "server-config/v2" as const,
      transport: this.lanSharingEnabled
        ? {
            mode: "lan_http" as const,
            listener: { protocol: "http" as const, host: "0.0.0.0", port: localPort },
            advertisedOrigin,
            acknowledgeInsecureLan: true as const
          }
        : {
            mode: "loopback_http" as const,
            listener: { protocol: "http" as const, host: "127.0.0.1", port: localPort },
            advertisedOrigin
          },
      deployment,
      allowedClientOrigins: null,
      dataDirectory,
      trustedProjects,
      operatorCredentials: [
        {
          operatorId: "desktop-local-admin",
          tokenSha256: hashOperatorToken(this.operatorToken),
          projectIds: [],
          serverAdmin: true
        }
      ]
    });
  }

  private exposureCode(error: unknown): DesktopServerExposureErrorCode {
    if (error instanceof ManagedPrivateHttpsExposureError) return error.code;
    if (error instanceof AggregateError) {
      for (const nestedError of error.errors) {
        const code = this.exposureCode(nestedError);
        if (code !== "SERVER_START_FAILED") return code;
      }
    }
    if (error && typeof error === "object" && "cause" in error) {
      const cause = (error as { cause?: unknown }).cause;
      if (cause !== undefined && cause !== error) return this.exposureCode(cause);
    }
    return "SERVER_START_FAILED";
  }
}
