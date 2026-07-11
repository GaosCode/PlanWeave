import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  desktopRunnerRecordSubscriptionInputSchema,
  desktopRunnerRecordSubscriptionPushSchema,
  resolveTaskCanvasWorkspace,
  subscribeRunRecord,
  type AcpEventSubscription,
  type DesktopRunnerRecordSubscriptionInput
} from "@planweave-ai/runtime";
import {
  runnerRecordEventChannel,
  runnerRecordSubscribeChannel,
  runnerRecordUnsubscribeChannel
} from "../shared/ipcChannels.js";

type OwnedSubscription = {
  sender: WebContents;
  runtime: AcpEventSubscription | null;
  destroyed: () => void;
};

const subscriptions = new Map<string, OwnedSubscription>();

function key(sender: WebContents, subscriptionId: string): string {
  return `${sender.id}:${subscriptionId}`;
}

function release(sender: WebContents, subscriptionId: string): boolean {
  const subscriptionKey = key(sender, subscriptionId);
  const owned = subscriptions.get(subscriptionKey);
  if (!owned || owned.sender !== sender) return false;
  subscriptions.delete(subscriptionKey);
  sender.removeListener("destroyed", owned.destroyed);
  owned.runtime?.unsubscribe();
  return true;
}

function releaseSender(sender: WebContents): void {
  for (const [subscriptionKey, owned] of subscriptions) {
    if (owned.sender !== sender) continue;
    subscriptions.delete(subscriptionKey);
    owned.runtime?.unsubscribe();
  }
}

async function subscribe(
  event: IpcMainInvokeEvent,
  rawInput: DesktopRunnerRecordSubscriptionInput
) {
  const input = desktopRunnerRecordSubscriptionInputSchema.parse(rawInput);
  const sender = event.sender;
  if (sender.isDestroyed()) throw new Error("Cannot subscribe a destroyed renderer window.");
  const subscriptionKey = key(sender, input.subscriptionId);
  if (subscriptions.has(subscriptionKey)) {
    throw new Error(`Runner record subscription '${input.subscriptionId}' already exists.`);
  }
  const destroyed = (): void => releaseSender(sender);
  subscriptions.set(subscriptionKey, { sender, runtime: null, destroyed });
  sender.once("destroyed", destroyed);
  try {
    const workspace = await resolveTaskCanvasWorkspace(input.ref.projectRoot, input.ref.canvasId);
    const consumer = await subscribeRunRecord(
      workspace,
      input.recordId,
      input.cursor,
      (runnerEvent) => {
        if (!subscriptions.has(subscriptionKey)) return;
        if (sender.isDestroyed()) {
          release(sender, input.subscriptionId);
          return;
        }
        sender.send(
          runnerRecordEventChannel,
          desktopRunnerRecordSubscriptionPushSchema.parse({
            subscriptionId: input.subscriptionId,
            event: runnerEvent
          })
        );
      }
    );
    const owned = subscriptions.get(subscriptionKey);
    if (!owned) {
      consumer.subscription?.unsubscribe();
      throw new Error("Runner record subscription owner was destroyed during registration.");
    }
    owned.runtime = consumer.subscription;
    if (!consumer.subscription) release(sender, input.subscriptionId);
    else void consumer.subscription.closed.then(() => release(sender, input.subscriptionId));
    return { subscriptionId: input.subscriptionId, snapshot: consumer.snapshot };
  } catch (error) {
    release(sender, input.subscriptionId);
    throw error;
  }
}

function unsubscribe(event: IpcMainInvokeEvent, subscriptionId: string): void {
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
    throw new Error("Runner record subscription id is invalid.");
  }
  release(event.sender, subscriptionId);
}

export function registerRunnerRecordBridgeHandlers(): void {
  ipcMain.handle(runnerRecordSubscribeChannel, subscribe);
  ipcMain.handle(runnerRecordUnsubscribeChannel, unsubscribe);
}
