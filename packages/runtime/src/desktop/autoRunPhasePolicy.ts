import type { DesktopAutoRunPhase } from "./types.js";

/**
 * Authoritative Desktop Auto Run phase semantics.
 *
 * This module only classifies phases. It does not read files, start loops, or write sessions.
 * Call sites that need ownership, recoverability, or resource-release decisions must use these
 * predicates instead of local phase arrays or ad-hoc string checks.
 *
 * Note: event-tail `isTerminalAutoRunPhase` in `autoRunEventSchema.ts` is a separate concern
 * (loop/event terminal detection, which includes `manual`). Do not merge those meanings.
 */
type AutoRunPhaseSemantics = {
  /** Owns the workspace and blocks creating a second Auto Run for the same target. */
  nonTerminal: boolean;
  /** Can be rehydrated and continued (`paused` / `manual`). */
  recoverable: boolean;
  /** Terminal for resource release (`completed` / `blocked` / `failed` / `stopped`). */
  terminal: boolean;
  /**
   * Process-owned in-flight phases. Without an active loop, recovery may convert these to
   * `failed`. This is not a second ownership policy; ownership still uses `nonTerminal`.
   */
  inFlight: boolean;
};

/**
 * Exhaustive phase map. Adding a `DesktopAutoRunPhase` member without updating this table
 * is a TypeScript error (`satisfies Record<DesktopAutoRunPhase, ...>`).
 */
const AUTO_RUN_PHASE_POLICY = {
  idle: { nonTerminal: false, recoverable: false, terminal: false, inFlight: false },
  running: { nonTerminal: true, recoverable: false, terminal: false, inFlight: true },
  pausing: { nonTerminal: true, recoverable: false, terminal: false, inFlight: true },
  paused: { nonTerminal: true, recoverable: true, terminal: false, inFlight: false },
  manual: { nonTerminal: true, recoverable: true, terminal: false, inFlight: false },
  completed: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  blocked: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  failed: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  stopped: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false }
} as const satisfies Record<DesktopAutoRunPhase, AutoRunPhaseSemantics>;

export function autoRunPhaseSemantics(phase: DesktopAutoRunPhase): AutoRunPhaseSemantics {
  return AUTO_RUN_PHASE_POLICY[phase];
}

/** Non-terminal ownership: running, pausing, paused, manual. */
export function isNonTerminalAutoRunPhase(phase: DesktopAutoRunPhase): boolean {
  return AUTO_RUN_PHASE_POLICY[phase].nonTerminal;
}

/** Recoverable continuation: paused, manual. */
export function isRecoverableAutoRunPhase(phase: DesktopAutoRunPhase): boolean {
  return AUTO_RUN_PHASE_POLICY[phase].recoverable;
}

/**
 * Resource-release terminal: completed, blocked, failed, stopped.
 * Distinct from event-tail terminal detection (which also treats `manual` as terminal).
 */
export function isResourceTerminalAutoRunPhase(phase: DesktopAutoRunPhase): boolean {
  return AUTO_RUN_PHASE_POLICY[phase].terminal;
}

/** Process-owned in-flight phases used by recovery when no active loop is present. */
export function isInFlightAutoRunPhase(phase: DesktopAutoRunPhase): boolean {
  return AUTO_RUN_PHASE_POLICY[phase].inFlight;
}
