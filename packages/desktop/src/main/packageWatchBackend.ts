/** Minimal backend handle shared by native and polling adapters. */
export type PackageWatchBackendHandle = {
  kind: "native" | "polling";
  close(): void;
};
