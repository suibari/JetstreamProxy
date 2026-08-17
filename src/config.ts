import { join, normalize } from "node:path";
import { exit } from "node:process";
import type { Config } from "./types.js";
import { parsePort, parseUpstreamURLs } from "./util.js";

// upstream urlのバリデーション。カンマ区切りで複数指定でき、繋がらない状態が続いたら
// 次の候補へ切り替える。既定は公式インスタンスを西→東の順に並べたもの。
const upstreamURLs = parseUpstreamURLs(
	process.argv[2] ||
		[
			"wss://jetstream2.us-west.bsky.network/subscribe",
			"wss://jetstream1.us-west.bsky.network/subscribe",
			"wss://jetstream1.us-east.bsky.network/subscribe",
			"wss://jetstream2.us-east.bsky.network/subscribe",
		].join(","),
);
if (upstreamURLs === false) {
	console.error("Invalid UPSTREAM_URL");
	exit(1);
}
// portのバリデーション
const proxyPort = parsePort(process.argv[3] ?? 8000);
if (proxyPort === false) {
	console.error("Invalid PORT");
	exit(1);
}
const logFile = normalize(process.argv[4] ?? join(__dirname, "log.txt"));

export const config: Config = { proxyPort, upstreamURLs, logFile } as const;
