import { DesktopCommandError, desktopCommandErrorSchema } from "../shared/desktopCommandFailure.js";
import { isActiveDesktopWatchEvent } from "./desktopWatchRegistration.js";

const bridges = new WeakMap<object, object>();

/** Restore failures after contextBridge has copied plain data into the renderer realm. */
export function desktopCommandBridge<T extends object>(api: T): T {
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
          if (property === "onPackageFileChanged" || property === "onRuntimeStateChanged") {
            const callback = args[0];
            if (typeof callback === "function") {
              args[0] = (event: unknown) => {
                if (isActiveDesktopWatchEvent(event)) Reflect.apply(callback, undefined, [event]);
              };
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
