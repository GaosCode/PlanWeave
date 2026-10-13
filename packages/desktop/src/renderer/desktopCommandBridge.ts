import type {
  DesktopPackageFileChangeEvent,
  DesktopRuntimeStateChangeEvent
} from "@planweave-ai/runtime";
import { DesktopCommandError, desktopCommandErrorSchema } from "../shared/desktopCommandFailure.js";
import { isActiveDesktopWatchEvent } from "./desktopWatchRegistration.js";
import {
  isDesktopHomeTransitionPending,
  onDesktopHomeTransitionSettled
} from "./desktopHomeTransition.js";

const homeBoundBridges = new WeakMap<object, object>();
const homeIndependentBridges = new WeakMap<object, object>();

function watchSubscription<
  Event extends DesktopPackageFileChangeEvent | DesktopRuntimeStateChangeEvent
>(
  subscribe: (listener: (event: Event) => void) => unknown,
  callback: (event: Event) => void,
  merge: (previous: Event, next: Event) => Event
): () => void {
  let active = true;
  const pending = new Map<string, Event>();
  const replay = () => {
    for (const [registrationId, event] of pending) {
      if (!active || isDesktopHomeTransitionPending()) return;
      pending.delete(registrationId);
      if (isActiveDesktopWatchEvent(event)) callback(event);
    }
  };
  const unsubscribe: unknown = subscribe((event) => {
    if (!active) return;
    for (const [registrationId, queued] of pending) {
      if (!isActiveDesktopWatchEvent(queued)) pending.delete(registrationId);
    }
    if (!isActiveDesktopWatchEvent(event)) return;
    if (isDesktopHomeTransitionPending() || pending.size > 0) {
      const previous = pending.get(event.registrationId);
      pending.set(event.registrationId, previous ? merge(previous, event) : event);
    } else callback(event);
  });
  if (typeof unsubscribe !== "function") {
    throw new Error("Desktop watch subscriptions must return an unsubscribe function.");
  }
  const stopReplay = onDesktopHomeTransitionSettled(replay);
  return () => {
    if (!active) return;
    active = false;
    pending.clear();
    stopReplay();
    Reflect.apply(unsubscribe, undefined, []);
  };
}

function mergePackageChanges(
  previous: DesktopPackageFileChangeEvent,
  next: DesktopPackageFileChangeEvent
): DesktopPackageFileChangeEvent {
  const paths = [...new Set([...previous.paths, ...next.paths])];
  return { ...next, paths, changedPathCount: paths.length };
}

/** Restore failures after contextBridge has copied plain data into the renderer realm. */
export function desktopCommandBridge<T extends object>(
  api: T,
  { homeIndependent = false }: { homeIndependent?: boolean } = {}
): T {
  const bridges = homeIndependent ? homeIndependentBridges : homeBoundBridges;
  const existing = bridges.get(api);
  // Each cached adapter preserves exactly the source API's methods and response shapes.
  if (existing) return existing as T;
  const methods = new Map<PropertyKey, (...args: unknown[]) => unknown>();
  // Electron freezes exposed APIs; a separate target avoids Proxy invariants on frozen methods.
  const adapted = new Proxy(
    { ...api },
    {
      get(_target, property) {
        const value: unknown = Reflect.get(api, property);
        if (typeof value !== "function") return value;
        const existingMethod = methods.get(property);
        if (existingMethod) return existingMethod;
        const method = (...args: unknown[]) => {
          const subscription = typeof property === "string" && /^on[A-Z]/.test(property);
          const watchCleanup =
            property === "unwatchPackageFiles" || property === "unwatchRuntimeState";
          if (
            !homeIndependent &&
            !subscription &&
            !watchCleanup &&
            isDesktopHomeTransitionPending()
          ) {
            return Promise.reject(new Error("PlanWeave Home is changing."));
          }
          if (property === "onPackageFileChanged" || property === "onRuntimeStateChanged") {
            const callback = args[0];
            if (typeof callback === "function") {
              if (property === "onPackageFileChanged")
                return watchSubscription<DesktopPackageFileChangeEvent>(
                  (listener) => Reflect.apply(value, api, [listener, ...args.slice(1)]),
                  (event) => Reflect.apply(callback, undefined, [event]),
                  mergePackageChanges
                );
              return watchSubscription<DesktopRuntimeStateChangeEvent>(
                (listener) => Reflect.apply(value, api, [listener, ...args.slice(1)]),
                (event) => Reflect.apply(callback, undefined, [event]),
                (_previous, next) => next
              );
            }
          }
          const result: unknown = Reflect.apply(value, api, args);
          if (!(result instanceof Promise)) return result;
          return result.catch((error: unknown) => {
            const parsed = desktopCommandErrorSchema.safeParse(error);
            if (parsed.success) throw new DesktopCommandError(parsed.data);
            throw error;
          });
        };
        methods.set(property, method);
        return method;
      }
    }
  );
  bridges.set(api, adapted);
  return adapted;
}
