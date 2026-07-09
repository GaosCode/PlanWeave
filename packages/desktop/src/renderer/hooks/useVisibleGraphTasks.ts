import { useMemo } from "react";
import type { DesktopGraphViewModel } from "@planweave-ai/runtime";

export function useVisibleGraphTasks(graph: DesktopGraphViewModel | null, searchQuery: string) {
  const visibleTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return graph?.tasks.filter((task) => {
      const matchesQuery =
        !query ||
        task.title.toLowerCase().includes(query) ||
        task.taskId.toLowerCase().includes(query);
      return matchesQuery;
    });
  }, [graph, searchQuery]);

  const visibleTaskIds = useMemo(
    () => new Set(visibleTasks?.map((task) => task.taskId) ?? []),
    [visibleTasks]
  );

  return { visibleTaskIds, visibleTasks };
}
