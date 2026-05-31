import "./sea";
import EventEmitter from "node:events";
import { exit } from "node:process";
import type { TID } from "@atproto/common-web";
import { DCtx, DDict } from "zstd-napi/binding";
import type { AccountEvent, CommitEvent, IdentityEvent } from "@skyware/jetstream";
import { config } from "./config.js";
import { createDownstream } from "./downstream.js";
import { logger } from "./logger.js";
import type { DownstreamEventMap, UpstreamEventMap } from "./types.js";
import { createUpstream } from "./upstream.js";
import { parseClientMap, validateMaxWantedCollection } from "./util.js";

async function main() {
	const upstreamEmmitter = new EventEmitter<UpstreamEventMap>();
	const downstreamEmmitter = new EventEmitter<DownstreamEventMap>();

	const dictBuf = await globalThis.getAsset("zstd_dictionary");
	const ddict = new DDict(dictBuf);
	const dctx = new DCtx();
	const dstBuf = Buffer.allocUnsafe(256 * 1024); // 256KB、1メッセージの上限として十分
	const decompress = (data: Buffer): string => {
		const n = dctx.decompressUsingDDict(dstBuf, data, ddict);
		return dstBuf.subarray(0, n).toString("utf-8");
	};
	const clientMap = new Map<TID, Set<string> | "all">();

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

	await createUpstream(config, upstreamEmmitter);
	createDownstream(config, downstreamEmmitter);
}

main();

if (process.env.MODE !== "test") {
	process.addListener("SIGTERM", () => exit(0));
	process.addListener("SIGINT", () => exit(0));
	process.addListener("SIGHUP", () => exit(0));
	process.addListener("SIGBREAK", () => exit(0));
}
