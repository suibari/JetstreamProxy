import type { TID } from "@atproto/common-web";

export function parseNSID(nsid: string): { nsid: string; hasPrefix: boolean } | false {
	// 空文字列チェック
	if (!nsid || nsid.length === 0) return false;

	// 全体の長さチェック (最大317文字)
	if (nsid.length > 317) return false;

	// ASCII文字のみ許可
	if (!/^[a-zA-Z0-9.*_-]+$/.test(nsid)) return false;

	// ワイルドカードパターンの処理
	let hasPrefix = false;
	let actualNsid = nsid;

	// 単独の * は無効
	if (nsid === "*") return false;

	// ワイルドカードが末尾にある場合
	if (nsid.endsWith(".*")) {
		hasPrefix = true;
		actualNsid = nsid.slice(0, -2); // .*を削除
	} else if (nsid.includes("*")) {
		// その他の位置のワイルドカードは無効
		return false;
	}

	// セグメントに分割
	const segments = actualNsid.split(".");

	// ケース別のセグメント数検証
	if (hasPrefix) {
		// ワイルドカード使用時は最低1セグメント必要（a.*のようなケース）
		if (segments.length < 1) return false;
	} else {
		// ワイルドカード未使用時は最低3セグメント必要
		if (segments.length < 3) return false;
	}

	// 空のセグメントがあれば無効
	if (segments.some((segment) => segment.length === 0)) return false;

	// ドメイン部分（最後のセグメントを除く、ワイルドカード使用時は全て）
	const domainSegments = hasPrefix ? segments : segments.slice(0, -1);

	// ドメイン部分は最低1セグメント必要（ワイルドカード使用時）
	// または通常時は最低2セグメント必要
	const minDomainSegments = hasPrefix ? 1 : 2;
	if (domainSegments.length < minDomainSegments) return false;

	// ドメイン部分の合計長さ（ピリオドを含む）を計算
	const domainLength = domainSegments.join(".").length;
	if (domainLength > 253) return false;

	// ドメイン部分の各セグメントを検証
	for (const segment of domainSegments) {
		// セグメントの長さ（1-63文字）
		if (segment.length < 1 || segment.length > 63) return false;

		// 許可された文字（小文字a-z、数字0-9、ハイフン-）
		if (!/^[a-z0-9-]+$/.test(segment.toLowerCase())) return false;

		// ハイフンは先頭や末尾に使用できない
		if (segment.startsWith("-") || segment.endsWith("-")) return false;
	}

	// 先頭セグメント（TLD）は数字で始まることができない
	if (/^[0-9]/.test(domainSegments[0])) return false;

	// ドメイン部分を小文字に正規化
	const normalizedDomainSegments = domainSegments.map((segment) => segment.toLowerCase());

	// 名前セグメントの検証（ワイルドカード未使用時のみ）
	let nameSegment = "";

	if (!hasPrefix) {
		// 名前セグメント（最後のセグメント）
		nameSegment = segments[segments.length - 1];

		// 名前セグメントの長さ（1-63文字）
		if (nameSegment.length < 1 || nameSegment.length > 63) return false;

		// 名前セグメントの許可された文字（英数字のみ）
		if (!/^[A-Za-z0-9]+$/.test(nameSegment)) return false;

		// 名前セグメントは数字で始めることができない
		if (/^[0-9]/.test(nameSegment)) return false;
	}

	// 正規化されたNSIDを構築
	const normalizedNsid = hasPrefix
		? normalizedDomainSegments.join(".")
		: [...normalizedDomainSegments, nameSegment].join(".");

	return {
		nsid: normalizedNsid,
		hasPrefix,
	};
}

/**
 * 上流の候補をカンマ区切りで受ける。
 *
 * 1本しか持たないと、そのインスタンスが不調なだけで再接続が延々空振りする。
 * 順序は指定どおり保ち、先頭を本命として使う。1つでも不正なら全体を不正とする。
 */
export function parseUpstreamURLs(value: unknown): URL[] | false {
	if (typeof value !== "string") return false;
	const urls: URL[] = [];
	for (const raw of value.split(",")) {
		const candidate = raw.trim();
		if (candidate.length === 0) continue;
		const parsed = parseUpstreamURL(candidate);
		if (parsed === false) return false;
		// 同じ先を並べても切り替えの役に立たないので畳む。
		if (!urls.some((url) => url.toString() === parsed.toString())) urls.push(parsed);
	}
	if (urls.length === 0) return false;
	return urls;
}

