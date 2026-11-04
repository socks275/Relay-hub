// Pine — community chat (the "Chat" tab). In-memory rooms over WebSocket.
// No accounts server-side: names/colours/badges live in each visitor's
// browser and are announced on join. History is a small ring per room so a
// fresh join doesn't land in silence. Restarts clear everything — by design.
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { log } from "./config.js";

const DEFAULT_ROOMS = ["lobby", "games", "study-hall", "music", "random"];
const HISTORY_MAX = 80;
const MAX_TEXT = 500;
const MAX_NAME = 24;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 6;

function cleanName(name) {
  const n = String(name || "").replace(/[^\p{L}\p{N} _.\-]/gu, "").trim().slice(0, MAX_NAME);
  return n || "guest";
}
function cleanRoom(room) {
  const r = String(room || "lobby").toLowerCase().replace(/[^a-z0-9-_]/g, "").slice(0, 24);
  return r || "lobby";
}
function cleanColor(color) {
  const c = String(color || "");
  return /^#[0-9a-f]{6}$/i.test(c) ? c : "";
}
function cleanBadge(badge) {
  return ["none", "leaf", "star", "diamond", "crown"].includes(badge) ? badge : "none";
}

export function createChat() {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const rooms = new Map(); // name -> { members: Set<client>, history: [] }

  for (const name of DEFAULT_ROOMS) rooms.set(name, { members: new Set(), history: [] });

  const roomOf = (name) => {
    if (!rooms.has(name)) rooms.set(name, { members: new Set(), history: [] });
    return rooms.get(name);
  };
  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) {
      try { ws.send(JSON.stringify(obj)); } catch { /* socket died mid-send */ }
    }
  };
  const roomList = () =>
    [...rooms.entries()]
      .map(([name, r]) => ({ name, count: r.members.size }))
      .sort((a, b) => (DEFAULT_ROOMS.indexOf(a.name) + 1 || 99) - (DEFAULT_ROOMS.indexOf(b.name) + 1 || 99) || a.name.localeCompare(b.name));

  function broadcastRoomList() {
    const list = roomList();
    for (const client of wss.clients) send(client, { t: "rooms", rooms: list });
  }
  function broadcastPresence(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;
    const users = [...room.members].map((c) => ({ name: c.pineName, color: c.pineColor, badge: c.pineBadge }));
    for (const client of room.members) send(client, { t: "presence", room: roomName, count: users.length, users });
  }
  function system(roomName, text) {
    const msg = { t: "system", room: roomName, text, ts: Date.now() };
    const room = rooms.get(roomName);
    if (!room) return;
    room.history.push(msg);
    if (room.history.length > HISTORY_MAX) room.history.shift();
    for (const client of room.members) send(client, msg);
  }

  wss.on("connection", (ws) => {
    ws.pineId = crypto.randomBytes(6).toString("hex");
    ws.pineName = "guest";
    ws.pineColor = "";
    ws.pineBadge = "none";
    ws.pineRoom = null;
    ws.pineSentAt = [];
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    send(ws, { t: "hello", id: ws.pineId, rooms: roomList() });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (!msg || typeof msg !== "object") return;

      if (msg.t === "join") {
        const roomName = cleanRoom(msg.room);
        ws.pineName = cleanName(msg.name);
        ws.pineColor = cleanColor(msg.color);
        ws.pineBadge = cleanBadge(msg.badge);
        if (ws.pineRoom && ws.pineRoom !== roomName) leaveRoom(ws, false);
        if (ws.pineRoom === roomName) { broadcastPresence(roomName); return; }
        ws.pineRoom = roomName;
        const room = roomOf(roomName);
        room.members.add(ws);
        send(ws, { t: "joined", room: roomName, history: room.history.slice(-40) });
        system(roomName, `${ws.pineName} joined the room 🍃`);
        broadcastPresence(roomName);
        broadcastRoomList();
        return;
      }

      if (msg.t === "msg") {
        if (!ws.pineRoom) return;
        const now = Date.now();
        ws.pineSentAt = ws.pineSentAt.filter((t) => now - t < RATE_WINDOW_MS);
        if (ws.pineSentAt.length >= RATE_MAX) {
          send(ws, { t: "notice", text: "Slow down a little 🌿" });
          return;
        }
        const text = String(msg.text || "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, MAX_TEXT);
        if (!text) return;
        ws.pineSentAt.push(now);
        const out = {
          t: "msg",
          id: ws.pineId,
          room: ws.pineRoom,
          name: ws.pineName,
          color: ws.pineColor,
          badge: ws.pineBadge,
          text,
          ts: now,
        };
        const room = rooms.get(ws.pineRoom);
        room.history.push(out);
        if (room.history.length > HISTORY_MAX) room.history.shift();
        for (const client of room.members) send(client, out);
        return;
      }

      if (msg.t === "rename") {
        const old = ws.pineName;
        ws.pineName = cleanName(msg.name);
        ws.pineColor = cleanColor(msg.color);
        ws.pineBadge = cleanBadge(msg.badge);
        if (ws.pineRoom) {
          if (old !== ws.pineName) system(ws.pineRoom, `${old} is now ${ws.pineName}`);
          broadcastPresence(ws.pineRoom);
        }
        return;
      }
    });

    const onGone = () => leaveRoom(ws, true);
    ws.on("close", onGone);
    ws.on("error", onGone);
  });

  function leaveRoom(ws, announceLeave) {
    const roomName = ws.pineRoom;
    if (!roomName) return;
    const room = rooms.get(roomName);
    ws.pineRoom = null;
    if (!room || !room.members.delete(ws)) return;
    if (announceLeave) system(roomName, `${ws.pineName} left the room`);
    broadcastPresence(roomName);
    broadcastRoomList();
    // Prune empty custom rooms; keep defaults warm.
    if (!DEFAULT_ROOMS.includes(roomName) && room.members.size === 0) rooms.delete(roomName);
  }

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { try { ws.terminate(); } catch { /* already gone */ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30000);
  heartbeat.unref?.();

  wss.on("close", () => clearInterval(heartbeat));

  return {
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    stats() {
      let users = 0;
      for (const r of rooms.values()) users += r.members.size;
      return { connected: wss.clients.size, inRooms: users, rooms: roomList() };
    },
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) { try { ws.terminate(); } catch { /* ignore */ } }
      wss.close();
    },
    _log: log,
  };
}
