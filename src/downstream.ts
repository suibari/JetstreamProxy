// 主にProxyに接続しているクライアントとの通信
import type { EventEmitter } from "node:events";
import { TID } from "@atproto/common-web";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { logger } from "./logger.js";
import type { Config, CursorState, DownstreamEventMap } from "./types.js";
import { createFilter, createTimeGate, parseClientCursor } from "./util.js";

export function createDownstream(config: Config, emitter: EventEmitter<DownstreamEventMap>, cursor: CursorState) {
	const server = new WebSocketServer({ port: config.proxyPort, perMessageDeflate: false });
	server.on("error", (error) => {
		logger.error(`Downstream server error: ${String(error)}`);
	});
	server.on("listening", () => {
		logger.info(`Downstream server started on port ${config.proxyPort}.`);
	});
	server.on("connection", (ws, req) => {
		const tid = TID.next();
		if (req.url == null) {
			ws.close(4000, "cannot read req.url");
			return;
		}
		const sp = new URL(req.url, "ws://example.com").searchParams;
		const allMode = !sp.has("wantedCollections");
		const wantedCollections = new Set(sp.getAll("wantedCollections"));
		const onlyCommit = sp.has("onlyCommit");
		const compress = sp.has("compress");
		const filter = createFilter(wantedCollections);
		logger.logConnect(tid.toString(), allMode, wantedCollections);
		if (filter === false) {
			logger.warn(`Client ${tid} rejected: invalid collection.`);
			ws.close(4000, "bad collection");
			return;
		}
		// upstream の cursor 巻き戻しが、このクライアントへの再配信にならないようにする。
		const gate = createTimeGate(parseClientCursor(sp.get("cursor"), cursor.last));
		const onMessage: DownstreamEventMap["message"] extends unknown[]
			? (...args: DownstreamEventMap["message"]) => void
			: never = (ev, col, raw, decompressed) => {
			const timeUs = typeof ev.time_us === "number" ? ev.time_us : undefined;
			if (!gate.allows(timeUs)) return;
			const forward = () => {
				gate.accept(timeUs);
				send(raw, decompressed);
			};
			switch (ev.kind) {
				case "account":
					if (!onlyCommit) forward();
					return;
				case "identity":
					if (!onlyCommit) forward();
					return;
				case "commit":
					if (col == null) return;
					if (allMode) return void forward();
					if (filter(col)) return void forward();
			}
		};
		const onReject = (rejectid: TID, reason: string) => {
			if (rejectid === tid) {
				ws.removeAllListeners();
				ws.close(4000, reason);
				emitter.emit("disconnect", tid);
				emitter.off("rejectConnect", onReject);
				emitter.off("acceptConnect", onAccept);
				emitter.off("message", onMessage);
				logger.warn(`Client ${tid} rejected: ${reason}`);
			}
		};
		const onAccept = () => {
			emitter.off("rejectConnect", onReject);
			emitter.off("acceptConnect", onAccept);
		};
		emitter.on("rejectConnect", onReject);
		emitter.on("acceptConnect", onAccept);
		emitter.emit("connect", tid, allMode ? "all" : wantedCollections);
		ws.on("close", () => {
			emitter.emit("disconnect", tid);
			// 切断したクライアント向けのリスナーは必ず外す。ここを on で登録し直すと、
			// 再接続を繰り返すクライアントの分だけリスナーが積み上がる。
			emitter.off("rejectConnect", onReject);
			emitter.off("acceptConnect", onAccept);
			emitter.off("message", onMessage);
			ws.removeAllListeners();
			logger.logDisconnect(tid.toString());
		});
		const send = createSend(ws, compress);
		emitter.on("message", onMessage);
	});
}

function createSend(ws: WebSocket, compress = false): (raw: RawData, decompressed: string) => void {
	if (compress) {
		return (raw) => {
			ws.send(raw);
		};
	}
	return (_, decompressed) => {
		ws.send(decompressed);
	};
}
