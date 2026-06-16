import type { DesktopBridgeApi } from "@planweave-ai/runtime";
import { desktopBridgeInvokeChannels, type DesktopBridgeSubscriptionMethod } from "../shared/ipcChannels.js";

export type DesktopBridgeInvokeApi = Omit<DesktopBridgeApi, DesktopBridgeSubscriptionMethod>;

export type DesktopBridgeInvoke = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function createDesktopBridgeInvokeApi(invoke: DesktopBridgeInvoke): DesktopBridgeInvokeApi {
  return Object.fromEntries(
    Object.entries(desktopBridgeInvokeChannels).map(([method, channel]) => [
      method,
      (...args: unknown[]) => invoke(channel, ...args)
    ])
  ) as DesktopBridgeInvokeApi;
}
