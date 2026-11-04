// 86tong — máy chủ phòng học chung (thật, nhiều người cùng vào) — v4: thêm Đoán từ cùng lớp
// Chạy:  npm install   rồi   npm start        (mặc định cổng 8080, hoặc PORT=8080)
// Tuỳ chọn (mặc định: 30 giây / câu, 10 câu / tiết):
//   GAME_QUESTION_SECONDS=20 GAME_TOTAL_QUESTIONS=10 npm start
// Không lưu tài khoản, không lưu mật khẩu, không lưu chat tự do.
// Chỉ lưu trong RAM, khi tắt máy chủ là mất: id, tên hiển thị, màu áo, vị trí, trạng thái ngồi, điểm game.
// Không có chat tự do, theo đúng tinh thần Sansa "ngồi cùng nhau mà không nói chuyện":
// người học chỉ gửi được 1 trong 4 lời chào có sẵn: 你好！ / 谢谢！ / 加油！ / 再见！
// và 3 phản ứng có sẵn: 👏 / 🎉 / 加油！
//
// Game Đoán từ: ý tưởng lấy cảm hứng từ Lớp Học Chữ (github.com/workaipvlinh-byte/lop-hoc-chu, MIT),
// code ở đây viết lại hoàn toàn cho tiếng Trung, không sao chép code, ảnh hay câu hỏi của họ.
// Luật (theo Lớp Học Chữ): đáp án gửi riêng tư, máy chủ chấm theo thời gian máy chủ nhận được —
// nhanh nhất 10 điểm, nhì 7, ba 5, sau đó 3; người nhanh nhất lên ngồi bàn đầu; hết tiết có Lớp trưởng.

const http = require("http");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const MAX_PER_ROOM = 40;
const GREETINGS = new Set(["你好！", "谢谢！", "加油！", "再见！"]);
const REACTIONS = new Set(["👏", "🎉", "加油！"]);
const COLORS = new Set(["#D9482B", "#1F7A64", "#3B5BDB", "#E9A13B", "#9B4D8F", "#0E7C86", "#E86A6A", "#4A90A4"]);
const GAME_SECONDS = Number(process.env.GAME_QUESTION_SECONDS || 30);
const GAME_TOTAL = Number(process.env.GAME_TOTAL_QUESTIONS || 10);

// Ngân hàng từ tiếng Trung — cùng 30 từ với frontend (chữ Hán | pinyin | nghĩa tiếng Việt | độ khó)
const BANK = [
  {h:"你好", p:"nǐ hǎo", v:"Xin chào", d:1}, {h:"谢谢", p:"xiè xie", v:"Cảm ơn", d:1},
  {h:"中国", p:"Zhōngguó", v:"Trung Quốc", d:1}, {h:"学习", p:"xuéxí", v:"Học tập", d:1},
  {h:"朋友", p:"péngyou", v:"Bạn bè", d:1}, {h:"老师", p:"lǎoshī", v:"Thầy / cô giáo", d:1},
  {h:"学生", p:"xuésheng", v:"Học sinh", d:1}, {h:"今天", p:"jīntiān", v:"Hôm nay", d:1},
  {h:"明天", p:"míngtiān", v:"Ngày mai", d:1}, {h:"喜欢", p:"xǐhuan", v:"Thích", d:1},
  {h:"吃饭", p:"chī fàn", v:"Ăn cơm", d:2}, {h:"喝水", p:"hē shuǐ", v:"Uống nước", d:2},
  {h:"大", p:"dà", v:"Lớn / to", d:1}, {h:"小", p:"xiǎo", v:"Nhỏ", d:1},
  {h:"好", p:"hǎo", v:"Tốt / hay", d:1}, {h:"不", p:"bù", v:"Không", d:1},
  {h:"是", p:"shì", v:"Là", d:1}, {h:"我", p:"wǒ", v:"Tôi", d:1},
  {h:"你", p:"nǐ", v:"Bạn", d:1}, {h:"再见", p:"zàijiàn", v:"Tạm biệt", d:1},
  {h:"家庭", p:"jiātíng", v:"Gia đình", d:2}, {h:"学校", p:"xuéxiào", v:"Trường học", d:2},
  {h:"工作", p:"gōngzuò", v:"Công việc", d:2}, {h:"时间", p:"shíjiān", v:"Thời gian", d:2},
  {h:"现在", p:"xiànzài", v:"Bây giờ", d:2}, {h:"知道", p:"zhīdào", v:"Biết", d:2},
  {h:"明白", p:"míngbai", v:"Hiểu", d:2}, {h:"高兴", p:"gāoxìng", v:"Vui vẻ", d:2},
  {h:"漂亮", p:"piàoliang", v:"Đẹp", d:2}, {h:"东西", p:"dōngxi", v:"Đồ vật", d:2},
];

