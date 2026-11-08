const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
app.get("/", (_req, res) => res.send("God'sgrace Ethics Football Battle multiplayer server is running."));
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const waiting = [];
const rooms = new Map();

function makeRoom() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}
function cleanWaiting() {
  for (let i = waiting.length - 1; i >= 0; i--) {
    if (!io.sockets.sockets.has(waiting[i])) waiting.splice(i, 1);
  }
}
function playerList(room) {
  return [...room.players.entries()].map(([id, p]) => ({
    id, name: p.name, score: p.score
  }));
}
function broadcastPlayers(code) {
  const room = rooms.get(code);
  if (room) io.to(code).emit("players:update", playerList(room));
}

io.on("connection", socket => {
  socket.emit("server:ready", { message: "Connected to Football Battle server" });

  socket.on("player:name", name => {
    socket.data.playerName = String(name || "Player").slice(0, 24);
  });

  socket.on("match:find", () => {
    cleanWaiting();
    const otherId = waiting.find(id => id !== socket.id);
    if (!otherId) {
      if (!waiting.includes(socket.id)) waiting.push(socket.id);
      socket.emit("match:waiting");
      return;
    }
    waiting.splice(waiting.indexOf(otherId), 1);
    const code = makeRoom();
    const room = { code, players: new Map(), started: false, createdAt: Date.now() };
    rooms.set(code, room);
    const other = io.sockets.sockets.get(otherId);
    [socket, other].forEach(s => {
      if (!s) return;
      s.join(code);
      room.players.set(s.id, { name: s.data.playerName || "Player", score: 0 });
      s.data.roomCode = code;
      s.emit("match:found", { roomCode: code, opponent: room.players.get(s.id === socket.id ? otherId : socket.id)?.name });
    });
    io.to(code).emit("match:ready", { roomCode: code, players: playerList(room) });
  });

  socket.on("room:create", () => {
    const code = makeRoom();
    const room = { code, players: new Map(), started: false, createdAt: Date.now() };
    rooms.set(code, room);
    room.players.set(socket.id, { name: socket.data.playerName || "Player", score: 0 });
    socket.join(code); socket.data.roomCode = code;
    socket.emit("room:created", { roomCode: code });
    broadcastPlayers(code);
  });

  socket.on("room:join", codeInput => {
    const code = String(codeInput || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.players.size >= 2) return socket.emit("room:error", "Room not found or full.");
    room.players.set(socket.id, { name: socket.data.playerName || "Player", score: 0 });
    socket.join(code); socket.data.roomCode = code;
    socket.emit("room:joined", { roomCode: code });
    io.to(code).emit("match:ready", { roomCode: code, players: playerList(room) });
  });

  socket.on("match:start", () => {
    const code = socket.data.roomCode, room = rooms.get(code);
    if (!room || room.players.size !== 2) return socket.emit("match:error", "A second player is required.");
    room.started = true;
    io.to(code).emit("match:start", { roomCode: code });
  });

  socket.on("score:update", score => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.players.has(socket.id)) return;
    room.players.get(socket.id).score = Math.max(0, Math.min(100000, Number(score) || 0));
    broadcastPlayers(room.code);
  });

  // WebRTC signaling only: browsers exchange offer/answer/ICE here.
  // Actual audio travels peer-to-peer (or through a TURN relay if needed).
  socket.on("voice:signal", payload => {
    const code = socket.data.roomCode;
    if (!code || !rooms.has(code)) return;
    socket.to(code).emit("voice:signal", { from: socket.id, data: payload });
  });

  socket.on("match:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => {
    const idx = waiting.indexOf(socket.id);
    if (idx >= 0) waiting.splice(idx, 1);
    leaveRoom(socket);
  });
});

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  if (room) {
    room.players.delete(socket.id);
    io.to(code).emit("match:opponent-left");
    if (!room.players.size) rooms.delete(code);
    else broadcastPlayers(code);
  }
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => console.log(`Football Battle server listening on ${port}`));
