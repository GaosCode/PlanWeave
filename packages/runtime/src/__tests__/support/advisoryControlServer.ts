import { createServer, type Socket } from "node:net";
import { z } from "zod";

const messageSchema = z
  .object({
    event: z.string(),
    actor: z.string(),
    pid: z.number().int().positive()
  })
  .passthrough();
type Message = z.infer<typeof messageSchema>;
export async function createAdvisoryControlServer() {
  const messages: Message[] = [];
  const sockets = new Map<string, Socket>();
  const clients = new Set<Socket>();
  const pending = new Map<string, { resolve(value: Message): void; reject(error: Error): void }>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let boundary = buffer.indexOf("\n");
      while (boundary !== -1) {
        const message = messageSchema.parse(JSON.parse(buffer.slice(0, boundary)));
        buffer = buffer.slice(boundary + 1);
        boundary = buffer.indexOf("\n");
        messages.push(message);
        sockets.set(message.actor, socket);
        const key = `${message.actor}:${message.event}`;
        pending.get(key)?.resolve(message);
        pending.delete(key);
      }
    });
    socket.on("error", (error) => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected loopback control listener");
  return {
    port: address.port,
    messages,
    wait(actor: string, event: string) {
      const known = messages.find((message) => message.actor === actor && message.event === event);
      if (known) return Promise.resolve(known);
      return new Promise<Message>((resolve, reject) => {
        const key = `${actor}:${event}`;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Control barrier timed out: ${key}`));
        }, 5000);
        pending.set(key, {
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          }
        });
      });
    },
    send(actor: string, command: string) {
      const socket = sockets.get(actor);
      if (!socket) throw new Error(`Missing control connection for ${actor}`);
      socket.write(`${command}\n`);
    },
    async close() {
      for (const waiter of pending.values()) waiter.reject(new Error("Control server closed"));
      pending.clear();
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}
