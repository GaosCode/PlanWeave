import { OperatorControlError } from "../../shared/operatorControl.js";
import type {
  OperatorProfileOperation,
  OperatorProfileOperations
} from "./operatorProfileOperations.js";

const localAgentHostErrorCodePattern = /^(?:agent_host|local_agent_host)_[a-z0-9_]+$/;

export function localAgentHostErrorFromUnknown(error: unknown): OperatorControlError {
  if (error instanceof OperatorControlError) return error;
  const code =
    error instanceof Error && localAgentHostErrorCodePattern.test(error.message)
      ? error.message
      : "local_agent_host_registration_failed";
  return new OperatorControlError({ kind: "unknown", code, cause: error });
}

/** Registration and repair share machine-local config files, independent of Server requests. */
export class OperatorLocalHostOperations {
  private readonly key = Symbol("local-host-mutations");
  constructor(private readonly operations: OperatorProfileOperations) {}

  run<T>(parent: OperatorProfileOperation, action: () => Promise<T>): Promise<T> {
    return this.operations.run(this.key, async () => {
      parent.assertCurrent();
      const result = await action();
      parent.assertCurrent();
      return result;
    });
  }
}
