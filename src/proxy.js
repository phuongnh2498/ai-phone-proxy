import * as mockttp from "mockttp";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./store.js";
import { AppDetector, computeTags, endpointPattern } from "./detect.js";
import { checkDestination, normalizeIp } from "./security.js";
import { phoneRoute, MAGIC_HOST } from "./phone.js";
import { looksLikeText } from "./decode.js";

// Pairing is decided by the real socket address.
export const isAllowedClient = (req, pairing) => pairing.isAllowed(normalizeIp(req.remoteIpAddress));

const MAX_BODY = 512 * 1024;
const MAX_WS_TEXT = 64 * 1024;
const MEDIA = /^(image|video|audio|font)\//i;

// Upload / server wait / download split, in ms, from mockttp's high-precision timestamps.
function phases(t) {
  if (!t?.startTimestamp) return null;
  const ms = (a, b) => (a != null && b != null ? Math.max(0, Math.round(b - a)) : null);
  return {
    upload: ms(t.startTimestamp, t.bodyReceivedTimestamp),
    wait: ms(t.bodyReceivedTimestamp, t.headersSentTimestamp),
    download: ms(t.headersSentTimestamp, t.responseSentTimestamp),
    total: ms(t.startTimestamp, t.responseSentTimestamp),
  };
}

export const CA_CERT_PATH = path.join(DATA_DIR, "ca.pem");
const CA_KEY_PATH = path.join(DATA_DIR, "ca.key");

export async function ensureCA() {
  if (!fs.existsSync(CA_CERT_PATH) || !fs.existsSync(CA_KEY_PATH)) {
    const ca = await mockttp.generateCACertificate({
      subject: { commonName: "Phone Proxy CA (local)", organizationName: "Phone Proxy" },
      bits: 2048,
    });
    fs.writeFileSync(CA_KEY_PATH, ca.key, { mode: 0o600 });
    fs.writeFileSync(CA_CERT_PATH, ca.cert);
  }
  fs.chmodSync(CA_KEY_PATH, 0o600);
  return { keyPath: CA_KEY_PATH, certPath: CA_CERT_PATH };
}

// Decodes gzip/br/deflate, then keeps text as text and binary (protobuf etc.) as raw bytes.
// Content-Type is not trusted: apps often send protobuf labelled as form data.
async function readBody(body, contentType) {
  const size = body?.buffer?.length ?? 0;
  if (!size) return { text: null, size, raw: null };
  if (MEDIA.test(contentType || "")) return { text: `<${size} bytes ${contentType}>`, size, raw: null };
  let buf;
  try { buf = await body.getDecodedBuffer(); } catch {}
  if (!buf) return { text: `<${size} bytes, undecodable>`, size, raw: null };
  if (looksLikeText(buf)) {
    const text = buf.toString("utf8");
    return { text: text.length > MAX_BODY ? text.slice(0, MAX_BODY) + "\n…[truncated]" : text, size, raw: null };
  }
  return { text: `<${buf.length} bytes binary>`, size, raw: Buffer.from(buf.subarray(0, MAX_BODY)) };
}

const hostnameOf = (req) => {
  try { return new URL(req.url).hostname; } catch { return req.destination?.hostname || ""; }
};

const deniedPage = (lanIp, uiPort) => ({
  statusCode: 403,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  body: `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px -apple-system,sans-serif;padding:24px;background:#0f1115;color:#e6e8ee">
<h2>📡 Device not paired</h2><p>This device isn't allowed to use Phone Proxy.</p>
<p>On the Mac: Phone Proxy → <b>Connect phone</b>, then open <b>http://${lanIp}:${uiPort}/setup</b> on this phone.</p></body>`,
});

