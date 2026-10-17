import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { computeTags, endpointPattern } from "./detect.js";
import { askViaCli, isValidModel, setupHint, DEFAULT_API_MODEL } from "./providers.js";
import { describeBody } from "./decode.js";

const MODEL = DEFAULT_API_MODEL;
const MAX_TOOL_CHARS = 40_000;
const MAX_STEPS = 10;

// Headers fetch() refuses or that would break a replay.
const DROP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "upgrade", "te", "trailer", "accept-encoding"]);

export async function replay(store, id, overrides = {}) {
  const orig = store.get(id);
  if (!orig) throw new Error(`request ${id} not found`);
  if (orig.method === "TLS") throw new Error("cannot replay a failed TLS handshake");
  const headers = {};
  for (const [k, v] of Object.entries({ ...orig.req_headers, ...(overrides.headers || {}) })) {
    if (!DROP_HEADERS.has(k.toLowerCase()) && v != null) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const method = overrides.method || orig.method;
  const url = overrides.url || orig.url;
  const body = ["GET", "HEAD"].includes(method) ? undefined : (overrides.body ?? (orig.req_raw?.length ? orig.req_raw : orig.req_body) ?? undefined);
  const started = Date.now();
  const res = await fetch(url, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  const resHeaders = Object.fromEntries(res.headers.entries());
  const u = new URL(url);
  const newId = randomUUID();
  const duration = Date.now() - started;
  store.insert({
    id: newId, ts: started, method, url, host: u.hostname, path: u.pathname + u.search,
    pattern: endpointPattern(u.pathname), app: orig.app, app_conf: orig.app_conf,
    req_headers: headers, req_body: Buffer.isBuffer(body) ? `<${body.length} bytes binary>` : (body ?? null),
    req_raw: Buffer.isBuffer(body) ? body : null, req_size: body ? Buffer.byteLength(body) : 0,
    status: res.status, duration, res_headers: resHeaders, res_body: text.slice(0, 512 * 1024),
    res_size: Buffer.byteLength(text), content_type: (resHeaders["content-type"] || "").split(";")[0],
    tags: ["replay", ...computeTags({ host: u.hostname, path: u.pathname, reqHeaders: headers, status: res.status, contentType: resHeaders["content-type"], duration })],
  });
  return { id: newId, status: res.status, duration, headers: resHeaders, body: text.slice(0, 8000) };
}

export function toCurl(r) {
  const parts = [`curl -X ${r.method} '${r.url.replace(/'/g, "'\\''")}'`];
  for (const [k, v] of Object.entries(r.req_headers || {})) {
    if (DROP_HEADERS.has(k.toLowerCase()) || k.startsWith(":")) continue;
    parts.push(`-H '${k}: ${String(v).replace(/'/g, "'\\''")}'`);
  }
  if (r.req_raw?.length) parts.push(`--data-binary @${r.id.slice(0, 8)}-req.bin  # binary body: download it from the request's detail pane`);
  else if (r.req_body && !r.req_body.startsWith("<")) parts.push(`--data-raw '${r.req_body.replace(/'/g, "'\\''")}'`);
  return parts.join(" \\\n  ");
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + `…[+${s.length - n} chars]` : s);

function compact(r) {
  return {
    id: r.id, time: new Date(r.ts).toISOString(), app: r.app, method: r.method, host: r.host,
    path: clip(r.path, 300), status: r.status, ms: r.duration, tags: r.tags, error: r.error || undefined,
  };
}

function full(r, maxBody = 6000) {
  if (!r) return null;
  // Binary bodies (protobuf etc.) are given to the model decoded, never as mangled bytes.
  const body = (text, raw, ct) => {
    const v = describeBody(text, raw, ct);
    return clip(v.kind === "protobuf" ? `[protobuf, decoded without schema]\n${v.text}` : v.kind === "binary" ? `[${v.note}]` : (text ?? null), maxBody);
  };
  return {
    ...compact(r), url: r.url,
    req_headers: r.req_headers, req_body: body(r.req_body, r.req_raw, r.req_headers?.["content-type"]),
    res_headers: r.res_headers, res_body: body(r.res_body, r.res_raw, r.content_type),
  };
}

// Shared by the in-app Ask AI panel and the MCP server.
export function trafficTools(store) {
  return {
    list_requests: {
      description: "List captured requests (newest first). Filter by app, host, tag (auth, api, analytics, static, error, slow, failed, pinned, system, replay), statusMin, method, or free-text q (searches URL, headers, bodies).",
      input_schema: {
        type: "object",
        properties: {
          app: { type: "string" }, host: { type: "string" }, tag: { type: "string" }, method: { type: "string" },
          statusMin: { type: "number" }, q: { type: "string" }, limit: { type: "number", description: "default 50, max 500" },
        },
      },
      run: (a) => store.list({ ...a, limit: Math.min(a.limit || 50, 500) }).map(compact),
    },
    get_request: {
      description: "Full detail (headers + bodies) of one captured request by id. For WebSocket rows (method WS) also returns the messages.",
      input_schema: { type: "object", properties: { id: { type: "string" }, max_body: { type: "number" } }, required: ["id"] },
      run: (a) => {
        const r = store.get(a.id);
        if (!r) return { error: "not found" };
        const out = full(r, a.max_body || 20000);
        if (r.method === "WS") out.websocket_messages = store.wsMessages(r.id, 200);
        return out;
      },
    },
    traffic_overview: {
      description: "Grouped overview: every app → host → endpoint pattern with counts, error counts and avg latency. Start here to understand what the phone is doing.",
      input_schema: { type: "object", properties: { app: { type: "string" }, host: { type: "string" }, hideSystem: { type: "boolean" } } },
      run: (a) => ({ stats: store.stats(), groups: store.groups(a).slice(0, 400) }),
    },
    replay_request: {
      description: "Re-send a captured request from the Mac (optionally overriding method, url, headers, body) and return the response. Recorded as a new request tagged 'replay'.",
      input_schema: {
        type: "object",
        properties: { id: { type: "string" }, method: { type: "string" }, url: { type: "string" }, headers: { type: "object" }, body: { type: "string" } },
        required: ["id"],
      },
      run: ({ id, ...overrides }) => replay(store, id, overrides),
    },
    export_curl: {
      description: "Export a captured request as a cURL command.",
      input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: (a) => { const r = store.get(a.id); return r ? toCurl(r) : { error: "not found" }; },
    },
  };
}

const SYSTEM = `You are a network debugging assistant embedded in a local HTTPS proxy that captures traffic from the user's phone.
Use the tools to inspect real captured traffic before answering.
When you reference a request, cite its id as the first 8 characters in backticks (e.g. \`dc4ed790\`); the UI turns these into links.
Diagnosing missing traffic: certificate pinning shows up as rows tagged "pinned" (method TLS, handshake failure). If an app's own API hosts have NO rows at all (not even pinned ones), the traffic bypassed the proxy instead: the app uses its own network stack that ignores the system proxy, or QUIC/HTTP3 over UDP. Do not call that pinning.
Be concise and concrete: what happened, why, and what to do. Use markdown.
Captured headers may contain the user's own session tokens; do not repeat secrets in full, truncate them.`;

// CLI providers get a self-contained snapshot in the prompt (plus MCP tools where the CLI supports them).
function cliPrompt(store, { question, selectedId, filter }) {
  const snapshot = {
    ui_filter: filter || {},
    stats: store.stats(),
    overview_app_host_endpoint: store.groups({ hideSystem: true }).slice(0, 150),
    recent_requests: store.list({ ...(filter || {}), limit: 60 }).map(compact),
    selected_request: selectedId ? full(store.get(selectedId)) : undefined,
  };
  let ctx = JSON.stringify(snapshot);
  if (ctx.length > 120_000) ctx = ctx.slice(0, 120_000) + "…[truncated]";
  return `${SYSTEM}
If tools named phone-proxy (list_requests, get_request, traffic_overview, replay_request, export_curl) are available, use them to dig deeper. Otherwise answer from this snapshot. Do not edit files or run shell commands.

<traffic_snapshot>
${ctx}
</traffic_snapshot>

Question: ${question}`;
}

export async function askAI(store, { question, selectedId, filter, provider = "api", model }) {
  if (provider !== "api") {
    let answer;
    try {
      answer = await askViaCli(provider, cliPrompt(store, { question, selectedId, filter }), model);
    } catch (e) {
      const hint = setupHint(provider, e.message);
      throw new Error(hint ? `${e.message}\n\n**How to fix:** ${hint}` : e.message);
    }
    return { answer: answer.trim(), trace: [{ tool: `via ${provider}${model ? ` (${model})` : ""}`, input: {} }] };
  }
  const client = new Anthropic();
  const tools = trafficTools(store);
  let context = `Current UI filter: ${JSON.stringify(filter || {})}\nTraffic stats: ${JSON.stringify(store.stats())}`;
  if (selectedId) context += `\n\nSelected request:\n${JSON.stringify(full(store.get(selectedId)), null, 1)}`;

  const messages = [{ role: "user", content: `${context}\n\nQuestion: ${question}` }];
  const toolDefs = Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
  const trace = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await client.beta.messages.create({
      model: isValidModel(model) ? model : MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      tools: toolDefs,
      messages,
    });
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "refusal") return { answer: "_The model declined to answer this request._", trace };
    if (response.stop_reason !== "tool_use") {
      const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      return { answer, trace };
    }

    const results = await Promise.all(
      response.content.filter((b) => b.type === "tool_use").map(async (b) => {
        trace.push({ tool: b.name, input: b.input });
        try {
          const out = await tools[b.name].run(b.input || {});
          return { type: "tool_result", tool_use_id: b.id, content: clip(JSON.stringify(out), MAX_TOOL_CHARS) };
        } catch (e) {
          return { type: "tool_result", tool_use_id: b.id, content: String(e.message || e), is_error: true };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { answer: "_Stopped after too many tool steps. Try a narrower question._", trace };
}
