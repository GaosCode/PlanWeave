import { resolvePlanweaveHome } from "@planweave-ai/runtime";
import type { WebContents } from "electron";

type InspectorHome = { home: string; generation: number };

let currentHome: InspectorHome | null = null;
const inspectorHomes = new WeakMap<WebContents, InspectorHome>();

export function captureDesktopInspectorHome(): InspectorHome {
  const home = resolvePlanweaveHome();
  if (!currentHome || currentHome.home !== home) {
    currentHome = { home, generation: (currentHome?.generation ?? 0) + 1 };
  }
  return currentHome;
}

export function bindDesktopInspectorHome(sender: WebContents, home: InspectorHome): void {
  inspectorHomes.set(sender, home);
}

export function isDesktopInspectorHomeCurrent(sender: WebContents): boolean {
  const home = inspectorHomes.get(sender);
  return !home || home === captureDesktopInspectorHome();
}

export function assertDesktopInspectorHomeCurrent(sender: WebContents): void {
  if (!isDesktopInspectorHomeCurrent(sender)) {
    throw new Error(
      "This inspector belongs to a previous PlanWeave Home. Open a new inspector to continue."
    );
  }
}
