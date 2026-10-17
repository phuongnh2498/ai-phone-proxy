// Export captured requests as HAR 1.2, Postman Collection v2.1, Python (requests) or cURL.
import { toCurl } from "./ai.js";

const SKIP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-connection", "accept-encoding"]);
const isText = (b) => b != null && !/^<\d+ bytes/.test(b);

const headerList = (h = {}) => Object.entries(h).flatMap(([name, v]) => (Array.isArray(v) ? v : [v]).map((value) => ({ name, value: String(value) })));

export function toHar(rows) {
  return {
    log: {
      version: "1.2",
      creator: { name: "Phone Proxy", version: "0.1.0" },
      entries: rows.filter((r) => r.method !== "TLS").map((r) => {
        const u = new URL(r.url);
        return {
          startedDateTime: new Date(r.ts).toISOString(),
          time: r.duration ?? 0,
          request: {
            method: r.method === "WS" ? "GET" : r.method,
            url: r.url,
            httpVersion: "HTTP/1.1",
            headers: headerList(r.req_headers),
            queryString: [...u.searchParams].map(([name, value]) => ({ name, value })),
            cookies: [],
            headersSize: -1,
            bodySize: r.req_size ?? 0,
            ...(isText(r.req_body) ? { postData: { mimeType: String(r.req_headers?.["content-type"] || "application/octet-stream"), text: r.req_body } } : {}),
            ...(r.req_raw?.length ? { postData: { mimeType: String(r.req_headers?.["content-type"] || "application/octet-stream"), text: r.req_raw.toString("base64"), _encoding: "base64" } } : {}),
          },
          response: {
            status: r.status ?? 0,
            statusText: r.error || "",
            httpVersion: "HTTP/1.1",
            headers: headerList(r.res_headers),
            cookies: [],
            content: {
              size: r.res_size ?? 0, mimeType: r.content_type || "",
              ...(r.res_raw?.length ? { text: r.res_raw.toString("base64"), encoding: "base64" } : isText(r.res_body) ? { text: r.res_body } : {}),
            },
            redirectURL: String(r.res_headers?.location || ""),
            headersSize: -1,
            bodySize: r.res_size ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: r.duration ?? 0, receive: 0 },
          _app: r.app,
        };
      }),
    },
  };
}

export function toPostman(rows, name = "Phone Proxy export") {
  return {
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: rows.filter((r) => r.method !== "TLS" && r.method !== "WS").map((r) => {
      const u = new URL(r.url);
      return {
        name: `${r.method} ${u.host}${u.pathname}`,
        request: {
          method: r.method,
          header: headerList(r.req_headers).filter((h) => !SKIP_HEADERS.has(h.name.toLowerCase()) && !h.name.startsWith(":")).map((h) => ({ key: h.name, value: h.value })),
          url: {
            raw: r.url,
            protocol: u.protocol.replace(":", ""),
            host: u.hostname.split("."),
            ...(u.port ? { port: u.port } : {}),
            path: u.pathname.split("/").filter(Boolean),
            query: [...u.searchParams].map(([key, value]) => ({ key, value })),
          },
          ...(isText(r.req_body) ? { body: { mode: "raw", raw: r.req_body } } : {}),
        },
      };
    }),
  };
}

const py = (s) => JSON.stringify(s); // JSON string literals are valid Python string literals

export function toPython(rows) {
  const parts = ["import base64", "import requests", ""];
  rows.filter((r) => r.method !== "TLS" && r.method !== "WS").forEach((r, i) => {
    const headers = Object.fromEntries(Object.entries(r.req_headers || {}).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()) && !k.startsWith(":")).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)]));
    const n = rows.length > 1 ? `_${i + 1}` : "";
    parts.push(`# ${r.app} — ${r.method} ${r.url}`);
    parts.push(`headers${n} = {`);
    for (const [k, v] of Object.entries(headers)) parts.push(`    ${py(k)}: ${py(v)},`);
    parts.push("}");
    const body = r.req_raw?.length ? `, data=base64.b64decode(${py(r.req_raw.toString("base64"))})` : isText(r.req_body) ? `, data=${py(r.req_body)}` : "";
    parts.push(`resp${n} = requests.request(${py(r.method)}, ${py(r.url)}, headers=headers${n}${body}, timeout=30)`);
    parts.push(`print(resp${n}.status_code)`);
    parts.push(`print(resp${n}.text[:2000])`, "");
  });
  return parts.join("\n");
}

export function exportRows(rows, format) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  switch (format) {
    case "har": return { body: JSON.stringify(toHar(rows), null, 2), type: "application/json", filename: `phone-proxy-${stamp}.har` };
    case "postman": return { body: JSON.stringify(toPostman(rows), null, 2), type: "application/json", filename: `phone-proxy-${stamp}.postman_collection.json` };
    case "python": return { body: toPython(rows), type: "text/x-python", filename: `phone-proxy-${stamp}.py` };
    case "curl": return { body: rows.filter((r) => r.method !== "TLS" && r.method !== "WS").map(toCurl).join("\n\n"), type: "text/plain", filename: `phone-proxy-${stamp}.sh` };
    default: throw new Error(`unknown export format ${format}`);
  }
}
