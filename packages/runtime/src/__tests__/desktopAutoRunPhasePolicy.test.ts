import { describe, expect, it } from "vitest";
import {
  autoRunPhaseSemantics,
  isInFlightAutoRunPhase,
  isNonTerminalAutoRunPhase,
  isRecoverableAutoRunPhase,
  isResourceTerminalAutoRunPhase
} from "../desktop/autoRunPhasePolicy.js";
import type { DesktopAutoRunPhase } from "../desktop/types.js";
import { desktopAutoRunPhaseSchema } from "../desktop/autoRunEventSchema.js";

const ALL_PHASES = desktopAutoRunPhaseSchema.options as readonly DesktopAutoRunPhase[];

/**
 * Expected product matrix for Desktop Auto Run phase ownership.
 * Source of truth for this table is CONCEPT/product semantics mirrored in autoRunPhasePolicy.
 */
const PHASE_MATRIX: Record<
  DesktopAutoRunPhase,
  {
    nonTerminal: boolean;
    recoverable: boolean;
    terminal: boolean;
    inFlight: boolean;
  }
> = {
  idle: { nonTerminal: false, recoverable: false, terminal: false, inFlight: false },
  running: { nonTerminal: true, recoverable: false, terminal: false, inFlight: true },
  pausing: { nonTerminal: true, recoverable: false, terminal: false, inFlight: true },
  paused: { nonTerminal: true, recoverable: true, terminal: false, inFlight: false },
  manual: { nonTerminal: true, recoverable: true, terminal: false, inFlight: false },
  completed: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  blocked: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  failed: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false },
  stopped: { nonTerminal: false, recoverable: false, terminal: true, inFlight: false }
};

describe("autoRunPhasePolicy", () => {
  it("covers every DesktopAutoRunPhase exactly once", () => {
    expect(ALL_PHASES.slice().sort()).toEqual(Object.keys(PHASE_MATRIX).sort());
  });

  it.each(ALL_PHASES)("classifies phase %s according to the product matrix", (phase) => {
    const expected = PHASE_MATRIX[phase];
    expect(autoRunPhaseSemantics(phase)).toEqual(expected);
    expect(isNonTerminalAutoRunPhase(phase)).toBe(expected.nonTerminal);
    expect(isRecoverableAutoRunPhase(phase)).toBe(expected.recoverable);
    expect(isResourceTerminalAutoRunPhase(phase)).toBe(expected.terminal);
    expect(isInFlightAutoRunPhase(phase)).toBe(expected.inFlight);
  });

  it("treats non-terminal ownership as mutually exclusive with resource-terminal", () => {
    for (const phase of ALL_PHASES) {
      const semantics = autoRunPhaseSemantics(phase);
      if (semantics.nonTerminal) {
        expect(semantics.terminal).toBe(false);
      }
      if (semantics.terminal) {
        expect(semantics.nonTerminal).toBe(false);
        expect(semantics.recoverable).toBe(false);
        expect(semantics.inFlight).toBe(false);
      }
    }
  });

  it("limits recoverable phases to paused and manual", () => {
    const recoverable = ALL_PHASES.filter(isRecoverableAutoRunPhase);
    expect(recoverable).toEqual(["paused", "manual"]);
  });

  it("limits in-flight phases to running and pausing", () => {
    const inFlight = ALL_PHASES.filter(isInFlightAutoRunPhase);
    expect(inFlight).toEqual(["running", "pausing"]);
  });
});
