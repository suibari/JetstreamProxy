import "./sea";
import EventEmitter from "node:events";
import { exit } from "node:process";
import type { TID } from "@atproto/common-web";
import { createDCtx, decompressUsingDict, init } from "@bokuweb/zstd-wasm";
import type { AccountEvent, CommitEvent, IdentityEvent } from "@skyware/jetstream";
import { config } from "./config.js";
import { createDownstream } from "./downstream.js";
import { logger } from "./logger.js";
import type { CursorState, DownstreamEventMap, UpstreamEventMap } from "./types.js";
import { createUpstream } from "./upstream.js";
import { parseClientMap, validateMaxWantedCollection } from "./util.js";

async function main() {
	const upstreamEmmitter = new EventEmitter<UpstreamEventMap>();
	const downstreamEmmitter = new EventEmitter<DownstreamEventMap>();
	// 接続クライアント1つにつき message リスナーを1つ持つ fan-out ハブなので、
	// 既定の「10個を超えたらリーク疑い」という警告は当てにならない。上限を外す。
	// リスナーはクライアント切断時に off しているので、実際に増え続けることはない
	// （接続/切断はログに出るので、増え続けていないかはそこで確認できる）。
	downstreamEmmitter.setMaxListeners(0);

	await init();
	const dict = await globalThis.getAsset("zstd_dictionary");
	const dctx = createDCtx();
	const decompress = (data: Buffer): string => {
		const raw = decompressUsingDict(dctx, data, dict);
		return Buffer.from(raw).toString("utf-8");
	};
	const clientMap = new Map<TID, Set<string> | "all">();
	// 転送した位置。upstream の再接続時の cursor と、新規クライアントの初期位置に使う。
	const cursor: CursorState = {};

	downstreamEmmitter.on("connect", (tid, wanted) => {
		if (wanted !== "all") {
			const isValid = validateMaxWantedCollection(clientMap, wanted);
			if (!isValid) {
				downstreamEmmitter.emit(
					"rejectConnect",
					tid,
					"The maximum number of collections (100) has been exceeded",
				);
				return;
			}
		}
		downstreamEmmitter.emit("acceptConnect", tid);
		clientMap.set(tid, wanted);
		upstreamEmmitter.emit("updateWantedCollections", parseClientMap(clientMap));
	});
	downstreamEmmitter.on("disconnect", (tid) => {
		clientMap.delete(tid);
		upstreamEmmitter.emit("updateWantedCollections", parseClientMap(clientMap));
	});
	upstreamEmmitter.on("message", (rawdata) => {
		let buff: Buffer;
		if (rawdata instanceof Buffer) {
			buff = rawdata;
		} else if (rawdata instanceof ArrayBuffer) {
			buff = Buffer.from(rawdata);
		} else {
			// FIXME: どう変換するのかわからん、たぶんBufferで渡ってくることが多いと思うからとりあえず放置
			logger.error(`Failed to parse raw data: ${String(rawdata)}`);
			return;
		}
		const decompressed = decompress(buff);
		const data = JSON.parse(decompressed) as AccountEvent | IdentityEvent | CommitEvent<string>;
		// クライアントへ配る前に進める。接続してきたクライアントは「ここから先」を受け取る。
		if (typeof data.time_us === "number" && data.time_us > (cursor.last ?? 0)) {
			cursor.last = data.time_us;
		}
		if (data.kind === "commit") {
			downstreamEmmitter.emit("message", data, data.commit.collection, rawdata, decompressed);
		} else if (data.kind === "identity") {
			downstreamEmmitter.emit("message", data, undefined, rawdata, decompressed);
		} else if (data.kind === "account") {
			downstreamEmmitter.emit("message", data, undefined, rawdata, decompressed);
		} else {
			logger.warn(`Unknown message kind received: ${JSON.stringify(data)}`);
		}
	});

	await createUpstream(config, upstreamEmmitter, cursor);
	createDownstream(config, downstreamEmmitter, cursor);
}

main();

if (process.env.MODE !== "test") {
	process.addListener("SIGTERM", () => exit(0));
	process.addListener("SIGINT", () => exit(0));
	process.addListener("SIGHUP", () => exit(0));
	process.addListener("SIGBREAK", () => exit(0));
}
