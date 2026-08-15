import type { OperatorHostView } from "@planweave-ai/agent-host-protocol/operator-control";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_INVENTORY_MAX_PAGES_PER_BATCH,
  HOST_INVENTORY_PAGE_SIZE,
  readHostInventoryBatch
} from "../renderer/settings/hostInventoryPagination";

function host(id: string, displayName = id): OperatorHostView {
  return {
    id,
    displayName,
    capabilities: [],
    capacity: 1,
    online: false,
    availability: { status: "unavailable", reason: "offline" }
  };
}

describe("Host inventory pagination", () => {
  it("follows cursors and deterministically keeps the latest duplicate version", async () => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [host("host-a", "Host A old"), host("host-b", "Host B")],
        nextCursor: 17
      })
      .mockResolvedValueOnce({
        items: [host("host-a", "Host A current"), host("host-c", "Host C")],
        nextCursor: null
      });

    const result = await readHostInventoryBatch({
      cursor: 0,
      hosts: [],
      requestedCursors: new Set(),
      readPage
    });

    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([0, 17]);
    expect(result.hosts.map(({ id, displayName }) => ({ id, displayName }))).toEqual([
      { id: "host-a", displayName: "Host A current" },
      { id: "host-b", displayName: "Host B" },
      { id: "host-c", displayName: "Host C" }
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns a continuation at the batch boundary", async () => {
    const readPage = vi.fn(async (cursor: number) => ({
      items: [host(`host-${cursor}`)],
      nextCursor: cursor + 1
    }));

    const result = await readHostInventoryBatch({
      cursor: 0,
      hosts: [],
      requestedCursors: new Set(),
      readPage
    });

    expect(readPage).toHaveBeenCalledTimes(HOST_INVENTORY_MAX_PAGES_PER_BATCH);
    expect(result.hosts).toHaveLength(HOST_INVENTORY_MAX_PAGES_PER_BATCH);
    expect(result.nextCursor).toBe(HOST_INVENTORY_MAX_PAGES_PER_BATCH);
  });

  it.each([
    { nextCursor: 0, code: "operator_host_pagination_cursor_repeated" },
    { nextCursor: 3, code: "operator_host_pagination_cursor_regressed" }
  ])("rejects a non-forward cursor", async ({ nextCursor, code }) => {
    const readPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [host("host-a")], nextCursor: 9 })
      .mockResolvedValueOnce({ items: [host("host-b")], nextCursor });

    await expect(
      readHostInventoryBatch({
        cursor: 0,
        hosts: [host("authoritative")],
        requestedCursors: new Set(),
        readPage
      })
    ).rejects.toMatchObject({ code });
  });

  it("rejects a page larger than the requested bound", async () => {
    await expect(
      readHostInventoryBatch({
        cursor: 0,
        hosts: [],
        requestedCursors: new Set(),
        readPage: vi.fn().mockResolvedValue({
          items: Array.from({ length: HOST_INVENTORY_PAGE_SIZE + 1 }, (_, index) =>
            host(`host-${index}`)
          ),
          nextCursor: null
        })
      })
    ).rejects.toMatchObject({ code: "operator_host_pagination_page_too_large" });
  });
});
