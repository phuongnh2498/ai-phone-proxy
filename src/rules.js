// Mock / Map Local / Map Remote / Block rules, and network throttling.
import fs from "node:fs";
import path from "node:path";

export const RULE_TYPES = ["mock", "map_local", "map_remote", "block"];

export const THROTTLE_PRESETS = {
  off: { label: "No throttling" },
  "4g": { label: "4G", latency: 60, down: 20_000_000, up: 8_000_000 },
  "3g": { label: "3G", latency: 300, down: 1_600_000, up: 750_000 },
  edge: { label: "Slow 2G / EDGE", latency: 800, down: 240_000, up: 200_000 },
  gprs: { label: "GPRS", latency: 2000, down: 50_000, up: 20_000 },
  latency: { label: "High latency (1.5s)", latency: 1500 },
  offline: { label: "Offline", offline: true },
};

const MIME = { ".json": "application/json", ".html": "text/html", ".xml": "application/xml", ".txt": "text/plain", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "*api.example.com/v1/*" wildcard, or "/regex/" — matched against the URL with and without scheme.
export function compilePattern(pattern) {
  const p = String(pattern || "").trim();
  if (!p) return () => false;
  if (p.length > 2 && p.startsWith("/") && p.endsWith("/")) {
    const re = new RegExp(p.slice(1, -1), "i");
    return (url) => re.test(url);
  }
  const re = new RegExp("^" + p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return (url) => re.test(url) || re.test(url.replace(/^[a-z]+:\/\//i, ""));
}

export class RuleEngine {
  constructor(store) {
    this.store = store;
    this.reload();
  }

  reload() {
    this.rules = this.store.rules().filter((r) => r.enabled).map((r) => ({ ...r, test: compilePattern(r.pattern) }));
  }

  match(method, url) {
    return this.rules.find((r) => (r.method === "ALL" || r.method === method) && r.test(url));
  }

  // Returns a mockttp beforeRequest result for the rule, or { url } for map remote.
  apply(rule, req) {
    const headers = rule.headers || {};
    if (rule.type === "block") return { response: "reset" };
    if (rule.type === "mock") {
      return { response: { statusCode: rule.status || 200, headers: { "content-type": "application/json", ...headers }, body: rule.body ?? "" } };
    }
    if (rule.type === "map_local") {
      try {
        const body = fs.readFileSync(rule.file_path);
        const type = MIME[path.extname(rule.file_path).toLowerCase()] || "application/octet-stream";
        return { response: { statusCode: rule.status || 200, headers: { "content-type": type, ...headers }, body } };
      } catch (e) {
        return { response: { statusCode: 502, headers: { "content-type": "text/plain" }, body: `Phone Proxy map-local: cannot read ${rule.file_path}: ${e.code || e.message}` } };
      }
    }
    if (rule.type === "map_remote") {
      // target "http://localhost:3000" keeps the original path; a target with its own path replaces the URL entirely.
      const orig = new URL(req.url);
      const target = new URL(rule.target);
      const keepPath = target.pathname === "/" && !target.search;
      const next = keepPath ? `${target.origin}${orig.pathname}${orig.search}` : target.toString();
      const outHeaders = { ...req.headers, host: target.host, ...headers };
      return { url: next, headers: outHeaders };
    }
    return undefined;
  }
}

export class Throttle {
  constructor(preset = "off") { this.set(preset); }
  set(preset) { this.preset = THROTTLE_PRESETS[preset] ? preset : "off"; this.cfg = THROTTLE_PRESETS[this.preset]; }
  get active() { return this.preset !== "off"; }

  async beforeRequest(bodySize) {
    const c = this.cfg;
    if (c.offline) return { response: "reset" };
    let ms = (c.latency || 0) / 2;
    if (c.up && bodySize) ms += (bodySize * 8 * 1000) / c.up;
    if (ms) await sleep(ms);
  }

  async beforeResponse(bodySize) {
    const c = this.cfg;
    let ms = (c.latency || 0) / 2;
    if (c.down && bodySize) ms += (bodySize * 8 * 1000) / c.down;
    if (ms) await sleep(Math.min(ms, 60_000));
  }
}
