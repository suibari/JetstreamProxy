import type { TID } from "@atproto/common-web";
import type { AccountEvent, CommitEvent, IdentityEvent } from "@skyware/jetstream";
import type { RawData } from "ws";

export interface DownstreamEventMap {
	message:
		| [AccountEvent, undefined, RawData, string]
		| [IdentityEvent, undefined, RawData, string]
		| [CommitEvent<string>, string, RawData, string];
	connect: [TID, Set<string> | "all"];
	rejectConnect: [TID, string];
	acceptConnect: [TID];
	disconnect: [TID];
}

export type DownstreamMessageListener = (...args: DownstreamEventMap["message"]) => void;

export interface UpstreamEventMap {
	message: [WSRawMessage];
	updateWantedCollections: [Set<string> | "all"];
}

export interface OptionUpdateMsg {
	type: "options_update";
	payload: {
		wantedCollections?: string[];
		/**wantedDidsはまだ対応しない */
		wantedDids?: never[];
		maxMessageSizeBytes?: number;
	};
}

export interface Config {
	proxyPort: number;
	/**先頭が本命。繋がらない状態が続くと次の候補へ切り替える */
	upstreamURLs: URL[];
	logFile: string;
}

/**
 * 転送済みイベントの最新 time_us。upstream の再接続時に cursor として使い、
 * 切断中に流れたイベントを取り戻す。downstream は新規クライアントの初期位置に使う。
 */
export interface CursorState {
	last?: number;
}

export type JetstreamEvent = AccountEvent | IdentityEvent | CommitEvent<string>;
export type WSRawMessage = ArrayBuffer | string;
