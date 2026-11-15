import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type {
  DesktopAgentCapabilityProbeResult,
  DesktopAgentKind,
  ExecutionHost
} from "@planweave-ai/runtime";
import { desktopAgentHostKey } from "../../shared/desktopSettings";
import { bridge } from "../bridge";

type AcpProbeState = {
  error: string | null;
  loading: boolean;
  result: DesktopAgentCapabilityProbeResult | null;
};

type AgentProbes = Partial<Record<DesktopAgentKind, AcpProbeState>>;

type ProbeSession = {
  cacheKey: string;
  executionHost: ExecutionHost;
  projectRoot: string | null;
  probes: AgentProbes;
};

const completedProbesByContext = new Map<string, AgentProbes>();
const noProbes: AgentProbes = {};

export function useAgentCapabilityProbeSession(
  projectRoot: string | null,
  sourceRoot: string | null,
  executionHost: ExecutionHost,
  bridgeUnavailableMessage: string
) {
  const cacheKey = JSON.stringify([projectRoot, sourceRoot, desktopAgentHostKey(executionHost)]);
  const sessionRef = useRef<ProbeSession | null>(null);
  const [view, setView] = useState<{ session: ProbeSession; probes: AgentProbes } | null>(null);

  useLayoutEffect(() => {
    const probes = completedProbesByContext.get(cacheKey) ?? noProbes;
    const session = { cacheKey, executionHost, projectRoot, probes };
    sessionRef.current = session;
    setView({ session, probes });
    return () => {
      sessionRef.current = null;
    };
  }, [cacheKey, executionHost, projectRoot]);

  const probe = useCallback(
    async (agentKind: DesktopAgentKind) => {
      const session = sessionRef.current;
      if (!session || session.probes[agentKind]) return;
      const pending: AcpProbeState = { error: null, loading: true, result: null };
      const publish = (state: AcpProbeState) => {
        session.probes = { ...session.probes, [agentKind]: state };
        setView({ session, probes: session.probes });
      };
      publish(pending);

      let completed: AcpProbeState;
      try {
        if (!bridge) throw new Error(bridgeUnavailableMessage);
        const result = await bridge.probeDesktopAgentCapabilities({
          agentKind,
          projectRoot: session.projectRoot
        });
        if (
          result.agentKind !== agentKind ||
          desktopAgentHostKey(result.executionHost) !== desktopAgentHostKey(session.executionHost)
        ) {
          throw new Error("ACP capability probe returned results for a different Agent or host.");
        }
        completed = {
          loading: false,
          result,
          error:
            result.ok || result.authentication?.status === "action_required" ? null : result.message
        };
      } catch (caught) {
        completed = {
          loading: false,
          result: null,
          error: caught instanceof Error ? caught.message : String(caught)
        };
      }

      if (sessionRef.current !== session || session.probes[agentKind] !== pending) return;
      completedProbesByContext.set(session.cacheKey, {
        ...completedProbesByContext.get(session.cacheKey),
        [agentKind]: completed
      });
      publish(completed);
    },
    [bridgeUnavailableMessage]
  );

  const session =
    view?.session.cacheKey === cacheKey && view.session.executionHost === executionHost
      ? view.session
      : null;
  const refreshProbes = () => {
    if (!session || sessionRef.current !== session) return;
    completedProbesByContext.delete(cacheKey);
    session.probes = noProbes;
    setView({ session, probes: noProbes });
  };
  const isCurrentProbe = (agentKind: DesktopAgentKind, state: AcpProbeState) =>
    session !== null && sessionRef.current === session && session.probes[agentKind] === state;

  return {
    probes: session ? (view?.probes ?? noProbes) : noProbes,
    probe,
    refreshProbes,
    isCurrentProbe
  };
}

export function resetAgentCapabilityProbeSessionCache() {
  completedProbesByContext.clear();
}
