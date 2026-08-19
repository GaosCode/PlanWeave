export type LiveWorkspaceSnapshot = {
  status: "local_only" | "connecting" | "connected" | "reconnecting" | "error" | "disconnected";
  serverBaseUrl: string | null;
  displayName: string | null;
};

export type LiveServerKind = "local" | "remote" | "idle";

export type LiveServerView = {
  kind: LiveServerKind;
  pending: boolean;
  url: string | null;
  name: string | null;
};

export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function classifyLiveServer(input: {
  workspace: LiveWorkspaceSnapshot | null;
  localRunning: boolean;
  localServerBaseUrl: string | null;
  advertisedOrigin: string | null;
}): LiveServerView {
  const localOrigin = originOf(input.advertisedOrigin) ?? originOf(input.localServerBaseUrl);
  const workspaceOrigin = originOf(input.workspace?.serverBaseUrl);
  const workspace = input.workspace;
  const workspaceActive = Boolean(
    workspace && workspace.status !== "local_only" && workspace.serverBaseUrl
  );
  const pending = workspace?.status === "connecting" || workspace?.status === "reconnecting";
  const onThisComputer =
    input.localRunning &&
    (!workspaceActive || !workspaceOrigin || !localOrigin || workspaceOrigin === localOrigin);

  if (onThisComputer) {
    return {
      kind: "local",
      pending: false,
      url: input.advertisedOrigin ?? input.localServerBaseUrl,
      name: null
    };
  }
  if (workspaceActive && workspace) {
    return {
      kind: "remote",
      pending,
      url: workspace.serverBaseUrl,
      name: workspace.displayName
    };
  }
  return { kind: "idle", pending: false, url: null, name: null };
}

export type OverviewServerDot = "ready" | "pending" | "error" | "idle";

export type OverviewServerLabel =
  | "remoteConnected"
  | "remoteConnecting"
  | "remoteError"
  | "localConnected"
  | "preparing"
  | "localError"
  | "notConnected";

export type OverviewServerPresentation = {
  state: OverviewServerDot;
  url: string | null;
  label: OverviewServerLabel;
};

/** Overview uses the same live Server classification as the Server tab, not local exposure alone. */
export function presentOverviewServer(input: {
  workspace: LiveWorkspaceSnapshot | null;
  localRunning: boolean;
  localServerBaseUrl: string | null;
  advertisedOrigin: string | null;
  localExposureLifecycle?: string | null;
}): OverviewServerPresentation {
  const live = classifyLiveServer({
    workspace: input.workspace,
    localRunning: input.localRunning,
    localServerBaseUrl: input.localServerBaseUrl,
    advertisedOrigin: input.advertisedOrigin
  });
  if (live.kind === "remote") {
    if (live.pending) {
      return { state: "pending", url: live.url, label: "remoteConnecting" };
    }
    if (input.workspace?.status === "error" || input.workspace?.status === "disconnected") {
      return { state: "error", url: live.url, label: "remoteError" };
    }
    return { state: "ready", url: live.url, label: "remoteConnected" };
  }
  if (live.kind === "local") {
    return { state: "ready", url: live.url, label: "localConnected" };
  }
  if (input.localExposureLifecycle === "preparing") {
    return { state: "pending", url: null, label: "preparing" };
  }
  if (input.localExposureLifecycle === "error") {
    return { state: "error", url: null, label: "localError" };
  }
  return { state: "idle", url: null, label: "notConnected" };
}
