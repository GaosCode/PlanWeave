import {
  isLoopbackHostname,
  isPrivateNetworkHostname
} from "@planweave-ai/collaboration-protocol/connection";
import {
  loopbackProjectRegistrationRequestSchema,
  loopbackProjectRegistrationViewSchema,
  loopbackServerLifecycleRequestSchema,
  loopbackServerStatusSchema,
  loopbackTrustedProjectListRequestSchema,
  loopbackTrustedProjectScopeSchema,
  type LoopbackProjectRegistrationRequest,
  type LoopbackProjectRegistrationView,
  type LoopbackServerLifecycleRequest,
  type LoopbackServerProfile,
  type LoopbackServerStatus,
  type LoopbackTrustedProjectScope
} from "@planweave-ai/collaboration-protocol/loopback";
import type { ActorRef } from "@planweave-ai/collaboration-protocol/core/primitives";
import { serverConfigSchema, type ServerConfig } from "./config.js";
import type { DistributedServerProcess } from "./serverServe.js";
import { serveDistributedServer } from "./serverServe.js";

export type LoopbackServerControllerOptions = {
  /** Desktop main supplies a fixed, local configuration factory; renderer never supplies config or paths. */
  createConfig(profile: LoopbackServerProfile): ServerConfig;
  serve?(config: ServerConfig): Promise<DistributedServerProcess>;
  /** Main-only lifecycle observation; callers must redact before crossing a process boundary. */
  onLifecycleError?(error: unknown): void;
  clock?: () => Date;
};

/**
 * Main-process-only lifecycle wrapper. It has no HTTP route and accepts no command,
 * filesystem, secret, or arbitrary network authority from callers.
 */
export class LoopbackServerController {
  private process: DistributedServerProcess | undefined;
  private profile: LoopbackServerProfile | undefined;
  private startedAt: string | null = null;
  private state: LoopbackServerStatus["state"] = "stopped";
  private reason: LoopbackServerStatus["reason"] = null;

  constructor(private readonly options: LoopbackServerControllerOptions) {}

  listTrustedProjectScopes(rawRequest: unknown): readonly LoopbackTrustedProjectScope[] {
    const request = loopbackTrustedProjectListRequestSchema.parse(rawRequest);
    return this.processForProfile(
      request.profileId
    ).trustedProjectControl.listTrustedProjectScopes();
  }

  resolveTrustedProjectScope(rawRequest: unknown): LoopbackTrustedProjectScope {
    const request = loopbackProjectRegistrationRequestSchema.parse(rawRequest);
    const scope = this.processForProfile(
      request.profileId
    ).trustedProjectControl.resolveTrustedProjectScope(scopeFromRegistration(request));
    if (!scope) throw new Error("loopback_registration_not_trusted");
    return scope;
  }

  bootstrapOwner(
    rawRegistration: unknown,
    rawRequest: unknown
  ): ReturnType<DistributedServerProcess["localAdminHumanIdentity"]["bootstrapOwner"]> {
    const registration = loopbackProjectRegistrationRequestSchema.parse(rawRegistration);
    const process = this.processForProfile(registration.profileId);
    const scope = process.trustedProjectControl.resolveTrustedProjectScope(
      scopeFromRegistration(registration)
    );
    if (!scope) throw new Error("loopback_registration_not_trusted");
    return process.localAdminHumanIdentity.bootstrapOwner(scope.projectId, rawRequest);
  }

  registerTrustedProject(actor: ActorRef, rawRequest: unknown): LoopbackProjectRegistrationView {
    const request = loopbackProjectRegistrationRequestSchema.parse(rawRequest);
    const scope = this.processForProfile(
      request.profileId
    ).trustedProjectControl.assertTrustedProjectAdministration(
      actor,
      scopeFromRegistration(request)
    );
    return loopbackProjectRegistrationViewSchema.parse({
      ...scope,
      profileId: request.profileId,
      registeredAt: (this.options.clock ?? (() => new Date()))().toISOString()
    });
  }

