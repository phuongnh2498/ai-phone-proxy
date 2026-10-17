// Turn captured bodies into something readable: JSON, form fields, schema-less protobuf, or a hex dump.

// Heuristic: valid UTF-8 with few control characters = text.
export function looksLikeText(buf) {
  if (!buf?.length) return true;
  const sample = buf.subarray(0, 4096);
  const str = sample.toString("utf8");
  let bad = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad / Math.max(str.length, 1) < 0.02;
}

// --- protobuf (no schema), like `protoc --decode_raw` ---
function readVarint(buf, pos) {
  let result = 0n, shift = 0n, b;
  do {
    if (pos >= buf.length) throw new Error("eof");
    b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    shift += 7n;
    if (shift > 70n) throw new Error("varint too long");
  } while (b & 0x80);
  return [result, pos];
}

const printable = (s) => !/[\u0000-\u0008\u000e-\u001f�]/.test(s);

function decodeMessage(buf, depth) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Number(key >> 3n), type = Number(key & 7n);
    if (field === 0 || field > 536870911) throw new Error("bad field");
    if (type === 0) {
      let v; [v, pos] = readVarint(buf, pos);
      fields.push({ field, type: "varint", value: v.toString() });
    } else if (type === 1) {
      if (pos + 8 > buf.length) throw new Error("eof");
      const b = buf.subarray(pos, pos + 8); pos += 8;
      fields.push({ field, type: "fixed64", value: `${b.readBigUInt64LE()} (double ${b.readDoubleLE()})` });
    } else if (type === 5) {
      if (pos + 4 > buf.length) throw new Error("eof");
      const b = buf.subarray(pos, pos + 4); pos += 4;
      fields.push({ field, type: "fixed32", value: `${b.readUInt32LE()} (float ${b.readFloatLE().toPrecision(7)})` });
    } else if (type === 2) {
      let len; [len, pos] = readVarint(buf, pos);
      const n = Number(len);
      if (pos + n > buf.length) throw new Error("eof");
      const chunk = buf.subarray(pos, pos + n); pos += n;
      fields.push({ field, ...decodeLengthDelimited(chunk, depth) });
    } else {
      throw new Error("bad wire type");
    }
  }
  return fields;
}

function decodeLengthDelimited(chunk, depth) {
  // Readable text wins; otherwise try a nested message; otherwise show bytes.
  const str = chunk.toString("utf8");
  if (chunk.length && printable(str)) return { type: "string", value: str };
  const nested = depth < 12 && tryNested(chunk, depth);
  if (nested) return { type: "message", value: nested };
  return { type: "bytes", value: chunk.toString("hex").slice(0, 200) + (chunk.length > 100 ? "…" : "") };
}

function tryNested(chunk, depth) {
  if (chunk.length < 2) return null;
  try {
    const f = decodeMessage(chunk, depth + 1);
    return f.length ? f : null;
  } catch { return null; }
}

export function decodeProtobuf(buf) {
  try {
    // gRPC framing: 1 byte flag + 4 byte length prefix.
    if (buf.length > 5 && buf[0] <= 1 && buf.readUInt32BE(1) === buf.length - 5) buf = buf.subarray(5);
    const fields = decodeMessage(buf, 0);
    return fields.length ? fields : null;
  } catch { return null; }
}

export function protobufText(fields, indent = "") {
  return fields.map((f) => {
    if (f.type === "message") return `${indent}${f.field} {\n${protobufText(f.value, indent + "  ")}\n${indent}}`;
    if (f.type === "string") return `${indent}${f.field}: ${JSON.stringify(f.value)}`;
    if (f.type === "bytes") return `${indent}${f.field}: <bytes ${f.value}>`;
    return `${indent}${f.field}: ${f.value}`;
  }).join("\n");
}

