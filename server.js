// 86tong — máy chủ phòng học chung (thật, nhiều người cùng vào)
// Chạy:  npm install   rồi   npm start        (mặc định cổng 8080, hoặc PORT=8080)
// Không lưu tài khoản, không lưu mật khẩu, không lưu chat tự do.
// Chỉ lưu trong RAM, khi tắt máy chủ là mất: id, tên hiển thị, màu áo, vị trí, trạng thái ngồi.
// Không có chat tự do, theo đúng tinh thần Sansa "ngồi cùng nhau mà không nói chuyện":
// người học chỉ gửi được 1 trong 4 lời chào có sẵn: 你好！ / 谢谢！ / 加油！ / 再见！

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_PER_ROOM = 40;
const GREETINGS = new Set(["你好！", "谢谢！", "加油！", "再见！"]);
const COLORS = new Set(["#D9482B", "#1F7A64", "#3B5BDB", "#E9A13B", "#9B4D8F", "#0E7C86", "#E86A6A", "#4A90A4"]);

const rooms = new Map(); // roomName -> Map(id -> player)
let nextId = 1;

function cleanName(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 20) || "Bạn học";
}
function cleanRoom(s) {
  const r = String(s || "phong-chung").replace(/[^a-zA-Z0-9-_]/g, "").slice(0, 30);
  return r || "phong-chung";
}
function clamp(n, lo, hi) {
  n = Number(n); if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
function publicPlayer(pl) {
  return { id: pl.id, name: pl.name, color: pl.color, x: pl.x, y: pl.y, sitting: pl.sitting };
}
function broadcast(room, obj, exceptId) {
  const text = JSON.stringify(obj);
  const players = rooms.get(room);
  if (!players) return;
  for (const pl of players.values()) {
    if (pl.id !== exceptId && pl.ws.readyState === 1) pl.ws.send(text);
  }
}
function presence(room) {
  const players = rooms.get(room);
  if (!players) return;
  broadcast(room, { type: "presence", count: players.size });
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size,
      players: [...rooms.values()].reduce((a, m) => a + m.size, 0) }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("86tong phong hoc chung — WebSocket server dang chay. Mo 86tong.com/live/ de vao phong.\n");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  let player = null;
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const room = cleanRoom(msg.room);
      if (!rooms.has(room)) rooms.set(room, new Map());
      const players = rooms.get(room);
      if (players.size >= MAX_PER_ROOM) {
        ws.send(JSON.stringify({ type: "error", message: "Phong da day (40 nguoi). Hay bam 'Vao phong khac'." }));
        return;
      }
      player = {
        id: nextId++, ws, room,
        name: cleanName(msg.name),
        color: COLORS.has(msg.color) ? msg.color : "#D9482B",
        x: clamp(msg.x, 60, 900), y: clamp(msg.y, 210, 500),
        sitting: false,
      };
      players.set(player.id, player);
      ws.send(JSON.stringify({ type: "welcome", id: player.id,
        players: [...players.values()].filter(p => p.id !== player.id).map(publicPlayer) }));
      broadcast(room, { type: "player-joined", player: publicPlayer(player) }, player.id);
      presence(room);
      return;
    }

    if (!player) return;

    if (msg.type === "move") {
      player.x = clamp(msg.x, 60, 900);
      player.y = clamp(msg.y, 210, 500);
      player.sitting = !!msg.sitting;
      broadcast(player.room, { type: "player-moved", id: player.id,
        x: player.x, y: player.y, sitting: player.sitting }, player.id);
    } else if (msg.type === "greet") {
      // Chỉ cho phép lời chào có sẵn — chat tự do bị chặn ở máy chủ, không chỉ ở trình duyệt.
      if (!GREETINGS.has(msg.text)) return;
      broadcast(player.room, { type: "player-greet", id: player.id, text: msg.text }, player.id);
    }
  });

  ws.on("close", () => {
    if (!player) return;
    const players = rooms.get(player.room);
    if (players) {
      players.delete(player.id);
      broadcast(player.room, { type: "player-left", id: player.id });
      presence(player.room);
      if (players.size === 0) rooms.delete(player.room);
    }
  });
});

// Dọn kết nối chết mỗi 30 giây
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("86tong phong hoc chung chay tai cong " + PORT + " — /health de kiem tra");
});
