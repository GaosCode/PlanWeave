import type { AgentHostStateRepository } from "../state/agentHostState.js";
import type { HostConnectionStatusPublisher } from "../transport/connectionStatus.js";
import {
  DEFAULT_HOST_TRANSPORT_LIMITS,
  type HostTransport,
  type HostTransportStatusListener
} from "../transport/hostTransport.js";

export const AGENT_HOST_SHUTDOWN_REQUIRES_PROCESS_EXIT =
  "agent_host_shutdown_requires_process_exit";

export class AgentHostCompositionShutdownError extends AggregateError {
  constructor(
    readonly runErrors: readonly unknown[],
    readonly shutdownErrors: readonly unknown[]
  ) {
    super([...runErrors, ...shutdownErrors], "agent_host_composition_shutdown_failed", {
      cause: runErrors[0] ?? shutdownErrors[0]
    });
  }
}

export interface AgentHostComposition {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  subscribeStatus(listener: HostTransportStatusListener): () => void;
}

export type AgentHostCompositionOptions = {
  state: Pick<AgentHostStateRepository, "close">;
  transport: Pick<HostTransport, "start" | "stop" | "subscribe">;
  statusPublisher?: HostConnectionStatusPublisher;
  closeResources?: () => void | Promise<void>;
};

function containsShutdownTimeout(error: unknown): boolean {
  if (error instanceof Error && error.message === "agent_host_transport_shutdown_timeout") {
    return true;
  }
  return error instanceof AggregateError ? error.errors.some(containsShutdownTimeout) : false;
}

export function composeAgentHost(options: AgentHostCompositionOptions): AgentHostComposition {
  let startAttempt: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let unsubscribeStatus: (() => void) | undefined;
  const { statusPublisher } = options;

  const composition: AgentHostComposition = {
    subscribeStatus(listener) {
      return options.transport.subscribe(listener);
    },
    start() {
      if (shutdownPromise) {
        return Promise.reject(new Error("agent_host_composition_already_shutdown"));
      }
      startAttempt ??= Promise.resolve().then(() => {
        if (statusPublisher) {
          unsubscribeStatus = options.transport.subscribe((status) =>
            statusPublisher.publish(status)
          );
        }
        return options.transport.start();
      });
      startPromise ??= startAttempt.catch(async (error: unknown) => {
        await composition.shutdown();
        throw error;
      });
      return startPromise;
    },
    shutdown() {
      shutdownPromise ??= Promise.resolve().then(async () => {
        const errors: unknown[] = [];
        const startupErrors: unknown[] = [];
        try {
          await startAttempt;
        } catch (error) {
          startupErrors.push(error);
        }

        let transportStopped = false;
        try {
          await options.transport.stop();
          transportStopped = true;
        } catch (error) {
          if (containsShutdownTimeout(error)) {
            throw new AggregateError(
              [...startupErrors, error],
              AGENT_HOST_SHUTDOWN_REQUIRES_PROCESS_EXIT,
              {
                cause: error
              }
            );
          }
          errors.push(error);
        } finally {
          unsubscribeStatus?.();
        }

        if (statusPublisher && startAttempt) {
          const timeout = new Error("agent_host_connection_status_shutdown_timeout");
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              statusPublisher.flush(),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(timeout),
                  DEFAULT_HOST_TRANSPORT_LIMITS.shutdownTimeoutMs
                );
              })
            ]);
          } catch (error) {
            if (error === timeout) {
              throw new AggregateError(
                [...startupErrors, ...errors, timeout],
                AGENT_HOST_SHUTDOWN_REQUIRES_PROCESS_EXIT,
                {
                  cause: timeout
                }
              );
            }
            errors.push(error);
          } finally {
            clearTimeout(timer);
          }
        }

        if (transportStopped) {
          try {
            await options.state.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            await options.closeResources?.();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) {
          throw new AgentHostCompositionShutdownError(startupErrors, errors);
        }
      });
      return shutdownPromise;
    }
  };
  return composition;
}

export function createNoopAgentHostComposition(): AgentHostComposition {
  return composeAgentHost({
    state: {
      close() {}
    },
    transport: {
      start() {},
      stop() {},
      subscribe(listener) {
        listener({ state: "stopped" });
        return () => {};
      }
    }
  });
}
