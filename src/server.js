import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";
import multer from "multer";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, UPLOAD_DIR), filename: (_req, file, cb) => cb(null, Date.now() + "-" + crypto.randomUUID() + path.extname(file.originalname).toLowerCase()) });
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024, files: 10 }, fileFilter: (_req, file, cb) => { const ok = ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.mimetype); cb(null, ok); } });

if (!process.env.DATABASE_URL) {
  console.warn("DATABASE_URL is not set. Set it before starting the server.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.DB_POOL_SIZE || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const app = express();
const server = http.createServer(app);

const rateBuckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(), b = rateBuckets.get(key);
  if (!b || now >= b.reset) { rateBuckets.set(key,{count:1,reset:now+windowMs}); return true; }
  if (b.count >= max) return false;
  b.count++;
  return true;
}
setInterval(() => { const now=Date.now(); for (const [k,b] of rateBuckets) if (b.reset<=now) rateBuckets.delete(k); },60000).unref();

function admin(req,res,next) {
  if (!process.env.ADMIN_USER_ID || String(req.user.id)!==String(process.env.ADMIN_USER_ID))
    return res.status(403).json({error:"Keine Admin-Berechtigung."});
  next();
}
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "../public")));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users(
      id BIGSERIAL PRIMARY KEY,
      nick TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      age INTEGER NOT NULL CHECK(age >= 18),
      gender TEXT NOT NULL DEFAULT 'd',
      state TEXT DEFAULT '',
      about TEXT DEFAULT '',
      avatar_url TEXT DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_nick_lower_idx ON users (LOWER(nick));

    CREATE TABLE IF NOT EXISTS rooms(
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS messages(
      id BIGSERIAL PRIMARY KEY,
      room_id BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT DEFAULT '';
    ALTER TABLE users DROP COLUMN IF EXISTS city;

    CREATE TABLE IF NOT EXISTS profile_images(id BIGSERIAL PRIMARY KEY,user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,url TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS profile_images_user_id_idx ON profile_images(user_id);

    CREATE TABLE IF NOT EXISTS direct_messages(
      id BIGSERIAL PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE messages ADD COLUMN IF NOT EXISTS image_url TEXT;
    ALTER TABLE direct_messages ADD COLUMN IF NOT EXISTS image_url TEXT;
    CREATE INDEX IF NOT EXISTS messages_room_id_id_idx ON messages(room_id, id);

    CREATE INDEX IF NOT EXISTS direct_messages_pair_idx
      ON direct_messages(sender_id, receiver_id, id);

    CREATE TABLE IF NOT EXISTS favorites(
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS blocks(
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(user_id, target_id)
    );

    CREATE TABLE IF NOT EXISTS reports(
      id BIGSERIAL PRIMARY KEY,
      reporter_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      message_id BIGINT,
      message_type TEXT,
      reason TEXT NOT NULL,
      details TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status, created_at DESC);
  `);

  for (const name of ["Lounge", "Flirt", "Regional"]) {
    await query("INSERT INTO rooms(name) VALUES($1) ON CONFLICT(name) DO NOTHING", [name]);
  }
}

const online = new Map();

async function userPublic(id) {
  const r = await query(
    "SELECT id,nick,age,gender,state,about,avatar_url FROM users WHERE id=$1",
    [id]
  );
  return r.rows[0] || null;
}

function tokenFor(user) {
  return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    req.user = jwt.verify(h.replace(/^Bearer\s+/, ""), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Nicht angemeldet" });
  }
}

function broadcastRoom(roomId, payload) {
  const msg = JSON.stringify(payload);
  for (const [, set] of online) {
    for (const ws of set) {
      if (ws.readyState === 1 && ws.roomId === Number(roomId)) ws.send(msg);
    }
  }
}

function broadcastUser(uid, payload) {
  const set = online.get(String(uid)) || new Set();
  const msg = JSON.stringify(payload);
  for (const ws of set) if (ws.readyState === 1) ws.send(msg);
}

app.post("/api/register", async (req, res) => {
  if (!rateLimit("register:"+req.ip,5,60*60*1000)) return res.status(429).json({error:"Zu viele Registrierungsversuche. Bitte später erneut versuchen."});
  const { nick, password, age, gender = "d", state = "" } = req.body || {};
  if (typeof nick !== "string" || nick.trim().length < 2 || nick.trim().length > 24)
    return res.status(400).json({ error: "Nickname muss 2–24 Zeichen haben." });
  if (typeof password !== "string" || password.length < 8)
    return res.status(400).json({ error: "Passwort muss mindestens 8 Zeichen haben." });
  if (!Number.isInteger(age) || age < 18 || age > 99)
    return res.status(400).json({ error: "Nur Volljährige können sich registrieren." });

  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO users(nick,password_hash,age,gender,state)
       VALUES($1,$2,$3,$4,$5)
       RETURNING id,nick,age,gender,city,about`,
      [nick.trim(), hash, age, gender, String(state || "").slice(0, 40)]
    );
    const u = r.rows[0];
    res.json({ token: tokenFor(u), user: u });
  } catch (e) {
    if (e.code === "23505")
      return res.status(409).json({ error: "Nickname ist bereits vergeben." });
    console.error(e);
    res.status(500).json({ error: "Registrierung fehlgeschlagen." });
  }
});

app.post("/api/login", async (req, res) => {
  if (!rateLimit("login:"+req.ip,15,15*60*1000)) return res.status(429).json({error:"Zu viele Loginversuche. Bitte später erneut versuchen."});
  const { nick, password } = req.body || {};
  try {
    const r = await query(
      "SELECT * FROM users WHERE LOWER(nick)=LOWER($1) LIMIT 1",
      [nick || ""]
    );
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password || "", u.password_hash)))
      return res.status(401).json({ error: "Login fehlgeschlagen." });

    res.json({ token: tokenFor(u), user: await userPublic(u.id) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login fehlgeschlagen." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  res.json({ ...(await userPublic(req.user.id)), is_admin: String(req.user.id) === String(process.env.ADMIN_USER_ID || "") });
});

app.get("/api/users", auth, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const r = await query(
    `SELECT id,nick,age,gender,state,about,avatar_url
     FROM users
     WHERE id<>$1 AND (nick ILIKE $2 OR state ILIKE $2)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id=$1 AND b.target_id=users.id)
     ORDER BY nick
     LIMIT 100`,
    [req.user.id, `%${q}%`]
  );
  res.json(r.rows.map(u => ({
    ...u,
    online: (online.get(String(u.id))?.size || 0) > 0
  })));
});

app.put("/api/me", auth, async (req, res) => {
  const { age, state, about } = req.body || {};
  if (!Number.isInteger(age) || age < 18 || age > 99)
    return res.status(400).json({ error: "Ungültiges Alter" });

  await query(
    "UPDATE users SET age=$1,state=$2,about=$3 WHERE id=$4",
    [age, String(state || "").slice(0, 40), String(about || "").slice(0, 1000), req.user.id]
  );
  res.json(await userPublic(req.user.id));
});

app.get("/api/users/:id/gallery", auth, async (req, res) => {
  const r = await query("SELECT id,url,created_at FROM profile_images WHERE user_id=$1 ORDER BY id DESC", [Number(req.params.id)]);
  res.json(r.rows);
});

app.post("/api/me/avatar", auth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Bitte ein gültiges Bild hochladen." });
  const url = "/uploads/" + req.file.filename;
  await query("UPDATE users SET avatar_url=$1 WHERE id=$2", [url, req.user.id]);
  res.json({ url });
});

