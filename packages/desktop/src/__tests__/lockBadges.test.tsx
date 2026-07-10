/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LockBadges } from "../renderer/graph/lockBadges";
import { LOCK_OVERFLOW_LIMIT, lockColor } from "../renderer/graph/lockColors";
import type { TaskLockState } from "../renderer/types";

afterEach(() => {
  cleanup();
});

const labels = {
  exclusiveLock: "Exclusive",
  heldBy: "Held by",
  waitingForResource: "Waiting for resource",
  moreLocks: (count: number) => `+${count}`
};

describe("lock colors and badges", () => {
  it("returns the same color object values for the same lock name", () => {
    expect(lockColor("db")).toEqual(lockColor("db"));
    expect(lockColor("api").dot).not.toEqual(lockColor("db").dot);
    expect(lockColor("exclusive").dot).toContain("exclusive");
  });

  it("renders free / held-by-this / held-elsewhere chip states", () => {
    const lockStates: Record<string, TaskLockState> = {
      freeLock: { kind: "free" },
      mine: { kind: "heldByThis" },
      theirs: { kind: "heldElsewhere", holderRef: "T-A#B-001", holderTaskId: "T-A" }
    };
    render(
      <LockBadges
        locks={["freeLock", "mine", "theirs"]}
        lockStates={lockStates}
        dispatchState={{ kind: "none" }}
        highlightedLock={null}
        releaseEpochByLock={{}}
        labels={labels}
        onLockHover={vi.fn()}
        onLockPin={vi.fn()}
        onOverflowOpen={vi.fn()}
        onJumpToTask={vi.fn()}
      />
    );
    const chips = screen.getAllByTestId("task-node-lock-chip");
    expect(chips).toHaveLength(3);
    expect(chips[0]).toHaveAttribute("data-lock-state", "free");
    expect(chips[1]).toHaveAttribute("data-lock-state", "heldByThis");
    expect(chips[2]).toHaveAttribute("data-lock-state", "heldElsewhere");
  });

  it("overflows after LOCK_OVERFLOW_LIMIT chips", () => {
    const locks = ["a", "b", "c", "d"];
    expect(locks.length).toBeGreaterThan(LOCK_OVERFLOW_LIMIT);
    const onOverflowOpen = vi.fn();
    render(
      <LockBadges
        locks={locks}
        lockStates={Object.fromEntries(locks.map((name) => [name, { kind: "free" as const }]))}
        dispatchState={{ kind: "none" }}
        highlightedLock={null}
        releaseEpochByLock={{}}
        labels={labels}
        onLockHover={vi.fn()}
        onLockPin={vi.fn()}
        onOverflowOpen={onOverflowOpen}
        onJumpToTask={vi.fn()}
      />
    );
    expect(screen.getAllByTestId("task-node-lock-chip")).toHaveLength(LOCK_OVERFLOW_LIMIT);
    fireEvent.click(screen.getByTestId("task-node-lock-overflow"));
    expect(onOverflowOpen).toHaveBeenCalled();
    expect(screen.getByTestId("task-node-lock-overflow")).toHaveTextContent("+1");
  });

  it("replaces other chips with exclusive lock chip", () => {
    render(
      <LockBadges
        locks={["db", "exclusive", "api"]}
        lockStates={{
          db: { kind: "free" },
          exclusive: { kind: "free" },
          api: { kind: "free" }
        }}
        dispatchState={{ kind: "none" }}
        highlightedLock={null}
        releaseEpochByLock={{}}
        labels={labels}
        onLockHover={vi.fn()}
        onLockPin={vi.fn()}
        onOverflowOpen={vi.fn()}
        onJumpToTask={vi.fn()}
      />
    );
    const chips = screen.getAllByTestId("task-node-lock-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveAttribute("data-lock-name", "exclusive");
    expect(chips[0]).toHaveTextContent("Exclusive");
  });
});
