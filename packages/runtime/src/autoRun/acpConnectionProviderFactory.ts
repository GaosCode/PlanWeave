import type { AcpConnectionMode } from "../acpProfile/schema.js";
import type { AcpConnection, CreateAcpConnectionOptions } from "./acpConnection.js";
import type { AcpConnectionProvider } from "./acpConnectionProvider.js";
import { createDedicatedAcpConnectionProvider } from "./acpDedicatedConnectionProvider.js";
import {
  createSharedAcpConnectionProvider,
  processSharedAcpConnectionProvider,
  type SharedAcpConnectionProviderOptions
} from "./acpSharedConnectionProvider.js";

export type CreateAcpConnectionProviderInput = {
  readonly mode: AcpConnectionMode;
  readonly connect?: (options: CreateAcpConnectionOptions) => AcpConnection;
  readonly shared?: Omit<SharedAcpConnectionProviderOptions, "connect">;
};

export function createAcpConnectionProvider(
  input: CreateAcpConnectionProviderInput
): AcpConnectionProvider {
  if (input.mode === "shared-project") {
    const shared = {
      ...input.shared,
      ...(input.connect ? { connect: input.connect } : {})
    };
    if (input.connect || input.shared) return createSharedAcpConnectionProvider(shared);
    return processSharedAcpConnectionProvider();
  }
  return createDedicatedAcpConnectionProvider(input.connect ? { connect: input.connect } : {});
}
