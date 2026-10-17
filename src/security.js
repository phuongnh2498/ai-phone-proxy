// Network safety: who may use the proxy, where the proxy may connect, and phone pairing.
import net from "node:net";
import os from "node:os";
import dns from "node:dns/promises";

const PAIRING_WINDOW_MS = 10 * 60 * 1000;

export const normalizeIp = (ip = "") => ip.replace(/^::ffff:/, "");

export function isLoopback(ip) {
  ip = normalizeIp(ip);
  return ip === "::1" || ip.startsWith("127.") || ip === "0.0.0.0" || ip === "::";
}

// RFC1918 + CGNAT + IPv6 ULA / link-local: the only client addresses we ever serve.
export function isPrivateClient(ip) {
  ip = normalizeIp(ip);
  if (isLoopback(ip)) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return /^f[cd]/i.test(ip) || /^fe80:/i.test(ip);
}

function macIps() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) for (const n of list || []) out.add(normalizeIp(n.address));
  return out;
}

// Destinations the proxy must never reach: this Mac (any interface), loopback, link-local/cloud metadata.
function forbiddenTarget(ip) {
  ip = normalizeIp(ip);
  if (isLoopback(ip)) return true;
  if (ip.startsWith("169.254.") || /^fe80:/i.test(ip)) return true;
  return macIps().has(ip);
}

// Resolves the hostname so DNS-rebinding names (evil.com -> 127.0.0.1) are caught too.
export async function checkDestination(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost is not reachable through the proxy";
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { return null; } // let upstream report DNS errors
  }
  const bad = addrs.find(forbiddenTarget);
  return bad ? `${host} resolves to ${bad}, which is this Mac or a local-only address` : null;
}

export class Pairing {
  constructor(store, onChange) {
    this.store = store;
    this.onChange = onChange;
    this.windowUntil = 0;
    this.paired = new Set(store.devices().map((d) => d.ip));
    this.pacFetches = new Map(); // ip -> { ts, proxied } so the UI can show whether the phone picked up the PAC file
  }

  notePac(ip, proxied) {
    ip = normalizeIp(ip);
    this.pacFetches.set(ip, { ts: Date.now(), proxied });
    this.onChange?.({ type: "pac", ip, proxied });
  }

  open() {
    this.windowUntil = Date.now() + PAIRING_WINDOW_MS;
    this.onChange?.({ type: "pairing", open: true, until: this.windowUntil });
    return this.windowUntil;
  }

  close() {
    this.windowUntil = 0;
    this.onChange?.({ type: "pairing", open: false });
  }

  isOpen() {
    return Date.now() < this.windowUntil;
  }

  // Mac itself is always allowed; phones only after pairing.
  isAllowed(ip) {
    ip = normalizeIp(ip);
    return isLoopback(ip) || this.paired.has(ip);
  }

  // Called when a phone opens the setup page. Pairs only inside the window, then closes it (one device per click).
  tryPair(ip, userAgent = "") {
    ip = normalizeIp(ip);
    if (isLoopback(ip) || !isPrivateClient(ip)) return false;
    if (this.paired.has(ip)) { this.store.touchDevice(ip); return true; }
    if (!this.isOpen()) return false;
    const name = /iPhone/.test(userAgent) ? "iPhone" : /iPad/.test(userAgent) ? "iPad" : /Android/.test(userAgent) ? "Android" : "Device";
    this.store.pairDevice(ip, name);
    this.paired.add(ip);
    this.windowUntil = 0;
    this.onChange?.({ type: "device", ip, name });
    this.onChange?.({ type: "pairing", open: false });
    return true;
  }

  forget(ip) {
    this.store.forgetDevice(ip);
    this.paired.delete(ip);
    this.onChange?.({ type: "device", ip, removed: true });
  }

  status() {
    const devices = this.store.devices().map((d) => ({ ...d, pac: this.pacFetches.get(d.ip) || null, last_traffic: this.store.lastTrafficFrom(d.ip) }));
    return { open: this.isOpen(), until: this.windowUntil, devices };
  }
}
