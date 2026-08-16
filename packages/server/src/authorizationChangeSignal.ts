export type AuthorizationChangeScope = {
  workspaceId: string;
  projectId: string;
  humanPrincipalId?: string;
  deviceSessionId?: string;
};

export const AUTHORIZATION_SAFETY_CHECK_INTERVAL_MS = 30_000;

type AuthorizationChangeListener = () => void | Promise<void>;
type AuthorizationChangeErrorReporter = (error: unknown) => void | Promise<void>;

type AuthorizationChangeSubscription = {
  scope: AuthorizationChangeScope;
  listener: AuthorizationChangeListener;
};

function defaultErrorReporter(error: unknown): void {
  process.emitWarning(error instanceof Error ? error : String(error), {
    code: "AUTHORIZATION_CHANGE_LISTENER_FAILED"
  });
}

function reportErrorReporterFailure(error: unknown): void {
  try {
    process.emitWarning(error instanceof Error ? error : String(error), {
      code: "AUTHORIZATION_CHANGE_ERROR_REPORTER_FAILED"
    });
  } catch (warningError) {
    try {
      process.stderr.write(
        `Authorization change error reporter and warning sink failed: ${String(error)}; ${String(warningError)}\n`
      );
    } catch {
      return;
    }
  }
}

function appliesToSubscriber(
  change: AuthorizationChangeScope,
  subscriber: AuthorizationChangeScope
): boolean {
  if (change.workspaceId !== subscriber.workspaceId || change.projectId !== subscriber.projectId) {
    return false;
  }
  if (
    change.humanPrincipalId !== undefined &&
    change.humanPrincipalId !== subscriber.humanPrincipalId
  ) {
    return false;
  }
  return (
    change.deviceSessionId === undefined || change.deviceSessionId === subscriber.deviceSessionId
  );
}

/** Server-local post-commit invalidation source for authorization-dependent sessions. */
export class AuthorizationChangeSignal {
  private readonly subscribers = new Map<number, AuthorizationChangeSubscription>();
  private readonly pendingChanges: AuthorizationChangeScope[] = [];
  private nextSubscriptionId = 1;
  private publishing = false;

  constructor(
    private readonly onListenerError: AuthorizationChangeErrorReporter = defaultErrorReporter
  ) {}

  subscribe(scope: AuthorizationChangeScope, listener: AuthorizationChangeListener): () => void {
    const subscriptionId = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    this.subscribers.set(subscriptionId, { scope, listener });
    return () => this.subscribers.delete(subscriptionId);
  }

  publish(change: AuthorizationChangeScope): void {
    this.pendingChanges.push(change);
    if (this.publishing) return;
    this.publishing = true;
    try {
      while (this.pendingChanges.length > 0) {
        const current = this.pendingChanges.shift();
        if (!current) continue;
        const snapshot = [...this.subscribers.values()];
        for (const subscription of snapshot) {
          if (!appliesToSubscriber(current, subscription.scope)) continue;
          this.notify(subscription.listener);
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  private notify(listener: AuthorizationChangeListener): void {
    try {
      const result = listener();
      void Promise.resolve(result).catch((error) => this.reportListenerError(error));
    } catch (error) {
      this.reportListenerError(error);
    }
  }

  private reportListenerError(error: unknown): void {
    queueMicrotask(() => {
      try {
        const result = this.onListenerError(error);
        void Promise.resolve(result).catch(reportErrorReporterFailure);
      } catch (reporterError) {
        reportErrorReporterFailure(reporterError);
      }
    });
  }
}
