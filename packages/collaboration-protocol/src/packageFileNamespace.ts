export function packageFileNamespaceConflict(paths: readonly string[]): string | undefined {
  const files = new Set(paths);
  for (const path of files) {
    for (
      let separator = path.indexOf("/");
      separator !== -1;
      separator = path.indexOf("/", separator + 1)
    ) {
      const parent = path.slice(0, separator);
      if (files.has(parent)) return `package_file_namespace_conflict:${parent}:${path}`;
    }
  }
  return undefined;
}
