import {
  createAcpConnection,
  type CreateAcpConnectionOptions,
  type AcpConnection
} from "./acpConnection.js";
import { createDedicatedAcpConnectionLease } from "./acpConnectionLease.js";
import type {
  AcpConnectionAcquireRequest,
  AcpConnectionLease,
  AcpConnectionProvider
} from "./acpConnectionProvider.js";

export type DedicatedAcpConnectionProviderOptions = {
  readonly connect?: (options: CreateAcpConnectionOptions) => AcpConnection;
};

export function createDedicatedAcpConnectionProvider(
  options: DedicatedAcpConnectionProviderOptions = {}
): AcpConnectionProvider {
  const connect = options.connect ?? createAcpConnection;
  return {
    acquire(request: AcpConnectionAcquireRequest): Promise<AcpConnectionLease> {
      return Promise.resolve(
        createDedicatedAcpConnectionLease(connect(request), request.cwd, request.shutdown)
      );
    },
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  };
}
