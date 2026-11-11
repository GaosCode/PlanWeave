export function hasPortablePackageFileSegmentLengths(path: string): boolean {
  return path.split("/").every((segment) => segment.length <= 255);
}

export function packageFileAddressKey(path: string): string {
  return path.toLowerCase();
}

export function packageFileNamespaceConflict(paths: readonly string[]): string | undefined {
  const files = new Map<string, string>();
  for (const path of paths) {
    const key = packageFileAddressKey(path);
    const existing = files.get(key);
    if (existing !== undefined && existing !== path) {
      return `package_file_namespace_conflict:${existing}:${path}`;
    }
    files.set(key, path);
  }
  for (const [key, path] of files) {
    for (
      let separator = key.indexOf("/");
      separator !== -1;
      separator = key.indexOf("/", separator + 1)
    ) {
      const parent = files.get(key.slice(0, separator));
      if (parent !== undefined) return `package_file_namespace_conflict:${parent}:${path}`;
    }
  }
  return undefined;
}
