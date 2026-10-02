import { Readable, Writable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { releaseHttpDownloadSource, transferHttpDownload } from "../httpDownloadTransfer.js";

function sink(chunks: Buffer[] = []): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    }
  });
}

function expectReleased(source: Readable, response: Writable): void {
  expect(source.destroyed).toBe(true);
  expect(response.destroyed).toBe(true);
  for (const event of ["error", "close", "end", "data"]) {
    expect(source.listenerCount(event)).toBe(0);
  }
  for (const event of ["error", "close", "finish", "unpipe", "drain"]) {
    expect(response.listenerCount(event)).toBe(0);
  }
}

describe("authorized HTTP download lifecycle", () => {
  it("preserves successful bytes and releases a source without autoDestroy at EOF", async () => {
    const bytes = [Buffer.from("first"), Buffer.from("last")];
    const source = Readable.from(bytes, { autoDestroy: false });
    const received: Buffer[] = [];
    const response = sink(received);
    transferHttpDownload(source, response);
    await setImmediate();
    expect(Buffer.concat(received)).toEqual(Buffer.from("firstlast"));
    expect(response.writableFinished).toBe(true);
    expectReleased(source, response);
  });

  it("reclaims an unfinished source when the client closes", async () => {
    const source = new Readable({ read() {} });
    const response = sink();
    transferHttpDownload(source, response);
    response.destroy();
    await setImmediate();
    expectReleased(source, response);
  });

  it.each([
    "source",
    "response",
    "both"
  ] as const)("terminates both ends and removes listeners on %s failure", async (side) => {
    const source = new Readable({ read() {} });
    const response = sink();
    transferHttpDownload(source, response);
    if (side !== "response") source.destroy(new Error("read failed"));
    if (side !== "source") response.destroy(new Error("socket failed"));
    await setImmediate();
    expectReleased(source, response);
  });

  it("terminates the response if the source closes before EOF", async () => {
    const source = new Readable({ read() {} });
    const response = sink();
    transferHttpDownload(source, response);
    source.destroy();
    await setImmediate();
    expect(response.writableFinished).toBe(false);
    expectReleased(source, response);
  });

  it.each([
    "closed",
    "ended"
  ] as const)("reclaims a source for an already %s response", async (state) => {
    const source = new Readable({ read() {} });
    const response = sink();
    if (state === "closed") response.destroy();
    else response.end();
    await setImmediate();
    transferHttpDownload(source, response);
    await setImmediate();
    expectReleased(source, response);
  });

  it("propagates a synchronous pipe failure while reclaiming both ends", async () => {
    class FailingSource extends Readable {
      override pipe<T extends NodeJS.WritableStream>(_destination: T): T {
        throw new Error("pipe failed");
      }
    }
    const source = new FailingSource({ read() {} });
    const response = sink();
    expect(() => transferHttpDownload(source, response)).toThrow("pipe failed");
    await setImmediate();
    expectReleased(source, response);
  });

  it("releases an unclaimed source repeatedly without retaining listeners or swallowing its owner error", async () => {
    const source = new Readable({ read() {} });
    releaseHttpDownloadSource(source);
    releaseHttpDownloadSource(source);
    await setImmediate();
    expect(source.closed).toBe(true);
    expect(source.eventNames()).toEqual([]);
  });
});
