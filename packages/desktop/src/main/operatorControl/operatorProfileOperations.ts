import { OperatorControlError } from "../../shared/operatorControl.js";

type DisposableClient = { dispose(): void };
type ProfileGeneration = {
  clients: Set<DisposableClient>;
  queue: Promise<unknown>;
  cancellations: Set<() => void>;
};

export type OperatorProfileOperation = {
  assertCurrent(): void;
  isCurrent(): boolean;
  track(client: DisposableClient): void;
  release(): void;
};

/** Main-only operation identities. Invalidation precedes local profile/credential changes. */
export class OperatorProfileOperations {
  private readonly generations = new Map<string | symbol, ProfileGeneration>();
  private closed = false;

  capture(profileId: string | symbol): OperatorProfileOperation {
    if (this.closed)
      throw new OperatorControlError({ kind: "offline", code: "operator_service_closed" });
    let generation = this.generations.get(profileId);
    if (!generation) {
      generation = {
        clients: new Set(),
        queue: Promise.resolve(),
        cancellations: new Set()
      };
      this.generations.set(profileId, generation);
    }
    const captured = generation;
    const clients = new Set<DisposableClient>();
    const isCurrent = () => !this.closed && this.generations.get(profileId) === captured;
    const assertCurrent = () => {
      if (!isCurrent())
        throw new OperatorControlError({ kind: "offline", code: "operator_operation_invalidated" });
    };
    return {
      assertCurrent,
      isCurrent,
      track(client) {
        if (!isCurrent()) {
          client.dispose();
          assertCurrent();
        }
        clients.add(client);
        captured.clients.add(client);
      },
      release() {
        for (const client of clients) {
          if (captured.clients.delete(client)) client.dispose();
        }
        clients.clear();
      }
    };
  }

  run<T>(
    profileId: string | symbol,
    action: (operation: OperatorProfileOperation) => Promise<T>
  ): Promise<T> {
    const operation = this.capture(profileId);
    const generation = this.generations.get(profileId)!;
    const execute = generation.queue.then(async () => {
      operation.assertCurrent();
      const result = await action(operation);
      operation.assertCurrent();
      return result;
    });
    let cancel!: () => void;
    const invalidated = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(
          new OperatorControlError({ kind: "offline", code: "operator_operation_invalidated" })
        );
      generation.cancellations.add(cancel);
    });
    const next = Promise.race([execute, invalidated]).finally(() => {
      generation.cancellations.delete(cancel);
      operation.release();
    });
    generation.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  invalidate(profileId: string | symbol): void {
    const generation = this.generations.get(profileId);
    this.generations.delete(profileId);
    for (const cancel of generation?.cancellations ?? []) cancel();
    generation?.cancellations.clear();
    for (const client of generation?.clients ?? []) client.dispose();
    generation?.clients.clear();
  }

  shutdown(): void {
    this.closed = true;
    for (const profileId of this.generations.keys()) this.invalidate(profileId);
  }
}
