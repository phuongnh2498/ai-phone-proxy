// Review C1: an unpaired device on the Wi-Fi must not reach services bound to the Mac's loopback
// through the LAN-facing proxy port (non-HTTP bytes inside CONNECT or SOCKS attempts).
// Runs under Electron (better-sqlite3 is built for it): ELECTRON_RUN_AS_NODE=1 electron --test test/lan-exposure.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

process.env.PHONE_PROXY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pp-lan-"));
const { openStore } = await import("../src/store.js");
const { startProxy } = await import("../src/proxy.js");
const { Pairing } = await import("../src/security.js");
const { RuleEngine, Throttle } = await import("../src/rules.js");

const lanIp = Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;

async function exchange(port, write, ms = 1500) {
  return new Promise((resolve) => {
    const c = net.connect({ host: lanIp, port, localAddress: lanIp });
    let got = Buffer.alloc(0);
    c.on("data", (d) => { got = Buffer.concat([got, d]); });
    c.on("connect", () => write(c));
    c.on("error", () => {});
    setTimeout(() => { c.destroy(); resolve(got.toString("latin1")); }, ms);
  });
}

test("unpaired LAN client cannot reach loopback-only services through the proxy", { skip: !lanIp && "no LAN address" }, async () => {
  const secret = net.createServer((s) => { s.write("SECRET-LOOPBACK-SERVICE"); s.on("error", () => {}); });
  await new Promise((r) => secret.listen(0, "127.0.0.1", r));
  const sport = secret.address().port;

  const store = openStore();
  const pairing = new Pairing(store);
  const port = 39000 + Math.floor(Math.random() * 1000);
  const proxy = await startProxy({
    store, port, onChange: () => {}, pairing, rules: new RuleEngine(store), throttle: new Throttle("off"),
    phoneCtx: { pairing, lanIp, proxyPort: port, uiPort: 1, caPath: "" },
  });
  try {
    const viaConnect = await exchange(port, (c) => {
      c.write(`CONNECT 127.0.0.1:${sport} HTTP/1.1\r\nHost: 127.0.0.1:${sport}\r\n\r\n`);
      setTimeout(() => c.write("\x00\x01binary-hello"), 200);
    });
    assert.ok(!viaConnect.includes("SECRET"), `CONNECT leaked: ${viaConnect}`);

    const meta = '{"tags":[]}';
    const viaSocks = await exchange(port, (c) => {
      c.write(Buffer.from([5, 1, 2]));
      setTimeout(() => c.write(Buffer.concat([Buffer.from([1, 8]), Buffer.from("metadata"), Buffer.from([meta.length]), Buffer.from(meta)])), 100);
      setTimeout(() => c.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, sport >> 8, sport & 255])), 200);
      setTimeout(() => c.write("\x00\x01binary-hello"), 400);
    });
    assert.ok(!viaSocks.includes("SECRET"), `SOCKS leaked: ${viaSocks}`);
  } finally {
    await proxy.stop();
    secret.close();
    store.db.close();
  }
});
