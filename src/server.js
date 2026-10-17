import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { askAI, replay, toCurl } from "./ai.js";
import { saveConfig, loadConfig } from "./store.js";
import { availableProviders, PROVIDERS } from "./providers.js";
import { phoneRoute, MAGIC_HOST } from "./phone.js";
import { isLoopback } from "./security.js";
import { RULE_TYPES, THROTTLE_PRESETS } from "./rules.js";
import { exportRows } from "./export.js";
import { describeBody, findPatterns, headerText } from "./decode.js";

// Detail payload for the UI: readable body views instead of raw blobs.
function detailView(r) {
  const { req_raw, res_raw, ...rest } = r;
  return {
    ...rest,
    curl: toCurl(r),
    req_view: describeBody(r.req_body, req_raw, r.req_headers?.["content-type"]),
    res_view: describeBody(r.res_body, res_raw, r.content_type),
    req_has_raw: Boolean(req_raw?.length), res_has_raw: Boolean(res_raw?.length),
    patterns: findPatterns([
      ["URL", r.url], ["request headers", headerText(r.req_headers)], ["request body", r.req_body],
      ["response headers", headerText(r.res_headers)], ["response body", r.res_body],
    ]),
  };
}

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const MAX_JSON = 2 * 1024 * 1024;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(body));
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_JSON) throw new Error("request body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

export function startServer({ store, proxy, port, lanIp, proxyPort, pairing, rules, throttle, phoneCtx }) {
  const clients = new Set();
  const setupUrl = `http://${lanIp}:${port}/setup`;
  const pacUrl = `http://${lanIp}:${port}/proxy.pac`;
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

  const send = (payload) => {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) c.write(data);
  };
  const broadcast = (event) => {
    if (!event.id) return send(event); // pairing / device events
    const row = store.summary(event.id);
    if (row) send({ type: event.type, row });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      // --- Phone-facing routes (LAN, private addresses only) ---
      const phone = phoneRoute(p, { clientIp: req.socket.remoteAddress, userAgent: req.headers["user-agent"], magic: false }, phoneCtx);
      if (phone) {
        res.writeHead(phone.status, { ...SECURITY_HEADERS, ...phone.headers });
        return res.end(phone.body);
      }

      // --- Dashboard + API: this Mac only ---
      // 1) loopback socket, 2) Host header must be localhost (stops DNS rebinding),
      // 3) writes need our custom header + same Origin (stops other websites in your browser from poking the API).
      if (!isLoopback(req.socket.remoteAddress) || !allowedHosts.has(req.headers.host || "")) {
        res.writeHead(403, SECURITY_HEADERS);
        return res.end("Forbidden");
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.origin;
        if (req.headers["x-phone-proxy"] !== "1" || (origin && !allowedOrigins.has(origin))) {
          res.writeHead(403, SECURITY_HEADERS);
          return res.end("Forbidden");
        }
      }

      if (p === "/" || p === "/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS,
          "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        });
        return fs.createReadStream(path.join(PUBLIC, "index.html")).pipe(res);
      }
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": hi\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      if (p === "/api/info") {
        return json(res, 200, {
          lanIp, proxyPort, setupUrl, pacUrl, magicHost: MAGIC_HOST, paused: proxy.isPaused(), stats: store.stats(),
          qr: await QRCode.toDataURL(setupUrl, { margin: 1, width: 220 }),
          providers: availableProviders(),
          aiProvider: loadConfig().aiProvider || defaultProvider(),
          aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE),
          pairing: pairing.status(),
          throttle: throttle.preset,
          throttlePresets: Object.fromEntries(Object.entries(THROTTLE_PRESETS).map(([k, v]) => [k, v.label])),
        });
      }
      const filter = Object.fromEntries(url.searchParams);
      if (filter.hideSystem) filter.hideSystem = filter.hideSystem === "1";
      if (filter.hideKeepalive) filter.hideKeepalive = filter.hideKeepalive === "1";
      if (p === "/api/requests") return json(res, 200, store.list(filter));
      if (p === "/api/groups") return json(res, 200, store.groups(filter));
      if (p.startsWith("/api/request/")) {
        const key = decodeURIComponent(p.slice("/api/request/".length));
        const r = store.get(key) || store.getByPrefix(key); // AI answers cite 8-char id prefixes
        return r ? json(res, 200, detailView(r)) : json(res, 404, { error: "not found" });
      }
      if (p.startsWith("/api/body/")) {
        const r = store.get(decodeURIComponent(p.slice("/api/body/".length)));
        const raw = url.searchParams.get("part") === "req" ? r?.req_raw : r?.res_raw;
        if (!raw) return json(res, 404, { error: "no raw body" });
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${r.id.slice(0, 8)}-${url.searchParams.get("part") || "res"}.bin"`, ...SECURITY_HEADERS });
        return res.end(raw);
      }
      if (p.startsWith("/api/ws/")) {
        return json(res, 200, store.wsMessages(decodeURIComponent(p.slice("/api/ws/".length))));
      }
      if (p === "/api/export") {
        const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
        const rows = ids.length ? store.getMany(ids) : store.listFull({ ...filter, limit: 5000 });
        const out = exportRows(rows, url.searchParams.get("format") || "har");
        res.writeHead(200, { "content-type": out.type, "content-disposition": `attachment; filename="${out.filename}"`, ...SECURITY_HEADERS });
        return res.end(out.body);
      }

      // --- writes ---
      if (req.method === "POST" && p === "/api/clear") { store.clear(); return json(res, 200, { ok: true }); }
      if (req.method === "POST" && p === "/api/delete") {
        const { app, host, pattern, method } = await readJson(req);
        return json(res, 200, { deleted: store.deleteWhere({ app, host, pattern, method }) });
      }
      if (req.method === "POST" && p === "/api/delete-ids") {
        const { ids } = await readJson(req);
        if (!Array.isArray(ids)) return json(res, 400, { error: "ids must be an array" });
        return json(res, 200, { deleted: store.deleteIds(ids.slice(0, 50000).map(String)) });
      }
      if (p === "/api/muted") return json(res, 200, store.muted());
      if (req.method === "POST" && (p === "/api/mute" || p === "/api/unmute")) {
        const { kind, value, deleteExisting } = await readJson(req);
        if (!["app", "host"].includes(kind) || !value) return json(res, 400, { error: "kind must be app|host" });
        if (p === "/api/mute") {
          store.mute(kind, value);
          if (deleteExisting) store.deleteWhere({ [kind]: value });
        } else store.unmute(kind, value);
        proxy.reloadMutes();
        return json(res, 200, store.muted());
      }
      if (req.method === "POST" && p === "/api/pause") {
        const { paused } = await readJson(req);
        proxy.setPaused(Boolean(paused));
        return json(res, 200, { paused: proxy.isPaused() });
      }
      if (req.method === "POST" && p === "/api/pairing") {
        const { open } = await readJson(req);
        if (open) pairing.open(); else pairing.close();
        return json(res, 200, pairing.status());
      }
      if (req.method === "POST" && p === "/api/devices/forget") {
        const { ip } = await readJson(req);
        pairing.forget(ip);
        return json(res, 200, pairing.status());
      }
      if (req.method === "POST" && p === "/api/throttle") {
        const { preset } = await readJson(req);
        throttle.set(preset);
        saveConfig({ throttle: throttle.preset });
        return json(res, 200, { throttle: throttle.preset });
      }
      if (p === "/api/rules" && req.method === "GET") return json(res, 200, store.rules());
      if (p === "/api/rules" && req.method === "POST") {
        const r = await readJson(req);
        if (!RULE_TYPES.includes(r.type)) return json(res, 400, { error: "bad rule type" });
        if (!r.pattern) return json(res, 400, { error: "pattern required" });
        if (r.type === "map_remote") { try { new URL(r.target); } catch { return json(res, 400, { error: "target must be a full URL, e.g. http://localhost:3000" }); } }
        if (r.type === "map_local" && !(r.file_path && fs.existsSync(r.file_path))) return json(res, 400, { error: "file not found" });
        store.saveRule({ ...r, id: r.id || randomUUID(), status: r.status ? Number(r.status) : null });
        rules.reload();
        return json(res, 200, store.rules());
      }
      if (p === "/api/rules/delete" && req.method === "POST") {
        const { id } = await readJson(req);
        store.deleteRule(id);
        rules.reload();
        return json(res, 200, store.rules());
      }
      if (req.method === "POST" && p === "/api/relabel") {
        const { host, app } = await readJson(req);
        proxy.detector.learn(host, app, "user");
        return json(res, 200, { updated: store.relabelHost(host, app) });
      }
      if (req.method === "POST" && p === "/api/replay") {
        const { id, ...overrides } = await readJson(req);
        const out = await replay(store, id, overrides);
        broadcast({ type: "new", id: out.id });
        return json(res, 200, out);
      }
      if (req.method === "POST" && p === "/api/settings") {
        const { anthropicApiKey, aiProvider } = await readJson(req);
        if (aiProvider && PROVIDERS[aiProvider]) saveConfig({ aiProvider });
        if (typeof anthropicApiKey === "string") {
          const key = anthropicApiKey.trim();
          saveConfig({ anthropicApiKey: key || undefined });
          if (key) process.env.ANTHROPIC_API_KEY = key; else delete process.env.ANTHROPIC_API_KEY;
        }
        return json(res, 200, { ok: true, aiConfigured: Boolean(process.env.ANTHROPIC_API_KEY) });
      }
      if (req.method === "POST" && p === "/api/ask") {
        const body = await readJson(req);
        const provider = loadConfig().aiProvider || defaultProvider();
        return json(res, 200, await askAI(store, { ...body, provider }));
      }
      res.writeHead(404, SECURITY_HEADERS);
      res.end("not found");
    } catch (e) {
      console.error(e);
      json(res, 500, { error: String(e.message || e) });
    }
  });

  server.listen(port, "0.0.0.0");
  return {
    broadcast,
    setupUrl,
    close: () => { for (const c of clients) c.end(); server.close(); server.closeAllConnections(); },
  };
}

// Prefer a subscription CLI the user already has; fall back to the API key.
function defaultProvider() {
  if (process.env.ANTHROPIC_API_KEY) return "api";
  return availableProviders().find((p) => p.id !== "api" && p.available)?.id || "api";
}
