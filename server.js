const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();
// Allow the Telegram Mini App (and browser preflight requests) to call this API.
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

app.get("/health", (_req, res) => res.json({
  ok: true,
  databaseConfigured: Boolean(supabase)
}));

function requireSession(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return res.status(401).json({ error: "Please sign in again through Telegram." });
  }
  req.telegramPlayer = session.player;
  next();
}

function requireDatabase(res) {
  if (!supabase) {
    res.status(503).json({ error: "Supabase is not configured. Check the Render environment variables." });
    return false;
  }
  return true;
}

// Telegram BotFather token must be configured as TELEGRAM_BOT_TOKEN
// in your Render environment variables. Never put the token in this file.
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
// Keep this server-side key only in Render. Never expose it in frontend code.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const supabase = SUPABASE_URL && SUPABASE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const TELEGRAM_MAX_AGE_SECONDS = 24 * 60 * 60;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (!/^[a-f0-9]{64}$/i.test(a) || !/^[a-f0-9]{64}$/i.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    const error = new Error("Telegram authentication is not configured on the server.");
    error.status = 503;
    throw error;
  }

  if (typeof initData !== "string" || !initData || initData.length > 10000) {
    throw new Error("Missing or invalid Telegram login data.");
  }

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) throw new Error("Telegram login hash is missing.");

  params.delete("hash");
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  // Telegram Web Apps validation: HMAC_SHA256("WebAppData", bot token)
  // is the secret key used to sign the sorted data-check string.
  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");

  if (!safeEqualHex(calculatedHash, receivedHash)) {
    throw new Error("Telegram login could not be verified.");
  }

  const authDate = Number(params.get("auth_date"));
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(authDate) || authDate > now + 60 ||
      now - authDate > TELEGRAM_MAX_AGE_SECONDS) {
    throw new Error("Telegram login has expired. Close and reopen the game from Telegram.");
  }

  let telegramUser;
  try {
    telegramUser = JSON.parse(params.get("user") || "null");
  } catch (_error) {
    throw new Error("Telegram account information is invalid.");
  }

  if (!telegramUser || !/^\d+$/.test(String(telegramUser.id || ""))) {
    throw new Error("A valid Telegram account was not found.");
  }

  return {
    id: String(telegramUser.id),
    username: typeof telegramUser.username === "string" ? telegramUser.username.slice(0, 32) : "",
    firstName: typeof telegramUser.first_name === "string" ? telegramUser.first_name.slice(0, 64) : "",
    lastName: typeof telegramUser.last_name === "string" ? telegramUser.last_name.slice(0, 64) : ""
  };
}

function displayName(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return (user.username ? `@${user.username}` : name) || "Telegram Player";
}

app.post("/api/auth/telegram", async (req, res) => {
  try {
    const player = verifyTelegramInitData(req.body && req.body.initData);
    if (!requireDatabase(res)) return;

    const display = displayName(player);
    const { error: playerError } = await supabase
      .from("players")
      .upsert({
        telegram_id: player.id,
        username: player.username || null,
        display_name: display
      }, { onConflict: "telegram_id" });
    if (playerError) throw playerError;

    const { error: walletError } = await supabase
      .from("wallets")
      .upsert({ telegram_id: player.id }, { onConflict: "telegram_id", ignoreDuplicates: true });
    if (walletError) throw walletError;

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + SESSION_LIFETIME_MS;
    sessions.set(token, { player, expiresAt });
    res.json({
      token,
      expiresAt,
      player: {
        id: player.id,
        username: player.username,
        firstName: player.firstName,
        lastName: player.lastName
      }
    });
  } catch (error) {
    console.error("Telegram/Supabase authentication error:", error.message);
    const status = error.status || (error.code ? 503 : 401);
    res.status(status).json({
      error: status === 401
        ? (error.message || "Telegram authentication failed.")
        : "Could not save your player profile. Please try again later."
    });
  }
});

// Authenticated, read-only player data endpoints. Wallet changes must be
// implemented as server-verified transactions, never as client balance edits.
app.get("/api/me", requireSession, async (req, res) => {
  if (!requireDatabase(res)) return;
  const { data, error } = await supabase.from("players").select(
    "telegram_id, username, display_name, avatar_url, total_score, games_played, games_won, created_at"
  ).eq("telegram_id", req.telegramPlayer.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not load player profile." });
  res.json({ player: data });
});

app.get("/api/wallet", requireSession, async (req, res) => {
  if (!requireDatabase(res)) return;
  const { data, error } = await supabase.from("wallets")
    .select("telegram_id, coin_balance, updated_at")
    .eq("telegram_id", req.telegramPlayer.id).maybeSingle();
  if (error) return res.status(500).json({ error: "Could not load wallet." });
  res.json({ wallet: data });
});

app.get("/api/leaderboard", async (_req, res) => {
  if (!requireDatabase(res)) return;
  const { data, error } = await supabase.from("players")
    .select("telegram_id, username, display_name, total_score, games_played, games_won")
    .order("total_score", { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: "Could not load leaderboard." });
  res.json({ players: data || [] });
});

app.get("/api/tournaments", async (_req, res) => {
  if (!requireDatabase(res)) return;
  const { data, error } = await supabase.from("tournaments")
    .select("id, name, description, entry_fee, prize_coins, max_players, status, starts_at, created_at")
    .order("created_at", { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: "Could not load tournaments." });
  res.json({ tournaments: data || [] });
});

// Remove expired login sessions periodically.
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (!session || session.expiresAt <= now) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref();

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Every multiplayer connection must present a valid server-issued session token.
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const session = typeof token === "string" ? sessions.get(token) : null;

  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return next(new Error("Unauthorized. Open the game through Telegram and sign in again."));
  }

  socket.data.telegramUser = session.player;
  next();
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
  const authenticatedName = displayName(socket.data.telegramUser);
  socket.data.playerName = authenticatedName;
  socket.emit("server:ready", { message: "Connected to Football Battle server" });

  // The server uses the verified Telegram identity, not a client-supplied name.
  socket.on("player:name", () => {
    socket.data.playerName = authenticatedName;
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
      room.players.set(s.id, { name: s.data.playerName || "Telegram Player", score: 0 });
      s.data.roomCode = code;
      s.emit("match:found", {
        roomCode: code,
        opponent: room.players.get(s.id === socket.id ? otherId : socket.id)?.name
      });
    });
    io.to(code).emit("match:ready", { roomCode: code, players: playerList(room) });
  });

  socket.on("room:create", () => {
    const code = makeRoom();
    const room = { code, players: new Map(), started: false, createdAt: Date.now() };
    rooms.set(code, room);
    room.players.set(socket.id, { name: socket.data.playerName || "Telegram Player", score: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:created", { roomCode: code });
    broadcastPlayers(code);
  });

  socket.on("room:join", codeInput => {
    const code = String(codeInput || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.players.size >= 2) {
      return socket.emit("room:error", "Room not found or full.");
    }
    if (room.players.has(socket.id)) return;
    room.players.set(socket.id, { name: socket.data.playerName || "Telegram Player", score: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room:joined", { roomCode: code });
    io.to(code).emit("match:ready", { roomCode: code, players: playerList(room) });
  });

  socket.on("match:start", () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.players.size !== 2) {
      return socket.emit("match:error", "A second player is required.");
    }
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
