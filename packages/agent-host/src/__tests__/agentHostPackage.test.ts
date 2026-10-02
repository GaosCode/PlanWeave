import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("@planweave-ai/agent-host", () => {
  it("imports and composes without starting process or transport state", async () => {
    const processListener = vi.spyOn(process, "on");
    const setIntervalCall = vi.spyOn(globalThis, "setInterval");
    const setTimeoutCall = vi.spyOn(globalThis, "setTimeout");

    const agentHost = await import("../index.js");
    const transport = {
      start: vi.fn(),
      stop: vi.fn(),
      subscribe: vi.fn(() => () => {})
    };
    const state = {
      close: vi.fn()
    };
    const composition = agentHost.composeAgentHost({ state, transport });

    expect(processListener).not.toHaveBeenCalled();
    expect(setIntervalCall).not.toHaveBeenCalled();
    expect(setTimeoutCall).not.toHaveBeenCalled();
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.stop).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();

    await Promise.all([composition.start(), composition.start()]);
    expect(transport.start).toHaveBeenCalledOnce();

    await Promise.all([composition.shutdown(), composition.shutdown()]);
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(state.close).toHaveBeenCalledOnce();
    await expect(composition.start()).rejects.toThrow("agent_host_composition_already_shutdown");
  });

  it("provides an explicitly started no-op composition", async () => {
    const { createNoopAgentHostComposition } = await import("../index.js");
    const composition = createNoopAgentHostComposition();

    await expect(composition.start()).resolves.toBeUndefined();
    await expect(composition.shutdown()).resolves.toBeUndefined();
  });

  it("keeps durable state open when transport shutdown fails", async () => {
    const { composeAgentHost } = await import("../index.js");
    const failure = new Error("transport_stop_failed");
    const state = { close: vi.fn() };
    const composition = composeAgentHost({
      state,
      transport: {
        start() {},
        subscribe: vi.fn(() => () => {}),
        stop() {
          throw failure;
        }
      }
    });

    await composition.start();
    await expect(composition.shutdown()).rejects.toThrow("agent_host_composition_shutdown_failed");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("keeps active-run state open when transport shutdown requires process exit", async () => {
    const { composeAgentHost } = await import("../index.js");
    const state = { close: vi.fn() };
    const closeResources = vi.fn();
    const composition = composeAgentHost({
      state,
      closeResources,
      transport: {
        start() {},
        subscribe: vi.fn(() => () => {}),
        stop() {
          throw new Error("agent_host_transport_shutdown_timeout");
        }
      }
    });

    await composition.start();
    await expect(composition.shutdown()).rejects.toThrow(
      "agent_host_shutdown_requires_process_exit"
    );
    expect(state.close).not.toHaveBeenCalled();
    expect(closeResources).not.toHaveBeenCalled();
  });
});
