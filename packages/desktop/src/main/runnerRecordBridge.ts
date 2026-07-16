import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import {
  createAcpEventSubscriptionCloseResult,
  desktopRunnerRecordSubscriptionInputSchema,
  desktopRunnerRecordSubscriptionPushSchema,
  resolveTaskCanvasWorkspace,
  subscribeRunRecord,
  type AcpEventSubscription,
  type AcpEventSubscriptionCloseResult,
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
  updateSequence: number;
  closing: boolean;
};

const subscriptions = new Map<string, OwnedSubscription>();

function key(sender: WebContents, subscriptionId: string): string {
  return `${sender.id}:${subscriptionId}`;
}

function sendClosedPush(
  owned: OwnedSubscription,
  subscriptionId: string,
  close: AcpEventSubscriptionCloseResult
): void {
  if (owned.sender.isDestroyed()) return;
  try {
    owned.sender.send(
      runnerRecordEventChannel,
      desktopRunnerRecordSubscriptionPushSchema.parse({
        kind: "closed",
        subscriptionId,
        updateSequence: ++owned.updateSequence,
        close
      })
    );
  } catch {
    // Sender may race-destroy during send; ownership cleanup continues below.
  }
}

function detach(sender: WebContents, subscriptionId: string): OwnedSubscription | null {
  const subscriptionKey = key(sender, subscriptionId);
  const owned = subscriptions.get(subscriptionKey);
  if (!owned || owned.sender !== sender) return null;
  subscriptions.delete(subscriptionKey);
  sender.removeListener("destroyed", owned.destroyed);
  return owned;
}

function release(
  sender: WebContents,
  subscriptionId: string,
  options: {
    close?: AcpEventSubscriptionCloseResult | null;
    unsubscribe?: boolean;
  } = {}
): boolean {
  const owned = detach(sender, subscriptionId);
  if (!owned) return false;
  if (options.close) {
    sendClosedPush(owned, subscriptionId, options.close);
  }
  if (options.unsubscribe !== false) {
    owned.runtime?.unsubscribe();
  }
  return true;
}

function releaseSender(sender: WebContents): void {
  for (const [subscriptionKey, owned] of [...subscriptions.entries()]) {
    if (owned.sender !== sender) continue;
    subscriptions.delete(subscriptionKey);
    // Window is gone: skip closed push and only tear down runtime ownership.
    owned.runtime?.unsubscribe();
  }
}

function finishClosed(
  sender: WebContents,
  subscriptionId: string,
  close: AcpEventSubscriptionCloseResult
): void {
  const subscriptionKey = key(sender, subscriptionId);
  const owned = subscriptions.get(subscriptionKey);
  if (!owned || owned.sender !== sender || owned.closing) return;
  owned.closing = true;
  // Closed push must happen before ownership release.
  sendClosedPush(owned, subscriptionId, close);
  subscriptions.delete(subscriptionKey);
  sender.removeListener("destroyed", owned.destroyed);
  // Do not call unsubscribe again: closed already completed (publisher or explicit path).
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
  subscriptions.set(subscriptionKey, {
    sender,
    runtime: null,
    destroyed,
    updateSequence: 0,
    closing: false
  });
  sender.once("destroyed", destroyed);
  try {
    const workspace = await resolveTaskCanvasWorkspace(input.ref.projectRoot, input.ref.canvasId);
    const consumer = await subscribeRunRecord(
      workspace,
      input.recordId,
      input.cursor,
      (snapshot) => {
        const owned = subscriptions.get(subscriptionKey);
        if (!owned || owned.closing) return;
        if (sender.isDestroyed()) {
          release(sender, input.subscriptionId, { unsubscribe: true });
          return;
        }
        const payload = desktopRunnerRecordSubscriptionPushSchema.parse({
          kind: "snapshot",
          subscriptionId: input.subscriptionId,
          updateSequence: ++owned.updateSequence,
          snapshot
        });
        try {
          sender.send(runnerRecordEventChannel, payload);
        } catch {
          release(sender, input.subscriptionId, { unsubscribe: true });
        }
      }
    );
    const owned = subscriptions.get(subscriptionKey);
    if (!owned) {
      consumer.subscription?.unsubscribe();
      throw new Error("Runner record subscription owner was destroyed during registration.");
    }
    owned.runtime = consumer.subscription;
    if (!consumer.subscription) {
      // Runtime returns subscription:null for true terminals and for non-terminal
      // identity/disk-replay paths. Only terminal absences are silent; non-terminal
      // must surface so the renderer does not stall without error or reconnect.
      const snapshot = consumer.snapshot;
      const lastSequence = snapshot?.cursor.afterSequence ?? 0;
      if (snapshot?.terminal) {
        release(sender, input.subscriptionId, {
          close: createAcpEventSubscriptionCloseResult(
            "terminal",
            lastSequence,
            "Runner record has no live subscription."
          ),
          unsubscribe: false
        });
      } else {
        const diagnosticMessage = snapshot?.diagnostics.find(
          (item) => item.message.trim().length > 0
        )?.message;
        release(sender, input.subscriptionId, {
          close: createAcpEventSubscriptionCloseResult(
            "not_subscribable",
            lastSequence,
            diagnosticMessage ?? "Runner record is not live-subscribable."
          ),
          unsubscribe: false
        });
      }
    } else {
      void consumer.subscription.closed.then((closeResult) => {
        finishClosed(sender, input.subscriptionId, closeResult);
      });
    }
    return {
      subscriptionId: input.subscriptionId,
      updateSequence: 0 as const,
      snapshot: consumer.snapshot
    };
  } catch (error) {
    release(sender, input.subscriptionId, { unsubscribe: true });
    throw error;
  }
}

function unsubscribe(event: IpcMainInvokeEvent, subscriptionId: string): void {
  if (typeof subscriptionId !== "string" || subscriptionId.length === 0) {
    throw new Error("Runner record subscription id is invalid.");
  }
  const sender = event.sender;
  const owned = subscriptions.get(key(sender, subscriptionId));
  if (!owned || owned.sender !== sender) return;
  // Trigger publisher close; finishClosed sends closed push once and releases ownership.
  owned.runtime?.unsubscribe();
  if (!owned.runtime) {
    release(sender, subscriptionId, {
      close: createAcpEventSubscriptionCloseResult("explicit_unsubscribe", 0),
      unsubscribe: false
    });
  }
}

export function registerRunnerRecordBridgeHandlers(): void {
  ipcMain.handle(runnerRecordSubscribeChannel, subscribe);
  ipcMain.handle(runnerRecordUnsubscribeChannel, unsubscribe);
}
