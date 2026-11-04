/* Pine — community chat client. Talks to /chat on this server.
 * Auto-reconnects with backoff and re-joins the current room. */
import { state } from "./store.js";

export class ChatClient {
  constructor({ onEvent, onStatus }) {
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
    this.room = "lobby";
    this.connected = false;
    this._backoff = 1000;
    this._wantOpen = false;
    this._reconnectTimer = null;
  }

  connect(room = "lobby") {
    this.room = room;
    this._wantOpen = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.join(room);
      return;
    }
    this._open();
  }

  _open() {
    this.onStatus?.("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}/chat`);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this._backoff = 1000;
      this.onStatus?.("online");
      this.join(this.room);
    };
    ws.onmessage = (e) => {
      try { this.onEvent?.(JSON.parse(e.data)); } catch { /* ignore malformed */ }
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus?.("offline");
      if (this._wantOpen) this._scheduleReconnect();
    };
    ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
  }

  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => { if (this._wantOpen) this._open(); }, this._backoff);
    this._backoff = Math.min(15000, this._backoff * 1.8);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  join(room) {
    this.room = room;
    const p = state.profile;
    this._send({ t: "join", room, name: p.name, color: p.color, badge: p.badge });
  }

  sendMessage(text) {
    this._send({ t: "msg", text });
  }

  syncProfile() {
    const p = state.profile;
    this._send({ t: "rename", name: p.name, color: p.color, badge: p.badge });
  }

  disconnect() {
    this._wantOpen = false;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}