  status(): LoopbackServerStatus {
    return loopbackServerStatusSchema.parse({
      profile: this.profile ?? null,
      state: this.state,
      startedAt: this.startedAt,
      reason: this.reason
    });
  }

  async apply(rawRequest: unknown): Promise<LoopbackServerStatus> {
    const request = loopbackServerLifecycleRequestSchema.parse(rawRequest);
    return request.action === "start" ? this.start(request) : this.stop(request);
  }

  private assertFixedLoopbackConfig(profile: LoopbackServerProfile): ServerConfig {
    const config = serverConfigSchema.parse(this.options.createConfig(profile));
    const profileUrl = new URL(profile.serverBaseUrl);
    const configUrl = new URL(config.transport.advertisedOrigin);
    const expectedPort = Number(profileUrl.port || (profileUrl.protocol === "https:" ? 443 : 80));
    const fixedLanConfig =
      config.transport.mode === "lan_http" &&
      config.transport.listener.host === "0.0.0.0" &&
      isPrivateNetworkHostname(configUrl.hostname) &&
      !isLoopbackHostname(configUrl.hostname);
    const fixedLoopbackConfig =
      config.transport.mode === "loopback_http" &&
      isLoopbackHostname(config.transport.listener.host) &&
      isLoopbackHostname(configUrl.hostname) &&
      configUrl.origin === profileUrl.origin;
    const fixedReverseProxyConfig =
      config.transport.mode === "reverse_proxy_https" &&
      config.transport.listener.protocol === "http" &&
      config.transport.listener.host === "127.0.0.1" &&
      profileUrl.protocol === "https:" &&
      profile.allowInsecureTransport === false &&
      configUrl.origin === profileUrl.origin;
    if (
      (!fixedReverseProxyConfig && config.transport.listener.port !== expectedPort) ||
      (!fixedLanConfig && !fixedLoopbackConfig && !fixedReverseProxyConfig)
    ) {
      throw new Error("loopback_profile_configuration_mismatch");
    }
    return config;
  }

  private processForProfile(profileId: string): DistributedServerProcess {
    if (!this.process) throw new Error("loopback_server_not_running");
    if (this.profile?.profileId !== profileId) throw new Error("loopback_profile_mismatch");
    return this.process;
  }

  private async start(
    request: Extract<LoopbackServerLifecycleRequest, { action: "start" }>
  ): Promise<LoopbackServerStatus> {
    if (this.process) {
      if (this.profile?.profileId !== request.profile.profileId)
        throw new Error("loopback_profile_already_running");
      return this.status();
    }
    this.profile = request.profile;
    this.state = "starting";
    this.reason = null;
    try {
      const serve = this.options.serve ?? serveDistributedServer;
      this.process = await serve(this.assertFixedLoopbackConfig(request.profile));
      this.startedAt = (this.options.clock ?? (() => new Date()))().toISOString();
      this.state = "running";
      return this.status();
    } catch (error) {
      this.options.onLifecycleError?.(error);
      this.process = undefined;
      this.startedAt = null;
      this.state = "error";
      this.reason = "start_failed";
      return this.status();
    }
  }

  private async stop(
    request: Extract<LoopbackServerLifecycleRequest, { action: "stop" }>
  ): Promise<LoopbackServerStatus> {
    if (!this.process) return this.status();
    if (this.profile?.profileId !== request.profileId) throw new Error("loopback_profile_mismatch");
    this.state = "stopping";
    try {
      await this.process.close();
      this.process = undefined;
      this.profile = undefined;
      this.startedAt = null;
      this.state = "stopped";
      this.reason = null;
      return this.status();
    } catch (error) {
      this.options.onLifecycleError?.(error);
      this.state = "error";
      this.reason = "stop_failed";
      return this.status();
    }
  }
}

function scopeFromRegistration(
  request: LoopbackProjectRegistrationRequest
): LoopbackTrustedProjectScope {
  return loopbackTrustedProjectScopeSchema.parse({
    workspaceId: request.workspaceId,
    projectId: request.projectId,
    canvasId: request.canvasId
  });
}

export type { LoopbackProjectRegistrationRequest };
