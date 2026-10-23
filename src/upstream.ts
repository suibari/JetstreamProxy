// 主にJetstream本体サーバーとの通信
import type EventEmitter from "node:events";
import { WebSocket } from "partysocket";
import { UpstreamWebSocket } from "./upstreamWebSocket.js";
import { logger } from "./logger.js";
import type { Config, CursorState, OptionUpdateMsg, UpstreamEventMap } from "./types.js";

/**
 * 同じ候補へ繋がらない状態がここまで続いたら、次の候補へ移る。
 * 短い瞬断は partysocket が張り直すので、それより十分長く取る。
 */
const ROTATE_AFTER_MS = 20 * 1000;
/**
 * 再接続時にどれだけ巻き戻すか。切断の検知からURL再評価までの隙間を吸収する。
 * 巻き戻し分はクライアント側の time_us ゲートで重複排除されるので、多めでも二重配信しない。
 */
const REPLAY_US = 60 * 1000 * 1000;
/**
 * 購読中なのに上流から何も届かない状態がここまで続いたら、接続を張り直して次の候補へ移る。
 *
 * 上流は TCP を開いたまま送信だけ止めることがある。2026-10-23 は jetstream2.us-west が
 * close も error も出さずに約9時間無通信になり、onclose 頼りのローテーションが一度も動かず
 * 配下の bot が全員止まった。公式 Jetstream の post だけでも毎秒数十件流れるので、
 * 1分の無音は異常とみなしてよい。
 */
const STALL_AFTER_MS = 60 * 1000;
const STALL_CHECK_MS = 10 * 1000;
const DUMMY_COLLECTION = "example.dummy.collection";

export interface UpstreamOptions {
	stallAfterMs?: number;
	stallCheckMs?: number;
}

