// Pages served to the phone: setup guide, PAC auto-proxy file, CA download, and the proxy.setup check page.
import fs from "node:fs";
import { isPrivateClient, isLoopback, normalizeIp } from "./security.js";

export const MAGIC_HOST = "proxy.setup";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

const html = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
:root{--bg:#0f1115;--card:#171a21;--line:#262b36;--text:#e6e8ee;--muted:#8a91a3;--accent:#4f8cff;--ok:#3ecf8e;--err:#f2555a}
body{font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px 16px 40px;background:var(--bg);color:var(--text)}
h1{font-size:22px}h2{font-size:16px;margin:0 0 6px}.step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
.n{display:inline-block;width:24px;height:24px;border-radius:12px;background:var(--accent);color:#fff;text-align:center;font-size:14px;line-height:24px;margin-right:6px}
a.btn{display:block;text-align:center;background:var(--accent);color:#fff;padding:13px;border-radius:12px;text-decoration:none;font-weight:600;margin-top:10px}
input{width:100%;box-sizing:border-box;font:15px ui-monospace,Menlo,monospace;padding:11px;border-radius:10px;border:1px solid var(--line);background:#0b0d11;color:var(--text);margin-top:8px}
.muted{color:var(--muted);font-size:14px}.ok{color:var(--ok)}.err{color:var(--err)}b{font-weight:600}
</style></head><body>${body}</body></html>`;

function pac(lanIp, proxyPort, paired) {
  if (!paired) return `// Device not paired with Phone Proxy: no proxying.\nfunction FindProxyForURL(url, host) { return "DIRECT"; }\n`;
  const proxy = `PROXY ${lanIp}:${proxyPort}`;
  return `// Phone Proxy auto-config. Falls back to DIRECT when the Mac app is closed.
function FindProxyForURL(url, host) {
  if (host == "${MAGIC_HOST}") return "${proxy}";
  if (isPlainHostName(host) || dnsDomainIs(host, ".local") ||
      shExpMatch(host, "10.*") || shExpMatch(host, "192.168.*") || shExpMatch(host, "127.*") ||
      /^172\\.(1[6-9]|2[0-9]|3[01])\\./.test(host)) return "DIRECT";
  return "${proxy}; DIRECT";
}
`;
}

function notPairedPage(uiUrl) {
  return html("Pair with Phone Proxy", `<h1>📡 Pair this phone</h1>
<div class="step"><p>This phone isn't paired yet, and pairing is closed.</p>
<p>On your Mac: open <b>Phone Proxy</b> → click <b>Connect phone</b>, then reload this page within 10 minutes.</p>
<a class="btn" href="${uiUrl}/setup">Reload</a></div>
<p class="muted">Only one phone can pair per click, so nobody else on this Wi-Fi can use your proxy.</p>`);
}

// Android: Manual proxy (PAC support is patchy) and a DER .cer, which every Android version accepts.
function androidSetupPage({ lanIp, proxyPort, deviceName }) {
  return html("Phone Proxy Setup", `<h1>📡 Phone Proxy setup (Android)</h1>
<p class="ok">✓ Paired as ${deviceName || "this device"}</p>

<div class="step"><h2><span class="n">1</span>Proxy</h2>
<p>Settings → Wi-Fi → long-press (or ⚙) your network → <b>Modify</b> → Advanced → Proxy: <b>Manual</b></p>
<p>Hostname <b>${lanIp}</b> · Port <b>${proxyPort}</b> → Save</p></div>

<div class="step"><h2><span class="n">2</span>Download certificate</h2>
<a class="btn" href="/ca.cer">Download certificate</a></div>

<div class="step"><h2><span class="n">3</span>Install it</h2>
<p>Settings → Security (&amp; privacy) → More → Encryption &amp; credentials → <b>Install a certificate</b> → <b>CA certificate</b> → Install anyway → pick <b>phone-proxy-ca.cer</b>.</p>
<p class="muted">Android 7+ apps only trust user-installed certificates if they opt in. Browsers and debug builds do; most release apps and games don't, so their HTTPS shows as TLS rows.</p></div>

<div class="step"><h2><span class="n">4</span>Check</h2>
<a class="btn" href="http://${MAGIC_HOST}">Run check</a></div>

<p class="muted">Done testing? Set the proxy back to None and remove the certificate (Encryption &amp; credentials → User credentials).</p>`);
}

function setupPage({ lanIp, proxyPort, uiPort, deviceName }) {
  const pacUrl = `http://${lanIp}:${uiPort}/proxy.pac`;
  return html("Phone Proxy Setup", `<h1>📡 Phone Proxy setup</h1>
<p class="ok">✓ Paired as ${deviceName || "this device"}</p>

<div class="step"><h2><span class="n">1</span>Auto proxy</h2>
<p>Settings → Wi-Fi → tap <b>ⓘ</b> next to your network → <b>Configure Proxy</b> → <b>Automatic</b> → paste this URL → Save:</p>
<input readonly value="${pacUrl}" onclick="this.select();this.setSelectionRange(0,999);try{document.execCommand('copy');this.nextElementSibling.textContent='Copied ✓'}catch(e){}">
<p class="muted">Tap to copy. Internet keeps working when the Mac app is closed.</p>
<p class="muted"><b>Game or app traffic missing?</b> Many game engines ignore Automatic. Use Manual: Server <b>${lanIp}</b>, Port <b>${proxyPort}</b>.</p>
<p class="muted"><b>Already set Automatic before pairing?</b> iOS cached the old answer: turn Wi-Fi off and on once.<br>
Still nothing? Use Manual instead: Server <b>${lanIp}</b>, Port <b>${proxyPort}</b>.</p></div>

<div class="step"><h2><span class="n">2</span>Download certificate</h2>
<p>Must be opened in <b>Safari</b>. Tap Allow when asked.</p>
<a class="btn" href="/ca.pem">Download certificate</a></div>

<div class="step"><h2><span class="n">3</span>Install it</h2>
<p>Open <b>Settings</b> → tap <b>Profile Downloaded</b> at the top<br><span class="muted">(or General → VPN &amp; Device Management → Phone Proxy CA)</span><br>→ <b>Install</b> → passcode → Install → Done.</p>
<p class="muted">Install within 8 minutes or iOS deletes the download.</p></div>

<div class="step"><h2><span class="n">4</span>Trust it</h2>
<p>Settings → General → About → scroll to the <b>bottom</b> → <b>Certificate Trust Settings</b> → turn on <b>Phone Proxy CA (local)</b> → Continue.</p>
<p class="muted">This menu only appears after step 3 is done.</p></div>

<div class="step"><h2><span class="n">5</span>Check</h2>
<p>Open <b>http://${MAGIC_HOST}</b> in Safari. You should see two green checks.</p>
<a class="btn" href="http://${MAGIC_HOST}">Run check</a></div>

<p class="muted">Done testing? Set Configure Proxy back to Off, and remove the profile in General → VPN &amp; Device Management.</p>`);
}

function checkPage({ deviceName }) {
  return html("Phone Proxy Check", `<h1>📡 Phone Proxy check</h1>
<div class="step"><h2 class="ok">✓ Proxy is working</h2><p class="muted">This page was served by Phone Proxy on your Mac (paired as ${deviceName || "this device"}).</p></div>
<div class="step"><h2 id="tls">… checking HTTPS trust</h2><p class="muted" id="tlsHint"></p></div>
<a class="btn" href="/ca.pem">Download certificate again</a>
<img src="https://${MAGIC_HOST}/ok.gif?${Date.now()}" style="display:none"
  onload="document.getElementById('tls').className='ok';document.getElementById('tls').textContent='✓ HTTPS decryption works (certificate trusted)'"
  onerror="document.getElementById('tls').className='err';document.getElementById('tls').textContent='✗ Certificate not trusted yet';document.getElementById('tlsHint').innerHTML='Install the profile (Settings → Profile Downloaded), then Settings → General → About → Certificate Trust Settings → enable Phone Proxy CA.'">`);
}

const reply = (status, contentType, body, extra = {}) => ({
  status,
  headers: { "content-type": contentType, "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  body,
});

/**
 * Returns a response for phone-facing paths, or null when the path isn't one of ours.
 * ctx: { pairing, lanIp, proxyPort, uiPort, caPath }; magic = request came in via http(s)://proxy.setup
 */
export function phoneRoute(pathname, { clientIp, userAgent, magic }, ctx) {
  const ip = normalizeIp(clientIp);
  if (!isPrivateClient(ip)) return reply(403, "text/plain", "Forbidden");
  const uiUrl = `http://${ctx.lanIp}:${ctx.uiPort}`;
  const device = () => ctx.pairing.store.devices().find((d) => d.ip === ip)?.name;

  if (pathname === "/proxy.pac" || pathname === "/wpad.dat") {
    const paired = ctx.pairing.paired.has(ip);
    if (!isLoopback(ip)) ctx.pairing.notePac(ip, paired);
    return reply(200, "application/x-ns-proxy-autoconfig", pac(ctx.lanIp, ctx.proxyPort, paired));
  }
  if (pathname === "/ok.gif" && magic) return reply(200, "image/gif", GIF);
  if (pathname === "/setup" || (magic && pathname === "/")) {
    if (!ctx.pairing.tryPair(ip, userAgent) && !ctx.pairing.isAllowed(ip)) return reply(200, "text/html; charset=utf-8", notPairedPage(uiUrl));
    const page = magic ? checkPage({ deviceName: device() })
      : /Android/i.test(userAgent || "") ? androidSetupPage({ ...ctx, deviceName: device() })
      : setupPage({ ...ctx, deviceName: device() });
    return reply(200, "text/html; charset=utf-8", page);
  }
  if (pathname === "/ca.cer" || pathname === "/ca.der") {
    if (!ctx.pairing.isAllowed(ip)) return reply(200, "text/html; charset=utf-8", notPairedPage(uiUrl));
    const der = Buffer.from(fs.readFileSync(ctx.caPath, "utf8").replace(/-----[^-]+-----|\s/g, ""), "base64");
    return reply(200, "application/x-x509-ca-cert", der, { "content-disposition": 'attachment; filename="phone-proxy-ca.cer"' });
  }
  if (pathname === "/ca.pem" || pathname === "/ca.crt") {
    if (!ctx.pairing.isAllowed(ip)) return reply(200, "text/html; charset=utf-8", notPairedPage(uiUrl));
    return reply(200, "application/x-x509-ca-cert", fs.readFileSync(ctx.caPath), { "content-disposition": 'attachment; filename="phone-proxy-ca.pem"' });
  }
  return null;
}
