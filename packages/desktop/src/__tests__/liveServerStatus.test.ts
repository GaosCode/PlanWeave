import { describe, expect, it } from "vitest";
import {
  classifyLiveServer,
  originOf,
  presentOverviewServer,
  type LiveWorkspaceSnapshot
} from "../renderer/collaboration/liveServerStatus";

const localUrl = "https://this-computer.tailnet.ts.net/";
const remoteUrl = "https://vps.example.test/";

function workspace(
  status: LiveWorkspaceSnapshot["status"],
  serverBaseUrl: string | null = remoteUrl
): LiveWorkspaceSnapshot {
  return {
    status,
    serverBaseUrl,
    displayName: status === "local_only" ? null : "Team"
  };
}

describe("liveServerStatus", () => {
  it("normalizes origins without a trailing path", () => {
    expect(originOf("https://this-computer.tailnet.ts.net/workspace")).toBe(
      "https://this-computer.tailnet.ts.net"
    );
    expect(originOf("not-a-url")).toBeNull();
  });

  it("treats a running local process as this computer when Workspace is unused", () => {
    expect(
      classifyLiveServer({
        workspace: workspace("local_only", null),
        localRunning: true,
        localServerBaseUrl: "http://127.0.0.1:8787/",
        advertisedOrigin: localUrl
      })
    ).toEqual({
      kind: "local",
      pending: false,
      url: localUrl,
      name: null
    });
  });

  it("keeps this computer when Workspace points at the advertised origin", () => {
    expect(
      classifyLiveServer({
        workspace: workspace("connected", localUrl),
        localRunning: true,
        localServerBaseUrl: "http://127.0.0.1:8787/",
        advertisedOrigin: localUrl
      }).kind
    ).toBe("local");
  });

  it("treats a different connected origin as remote even if local is running", () => {
    const live = classifyLiveServer({
      workspace: workspace("connected", remoteUrl),
      localRunning: true,
      localServerBaseUrl: "http://127.0.0.1:8787/",
      advertisedOrigin: localUrl
    });
    expect(live).toEqual({
      kind: "remote",
      pending: false,
      url: remoteUrl,
      name: "Team"
    });
  });

  it("marks a remote connecting session as pending", () => {
    const live = classifyLiveServer({
      workspace: workspace("connecting", remoteUrl),
      localRunning: false,
      localServerBaseUrl: null,
      advertisedOrigin: null
    });
    expect(live.kind).toBe("remote");
    expect(live.pending).toBe(true);
  });

  it("keeps a disconnected last remote Server so retry stays on that origin", () => {
    expect(
      classifyLiveServer({
        workspace: workspace("disconnected", remoteUrl),
        localRunning: false,
        localServerBaseUrl: null,
        advertisedOrigin: null
      })
    ).toEqual({
      kind: "remote",
      pending: false,
      url: remoteUrl,
      name: "Team"
    });
  });
});

describe("presentOverviewServer", () => {
  it("shows a connected remote Server even when this computer is not exposed", () => {
    expect(
      presentOverviewServer({
        workspace: workspace("connected", remoteUrl),
        localRunning: false,
        localServerBaseUrl: null,
        advertisedOrigin: null,
        localExposureLifecycle: "idle"
      })
    ).toEqual({
      state: "ready",
      url: remoteUrl,
      label: "remoteConnected"
    });
  });

  it("keeps the last remote origin when reconnect failed", () => {
    expect(
      presentOverviewServer({
        workspace: workspace("disconnected", remoteUrl),
        localRunning: false,
        localServerBaseUrl: null,
        advertisedOrigin: null,
        localExposureLifecycle: "idle"
      })
    ).toEqual({
      state: "error",
      url: remoteUrl,
      label: "remoteError"
    });
  });

  it("uses not-connected when neither this computer nor a remote Server is live", () => {
    expect(
      presentOverviewServer({
        workspace: workspace("local_only", null),
        localRunning: false,
        localServerBaseUrl: null,
        advertisedOrigin: null,
        localExposureLifecycle: "idle"
      })
    ).toEqual({
      state: "idle",
      url: null,
      label: "notConnected"
    });
  });
});
