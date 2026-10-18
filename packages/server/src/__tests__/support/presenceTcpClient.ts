import { connect } from "node:net";

function maskedFrame(payload: Buffer, opcode = 1): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = 0x80 | (payload.length < 126 ? payload.length : 126);
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]!));
  return Buffer.concat([header, mask, masked]);
}

/** Sends application frames together after a real authenticated TCP upgrade. */
export function sendPresenceTcpBatch(
  url: string,
  token: string,
  frames: string[]
): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = connect({ host: target.hostname, port: Number(target.port) });
    let upgraded = false;
    let received = Buffer.alloc(0);
    let closeCode: number | undefined;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("presence_tcp_close_timeout"));
    }, 3_000);
    socket.once("error", reject);
    socket.once("close", () => {
      clearTimeout(timer);
      if (closeCode === undefined) reject(new Error("presence_tcp_close_frame_required"));
      else resolve(closeCode);
    });
    socket.once("connect", () =>
      socket.write(
        [
          `GET ${target.pathname} HTTP/1.1`,
          `Host: ${target.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          `Authorization: Bearer ${token}`,
          "",
          ""
        ].join("\r\n")
      )
    );
    socket.on("data", (data: Buffer) => {
      received = Buffer.concat([received, data]);
      if (!upgraded) {
        const end = received.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (!received.toString().startsWith("HTTP/1.1 101 ")) {
          socket.destroy();
          reject(new Error("presence_tcp_upgrade_rejected"));
          return;
        }
        upgraded = true;
        received = received.subarray(end + 4);
        socket.write(Buffer.concat(frames.map((frame) => maskedFrame(Buffer.from(frame)))));
      }
      while (received.length >= 2) {
        const length = received[1]! & 0x7f;
        const offset = length === 126 ? 4 : 2;
        if (received.length < offset) return;
        const size = length === 126 ? received.readUInt16BE(2) : length;
        if (length === 127) {
          socket.destroy();
          reject(new Error("presence_tcp_unexpected_large_frame"));
          return;
        }
        if (received.length < offset + size) return;
        const opcode = received[0]! & 0x0f;
        const payload = received.subarray(offset, offset + size);
        received = received.subarray(offset + size);
        if (opcode === 8) {
          closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          socket.end(maskedFrame(payload, 8));
        }
      }
    });
  });
}
