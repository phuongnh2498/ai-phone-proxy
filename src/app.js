import os from "node:os";
import { openStore, DATA_DIR, loadConfig, saveConfig } from "./store.js";
import { pickPort, DEFAULT_PROXY_PORT, DEFAULT_UI_PORT } from "./ports.js";
import { startProxy, CA_CERT_PATH } from "./proxy.js";
import { Pairing } from "./security.js";
import { RuleEngine, Throttle } from "./rules.js";
import { startServer } from "./server.js";

// Ports: env override > last used (kept stable so the phone's proxy setting keeps working) > defaults.
// If the saved port is taken by another program, move to the next free one and remember it.
async function resolvePorts(cfg) {
  const wantProxy = Number(process.env.PROXY_PORT || cfg.proxyPort || DEFAULT_PROXY_PORT);
  const wantUi = Number(process.env.UI_PORT || cfg.uiPort || DEFAULT_UI_PORT);
  const proxyPort = await pickPort(wantProxy);
  const uiPort = await pickPort(wantUi, [proxyPort]);
  if (!process.env.PROXY_PORT && !process.env.UI_PORT && (proxyPort !== cfg.proxyPort || uiPort !== cfg.uiPort)) {
    saveConfig({ proxyPort, uiPort });
  }
  return { proxyPort, uiPort, proxyMoved: proxyPort !== wantProxy };
}

export function lanIp() {
  const nets = os.networkInterfaces();
  const order = ["en0", "en1", ...Object.keys(nets)];
  for (const name of order) {
    for (const n of nets[name] || []) {
      if (n.family === "IPv4" && !n.internal && !n.address.startsWith("169.254")) return n.address;
    }
  }
  return "127.0.0.1";
}

export async function startApp() {
  const cfg = loadConfig();
  if (cfg.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;

  const { proxyPort: PROXY_PORT, uiPort: UI_PORT, proxyMoved } = await resolvePorts(cfg);
  if (proxyMoved) console.warn(`Proxy port was busy; now using ${PROXY_PORT}. Update the phone's Wi-Fi proxy port.`);

  const store = openStore();
  let ui;
  const onChange = (e) => ui?.broadcast(e);
  const ip = lanIp();
  const pairing = new Pairing(store, onChange);
  const rules = new RuleEngine(store);
  const throttle = new Throttle(cfg.throttle || "off");
  const phoneCtx = { pairing, lanIp: ip, proxyPort: PROXY_PORT, uiPort: UI_PORT, caPath: CA_CERT_PATH };
  const proxy = await startProxy({ store, port: PROXY_PORT, onChange, pairing, rules, throttle, phoneCtx });
  ui = startServer({ store, proxy, port: UI_PORT, lanIp: ip, proxyPort: PROXY_PORT, pairing, rules, throttle, phoneCtx });

  console.log(`
  Phone Proxy running
  ───────────────────────────────────────────
  Proxy        ${ip}:${PROXY_PORT}
  Auto proxy   http://${ip}:${UI_PORT}/proxy.pac   (phone: Wi-Fi → Configure Proxy → Automatic)
  Phone setup  ${ui.setupUrl}   (click "Connect phone" in the app first to pair)
  Dashboard    http://localhost:${UI_PORT}
  Data         ${DATA_DIR}
`);

  return {
    url: `http://localhost:${UI_PORT}`,
    setupUrl: ui.setupUrl,
    proxyAddr: `${ip}:${PROXY_PORT}`,
    proxyMoved,
    stop: async () => {
      ui.close();
      await Promise.race([proxy.stop().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
      store.db.close();
    },
  };
}
