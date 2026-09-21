import {
  compareContentVersionMemberPaths,
  contentVersionMemberPathSchema,
  contentVersionMemberSchema,
  type CompletedContentVersionRef,
  type ContentVersionMember
} from "@planweave-ai/collaboration-protocol/content/version";
import {
  CONTENT_VERSION_MAX_MEMBERS,
  CONTENT_VERSION_MAX_MEMBER_BYTES,
  CONTENT_VERSION_MAX_TOTAL_BYTES
} from "@planweave-ai/collaboration-protocol/core/limits";
import { z } from "zod";
import type { SqliteDatabase } from "../sqlite.js";
import type { CanvasScopeKey } from "./repository.js";

const batchMemberLimit = 64;
const batchByteTarget = 1_024 * 1_024;
const memberIndexSchema = z
  .array(
    z.object({
      member_path: contentVersionMemberPathSchema,
      size_bytes: z.number().int().nonnegative().max(CONTENT_VERSION_MAX_MEMBER_BYTES),
      actual_bytes: z.number().int().nonnegative().max(CONTENT_VERSION_MAX_MEMBER_BYTES)
    })
  )
  .min(2)
  .max(CONTENT_VERSION_MAX_MEMBERS);

/** Materializes only one bounded batch; no SQLite cursor or transaction survives a yield. */
export function* readContentVersionMembers(
  database: SqliteDatabase,
  scope: CanvasScopeKey,
  content: CompletedContentVersionRef
): Iterable<ContentVersionMember> {
  const scopeValues = [scope.workspaceId, scope.projectId, scope.canvasId, content.versionId];
  const index = memberIndexSchema.parse(
    database
      .prepare(
        `SELECT member_path,size_bytes,length(CAST(content AS BLOB)) AS actual_bytes
       FROM canvas_content_version_members
      WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=? LIMIT ?`
      )
      .all(...scopeValues, CONTENT_VERSION_MAX_MEMBERS + 1)
  );
  index.sort((left, right) =>
    compareContentVersionMemberPaths(left.member_path, right.member_path)
  );
  let totalBytes = 0;
  for (const [position, member] of index.entries()) {
    if (member.size_bytes !== member.actual_bytes) {
      throw new Error("content_version_member_size_mismatch");
    }
    if (position > 0 && index[position - 1]!.member_path === member.member_path) {
      throw new Error("duplicate_content_version_member_path");
    }
    totalBytes += member.actual_bytes;
    if (totalBytes > CONTENT_VERSION_MAX_TOTAL_BYTES) {
      throw new Error("content_transfer_total_bytes_invalid");
    }
  }
  for (let offset = 0; offset < index.length; ) {
    const start = offset;
    let bytes = 0;
    while (offset < index.length && offset - start < batchMemberLimit) {
      const next = index[offset]!;
      if (offset > start && bytes + next.actual_bytes > batchByteTarget) break;
      bytes += next.actual_bytes;
      offset += 1;
      // A legal member larger than the target occupies its own batch.
      if (bytes >= batchByteTarget) break;
    }
    const batch = index.slice(start, offset);
    const rows = database
      .prepare(
        `SELECT member_kind,member_path,content,digest_sha256,size_bytes
         FROM canvas_content_version_members
        WHERE workspace_id=? AND project_id=? AND canvas_id=? AND version_id=?
          AND member_path IN (${batch.map(() => "?").join(",")})`
      )
      .all(...scopeValues, ...batch.map((member) => member.member_path));
    const expected = new Map(batch.map((member) => [member.member_path, member]));
    const members = new Map<string, ContentVersionMember>();
    for (const row of rows) {
      const member = contentVersionMemberSchema.parse({
        kind: row.member_kind,
        path: row.member_path,
        content: row.content,
        digestSha256: row.digest_sha256,
        sizeBytes: row.size_bytes
      });
      const metadata = expected.get(member.path);
      if (!metadata || members.has(member.path))
        throw new Error("duplicate_content_version_member_path");
      if (metadata.actual_bytes !== member.sizeBytes)
        throw new Error("content_version_member_size_mismatch");
      members.set(member.path, member);
    }
    if (members.size !== batch.length) throw new Error("content_version_member_missing");
    for (const metadata of batch) yield members.get(metadata.member_path)!;
  }
}