export async function createUpstream(
	config: Config,
	emitter: EventEmitter<UpstreamEventMap>,
	cursor: CursorState,
	{ stallAfterMs = STALL_AFTER_MS, stallCheckMs = STALL_CHECK_MS }: UpstreamOptions = {},
) {
	const wantedCollections = new Set<string>();
	let allMode = false;
	let index = 0;
	let connected = false;
	let rotateTimer: NodeJS.Timeout | null = null;
	let lastMessageAt = Date.now();
	const current = () => config.upstreamURLs[index];
	const getURL = () => {
		const url = new URL(current());
		url.searchParams.set("compress", "true");
		// 全取得モードの場合はwantedCollectionsを削除
		if (allMode) {
			url.searchParams.delete("wantedCollections");
		} else {
			// クライアントが接続されていない場合
			if (wantedCollections.size === 0) {
				url.searchParams.set("requireHello", "true");
			} else {
				for (const collection of wantedCollections) {
					url.searchParams.append("wantedCollections", collection);
				}
			}
		}
		// 再接続で切断中のイベントを取り戻す。requireHelloのときは何も流れてこないので付けない。
		if (cursor.last != null && (allMode || wantedCollections.size > 0)) {
			url.searchParams.set("cursor", String(Math.max(0, cursor.last - REPLAY_US)));
		}
		return url.toString();
	};
	const upstream = new WebSocket(getURL, [], { WebSocket: UpstreamWebSocket });

	/**
	 * partysocket は同じURLへ延々と繋ぎ直す。上流の1インスタンスが死んでいる場合はそれでは
	 * 復帰しないので、一定時間つながらなければ次の候補へ寄せる。URLは関数で渡してあるため、
	 * ここで index を進めて reconnect するだけで切り替わる。
	 */
	const armRotate = () => {
		if (rotateTimer || config.upstreamURLs.length < 2) return;
		rotateTimer = setTimeout(() => {
			rotateTimer = null;
			if (connected) return;
			index = (index + 1) % config.upstreamURLs.length;
			logger.warn(`Rotating upstream server: ${current().toString()}`);
			upstream.reconnect();
			armRotate();
		}, ROTATE_AFTER_MS);
		rotateTimer.unref?.();
	};

	/**
	 * クライアントが居ない間（requireHello やダミー購読）は何も流れてこないのが正常なので、
	 * 無通信を異常とみなすのは実際に何かを購読しているときだけ。
	 */
	const expectsEvents = () => allMode || Array.from(wantedCollections).some((c) => c !== DUMMY_COLLECTION);
	const stallTimer = setInterval(() => {
		if (!connected || !expectsEvents()) return;
		const silentMs = Date.now() - lastMessageAt;
		if (silentMs < stallAfterMs) return;
		index = (index + 1) % config.upstreamURLs.length;
		logger.warn(
			`Upstream silent for ${Math.round(silentMs / 1000)}s, reconnecting to: ${current().toString()}`,
		);
		// 張り直しが繋がるまでの間に連続で発火しないよう、ここで計測をやり直す。
		lastMessageAt = Date.now();
		connected = false;
		upstream.reconnect();
		armRotate();
	}, stallCheckMs);
	stallTimer.unref?.();

	upstream.onmessage = async (ev) => {
		lastMessageAt = Date.now();
		const raw: Blob | ArrayBuffer | string = ev.data;
		if (raw instanceof Blob) {
			const ab = await raw.arrayBuffer();
			emitter.emit("message", ab);
		} else {
			emitter.emit("message", raw);
		}
	};
	emitter.on("updateWantedCollections", (collections) => {
		// 購読を変えた直後は流れ始めるまで待つ。何も購読していなかった間の無音を数えない。
		lastMessageAt = Date.now();
		if (collections === "all") {
			allMode = true;
			upstream.send(createOptionUpdateMsg(undefined));
			logger.upstreamUpdate("all");
		} else {
			allMode = false;
			wantedCollections.clear();
			for (const collection of collections) wantedCollections.add(collection);
			if (wantedCollections.size === 0) wantedCollections.add(DUMMY_COLLECTION);
			upstream.send(createOptionUpdateMsg(wantedCollections));
			logger.upstreamUpdate(wantedCollections);
		}
	});
	/**
	 * 起動を諦めるまでの時間。候補を一巡試し切るだけの猶予を持たせる。
	 * ここでエラー即 reject にすると、第一候補が死んでいるだけでローテーションを待たずに
	 * 起動が失敗してしまい、候補リストの意味が無くなる。
	 * 候補が1本のときは従来どおり10秒で諦める。
	 */
	const initialTimeoutMs = 10 * 1000 + ROTATE_AFTER_MS * (config.upstreamURLs.length - 1);
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		const to = setTimeout(() => {
			if (settled) return;
			settled = true;
			logger.error("Upstream initial connection timeout");
			reject(new Error("Upstream initial connection timeout"));
		}, initialTimeoutMs);
		to.unref?.();
		upstream.onopen = () => {
			connected = true;
			lastMessageAt = Date.now();
			if (rotateTimer) clearTimeout(rotateTimer);
			rotateTimer = null;
			logger.info(`Connected to upstream server: ${upstream.url}`);
			if (settled) return;
			settled = true;
			clearTimeout(to);
			resolve();
		};
		upstream.onclose = () => {
			connected = false;
			armRotate();
		};
		upstream.onerror = (err) => {
			connected = false;
			// どの候補で何が起きたかを残す。ErrorEvent は String() だと [object Object] になる。
			logger.error(`Upstream connection error (${current().toString()}): ${describeError(err)}`);
			// 失敗しても reject しない。partysocket の再接続とローテーションに任せ、
			// 一度も繋がらないまま initialTimeoutMs を過ぎたときだけ起動を失敗させる。
			armRotate();
		};
		armRotate();
	});
}

function describeError(err: unknown): string {
	if (err == null) return "unknown error";
	if (err instanceof Error) return err.message;
	if (typeof err === "object") {
		const { message, error, type } = err as { message?: unknown; error?: unknown; type?: unknown };
		if (typeof message === "string" && message.length > 0) return message;
		if (error instanceof Error) return error.message;
		if (typeof type === "string" && type.length > 0) return type;
	}
	return String(err);
}

function createOptionUpdateMsg(wantedCollections: Set<string> | undefined): string {
	if (wantedCollections?.size === 0) {
		const msg: OptionUpdateMsg = {
			type: "options_update",
			payload: {
				wantedCollections: [DUMMY_COLLECTION],
			},
		};
		return JSON.stringify(msg);
	}
	const msg: OptionUpdateMsg = {
		type: "options_update",
		payload: {
			wantedCollections: wantedCollections != null ? Array.from(wantedCollections) : undefined,
		},
	};
	return JSON.stringify(msg);
}
