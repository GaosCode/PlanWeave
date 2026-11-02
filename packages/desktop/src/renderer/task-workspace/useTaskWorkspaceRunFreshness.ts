import type { TaskWorkspace, TaskWorkspaceRunListItem } from "@planweave-ai/runtime";
import { useCallback, useRef, useState } from "react";
import type { TaskWorkspaceRecordLoad } from "./useTaskWorkspaceRecordCache";

function runSummaryFreshness(item: TaskWorkspaceRunListItem): string {
  return JSON.stringify([
    item.run.duration.finishedAt,
    item.run.metadata.submittedAt,
    item.run.metadata.terminalState,
    item.run.metadata.exitCode,
    item.active
  ]);
}

function selectionKey(authorityKey: string, blockRef: string, recordId: string): string {
  return `${authorityKey}\u0000${blockRef}\u0000${recordId}`;
}

export function useTaskWorkspaceRunFreshness() {
  const [freshnessById, setFreshnessById] = useState<ReadonlyMap<string, string>>(() => new Map());
  const currentRef = useRef<ReadonlyMap<string, TaskWorkspaceRunListItem>>(new Map());
  const selectedDetailRef = useRef<{ key: string; reportMissing: boolean } | null>(null);
  const headerStatusRef = useRef<{
    authorityKey: string;
    byBlockRef: ReadonlyMap<string, string>;
  } | null>(null);

  const noteSelectedDetail = useCallback((authorityKey: string, load: TaskWorkspaceRecordLoad) => {
    if (!load.blockRef || !load.record) return;
    selectedDetailRef.current = {
      key: selectionKey(authorityKey, load.blockRef, load.key),
      reportMissing: load.record.reportPath === null
    };
  }, []);

  const shouldRefreshSelectedOffPage = useCallback(
    (input: {
      authorityKey: string;
      blockRef: string | null;
      recordId: string | null;
      blocks: TaskWorkspace["blocks"];
      onFirstPage: boolean;
    }) => {
      const previous = headerStatusRef.current;
      const previousStatus =
        previous?.authorityKey === input.authorityKey && input.blockRef
          ? previous.byBlockRef.get(input.blockRef)
          : undefined;
      const currentStatus = input.blocks.find((block) => block.ref === input.blockRef)?.status;
      headerStatusRef.current = {
        authorityKey: input.authorityKey,
        byBlockRef: new Map(input.blocks.map((block) => [block.ref, block.status]))
      };
      if (!input.blockRef || !input.recordId) return false;
      const key = selectionKey(input.authorityKey, input.blockRef, input.recordId);
      return (
        !input.onFirstPage &&
        previousStatus !== undefined &&
        currentStatus !== undefined &&
        previousStatus !== currentStatus &&
        (selectedDetailRef.current?.key !== key || selectedDetailRef.current.reportMissing)
      );
    },
    []
  );

  const replace = useCallback((items: readonly TaskWorkspaceRunListItem[]) => {
    const next = new Map(items.map((item) => [item.run.record.recordId, item]));
    currentRef.current = next;
    setFreshnessById(
      new Map(items.map((item) => [item.run.record.recordId, runSummaryFreshness(item)]))
    );
  }, []);

  const append = useCallback((items: readonly TaskWorkspaceRunListItem[]) => {
    const next = new Map(currentRef.current);
    for (const item of items) {
      next.set(item.run.record.recordId, item);
    }
    currentRef.current = next;
    setFreshnessById(
      new Map([...next].map(([recordId, item]) => [recordId, runSummaryFreshness(item)]))
    );
  }, []);

  const matches = useCallback((load: TaskWorkspaceRecordLoad) => {
    if (!load.item || !load.blockRef) return false;
    const listed = currentRef.current.get(load.key);
    if (!listed) return true;
    const detail = load.item.run;
    if (
      runSummaryFreshness({ blockRef: load.blockRef, ...load.item }) === runSummaryFreshness(listed)
    ) {
      return true;
    }
    if (
      (listed.run.metadata.submittedAt !== null &&
        detail.metadata.submittedAt !== listed.run.metadata.submittedAt) ||
      (listed.run.duration.finishedAt !== null &&
        detail.duration.finishedAt !== listed.run.duration.finishedAt)
    ) {
      return false;
    }
    return (
      (listed.run.metadata.submittedAt === null && detail.metadata.submittedAt !== null) ||
      (listed.run.duration.finishedAt === null && detail.duration.finishedAt !== null) ||
      (listed.run.metadata.terminalState === null &&
        detail.metadata.terminalState !== null &&
        listed.run.metadata.exitCode === detail.metadata.exitCode &&
        listed.active === load.item.active)
    );
  }, []);

  return {
    append,
    freshnessById,
    matches,
    noteSelectedDetail,
    replace,
    shouldRefreshSelectedOffPage
  };
}
