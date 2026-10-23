import EventEmitter, { once } from "node:events";
import { afterEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { createUpstream } from "../src/upstream.js";
import type { Config, CursorState, UpstreamEventMap } from "../src/types.js";

const servers: WebSocketServer[] = [];

async function listen() {
	const server = new WebSocketServer({ port: 0 });
	servers.push(server);
	await once(server, "listening");
	const address = server.address();
	if (typeof address === "string") throw new Error("Expected TCP address");
	return { server, url: new URL(`ws://127.0.0.1:${address.port}/subscribe`) };
}

function config(upstreamURLs: URL[]): Config {
	return { proxyPort: 0, upstreamURLs, logFile: "" };
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		for (const client of server.clients) client.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("接続を保ったまま無通信になった上流から、次の候補へ移る", async () => {
	// 1本目は接続を受けるだけで何も送らない（2026-10-23 の us-west と同じ状態）。
	const silent = await listen();
	const healthy = await listen();
	const emitter = new EventEmitter<UpstreamEventMap>();
	const cursor: CursorState = { last: 120_000_000 };

	await createUpstream(config([silent.url, healthy.url]), emitter, cursor, {
		stallAfterMs: 300,
		stallCheckMs: 50,
	});
	const reconnected = once(healthy.server, "connection") as Promise<[unknown, IncomingMessage]>;
	emitter.emit("updateWantedCollections", new Set(["app.bsky.feed.post"]));

	const [, request] = await reconnected;
	const url = new URL(request.url ?? "", "ws://localhost");
	expect(url.searchParams.getAll("wantedCollections")).toEqual(["app.bsky.feed.post"]);
	// 無音の間に流れたイベントを取り戻せるよう、最後に転送した位置から巻き戻して繋ぐ。
	expect(url.searchParams.get("cursor")).toBe("60000000");
});

test("イベントが流れている間は張り直さない", async () => {
	const live = await listen();
	const other = await listen();
	live.server.on("connection", (socket) => {
		const timer = setInterval(() => socket.send(Buffer.from([0])), 50);
		socket.on("close", () => clearInterval(timer));
	});
	let otherConnections = 0;
	other.server.on("connection", () => otherConnections++);
	const emitter = new EventEmitter<UpstreamEventMap>();
	emitter.on("message", () => {});

	await createUpstream(config([live.url, other.url]), emitter, {}, { stallAfterMs: 300, stallCheckMs: 50 });
	emitter.emit("updateWantedCollections", new Set(["app.bsky.feed.post"]));

	await new Promise((resolve) => setTimeout(resolve, 800));
	expect(otherConnections).toBe(0);
});

test("クライアントが居ないあいだの無音では張り直さない", async () => {
	const idle = await listen();
	const other = await listen();
	let otherConnections = 0;
	other.server.on("connection", () => otherConnections++);
	const emitter = new EventEmitter<UpstreamEventMap>();

	await createUpstream(config([idle.url, other.url]), emitter, {}, { stallAfterMs: 300, stallCheckMs: 50 });
	// 最後のクライアントが抜けるとダミー購読になり、上流は何も流してこない。
	emitter.emit("updateWantedCollections", new Set());

	await new Promise((resolve) => setTimeout(resolve, 800));
	expect(otherConnections).toBe(0);
});
