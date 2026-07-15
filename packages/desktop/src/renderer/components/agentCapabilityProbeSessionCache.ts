import type { DesktopAgentCapabilityProbeResult, DesktopAgentKind } from "@planweave-ai/runtime";

interface AcpProbeState {
  error: string | null;
  loading: boolean;
  result: DesktopAgentCapabilityProbeResult | null;
}

type ProjectProbeCache = Partial<Record<DesktopAgentKind, AcpProbeState>>;

const probeCacheByProject = new Map<string | null, ProjectProbeCache>();

export function readAgentCapabilityProbeSession(projectRoot: string | null): ProjectProbeCache {
  return { ...(probeCacheByProject.get(projectRoot) ?? {}) };
}

export function writeAgentCapabilityProbeSession(
  projectRoot: string | null,
  agentKind: DesktopAgentKind,
  state: AcpProbeState
) {
  if (state.loading) {
    throw new Error("An in-flight ACP capability probe cannot be cached as a completed result.");
  }
  probeCacheByProject.set(projectRoot, {
    ...probeCacheByProject.get(projectRoot),
    [agentKind]: state
  });
}

export function clearAgentCapabilityProbeSession(projectRoot: string | null) {
  probeCacheByProject.delete(projectRoot);
}

export function resetAgentCapabilityProbeSessionCache() {
  probeCacheByProject.clear();
}

export type { AcpProbeState };
