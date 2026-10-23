import WS from "ws";

// compress=true uses custom zstd; offering deflate too causes HTTP 400.
// partysocket uses this constructor again on every reconnect.
export class UpstreamWebSocket extends WS {
 constructor(address: string | URL, protocols?: string | string[]) {
  super(address, protocols, { perMessageDeflate: false });
 }
}
