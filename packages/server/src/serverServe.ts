import { readFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import type { ServerConfig } from "./config.js";
import { serverConfigSummary } from "./config.js";
import type {
  ExposureLeaseStorePort,
  ExposureOwnership,
  ServerExposureLifecyclePort
} from "./exposure/types.js";
import { serverPackageVersion } from "./packageInfo.js";
import { ServerReadinessController, type ServerReadiness } from "./readiness.js";
import {
  createDistributedServerComposition,
  type DistributedServerComposition
} from "./serverComposition.js";
import type { TrustedProjectControlPort } from "./trustedProjectControl.js";
import type { HumanMembershipService } from "./identity/index.js";

export type DistributedServerExposureRuntime = {
  lifecycle: ServerExposureLifecyclePort;
  close?(): void | Promise<void>;
};

export type DistributedServerServeOptions = {
  exposure?: DistributedServerExposureRuntime;
  createExposureLifecycle?: (leases: ExposureLeaseStorePort) => ServerExposureLifecyclePort;
  /** Main-process-only Owner runtime scope; collaboration remains constrained by config.trustedProjects. */
  ownerTrustedProjects?: ServerConfig["trustedProjects"];
};

export type DistributedServerProcess = {
  readonly version: string;
  readonly publicUrl: string;
  /** Main-process-only port; it never exposes paths, tokens, or transport control. */
  readonly trustedProjectControl: TrustedProjectControlPort;
  /** Main-process-only owner bootstrap authority; never attached to an HTTP route. */
  readonly localAdminHumanIdentity: Pick<HumanMembershipService, "bootstrapOwner">;
  readiness(): ServerReadiness;
  close(): Promise<void>;
};

async function createListener(config: ServerConfig): Promise<HttpServer> {
  if (config.transport.listener.protocol === "http") return createHttpServer();
  const tls = config.transport.listener.tls;
  const [certificate, privateKey] = await Promise.all([
    readFile(tls.certificatePath),
    readFile(tls.privateKeyPath)
  ]);
  return createHttpsServer({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" });
}

async function listen(server: HttpServer, config: ServerConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.transport.listener.port, config.transport.listener.host);
  });
}

async function stopListenerBounded(
  server: HttpServer,
  sockets: ReadonlySet<Socket>,
  timeoutMs: number
): Promise<void> {
  if (!server.listening) {
    for (const socket of sockets) socket.destroy();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeError: Error | undefined;
  let timedOut = false;
  const closed = new Promise<void>((resolve) => {
    server.close((error) => {
      closeError = error;
      resolve();
    });
  });
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      for (const socket of sockets) socket.destroy();
      resolve();
    }, timeoutMs);
  });
  await Promise.race([closed, timeout]);
  if (timer) clearTimeout(timer);
  if (timedOut) {
    for (const socket of sockets) socket.destroy();
  }
  await closed;
  if (closeError) throw closeError;
}

export async function serveDistributedServer(
  config: ServerConfig,
  options: DistributedServerServeOptions = {}
): Promise<DistributedServerProcess> {
  const readiness = new ServerReadinessController();
  let server: HttpServer;
  try {
    server = await createListener(config);
  } catch (error) {
    try {
      await options.exposure?.close?.();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "distributed_server_listener_creation_cleanup_failed",
        { cause: error }
      );
    }
    throw error;
  }
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let composition: DistributedServerComposition | undefined;
  let exposure = options.exposure;
  let ownership: ExposureOwnership | undefined;
  try {
    composition = await createDistributedServerComposition({
      httpServer: server,
      config,
      readiness,
      ...(options.ownerTrustedProjects
        ? { ownerTrustedProjects: options.ownerTrustedProjects }
        : {})
    });
    if (
      !exposure &&
      config.transport.mode === "reverse_proxy_https" &&
      options.createExposureLifecycle
    ) {
      exposure = {
        lifecycle: options.createExposureLifecycle(composition.exposureLeaseStore)
      };
    }
    await exposure?.lifecycle.inspect(config);
    await listen(server, config);
    const schemaVersion = composition.readiness().schemaVersion;
    readiness.transition("listening", schemaVersion);
    const prepared = await exposure?.lifecycle.activate(config);
    ownership = prepared?.ownership;
    readiness.transition("ready", schemaVersion);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (ownership?.createdByActivation) {
      try {
        await exposure?.lifecycle.release(ownership);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await stopListenerBounded(server, sockets, config.limits.shutdownTimeoutMs);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await composition?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await exposure?.close?.();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "distributed_server_serve_startup_and_cleanup_failed",
        { cause: error }
      );
    }
    throw error;
  }

  const activeComposition = composition;
  let closePromise: Promise<void> | undefined;
  return {
    version: serverPackageVersion,
    publicUrl: serverConfigSummary(config).advertisedOrigin,
    trustedProjectControl: activeComposition.trustedProjectControl,
    localAdminHumanIdentity: activeComposition.localAdminHumanIdentity,
    readiness: () => readiness.readiness(),
    close() {
      closePromise ??= (async () => {
        activeComposition.beginDrain();
        const errors: unknown[] = [];
        if (ownership) {
          try {
            await exposure?.lifecycle.release(ownership);
          } catch (error) {
            errors.push(error);
          }
        }
        const transportResults = await Promise.allSettled([
          stopListenerBounded(server, sockets, config.limits.shutdownTimeoutMs),
          activeComposition.drainTransports()
        ]);
        for (const result of transportResults) {
          if (result.status === "rejected") errors.push(result.reason);
        }
        try {
          await activeComposition.close();
        } catch (error) {
          errors.push(error);
        }
        try {
          await exposure?.close?.();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "distributed_server_serve_cleanup_failed");
        }
      })();
      return closePromise;
    }
  };
}
