import { describe, expect, it } from "vitest";
import type { DispatchRecord, DispatchWriteback } from "../dispatches.js";
import type { CommentActivityHttpOptions } from "../index.js";
import * as serverApi from "../index.js";
// @ts-expect-error Dispatch construction options are intentionally internal to the coordinator.
import type { DispatchServiceOptions } from "../index.js";
// @ts-expect-error Dispatch writeback is intentionally internal to the coordinator.
import type { DispatchWriteback as PublicDispatchWriteback } from "../index.js";
// @ts-expect-error Raw coordinator construction is intentionally internal to the fixed Server composition.
import type { RemoteBlockCoordinator } from "../index.js";
// @ts-expect-error Raw coordinator options are intentionally internal to the fixed Server composition.
import type { RemoteBlockCoordinatorOptions } from "../index.js";

/** Compile-time guard: residual packageRef must not return to public DTOs. */
type AssertNoPackageRefKey<T> = "packageRef" extends keyof T ? never : true;
const _dispatchRecordHasNoPackageRef: AssertNoPackageRefKey<DispatchRecord> = true;
const _writebackCompleteHasNoPackageRef: AssertNoPackageRefKey<
  Parameters<DispatchWriteback["complete"]>[0]
> = true;
const _writebackFailHasNoPackageRef: AssertNoPackageRefKey<
  Parameters<DispatchWriteback["fail"]>[0]
> = true;
void _dispatchRecordHasNoPackageRef;
void _writebackCompleteHasNoPackageRef;
void _writebackFailHasNoPackageRef;
void (undefined as
  | DispatchServiceOptions
  | PublicDispatchWriteback
  | RemoteBlockCoordinator
  | RemoteBlockCoordinatorOptions
  | undefined);

const _commentActivityHttpOptions: CommentActivityHttpOptions | undefined = undefined;
void _commentActivityHttpOptions;

describe("server public export surface", () => {
  it("exports remote coordination and omits the retired thin dual factory", () => {
    expect(typeof serverApi.createRemoteBlockCoordination).toBe("function");
    expect(typeof serverApi.startRemoteBlockCoordinationServer).toBe("function");
    expect(serverApi).not.toHaveProperty("RemoteBlockCoordinator");
    expect(serverApi).not.toHaveProperty("createDistributedCoordination");
    expect(serverApi).not.toHaveProperty("DistributedCoordinationOptions");
  });

  it("keeps dispatch construction and writeback behind the coordinator", () => {
    expect(serverApi).not.toHaveProperty("DispatchService");
    expect(serverApi.dispatchStatusSchema).toBeDefined();
  });

  it("exports the comment and activity HTTP adapter from the package root", () => {
    expect(typeof serverApi.handleCommentActivityHttpRequest).toBe("function");
    expect(typeof serverApi.resetCommentActivityHttpRateLimits).toBe("function");
  });
});