export function parseUpstreamURL(url: unknown): URL | false {
	if (typeof url !== "string") return false;
	if (/\s/.test(url)) return false;
	if (!URL.canParse(url)) return false;
	const parsedURL = new URL(url);
	if (parsedURL.protocol !== "ws:" && parsedURL.protocol !== "wss:") return false;
	if (parsedURL.hostname.length === 0) return false;
	return parsedURL;
}

/**
 * 既に配ったイベントを二度配らないための time_us ゲート。
 *
 * upstream は再接続のたびに cursor で巻き戻すので、これが無いと「切断中の穴埋め」が
 * そのまま「配信済みイベントの再配信」になり、cursor を持たない bot が同じ投稿へ
 * 二度反応してしまう。
 *
 * 初期位置は、クライアントが cursor を指定していればその値、指定が無ければ接続時点の
 * 最新位置（＝ここから先だけを配る）。どちらも無ければ素通しする。
 */
export function createTimeGate(initial: number | undefined) {
	let last = Number.isFinite(initial) ? initial : undefined;
	return {
		/**このイベントをまだ配っていないか */
		allows: (timeUs: number | undefined): boolean => timeUs == null || last == null || timeUs > last,
		/**実際に配った位置を進める。配らなかったイベントでは進めない */
		accept: (timeUs: number | undefined): void => {
			if (timeUs != null && (last == null || timeUs > last)) last = timeUs;
		},
		get last(): number | undefined {
			return last;
		},
	};
}

/**
 * クライアントが指定した cursor。読めなければ fallback（接続時点の最新位置）へ倒す。
 *
 * time_us は unix マイクロ秒なので 0 以下はあり得ない。`?cursor=` のような空指定を
 * Number("")===0 として受けると、ゲートが実質無効になり巻き戻し分を再配信してしまう。
 */
export function parseClientCursor(value: string | null, fallback: number | undefined): number | undefined {
	if (value == null) return fallback;
	const parsed = Number(value.trim());
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePort(port: unknown): number | false {
	if (typeof port === "number") {
		if (port < 0 || port > 65535 || Number.isNaN(port) || !Number.isInteger(port)) return false;
		return port;
	} else if (typeof port === "string") {
		const parsedPort = Number.parseInt(port, 10);
		if (Number.isNaN(parsedPort) || parsedPort < 0 || parsedPort > 65535) return false;
		if (port !== parsedPort.toString()) return false;
		return parsedPort;
	}
	return false;
}

/**新規クライアント接続時は上限に達しないことを事前にvalidateMaxWantedCollectionで確認すること */
export function parseClientMap(map: Map<TID, Set<string> | "all">): Set<string> | "all" {
	const wanted = new Set<string>();
	for (const [key, cols] of map) {
		if (cols === "all") {
			return "all";
		} else {
			// TODO: app.bsky.feed.*とapp.bsky.feed.likeのような重複を防ぐ
			for (const col of cols) wanted.add(col);
		}
	}
	if (wanted.size > 100) throw new Error("Too many wanted collections (maximum 100 allowed)");
	if (wanted.size === 0) wanted.add("example.dummy.collection");
	return wanted;
}

export function validateMaxWantedCollection(
	oldset: Map<TID, Set<string> | "all"> | Set<string>,
	newset: Set<string>,
): boolean {
	const set = oldset instanceof Set ? oldset : new Set<string>();
	if (oldset instanceof Map) {
		for (const connect of oldset.values())
			if (connect !== "all") for (const collection of connect) set.add(collection);
	}
	for (const collection of newset) set.add(collection);
	// TODO: app.bsky.feed.*とapp.bsky.feed.likeのような重複を防ぐ
	return set.size <= 100;
}
const CACHE = ["app.bsky.feed.post", "app.bsky.feed.like", "app.bsky.feed.repost", "app.bsky.graph.follow"];
export function createFilter(wanted: Set<string>): ((col: string) => boolean) | false {
	if (wanted.size === 0) return () => true;
	const parsedWanted = Array.from(wanted).map(parseNSID);
	// falseの値が一つでもあれば不可
	const hasInvalid = parsedWanted.reduce<boolean>((prev, cur) => prev || cur === false, false);
	if (hasInvalid) return false;
	const filterInner = (col: string) => {
		for (const { nsid, hasPrefix } of parsedWanted.filter((v) => v !== false)) {
			if (hasPrefix) {
				if (col.startsWith(nsid)) return true;
			} else {
				if (nsid === col) return true;
			}
		}
		return false;
	};
	const cache = new Map<string, boolean>();
	for (const collection of CACHE) {
		cache.set(collection, filterInner(collection));
	}
	return (col) => {
		const cached = cache.get(col);
		if (cached != null) return cached;
		return filterInner(col);
	};
}