app.post("/api/me/gallery", auth, upload.array("images", 10), async (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: "Keine Bilder hochgeladen." });
  const rows = [];
  for (const file of files) {
    const url = "/uploads/" + file.filename;
    const r = await query("INSERT INTO profile_images(user_id,url) VALUES($1,$2) RETURNING id,url,created_at", [req.user.id, url]);
    rows.push(r.rows[0]);
  }
  res.json(rows);
});

app.delete("/api/me/gallery/:id", auth, async (req, res) => {
  const r = await query("DELETE FROM profile_images WHERE id=$1 AND user_id=$2 RETURNING url", [Number(req.params.id), req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "Bild nicht gefunden." });
  fs.rm(path.join(UPLOAD_DIR, path.basename(r.rows[0].url)), { force: true }, () => {});
  res.json({ ok: true });
});

app.post("/api/chat-image", auth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Bitte ein gültiges Bild hochladen." });
  res.json({ url: "/uploads/" + req.file.filename });
});

app.delete("/api/chat-message/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Ungültige Nachricht." });
  const r = await query(
    "DELETE FROM messages WHERE id=$1 AND user_id=$2 AND image_url IS NOT NULL RETURNING image_url",
    [id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Bildnachricht nicht gefunden." });
  fs.rm(path.join(UPLOAD_DIR, path.basename(r.rows[0].image_url)), { force: true }, () => {});
  broadcastRoom(0, { type: "message_deleted", messageId: id });
  for (const [, set] of online) for (const ws of set) if (ws.readyState === 1) ws.send(JSON.stringify({ type: "message_deleted", messageId: id }));
  res.json({ ok: true });
});

