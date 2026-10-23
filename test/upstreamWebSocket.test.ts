import { once } from "node:events";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { UpstreamWebSocket } from "../src/upstreamWebSocket.js";

test("zstd upstream never offers deflate, including reconnects", async () => {
 const server = new WebSocketServer({ port: 0 });
 await once(server, "listening");
 const address = server.address();
 if (typeof address === "string") throw new Error("Expected TCP address");
 try {
  for (let attempt = 0; attempt < 2; attempt++) {
   const incoming = once(server, "connection");
   const client = new UpstreamWebSocket(`ws://127.0.0.1:${address.port}/subscribe?compress=true`);
   client.on("error", () => {});
   const [socket, request] = await incoming;
   try {
    expect(request.url).toContain("compress=true");
    expect(request.headers["sec-websocket-extensions"] ?? "").not.toContain("permessage-deflate");
   } finally {
    client.terminate();
    socket.terminate();
   }
  }
 } finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
 }
});
