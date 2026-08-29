import type { RemoteBlockCoordinationOptions } from "../distributedCoordination.js";
import type { RemoteBlockCoordinatorOptions } from "../remoteBlockCoordinator.js";
// @ts-expect-error Raw coordinator construction is not part of the Server package API.
import type { RemoteBlockCoordinator as PublicRemoteBlockCoordinator } from "../index.js";
// @ts-expect-error Raw coordinator options are not part of the Server package API.
import type { RemoteBlockCoordinatorOptions as PublicRemoteBlockCoordinatorOptions } from "../index.js";

type Assert<T extends true> = T;
type IsRequired<T, Key extends keyof T> =
  Pick<T, Key> extends Required<Pick<T, Key>> ? true : false;

export type RemoteCoordinatorContentAuthorizationIsRequired = Assert<
  IsRequired<RemoteBlockCoordinatorOptions, "contentAuthorize">
>;

export type RemoteCoordinationCannotOverrideServerCandidateAuthority = Assert<
  "dispatchCandidates" extends keyof RemoteBlockCoordinationOptions ? false : true
>;

export type PublicRawRemoteCoordinatorIsUnavailable =
  | PublicRemoteBlockCoordinator
  | PublicRemoteBlockCoordinatorOptions;