app.delete("/api/dm-message/:id", auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Ungültige Nachricht." });
  const r = await query(
    "DELETE FROM direct_messages WHERE id=$1 AND sender_id=$2 AND image_url IS NOT NULL RETURNING image_url",
    [id, req.user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: "Bildnachricht nicht gefunden." });
  fs.rm(path.join(UPLOAD_DIR, path.basename(r.rows[0].image_url)), { force: true }, () => {});
  for (const [, set] of online) for (const ws of set) if (ws.readyState === 1) ws.send(JSON.stringify({ type: "message_deleted", messageId: id }));
  res.json({ ok: true });
});
app.get("/api/rooms", auth, async (req, res) => {
  const r = await query("SELECT id,name FROM rooms ORDER BY id");
  res.json(r.rows);
});

app.get("/api/rooms/:id/messages", auth, async (req, res) => {
  const r = await query(
    `SELECT m.id,m.text,m.image_url,m.created_at,u.nick
     FROM messages m JOIN users u ON u.id=m.user_id
     WHERE m.room_id=$1 ORDER BY m.id DESC LIMIT 100`,
    [Number(req.params.id)]
  );
  res.json(r.rows.reverse());
});

app.get("/api/dm/:id", auth, async (req, res) => {
  const r = await query(
    `SELECT d.id,d.text,d.image_url,d.created_at,u.nick,d.sender_id
     FROM direct_messages d JOIN users u ON u.id=d.sender_id
     WHERE (d.sender_id=$1 AND d.receiver_id=$2)
        OR (d.sender_id=$2 AND d.receiver_id=$1)
     ORDER BY d.id DESC LIMIT 100`,
    [req.user.id, Number(req.params.id)]
  );
  res.json(r.rows.reverse());
});


app.post("/api/report", auth, async (req,res) => {
  if (!rateLimit("report:"+req.user.id,10,60*60*1000)) return res.status(429).json({error:"Zu viele Meldungen. Bitte später erneut versuchen."});
  const {targetUserId,messageId,messageType,reason,details}=req.body||{};
  if (typeof reason!=="string" || reason.trim().length<3 || reason.trim().length>100) return res.status(400).json({error:"Bitte einen gültigen Meldegrund angeben."});
  const target=targetUserId==null?null:Number(targetUserId), msg=messageId==null?null:Number(messageId);
  if (target!=null && !Number.isInteger(target)) return res.status(400).json({error:"Ungültiger Benutzer."});
  if (msg!=null && !Number.isInteger(msg)) return res.status(400).json({error:"Ungültige Nachricht."});
  await query("INSERT INTO reports(reporter_id,target_user_id,message_id,message_type,reason,details) VALUES($1,$2,$3,$4,$5,$6)",[req.user.id,target,msg,String(messageType||"").slice(0,20),reason.trim(),String(details||"").slice(0,1000)]);
  res.json({ok:true});
});

