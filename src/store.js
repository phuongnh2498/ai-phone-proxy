import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR = process.env.PHONE_PROXY_DIR || path.join(os.homedir(), ".phone-proxy");
fs.mkdirSync(DATA_DIR, { recursive: true });

const CONFIG_PATH = path.join(DATA_DIR, "config.json");

export function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

const SUMMARY_COLS = `id, ts, method, url, host, path, pattern, app, app_conf, status, duration,
  req_size, res_size, content_type, tags, error`;

export function openStore() {
  const db = new Database(path.join(DATA_DIR, "traffic.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 3000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      method TEXT, url TEXT, host TEXT, path TEXT, pattern TEXT,
      app TEXT, app_conf REAL,
      status INTEGER, duration INTEGER,
      req_headers TEXT, req_body TEXT, req_size INTEGER,
      res_headers TEXT, res_body TEXT, res_size INTEGER,
      content_type TEXT, tags TEXT DEFAULT '[]', error TEXT, client_ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_req_ts ON requests(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_req_app_host ON requests(app, host);
    CREATE INDEX IF NOT EXISTS idx_req_host ON requests(host);
    CREATE TABLE IF NOT EXISTS host_map (host TEXT PRIMARY KEY, app TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS devices (ip TEXT PRIMARY KEY, name TEXT, paired_at INTEGER, last_seen INTEGER);
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY, name TEXT, enabled INTEGER DEFAULT 1, type TEXT, method TEXT DEFAULT 'ALL',
      pattern TEXT, status INTEGER, headers TEXT, body TEXT, file_path TEXT, target TEXT, created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ws_messages (
      stream_id TEXT, ts INTEGER, direction TEXT, is_binary INTEGER, size INTEGER, content TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_stream ON ws_messages(stream_id, ts);
    CREATE TABLE IF NOT EXISTS muted (kind TEXT, value TEXT, created_at INTEGER, PRIMARY KEY (kind, value));
  `);
  // Raw bytes for binary bodies (protobuf etc.) so nothing is mangled into text. Added in v0.2.
  for (const col of ["req_raw", "res_raw"]) {
    try { db.exec(`ALTER TABLE requests ADD COLUMN ${col} BLOB`); } catch {}
  }
  // Phase breakdown (upload / server wait / download) as JSON. Added in v0.3.
  try { db.exec("ALTER TABLE requests ADD COLUMN timing TEXT"); } catch {}
  // Tag keep-alive pings captured before the "keepalive" tag existed (VPN mode, v0.3). Idempotent.
  db.exec(`UPDATE requests SET tags = json_insert(tags, '$[#]', 'keepalive')
    WHERE method IN ('PINNED', 'TCP') AND req_size <= 100 AND res_size <= 100 AND tags NOT LIKE '%"keepalive"%'`);

  const insertStmt = db.prepare(`INSERT OR REPLACE INTO requests
    (id, ts, method, url, host, path, pattern, app, app_conf, status, duration,
     req_headers, req_body, req_size, res_headers, res_body, res_size, content_type, tags, error, client_ip, req_raw, res_raw)
    VALUES (@id, @ts, @method, @url, @host, @path, @pattern, @app, @app_conf, @status, @duration,
     @req_headers, @req_body, @req_size, @res_headers, @res_body, @res_size, @content_type, @tags, @error, @client_ip, @req_raw, @res_raw)`);

  const parse = (row) => row && {
    ...row,
    tags: JSON.parse(row.tags || "[]"),
    req_headers: row.req_headers ? JSON.parse(row.req_headers) : undefined,
    res_headers: row.res_headers ? JSON.parse(row.res_headers) : undefined,
    timing: row.timing ? JSON.parse(row.timing) : undefined,
  };

  function where(f = {}) {
    const clauses = [];
    const params = {};
    if (f.app) { clauses.push("app = @app"); params.app = f.app; }
    if (f.host) { clauses.push("host = @host"); params.host = f.host; }
    if (f.pattern) { clauses.push("pattern = @pattern"); params.pattern = f.pattern; }
    if (f.method) { clauses.push("method = @method"); params.method = f.method.toUpperCase(); }
    if (f.tag) { clauses.push("tags LIKE @tag"); params.tag = `%"${f.tag}"%`; }
    if (f.statusMin) { clauses.push("status >= @statusMin"); params.statusMin = Number(f.statusMin); }
    if (f.statusMax) { clauses.push("status <= @statusMax"); params.statusMax = Number(f.statusMax); }
    if (f.ctype) { clauses.push("content_type LIKE @ctype"); params.ctype = `%${f.ctype}%`; }
    if (f.since) { clauses.push("ts >= @since"); params.since = Number(f.since); }
    if (f.hideSystem) clauses.push(`tags NOT LIKE '%"system"%'`);
    if (f.hideKeepalive) clauses.push(`tags NOT LIKE '%"keepalive"%'`);
    if (f.q) {
      clauses.push("(url LIKE @q OR req_body LIKE @q OR res_body LIKE @q OR req_headers LIKE @q OR res_headers LIKE @q OR app LIKE @q)");
      params.q = `%${f.q}%`;
    }
    return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
  }

  return {
    db,
    insert(row) {
      insertStmt.run({
        status: null, duration: null, req_body: null, res_headers: null, res_body: null,
        res_size: null, content_type: null, error: null, client_ip: null, req_raw: null, res_raw: null, ...row,
        req_headers: JSON.stringify(row.req_headers ?? {}),
        res_headers: row.res_headers ? JSON.stringify(row.res_headers) : null,
        tags: JSON.stringify(row.tags ?? []),
      });
    },
    update(id, fields) {
      const f = { ...fields };
      if (f.res_headers) f.res_headers = JSON.stringify(f.res_headers);
      if (f.tags) f.tags = JSON.stringify(f.tags);
      if (f.timing) f.timing = JSON.stringify(f.timing);
      const keys = Object.keys(f);
      if (!keys.length) return;
      db.prepare(`UPDATE requests SET ${keys.map((k) => `${k} = @${k}`).join(", ")} WHERE id = @id`).run({ ...f, id });
    },
    get(id) {
      return parse(db.prepare("SELECT * FROM requests WHERE id = ?").get(id));
    },
    summary(id) {
      return parse(db.prepare(`SELECT ${SUMMARY_COLS} FROM requests WHERE id = ?`).get(id));
    },
    list(filter = {}) {
      const { sql, params } = where(filter);
      const limit = Math.min(Number(filter.limit) || 200, 2000);
      return db.prepare(`SELECT ${SUMMARY_COLS} FROM requests ${sql} ORDER BY ts DESC LIMIT ${limit}`).all(params).map(parse);
    },
    groups(filter = {}) {
      const { sql, params } = where(filter);
      return db.prepare(`SELECT app, host, method, pattern, COUNT(*) AS count,
          SUM(CASE WHEN status >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
          CAST(AVG(duration) AS INTEGER) AS avg_ms, MAX(ts) AS last_ts
        FROM requests ${sql} GROUP BY app, host, method, pattern ORDER BY count DESC LIMIT 5000`).all(params);
    },
    stats() {
      return db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT app) AS apps, COUNT(DISTINCT host) AS hosts,
        SUM(CASE WHEN status >= 400 OR error IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM requests`).get();
    },
    // Delete everything matching an app / host / endpoint group (sidebar "Delete").
    deleteWhere({ app, host, pattern, method }) {
      const f = { app, host, pattern, method };
      const keys = Object.keys(f).filter((k) => f[k]);
      if (!keys.length) return 0;
      const cond = keys.map((k) => `${k} = @${k}`).join(" AND ");
      const params = Object.fromEntries(keys.map((k) => [k, f[k]]));
      return db.transaction(() => {
        db.prepare(`DELETE FROM ws_messages WHERE stream_id IN (SELECT id FROM requests WHERE ${cond})`).run(params);
        return db.prepare(`DELETE FROM requests WHERE ${cond}`).run(params).changes;
      })();
    },
    deleteIds(ids) {
      return db.transaction(() => {
        const ws = db.prepare("DELETE FROM ws_messages WHERE stream_id = ?");
        const rq = db.prepare("DELETE FROM requests WHERE id = ?");
        let n = 0;
        for (const id of ids) { ws.run(id); n += rq.run(id).changes; }
        return n;
      })();
    },
    muted() {
      return db.prepare("SELECT kind, value FROM muted ORDER BY created_at DESC").all();
    },
    mute(kind, value) {
      db.prepare("INSERT OR IGNORE INTO muted (kind, value, created_at) VALUES (?, ?, ?)").run(kind, value, Date.now());
    },
    unmute(kind, value) {
      db.prepare("DELETE FROM muted WHERE kind = ? AND value = ?").run(kind, value);
    },
    clear() {
      db.exec("DELETE FROM requests; DELETE FROM ws_messages;");
    },
    getByPrefix(prefix) {
      if (!/^[0-9a-f-]{6,36}$/i.test(prefix)) return null;
      const rows = db.prepare("SELECT id FROM requests WHERE id LIKE ? LIMIT 2").all(prefix.toLowerCase() + "%");
      return rows.length === 1 ? parse(db.prepare("SELECT * FROM requests WHERE id = ?").get(rows[0].id)) : null;
    },
    getMany(ids) {
      const stmt = db.prepare("SELECT * FROM requests WHERE id = ?");
      return ids.map((id) => parse(stmt.get(id))).filter(Boolean);
    },
    listFull(filter = {}) {
      const { sql, params } = where(filter);
      const limit = Math.min(Number(filter.limit) || 500, 5000);
      return db.prepare(`SELECT * FROM requests ${sql} ORDER BY ts DESC LIMIT ${limit}`).all(params).map(parse);
    },

    // --- websocket messages ---
    addWsMessage(m) {
      db.prepare("INSERT INTO ws_messages (stream_id, ts, direction, is_binary, size, content) VALUES (?, ?, ?, ?, ?, ?)")
        .run(m.stream_id, m.ts, m.direction, m.is_binary ? 1 : 0, m.size, m.content);
    },
    wsMessages(streamId, limit = 2000) {
      return db.prepare("SELECT ts, direction, is_binary, size, content FROM ws_messages WHERE stream_id = ? ORDER BY ts LIMIT ?").all(streamId, limit);
    },
    wsCount(streamId) {
      return db.prepare("SELECT COUNT(*) AS n FROM ws_messages WHERE stream_id = ?").get(streamId).n;
    },

    // --- paired devices ---
    devices() {
      return db.prepare("SELECT * FROM devices ORDER BY paired_at DESC").all();
    },
    pairDevice(ip, name) {
      db.prepare("INSERT OR REPLACE INTO devices (ip, name, paired_at, last_seen) VALUES (?, ?, ?, ?)").run(ip, name, Date.now(), Date.now());
    },
    forgetDevice(ip) {
      db.prepare("DELETE FROM devices WHERE ip = ?").run(ip);
    },
    lastTrafficFrom(ip) {
      return db.prepare("SELECT MAX(ts) AS ts FROM requests WHERE client_ip = ?").get(ip)?.ts || null;
    },
    touchDevice(ip) {
      db.prepare("UPDATE devices SET last_seen = ? WHERE ip = ?").run(Date.now(), ip);
    },

    // --- mock / map rules ---
    rules() {
      return db.prepare("SELECT * FROM rules ORDER BY created_at").all().map((r) => ({ ...r, enabled: !!r.enabled, headers: r.headers ? JSON.parse(r.headers) : {} }));
    },
    saveRule(r) {
      db.prepare(`INSERT OR REPLACE INTO rules (id, name, enabled, type, method, pattern, status, headers, body, file_path, target, created_at)
        VALUES (@id, @name, @enabled, @type, @method, @pattern, @status, @headers, @body, @file_path, @target, @created_at)`).run({
        name: "", method: "ALL", status: null, body: null, file_path: null, target: null, created_at: Date.now(), ...r,
        enabled: r.enabled === false ? 0 : 1, headers: JSON.stringify(r.headers || {}),
      });
    },
    deleteRule(id) {
      db.prepare("DELETE FROM rules WHERE id = ?").run(id);
    },
    loadHostMap() {
      return db.prepare("SELECT host, app, source FROM host_map").all();
    },
    hostMapSource(host) {
      return db.prepare("SELECT source FROM host_map WHERE host = ?").get(host)?.source;
    },
    saveHostMap(host, app, source) {
      db.prepare("INSERT OR REPLACE INTO host_map (host, app, source) VALUES (?, ?, ?)").run(host, app, source);
    },
    relabelHost(host, app) {
      db.prepare("INSERT OR REPLACE INTO host_map (host, app, source) VALUES (?, ?, 'user')").run(host, app);
      return db.prepare("UPDATE requests SET app = ?, app_conf = 1 WHERE host = ?").run(app, host).changes;
    },
  };
}