const rooms = new Map(); // roomName -> Map(id -> player)
const games = new Map(); // roomName -> game state
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
function normAns(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
}
function scramble(word) {
  if (word.length < 2) return word;
  let arr = word.split("");
  for (let t = 0; t < 10; t++) {
    arr.sort(() => Math.random() - 0.5);
    if (arr.join("") !== word) break;
  }
  return arr.join("");
}
function gameScoresList(game) {
  return [...game.scores.values()].sort((a, b) => b.score - a.score);
}
function broadcastScores(room, game) {
  broadcast(room, { type: "game-scores", scores: gameScoresList(game) });
}
function sendQuestion(room, game) {
  const word = BANK[game.questions[game.q]];
  broadcast(room, { type: "game-question", question: {
    n: game.q + 1, total: game.questions.length,
    viet: word.v, scrambled: scramble(word.h), difficulty: word.d,
    duration: GAME_SECONDS,
  }});
  game.timer = setTimeout(() => advanceGame(room), GAME_SECONDS * 1000);
}
function startGame(room) {
  const existing = games.get(room);
  if (existing && existing.active) return false;
  const players = rooms.get(room);
  const indices = [...BANK.keys()].sort(() => Math.random() - 0.5).slice(0, GAME_TOTAL);
  const game = { active: true, questions: indices, q: 0, correctCount: 0,
    answered: new Set(), scores: new Map(), timer: null };
  if (players) for (const pl of players.values()) game.scores.set(pl.id, { name: pl.name, score: 0 });
  games.set(room, game);
  sendQuestion(room, game);
  return true;
}
function advanceGame(room) {
  const game = games.get(room);
  if (!game || !game.active) return;
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
  game.q++;
  game.correctCount = 0;
  game.answered = new Set();
  if (game.q >= game.questions.length) {
    game.active = false;
    const scores = gameScoresList(game);
    broadcast(room, { type: "game-end", scores, monitor: scores.length ? scores[0].name : "" });
    games.delete(room);
  } else {
    sendQuestion(room, game);
  }
}
function endGameForRoom(room) {
  const game = games.get(room);
  if (game && game.timer) clearTimeout(game.timer);
  games.delete(room);
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
      // Vào giữa tiết: gửi câu hiện tại + bảng điểm cho người mới, để họ chơi tiếp được ngay
      const game = games.get(room);
      if (game && game.active) {
        const word = BANK[game.questions[game.q]];
        ws.send(JSON.stringify({ type: "game-question", question: {
          n: game.q + 1, total: game.questions.length,
          viet: word.v, scrambled: scramble(word.h), difficulty: word.d, duration: GAME_SECONDS } }));
        ws.send(JSON.stringify({ type: "game-scores", scores: gameScoresList(game) }));
      }
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
      if (!GREETINGS.has(msg.text)) return;
      broadcast(player.room, { type: "player-greet", id: player.id, text: msg.text }, player.id);
    } else if (msg.type === "react") {
      if (!REACTIONS.has(msg.emoji)) return;
      broadcast(player.room, { type: "player-react", id: player.id, emoji: msg.emoji }, player.id);
    } else if (msg.type === "game-start") {
      const ok = startGame(player.room);
      if (!ok) ws.send(JSON.stringify({ type: "game-error", message: "Đã có tiết học đang diễn ra trong phòng này. Chờ hết tiết rồi bắt đầu tiết mới." }));
    } else if (msg.type === "game-answer") {
      const game = games.get(player.room);
      if (!game || !game.active) return;
      if (game.answered.has(player.id)) {
        ws.send(JSON.stringify({ type: "game-answer-result", correct: false, already: true }));
        return;
      }
      const word = BANK[game.questions[game.q]];
      const n = normAns(msg.text);
      const correct = n !== "" && (n === normAns(word.h) || n === normAns(word.p));
      if (!correct) {
        ws.send(JSON.stringify({ type: "game-answer-result", correct: false }));
        return;
      }
      game.answered.add(player.id);
      const rank = game.correctCount + 1;
      game.correctCount++;
      const points = rank === 1 ? 10 : rank === 2 ? 7 : rank === 3 ? 5 : 3;
      if (!game.scores.has(player.id)) game.scores.set(player.id, { name: player.name, score: 0 });
      game.scores.get(player.id).score += points;
      ws.send(JSON.stringify({ type: "game-answer-result", correct: true,
        points, rank, hanzi: word.h, pinyin: word.p }));
      if (rank === 1) broadcast(player.room, { type: "game-winner", id: player.id, name: player.name });
      broadcastScores(player.room, game);
    }
  });

  ws.on("close", () => {
    if (!player) return;
    const players = rooms.get(player.room);
    if (players) {
      players.delete(player.id);
      broadcast(player.room, { type: "player-left", id: player.id });
      presence(player.room);
      if (players.size === 0) { rooms.delete(player.room); endGameForRoom(player.room); }
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log("86tong phong hoc chung chay tai cong " + PORT + " — /health de kiem tra");
});