app.get("/api/admin/reports", auth, admin, async (req,res) => {
  const r=await query("SELECT r.*, reporter.nick AS reporter_nick, target.nick AS target_nick FROM reports r JOIN users reporter ON reporter.id=r.reporter_id LEFT JOIN users target ON target.id=r.target_user_id WHERE r.status='open' ORDER BY r.created_at ASC LIMIT 100");
  res.json(r.rows);
});

app.patch("/api/admin/reports/:id", auth, admin, async (req,res) => {
  const status=String(req.body?.status||"");
  if (!["resolved","rejected"].includes(status)) return res.status(400).json({error:"Ungültiger Status."});
  const r=await query("UPDATE reports SET status=$1,resolved_at=NOW() WHERE id=$2 RETURNING id,status",[status,Number(req.params.id)]);
  if (!r.rows[0]) return res.status(404).json({error:"Meldung nicht gefunden."});
  res.json(r.rows[0]);
});

app.delete("/api/admin/users/:id", auth, admin, async (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isInteger(id) || String(id)===String(req.user.id)) return res.status(400).json({error:"Ungültiger Benutzer."});
  const u=await query("SELECT avatar_url FROM users WHERE id=$1",[id]);
  if (!u.rows[0]) return res.status(404).json({error:"Benutzer nicht gefunden."});
  const files=await query("SELECT url FROM profile_images WHERE user_id=$1 UNION ALL SELECT image_url AS url FROM messages WHERE user_id=$1 AND image_url IS NOT NULL UNION ALL SELECT image_url AS url FROM direct_messages WHERE sender_id=$1 AND image_url IS NOT NULL",[id]);
  await query("DELETE FROM users WHERE id=$1",[id]);
  for (const url of [u.rows[0].avatar_url,...files.rows.map(x=>x.url)].filter(Boolean)) fs.rm(path.join(UPLOAD_DIR,path.basename(url)),{force:true},()=>{});
  res.json({ok:true});
});

app.post("/api/favorite/:id", auth, async (req, res) => {
  await query(
    "INSERT INTO favorites(user_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [req.user.id, Number(req.params.id)]
  );
  res.json({ ok: true });
});

app.delete("/api/favorite/:id", auth, async (req, res) => {
  await query(
    "DELETE FROM favorites WHERE user_id=$1 AND target_id=$2",
    [req.user.id, Number(req.params.id)]
  );
  res.json({ ok: true });
});

app.post("/api/block/:id", auth, async (req, res) => {
  await query(
    "INSERT INTO blocks(user_id,target_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [req.user.id, Number(req.params.id)]
  );
  res.json({ ok: true });
});