export async function startProxy({ store, port, onChange, pairing, rules, throttle, phoneCtx }) {
  const https = await ensureCA();
  const server = mockttp.getLocal({
    https: { ...https, tlsServerOptions: { minVersion: "TLSv1" } },
    http2: "fallback",
    recordTraffic: false,
  });
  const detector = new AppDetector(store);
  const pending = new Map(); // id -> { started, host, path, reqHeaders, extraTags }
  const marks = new Map();   // id -> { tags: [], note } from rules / guards
  let paused = false;
  let mutedHosts = new Set(), mutedApps = new Set();
  const reloadMutes = () => {
    const m = store.muted();
    mutedHosts = new Set(m.filter((x) => x.kind === "host").map((x) => x.value));
    mutedApps = new Set(m.filter((x) => x.kind === "app").map((x) => x.value));
  };
  reloadMutes();

  const clientOf = (req) => normalizeIp(req.remoteIpAddress);
  // Phone pages: http(s)://proxy.setup/*, or the Mac's own setup URL requested through the proxy.
  const isPhoneReq = (req) => {
    const host = hostnameOf(req);
    if (host === MAGIC_HOST) return true;
    const u = new URL(req.url);
    return host === phoneCtx.lanIp && Number(u.port) === phoneCtx.uiPort;
  };
  const mark = (id, tag, note) => {
    const m = marks.get(id) || { tags: [], note: null };
    m.tags.push(tag);
    if (note) m.note = note;
    marks.set(id, m);
  };

  // 1. Phone setup / PAC / CA / check pages.
  await server.forAnyRequest().matching(isPhoneReq).always().thenCallback((req) => {
    const u = new URL(req.url);
    const r = phoneRoute(u.pathname, { clientIp: req.remoteIpAddress, userAgent: req.headers["user-agent"], magic: u.hostname === MAGIC_HOST }, phoneCtx)
      || { status: 404, headers: { "content-type": "text/plain" }, body: "Not found" };
    return { statusCode: r.status, headers: r.headers, body: r.body };
  });

  // 2. Unpaired devices may not use the proxy at all.
  await server.forAnyRequest().matching((req) => !isAllowedClient(req, pairing)).always()
    .thenCallback(() => deniedPage(phoneCtx.lanIp, phoneCtx.uiPort));
  await server.forAnyWebSocket().matching((req) => !isAllowedClient(req, pairing)).always()
    .thenRejectConnection(403, "Device not paired");

  // 3. Everything else: rules, destination guard, throttling, then forward.
  await server.forAnyRequest().always().thenPassThrough({
    beforeRequest: async (req) => {
      const rule = rules.match(req.method, req.url);
      let result;
      if (rule) {
        result = rules.apply(rule, req);
        mark(req.id, rule.type === "mock" ? "mocked" : rule.type === "map_local" ? "mapped-local" : rule.type === "map_remote" ? "mapped-remote" : "blocked", `rule: ${rule.name || rule.pattern}`);
        if (result?.response === "reset") return result;
      }
      // Map Remote targets are user-chosen (e.g. localhost dev server); everything else is guarded.
      if (rule?.type !== "map_remote") {
        const bad = await checkDestination(hostnameOf(req));
        if (bad) {
          mark(req.id, "blocked", bad);
          return { response: { statusCode: 403, headers: { "content-type": "text/plain" }, body: `Phone Proxy blocked this request: ${bad}` } };
        }
      }
      if (throttle.active) {
        mark(req.id, "throttled");
        const t = await throttle.beforeRequest(req.body?.buffer?.length || 0);
        if (t) return t;
      }
      return result;
    },
    beforeResponse: async (res) => {
      if (throttle.active) await throttle.beforeResponse(res.body?.buffer?.length || 0);
    },
  });

  // WebSockets: guard destination, then pass through (messages are recorded via events below).
  await server.forAnyWebSocket().matching(async (req) => Boolean(await checkDestination(hostnameOf(req)))).always()
    .thenRejectConnection(403, "Blocked by Phone Proxy");
  await server.forAnyWebSocket().always().thenPassThrough();

  const shouldRecord = (req) => !paused && !isPhoneReq(req) && isAllowedClient(req, pairing);

  // Returns null when the request belongs to a muted app/host (nothing is stored).
  function recordRequest(req, { method, extraTags = [] } = {}) {
    const ts = Date.now();
    const u = new URL(req.url);
    const host = u.hostname;
    const reqPath = u.pathname + u.search;
    const { app, confidence } = detector.detect({ host, headers: req.headers, ts });
    if (mutedHosts.has(host) || mutedApps.has(app)) return null;
    pending.set(req.id, { started: req.timingEvents?.startTime ?? ts, host, path: reqPath, reqHeaders: req.headers, extraTags });
    const ip = clientOf(req);
    if (!ip.startsWith("127.")) store.touchDevice(ip);
    return { ts, u, host, reqPath, app, confidence, ip };
  }

  await server.on("request", async (req) => {
    if (!shouldRecord(req)) return;
    const reqCt = req.headers["content-type"];
    const { text, size, raw } = await readBody(req.body, reqCt);
    const r = recordRequest(req);
    if (!r) return;
    store.insert({
      id: req.id, ts: r.ts, method: req.method, url: req.url, host: r.host, path: r.reqPath,
      pattern: endpointPattern(r.u.pathname), app: r.app, app_conf: r.confidence,
      req_headers: req.headers, req_body: text, req_size: size, req_raw: raw,
      tags: [...computeTags({ host: r.host, path: r.reqPath, reqHeaders: req.headers, contentType: reqCt })],
      client_ip: r.ip,
    });
    onChange({ type: "new", id: req.id });
  });

  await server.on("response", async (res) => {
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    const m = marks.get(res.id); marks.delete(res.id);
    const ct = res.headers["content-type"] || "";
    const { text, size, raw } = await readBody(res.body, ct);
    const duration = Date.now() - p.started;
    store.update(res.id, {
      status: res.statusCode, duration, res_headers: res.headers, res_body: text, res_size: size, res_raw: raw,
      timing: phases(res.timingEvents),
      content_type: String(ct).split(";")[0],
      error: m?.tags.includes("blocked") ? m.note : null,
      tags: [...new Set([...(m?.tags || []), ...computeTags({ host: p.host, path: p.path, reqHeaders: p.reqHeaders, status: res.statusCode, contentType: ct, duration })])],
    });
    onChange({ type: "update", id: res.id });
  });

  await server.on("abort", (req) => {
    const p = pending.get(req.id);
    if (!p) return;
    pending.delete(req.id);
    const m = marks.get(req.id); marks.delete(req.id);
    const error = m?.note || req.error?.message || req.error?.code || "aborted";
    store.update(req.id, {
      error, duration: Date.now() - p.started,
      tags: [...new Set([...(m?.tags || []), ...p.extraTags, ...computeTags({ host: p.host, path: p.path, reqHeaders: p.reqHeaders, error })])],
    });
    onChange({ type: "update", id: req.id });
  });

  // --- WebSockets ---
  const wsTick = new Map(); // streamId -> last broadcast time
  const wsBroadcast = (id) => {
    const now = Date.now();
    if (now - (wsTick.get(id) || 0) < 500) return;
    wsTick.set(id, now);
    onChange({ type: "update", id });
  };

  await server.on("websocket-request", (req) => {
    if (!shouldRecord(req)) return;
    const r = recordRequest(req, { extraTags: ["websocket"] });
    if (!r) return;
    store.insert({
      id: req.id, ts: r.ts, method: "WS", url: req.url, host: r.host, path: r.reqPath,
      pattern: endpointPattern(r.u.pathname), app: r.app, app_conf: r.confidence,
      req_headers: req.headers, req_size: 0, tags: ["websocket"], client_ip: r.ip,
    });
    onChange({ type: "new", id: req.id });
  });

  await server.on("websocket-accepted", (res) => {
    const p = pending.get(res.id);
    if (!p) return;
    store.update(res.id, { status: res.statusCode, res_headers: res.headers, tags: ["websocket", "open"] });
    onChange({ type: "update", id: res.id });
  });

  const onWsMessage = (m) => {
    if (!pending.has(m.streamId)) return;
    const buf = Buffer.from(m.content);
    const content = m.isBinary
      ? `<${buf.length} bytes binary> ${buf.subarray(0, 512).toString("base64")}`
      : (buf.length > MAX_WS_TEXT ? buf.subarray(0, MAX_WS_TEXT).toString("utf8") + "…[truncated]" : buf.toString("utf8"));
    store.addWsMessage({ stream_id: m.streamId, ts: Date.now(), direction: m.direction, is_binary: m.isBinary, size: buf.length, content });
    wsBroadcast(m.streamId);
  };
  await server.on("websocket-message-received", onWsMessage);
  await server.on("websocket-message-sent", onWsMessage);

  await server.on("websocket-close", (c) => {
    const p = pending.get(c.streamId);
    if (!p) return;
    pending.delete(c.streamId);
    store.update(c.streamId, {
      duration: Date.now() - p.started, res_size: store.wsCount(c.streamId),
      error: c.closeCode && c.closeCode !== 1000 && c.closeCode !== 1005 ? `closed ${c.closeCode} ${c.closeReason || ""}`.trim() : null,
      tags: ["websocket", "closed"],
    });
    wsTick.delete(c.streamId);
    onChange({ type: "update", id: c.streamId });
  });

  const pinnedRecent = new Map(); // host -> { id, ts, count }
  // Pinned apps reject our cert: we still record host + timing so they show in the domain view.
  await server.on("tls-client-error", (e) => {
    if (paused || !pairing.isAllowed(normalizeIp(e.remoteIpAddress))) return;
    const host = e.tlsMetadata?.sniHostname || e.destination?.hostname || "unknown";
    if (host === MAGIC_HOST) return;
    const ts = Date.now();
    const { app, confidence } = detector.detect({ host, headers: {}, ts });
    if (mutedHosts.has(host) || mutedApps.has(app)) return;
    // Pinned clients retry constantly (iCloud does it dozens of times a minute): fold repeats into one row.
    const prev = pinnedRecent.get(host);
    if (prev && ts - prev.ts < 60_000) {
      prev.count++;
      store.update(prev.id, { res_size: prev.count, error: `TLS ${e.failureCause} ×${prev.count} in the last minute (likely certificate pinning or CA not trusted)` });
      onChange({ type: "update", id: prev.id });
      return;
    }
    const id = randomUUID();
    pinnedRecent.set(host, { id, ts, count: 1 });
    store.insert({
      id, ts, method: "TLS", url: `https://${host}/`, host, path: "/", pattern: "<tls handshake>",
      app, app_conf: confidence, req_headers: {}, req_size: 0,
      error: `TLS ${e.failureCause} (likely certificate pinning or CA not trusted)`,
      tags: ["pinned", ...computeTags({ host, path: "/", error: true })],
      client_ip: normalizeIp(e.remoteIpAddress),
    });
    onChange({ type: "new", id });
  });

  // Malformed HTTP (common in game engines' hand-rolled clients): mockttp answers 400; record it instead of dropping it.
  await server.on("client-error", (e) => {
    const req = e.request || {};
    const ip = normalizeIp(req.remoteIpAddress);
    if (paused || !ip || !isAllowedClient(req, pairing)) return;
    const host = req.destination?.hostname || hostnameOf({ url: req.url || "" }) || "unknown";
    if (host === MAGIC_HOST || mutedHosts.has(host)) return;
    const ts = Date.now();
    const { app, confidence } = detector.detect({ host, headers: req.headers || {}, ts });
    if (mutedApps.has(app)) return;
    const url = req.url && /^\w+:\/\//.test(req.url) ? req.url : `http://${host}${req.path || "/"}`;
    const id = randomUUID();
    store.insert({
      id, ts, method: req.method || "BAD", url, host, path: req.path || "/", pattern: "<malformed>",
      app, app_conf: confidence, req_headers: req.headers || {}, req_size: 0,
      status: e.response !== "aborted" ? e.response?.statusCode ?? null : null,
      error: `Malformed HTTP request (${e.errorCode || "parse error"}); the proxy could not forward it`,
      tags: ["malformed", "failed"], client_ip: ip,
    });
    onChange({ type: "new", id });
  });

  await server.start(port);
  return {
    server,
    detector,
    setPaused(v) { paused = v; },
    reloadMutes,
    isPaused: () => paused,
    isMuted: (host, app) => mutedHosts.has(host) || mutedApps.has(app),
    stop: () => server.stop(),
  };
}
