/**
 * Package-relative paths in manifests and diagnostics use POSIX separators.
 * On Windows, path.relative() yields backslashes; normalize before Set/map equality.
 */
export function toPackagePosixPath(path: string): string {
  return path.split("\\").join("/");
}