wss.on("connection", async (ws, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    const payload = jwt.verify(token, JWT_SECRET);

    ws.userId = String(payload.id);
    ws.roomId = null;

    if (!online.has(ws.userId)) online.set(ws.userId, new Set());
    online.get(ws.userId).add(ws);

    ws.send(JSON.stringify({ type: "ready", user: await userPublic(ws.userId) }));

    ws.on("message", async raw => {
      try {
        if (!rateLimit("ws:"+ws.userId,60,10000)) return ws.send(JSON.stringify({type:"error",error:"Zu viele Nachrichten. Bitte langsamer."}));
        const x = JSON.parse(raw.toString());

        if (x.type === "join_room") {
          const r = await query("SELECT id,name FROM rooms WHERE id=$1", [Number(x.roomId)]);
          const room = r.rows[0];
          if (!room) return;
          ws.roomId = Number(room.id);
          ws.send(JSON.stringify({ type: "joined_room", room }));
        }

        if (x.type === "room_message") {
          if (!ws.roomId || (typeof x.text !== "string" && !x.imageUrl)) return;
          const text = x.text.trim().slice(0, 1000);
          const imageUrl = typeof x.imageUrl==="string" && /^\/uploads\/[A-Za-z0-9._-]+$/.test(x.imageUrl) ? x.imageUrl : null;
          if (!text && !imageUrl) return;

          const r = await query(
            "INSERT INTO messages(room_id,user_id,text,image_url) VALUES($1,$2,$3,$4) RETURNING id",
            [ws.roomId, ws.userId, text || "", imageUrl]
          );
          const m = await query(
            `SELECT m.id,m.text,m.image_url,m.created_at,u.nick
             FROM messages m JOIN users u ON u.id=m.user_id
             WHERE m.id=$1`,
            [r.rows[0].id]
          );
          broadcastRoom(ws.roomId, { type: "room_message", message: m.rows[0] });
        }

        if (x.type === "dm") {
          const to = Number(x.to);
          const text = String(x.text || "").trim().slice(0, 1000);
          const imageUrl = typeof x.imageUrl==="string" && /^\/uploads\/[A-Za-z0-9._-]+$/.test(x.imageUrl) ? x.imageUrl : null;
          if (!to || (!text && !imageUrl) || String(to) === ws.userId) return;
          const blocked = await query(
            "SELECT 1 FROM blocks WHERE (user_id=$1 AND target_id=$2) OR (user_id=$2 AND target_id=$1) LIMIT 1",
            [ws.userId, to]
          );
          if (blocked.rows.length) return;

          const r = await query(
            `INSERT INTO direct_messages(sender_id,receiver_id,text,image_url)
             VALUES($1,$2,$3,$4) RETURNING id`,
            [ws.userId, to, text || "", imageUrl]
          );
          const m = await query(
            `SELECT d.id,d.text,d.image_url,d.created_at,u.nick,d.sender_id
             FROM direct_messages d JOIN users u ON u.id=d.sender_id
             WHERE d.id=$1`,
            [r.rows[0].id]
          );
          broadcastUser(to, { type: "dm", message: m.rows[0] });
          broadcastUser(ws.userId, { type: "dm", message: m.rows[0] });
        }
      } catch (e) {
        console.error("WS message error:", e.message);
      }
    });

    ws.on("close", () => {
      online.get(ws.userId)?.delete(ws);
      if (online.get(ws.userId)?.size === 0) online.delete(ws.userId);
    });
  } catch {
    ws.close(1008, "Unauthorized");
  }
});

app.delete("/api/me", auth, async (req,res) => {
  const id=req.user.id, u=await query("SELECT avatar_url FROM users WHERE id=$1",[id]);
  if (!u.rows[0]) return res.status(404).json({error:"Konto nicht gefunden."});
  const files=await query("SELECT url FROM profile_images WHERE user_id=$1 UNION ALL SELECT image_url AS url FROM messages WHERE user_id=$1 AND image_url IS NOT NULL UNION ALL SELECT image_url AS url FROM direct_messages WHERE sender_id=$1 AND image_url IS NOT NULL",[id]);
  await query("DELETE FROM users WHERE id=$1",[id]);
  for (const url of [u.rows[0].avatar_url,...files.rows.map(x=>x.url)].filter(Boolean)) fs.rm(path.join(UPLOAD_DIR,path.basename(url)),{force:true},()=>{});
  online.delete(String(id));
  res.json({ok:true});
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    online_connections: [...online.values()].reduce((n, s) => n + s.size, 0),
    database: "postgresql"
  });
});

app.get(/(.*)/, (req, res) =>
  res.sendFile(path.join(__dirname, "../public/index.html"))
);

initDb()
  .then(() => {
    server.listen(PORT, "0.0.0.0", () =>
      console.log(`ChatVZ running on port ${PORT}`)
    );
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
