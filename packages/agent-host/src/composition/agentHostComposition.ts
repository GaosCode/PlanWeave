import type { AgentHostStateRepository } from "../state/agentHostState.js";
import type { HostTransport, HostTransportStatusListener } from "../transport/hostTransport.js";

export interface AgentHostComposition {
  start(): Promise<void>;
  shutdown(): Promise<void>;
  subscribeStatus(listener: HostTransportStatusListener): () => void;
}

export type AgentHostCompositionOptions = {
  state: Pick<AgentHostStateRepository, "close">;
  transport: Pick<HostTransport, "start" | "stop" | "subscribe">;
  closeResources?: () => void | Promise<void>;
};

function containsShutdownTimeout(error: unknown): boolean {
  if (error instanceof Error && error.message === "agent_host_transport_shutdown_timeout") {
    return true;
  }
  return error instanceof AggregateError ? error.errors.some(containsShutdownTimeout) : false;
}

export function composeAgentHost(options: AgentHostCompositionOptions): AgentHostComposition {
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  return {
    subscribeStatus(listener) {
      return options.transport.subscribe(listener);
    },
    start() {
      if (shutdownPromise) {
        return Promise.reject(new Error("agent_host_composition_already_shutdown"));
      }
      startPromise ??= Promise.resolve().then(() => options.transport.start());
      return startPromise;
    },
    shutdown() {
      shutdownPromise ??= (async () => {
        const errors: unknown[] = [];
        try {
          if (startPromise) {
            await startPromise;
          }
          await options.transport.stop();
        } catch (error) {
          if (containsShutdownTimeout(error)) {
            throw new AggregateError([error], "agent_host_shutdown_requires_process_exit", {
              cause: error
            });
          }
          throw new AggregateError([error], "agent_host_composition_shutdown_failed", {
            cause: error
          });
        }
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
        if (errors.length > 0) {
          throw new AggregateError(errors, "agent_host_composition_shutdown_failed");
        }
      })();
      return shutdownPromise;
    }
  };
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
