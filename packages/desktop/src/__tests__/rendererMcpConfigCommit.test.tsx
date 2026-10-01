/* @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsMcpSection } from "../renderer/settings/SettingsMcpSection.js";
import { createTranslator } from "../renderer/i18n.js";
import type { McpTunnelStatus, PlanWeaveMcpTunnelApi } from "../shared/mcpTunnel.js";

const initial: McpTunnelStatus = {
  binary: {
    path: "/test/old",
    available: true,
    source: "manual",
    assetName: null,
    assetSha256: null,
    sha256: null,
    version: null,
    verified: false,
    error: null
  },
  download: { phase: "idle", assetName: null, error: null },
  localMcp: {
    phase: "stopped",
    endpoint: null,
    host: "127.0.0.1",
    port: 8787,
    pid: null,
    planweaveHome: "",
    planweaveHomeFromEnv: false,
    healthy: false,
    error: null
  },
  tunnel: {
    phase: "stopped",
    profile: "planweave-local-http",
    tunnelId: null,
    pid: null,
    healthUrl: null,
    ready: false,
    error: null
  },
  config: {
    tunnelId: "old-id",
    hasRuntimeApiKey: true,
    runtimeApiKeyPersistence: "persisted",
    runtimeApiKeyStorage: "available",
    autoStart: false
  },
  downloadUrl: "https://example.test/release",
  updatedAt: "2026-10-01T00:00:00Z"
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mount(getStatus: Promise<McpTunnelStatus> = Promise.resolve(initial)) {
  let changed: (status: McpTunnelStatus) => void = () => undefined;
  const api: PlanWeaveMcpTunnelApi = {
    getMcpTunnelStatus: vi.fn(() => getStatus),
    onMcpTunnelChanged: vi.fn((listener) => {
      changed = listener;
      return () => undefined;
    }),
    setTunnelClientPath: vi.fn(async () => initial),
    setTunnelAutoStart: vi.fn(async () => initial),
    downloadTunnelClient: vi.fn(async () => initial),
    startTunnel: vi.fn(async () => initial),
    stopTunnel: vi.fn(async () => initial),
    startLocalMcp: vi.fn(async () => initial),
    stopLocalMcp: vi.fn(async () => initial)
  };
  Object.defineProperty(window, "planweaveMcpTunnel", { configurable: true, value: api });
  const setError = vi.fn();
  render(<SettingsMcpSection setError={setError} t={createTranslator("en")} />);
  return { api, setError, emit: (status: McpTunnelStatus) => act(() => changed(status)) };
}
afterEach(() => {
  cleanup();
  delete window.planweaveMcpTunnel;
});

describe("MCP settings commit feedback", () => {
  it("blocks duplicate saves, preserves newer draft edits across broadcasts and failed persistence, then retries", async () => {
    const { api, setError, emit } = mount();
    const path = screen.getByRole("textbox", { name: "tunnel-client path" });
    await waitFor(() => expect(path).toHaveValue("/test/old"));
    fireEvent.change(path, { target: { value: "/test/draft" } });
    const saving = deferred<McpTunnelStatus>();
    vi.mocked(api.setTunnelClientPath).mockReturnValueOnce(saving.promise);
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(save).toBeDisabled();
    expect(api.setTunnelClientPath).toHaveBeenCalledTimes(1);
    fireEvent.change(path, { target: { value: "/test/newer-draft" } });
    emit({ ...initial, binary: { ...initial.binary, path: "/test/external" } });
    expect(path).toHaveValue("/test/newer-draft");
    await act(async () => saving.reject(new Error("configuration commit denied")));
    await waitFor(() => expect(setError).toHaveBeenCalledWith("configuration commit denied"));
    expect(path).toHaveValue("/test/newer-draft");
    expect(save).toBeEnabled();
    vi.mocked(api.setTunnelClientPath).mockResolvedValueOnce({
      ...initial,
      binary: { ...initial.binary, path: "/test/newer-draft" }
    });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.setTunnelClientPath).toHaveBeenLastCalledWith("/test/newer-draft")
    );
    await waitFor(() => expect(setError).toHaveBeenLastCalledWith(null));
  });

  it("leaves tunnel ID and key drafts intact when startup fails and reports the process error", async () => {
    const { api, setError, emit } = mount();
    const id = screen.getByRole("textbox", { name: "Tunnel ID" });
    const key = screen.getByLabelText("Runtime API key");
    await waitFor(() => expect(id).toHaveValue("old-id"));
    fireEvent.change(id, { target: { value: "draft-id" } });
    fireEvent.change(key, { target: { value: "fake-draft-key" } });
    const starting = deferred<McpTunnelStatus>();
    vi.mocked(api.startTunnel).mockReturnValueOnce(starting.promise);
    const start = screen.getByRole("button", { name: "Start tunnel" });
    fireEvent.click(start);
    expect(start).toBeDisabled();
    emit({ ...initial, config: { ...initial.config, tunnelId: "external-id" } });
    expect(id).toHaveValue("draft-id");
    await act(async () =>
      starting.resolve({
        ...initial,
        tunnel: { ...initial.tunnel, phase: "error", error: "process failed" }
      })
    );
    await waitFor(() => expect(setError).toHaveBeenCalledWith("process failed"));
    expect(id).toHaveValue("draft-id");
    expect(key).toHaveValue("fake-draft-key");
    expect(start).toBeEnabled();
    expect(api.startTunnel).toHaveBeenCalledWith({
      tunnelId: "draft-id",
      runtimeApiKey: "fake-draft-key"
    });
  });

  it.each([
    ["path", false],
    ["id", false],
    ["path", true],
    ["id", true]
  ] as const)("%s completion uses accepted authority while protecting newer draft=%s", async (field, editWhilePending) => {
    const { api, emit } = mount();
    const input = screen.getByRole("textbox", {
      name: field === "path" ? "tunnel-client path" : "Tunnel ID"
    });
    await waitFor(() => expect(input).toHaveValue(field === "path" ? "/test/old" : "old-id"));
    const submitted = field === "path" ? "/test/submitted" : "submitted-id";
    const newer = field === "path" ? "/test/newer-authority" : "newer-authority-id";
    const draft = field === "path" ? "/test/newer-draft" : "newer-draft-id";
    const later = field === "path" ? "/test/later-authority" : "later-authority-id";
    const statusFor = (value: string): McpTunnelStatus =>
      field === "path"
        ? { ...initial, binary: { ...initial.binary, path: value } }
        : { ...initial, config: { ...initial.config, tunnelId: value } };
    const saving = deferred<McpTunnelStatus>();
    if (field === "path") vi.mocked(api.setTunnelClientPath).mockReturnValueOnce(saving.promise);
    else vi.mocked(api.startTunnel).mockReturnValueOnce(saving.promise);
    fireEvent.change(input, { target: { value: submitted } });
    const button = screen.getByRole("button", { name: field === "path" ? "Save" : "Start tunnel" });
    fireEvent.click(button);
    emit(statusFor(newer));
    if (editWhilePending) fireEvent.change(input, { target: { value: draft } });
    await act(async () => saving.resolve(statusFor(submitted)));
    expect(input).toHaveValue(editWhilePending ? draft : newer);
    expect(button).toBeEnabled();
    emit(statusFor(later));
    expect(input).toHaveValue(editWhilePending ? draft : later);
    if (editWhilePending) {
      // A later successful submission clears dirty only for that submitted draft.
      if (field === "path")
        vi.mocked(api.setTunnelClientPath).mockResolvedValueOnce(statusFor(draft));
      else vi.mocked(api.startTunnel).mockResolvedValueOnce(statusFor(draft));
      fireEvent.click(button);
      await waitFor(() => expect(button).toBeEnabled());
      emit(statusFor(newer));
      expect(input).toHaveValue(newer);
    }
  });

  it("a late initial status fetch cannot replace a newer committed broadcast", async () => {
    const loading = deferred<McpTunnelStatus>();
    const { emit } = mount(loading.promise);
    emit({
      ...initial,
      binary: { ...initial.binary, path: "/test/committed" },
      config: { ...initial.config, tunnelId: "committed-id" }
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Tunnel ID" })).toHaveValue("committed-id")
    );
    await act(async () => loading.resolve(initial));
    expect(screen.getByRole("textbox", { name: "Tunnel ID" })).toHaveValue("committed-id");
    expect(screen.getByRole("textbox", { name: "tunnel-client path" })).toHaveValue(
      "/test/committed"
    );
  });
});
