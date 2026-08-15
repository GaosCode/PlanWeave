import type {
  OperatorHostPage,
  OperatorHostView
} from "@planweave-ai/agent-host-protocol/operator-control";

export const HOST_INVENTORY_PAGE_SIZE = 100;
export const HOST_INVENTORY_MAX_PAGES_PER_BATCH = 5;
export const HOST_INVENTORY_MAX_ITEMS_PER_BATCH =
  HOST_INVENTORY_PAGE_SIZE * HOST_INVENTORY_MAX_PAGES_PER_BATCH;

export type HostInventoryBatch = {
  hosts: OperatorHostView[];
  nextCursor: number | null;
  requestedCursors: ReadonlySet<number>;
};

export function mergeHostInventory(
  existingHosts: readonly OperatorHostView[],
  refreshedHosts: readonly OperatorHostView[]
): OperatorHostView[] {
  const hostsById = new Map(existingHosts.map((host) => [host.id, host]));
  for (const host of refreshedHosts) hostsById.set(host.id, host);
  return [...hostsById.values()];
}

export class HostInventoryPaginationError extends Error {
  readonly code:
    | "operator_host_pagination_cursor_repeated"
    | "operator_host_pagination_cursor_regressed"
    | "operator_host_pagination_page_too_large";

  constructor(code: HostInventoryPaginationError["code"]) {
    super(code);
    this.name = "HostInventoryPaginationError";
    this.code = code;
  }
}

/**
 * Reads one bounded Host inventory batch. Host order follows first appearance, while a later page
 * replaces the value for a repeated Host id. Results are published only after the whole batch.
 */
export async function readHostInventoryBatch(input: {
  cursor: number;
  hosts: readonly OperatorHostView[];
  requestedCursors: ReadonlySet<number>;
  readPage: (cursor: number) => Promise<OperatorHostPage>;
}): Promise<HostInventoryBatch> {
  const hostsById = new Map(input.hosts.map((host) => [host.id, host]));
  const requestedCursors = new Set(input.requestedCursors);
  let cursor = input.cursor;
  let itemCount = 0;

  for (let pageCount = 0; pageCount < HOST_INVENTORY_MAX_PAGES_PER_BATCH; pageCount += 1) {
    if (requestedCursors.has(cursor)) {
      throw new HostInventoryPaginationError("operator_host_pagination_cursor_repeated");
    }
    requestedCursors.add(cursor);

    const page = await input.readPage(cursor);
    if (page.items.length > HOST_INVENTORY_PAGE_SIZE) {
      throw new HostInventoryPaginationError("operator_host_pagination_page_too_large");
    }
    itemCount += page.items.length;
    for (const host of page.items) hostsById.set(host.id, host);

    if (page.nextCursor === null) {
      return { hosts: [...hostsById.values()], nextCursor: null, requestedCursors };
    }
    if (page.nextCursor === cursor || requestedCursors.has(page.nextCursor)) {
      throw new HostInventoryPaginationError("operator_host_pagination_cursor_repeated");
    }
    if (page.nextCursor < cursor) {
      throw new HostInventoryPaginationError("operator_host_pagination_cursor_regressed");
    }
    if (
      pageCount + 1 === HOST_INVENTORY_MAX_PAGES_PER_BATCH ||
      itemCount >= HOST_INVENTORY_MAX_ITEMS_PER_BATCH
    ) {
      return { hosts: [...hostsById.values()], nextCursor: page.nextCursor, requestedCursors };
    }
    cursor = page.nextCursor;
  }

  throw new Error("operator_host_pagination_batch_unreachable");
}
