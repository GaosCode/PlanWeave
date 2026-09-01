import type { IncomingMessage } from "node:http";
import { StringDecoder } from "node:string_decoder";
import {
  ownerCanvasMaterializationRequestSchema,
  ownerCanvasMaterializationUploadFrameSchema,
  ownerCanvasMaterializationUploadLimits,
  ownerCanvasMaterializationUploadMediaType,
  type OwnerCanvasMaterializationRequest,
  type OwnerCanvasMaterializationUploadFrame
} from "@planweave-ai/collaboration-protocol/owner-canvas/materialization";
import {
  CONTENT_VERSION_MAX_MEMBERS,
  CONTENT_VERSION_MAX_TOTAL_BYTES
} from "@planweave-ai/collaboration-protocol/core/limits";

export class OwnerCanvasMaterializationUploadBudget {
  private memberCount = 0;
  private totalBytes = 0;

  constructor(
    private readonly maxMembers = CONTENT_VERSION_MAX_MEMBERS,
    private readonly maxTotalBytes = CONTENT_VERSION_MAX_TOTAL_BYTES
  ) {}

  acceptMember(sizeBytes: number): void {
    this.memberCount += 1;
    if (this.memberCount > this.maxMembers) {
      throw new Error("owner_canvas_materialization_member_count_too_large");
    }
    this.totalBytes += sizeBytes;
    if (this.totalBytes > this.maxTotalBytes) {
      throw new Error("owner_canvas_materialization_total_bytes_too_large");
    }
  }
}

function assertContentType(request: IncomingMessage): void {
  const value = request.headers["content-type"] ?? "";
  const mediaType = Array.isArray(value) ? "" : value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== ownerCanvasMaterializationUploadMediaType) {
    throw new Error("owner_canvas_materialization_content_type_invalid");
  }
}

function declaredLength(request: IncomingMessage): number | undefined {
  const value = request.headers["content-length"];
  if (Array.isArray(value)) throw new Error("owner_canvas_materialization_content_length_invalid");
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new Error("owner_canvas_materialization_content_length_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("owner_canvas_materialization_content_length_invalid");
  }
  if (parsed > ownerCanvasMaterializationUploadLimits.maxWireBytes) {
    throw new Error("owner_canvas_materialization_body_too_large");
  }
  return parsed;
}

function parseFrame(line: string): OwnerCanvasMaterializationUploadFrame {
  if (Buffer.byteLength(line, "utf8") > ownerCanvasMaterializationUploadLimits.maxFrameBytes) {
    throw new Error("owner_canvas_materialization_frame_too_large");
  }
  try {
    return ownerCanvasMaterializationUploadFrameSchema.parse(JSON.parse(line));
  } catch {
    throw new Error("owner_canvas_materialization_frame_invalid");
  }
}

/** Authenticated Operator upload parser. It accepts exactly one ordered NDJSON document. */
export async function readOwnerCanvasMaterializationUpload(
  request: IncomingMessage
): Promise<OwnerCanvasMaterializationRequest> {
  assertContentType(request);
  const expectedLength = declaredLength(request);
  let wireBytes = 0;
  let buffered = "";
  const decoder = new StringDecoder("utf8");
  let header: Extract<OwnerCanvasMaterializationUploadFrame, { type: "header" }> | undefined;
  const members: Array<
    Extract<OwnerCanvasMaterializationUploadFrame, { type: "member" }>["member"]
  > = [];
  const uploadBudget = new OwnerCanvasMaterializationUploadBudget();
  let complete: Extract<OwnerCanvasMaterializationUploadFrame, { type: "complete" }> | undefined;

  const accept = (line: string) => {
    if (line.length === 0 || complete) {
      throw new Error("owner_canvas_materialization_frame_invalid");
    }
    const frame = parseFrame(line);
    if (frame.type === "header") {
      if (header || members.length > 0) {
        throw new Error("owner_canvas_materialization_frame_invalid");
      }
      header = frame;
      return;
    }
    if (!header) throw new Error("owner_canvas_materialization_frame_invalid");
    if (frame.type === "member") {
      if (frame.index !== members.length) {
        throw new Error("owner_canvas_materialization_member_order_invalid");
      }
      uploadBudget.acceptMember(frame.member.sizeBytes);
      members.push(frame.member);
      return;
    }
    complete = frame;
  };

  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    wireBytes += bytes.byteLength;
    if (wireBytes > ownerCanvasMaterializationUploadLimits.maxWireBytes) {
      throw new Error("owner_canvas_materialization_body_too_large");
    }
    buffered += decoder.write(bytes);
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      accept(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (
      Buffer.byteLength(buffered, "utf8") > ownerCanvasMaterializationUploadLimits.maxFrameBytes
    ) {
      throw new Error("owner_canvas_materialization_frame_too_large");
    }
  }
  buffered += decoder.end();
  if (expectedLength !== undefined && wireBytes !== expectedLength) {
    throw new Error("owner_canvas_materialization_content_length_invalid");
  }
  if (buffered.length > 0) accept(buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered);
  if (!header || !complete) throw new Error("owner_canvas_materialization_frame_invalid");
  if (complete.memberCount !== members.length) {
    throw new Error("owner_canvas_materialization_complete_invalid");
  }
  const totalBytes = members.reduce((sum, member) => sum + member.sizeBytes, 0);
  if (complete.totalBytes !== totalBytes) {
    throw new Error("owner_canvas_materialization_complete_invalid");
  }
  return ownerCanvasMaterializationRequestSchema.parse({
    ...header.request,
    content: {
      members,
      totalBytes: complete.totalBytes,
      canonicalDigest: complete.canonicalDigest
    }
  });
}
