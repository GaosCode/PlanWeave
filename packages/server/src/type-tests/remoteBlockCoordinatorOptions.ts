import type { RemoteBlockCoordinatorOptions } from "../remoteBlockCoordinator.js";

type Assert<T extends true> = T;
type IsRequired<T, Key extends keyof T> =
  Pick<T, Key> extends Required<Pick<T, Key>> ? true : false;

export type RemoteCoordinatorContentAuthorizationIsRequired = Assert<
  IsRequired<RemoteBlockCoordinatorOptions, "contentAuthorize">
>;