export function hexDump(buf, max = 4096) {
  const lines = [];
  const b = buf.subarray(0, max);
  for (let i = 0; i < b.length; i += 16) {
    const row = b.subarray(i, i + 16);
    const hex = [...row].map((x) => x.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("");
    lines.push(`${i.toString(16).padStart(6, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > max) lines.push(`… ${buf.length - max} more bytes`);
  return lines.join("\n");
}

function formFields(text) {
  try {
    const params = new URLSearchParams(text);
    const entries = [...params];
    return entries.length && entries.every(([k]) => k.length < 200) ? entries : null;
  } catch { return null; }
}

/**
 * Best readable representation of a body.
 * Returns { kind: "json"|"form"|"protobuf"|"text"|"binary"|"empty", text, fields? , hex? }
 */
export function describeBody(textBody, raw, contentType = "") {
  if (raw && raw.length) {
    const pb = decodeProtobuf(raw);
    const hex = hexDump(raw);
    if (pb) return { kind: "protobuf", text: protobufText(pb), hex, note: `${raw.length} bytes of binary protobuf (decoded without schema; field numbers only)` };
    return { kind: "binary", text: hex, hex, note: `${raw.length} bytes of binary data` };
  }
  if (!textBody) return { kind: "empty", text: "" };
  if (/^<\d+ bytes/.test(textBody)) return { kind: "binary", text: textBody, note: "binary (not stored)" };
  try { return { kind: "json", text: JSON.stringify(JSON.parse(textBody), null, 2) }; } catch {}
  if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%\-[\]]+=[^&\s]*(&[\w.%\-[\]]+=[^&\s]*)+$/.test(textBody.trim())) {
    const fields = formFields(textBody);
    if (fields) {
      // Values are often JSON themselves; pretty-print those.
      const pretty = fields.map(([k, v]) => { try { return [k, JSON.stringify(JSON.parse(v), null, 2)]; } catch { return [k, v]; } });
      return { kind: "form", text: pretty.map(([k, v]) => `${k} = ${v}`).join("\n"), fields: pretty };
    }
  }
  return { kind: "text", text: textBody };
}

// --- Pattern detection: JWTs, bearer tokens, API keys, Base64 blobs in headers and bodies ---
const b64urlJson = (s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return null; } };

function decodeJwt(token) {
  const [h, p] = token.split(".");
  const header = b64urlJson(h), payload = b64urlJson(p);
  if (!header || !payload) return null;
  const exp = typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  return { header, payload, expires: exp?.toISOString() ?? null, expired: exp ? exp.getTime() < Date.now() : null };
}

// Known key formats first (high confidence), then generic "something_key": "value" pairs.
const KEY_FORMATS = [
  ["Stripe key", /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
];
const GENERIC_KEY = /["']?([A-Za-z_-]*(?:api[_-]?key|apikey|secret|access[_-]?token|auth[_-]?token|app[_-]?key|client[_-]?secret|session[_-]?id|token))["']?\s*[:=]\s*["']?([A-Za-z0-9_\-.+/=]{16,})/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const BASE64 = /(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/]{4}){6,}(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![A-Za-z0-9+/_-])/g;

// Base64 is only worth showing when it decodes to readable text (otherwise every hash/ID would match).
function readableBase64(s) {
  if (/^[0-9a-f]+$/i.test(s) || /^[A-Za-z]+$/.test(s)) return null; // hex ids, plain words
  const buf = Buffer.from(s, "base64");
  if (buf.length < 12 || !looksLikeText(buf)) return null;
  const text = buf.toString("utf8");
  return /[\x00-\x08\x0e-\x1f�]/.test(text) ? null : text;
}

export function findPatterns(sources) {
  const out = [], seen = new Set();
  const add = (type, where, value, extra = {}) => {
    const k = value; // first (most specific) type wins
    if (seen.has(k) || out.length >= 50) return;
    seen.add(k);
    out.push({ type, where, value, ...extra });
  };
  for (const [where, raw] of sources) {
    if (!raw) continue;
    const text = String(raw).slice(0, 512 * 1024);
    for (const m of text.matchAll(JWT)) {
      const jwt = decodeJwt(m[0]);
      if (jwt) add("JWT", where, m[0], { decoded: jwt });
    }
    for (const m of text.matchAll(/\bBearer\s+([A-Za-z0-9_\-.~+/=]{12,})/g)) if (!m[1].startsWith("eyJ")) add("Bearer token", where, m[1]);
    for (const [type, re] of KEY_FORMATS) for (const m of text.matchAll(re)) add(type, where, m[0]);
    for (const m of text.matchAll(GENERIC_KEY)) if (!m[2].startsWith("eyJ")) add("API key / secret", where, m[2], { name: m[1] });
    for (const m of text.matchAll(BASE64)) {
      if (seen.has(m[0]) || m[0].includes("eyJ")) continue;
      const decoded = readableBase64(m[0]);
      if (decoded) add("Base64", where, m[0], { decoded: decoded.slice(0, 2000) });
    }
  }
  return out;
}

// Header lines as "name: value" so header-based secrets (authorization, x-api-key) get found.
export const headerText = (h) => Object.entries(h || {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
