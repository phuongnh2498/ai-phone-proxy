# AI Phone Proxy

AI-native HTTPS debugging proxy for your phone. Captures traffic, groups it by app → domain → endpoint, and lets Claude inspect it (in-app "Ask AI" panel + MCP server for Claude Code).

macOS only for now. Free and open source (MIT). Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Run

```bash
git clone https://github.com/phuongnh2498/ai-phone-proxy.git && cd ai-phone-proxy
npm install          # also rebuilds better-sqlite3 for Electron
npm start            # Electron app (dev)
npm run dist:dir     # build dist.noindex/mac-arm64/Phone Proxy.app
npm run cli          # headless: proxy + dashboard in your browser
```

Install the built app: `cp -R "dist.noindex/mac-arm64/Phone Proxy.app" /Applications/`

Ask AI — pick the engine in the AI panel's **AI via** dropdown:

| Option | Uses | Can dig with traffic tools (MCP) |
|---|---|---|
| Claude Code | your Claude subscription (`claude -p`) | yes |
| Codex CLI | your ChatGPT subscription (`codex exec`, read-only sandbox) | yes |
| Antigravity CLI | your Google subscription (`agy -p`) | no — answers from a traffic snapshot |
| Anthropic API key | pay-per-use key (saved to `~/.phone-proxy/config.json`, mode 600) | yes |

The CLIs must be installed and signed in already (`claude`, `codex login`, `agy`). They run in an empty folder (`~/.phone-proxy/ai-work`) with no file/shell tools.

## Connect a phone

1. Click **Connect phone** in the app. This opens a 10-minute pairing window.
2. Scan the QR with the iPhone camera (same Wi-Fi). Opening the page pairs the phone and closes the window.
3. Wi-Fi ⓘ → Configure Proxy → **Automatic** → paste the PAC URL shown (`http://<mac-ip>:47822/proxy.pac`).
   With the PAC link the phone falls back to a direct connection whenever the Mac app is closed.
4. Download the certificate in **Safari** → Settings → **Profile Downloaded** → Install.
5. Settings → General → About → **Certificate Trust Settings** → enable *Phone Proxy CA (local)*.
   (This menu only appears after step 4.)
6. Open `http://proxy.setup` on the phone. Two green checks mean the proxy and HTTPS decryption both work.

No USB cable needed. When done: Configure Proxy → Off, and remove the profile (Settings → General → VPN & Device Management).

## Security

- **Pairing:** only paired devices can use the proxy. One device per "Connect phone" click; forget devices in the same dialog. Unpaired devices are refused, and their PAC file says DIRECT, so their internet is unaffected and nothing of theirs is recorded.
- **No access to your Mac through the proxy:** requests to localhost, any of this Mac's IPs, link-local/cloud-metadata addresses, or hostnames that *resolve* to those (DNS rebinding) are blocked.
- **Dashboard is Mac-only:** loopback connections only, `Host` must be localhost (blocks DNS rebinding), and every write needs a custom header + same Origin (blocks other websites in your browser). CSP and no-sniff/no-frame headers on all responses.
- **LAN-facing pages** (`/setup`, `/proxy.pac`, `/ca.pem`) answer private-network addresses only; the certificate is only handed to paired devices.
- CA private key stays in `~/.phone-proxy/ca.key` (mode 600). Anyone with that file can intercept traffic from a device that trusts it.

## Tools

- **Rules** (header → Rules): Mock response, Map Local (serve a file), Map Remote (redirect to e.g. `http://localhost:3000`), Block. Wildcard (`*api.example.com/v1/*`) or `/regex/` patterns, first match wins.
- **Throttling** (header dropdown): 4G, 3G, Slow 2G, GPRS, high latency, offline.
- **WebSockets:** connections show as `WS` rows; open one to see every message (↑ phone → server, ↓ server → phone).
- **Compare:** Cmd-click two requests → **Compare 2** for a side-by-side diff.
- **Export:** header → Export (HAR, Postman v2.1, Python `requests`, cURL) for everything shown, or per request from the detail pane.

## Use with Claude Code (MCP)

In the app: menu **Proxy → Copy Claude Code MCP Command**, paste in a terminal. For the installed app it is:

```bash
claude mcp add phone-proxy -e ELECTRON_RUN_AS_NODE=1 -- \
  "/Applications/Phone Proxy.app/Contents/MacOS/Phone Proxy" \
  "/Applications/Phone Proxy.app/Contents/Resources/app/src/mcp.js"
```

(The MCP server runs on Electron's bundled Node so it shares the same native SQLite build — no system Node needed.)

Then ask: *"use phone-proxy: why is login failing in my app?"*

Tools: `traffic_overview`, `list_requests`, `get_request`, `replay_request`, `export_curl`, `relabel_host`.

## Notes

- Closing the window (or Cmd+Q) fully quits: proxy, dashboard server and DB all stop; nothing keeps running.
- Ports: proxy `47821`, dashboard `47822` by default. If another program holds one, the app moves to the next free port, remembers it, and tells you (update the phone proxy port then).
- Data + CA live in `~/.phone-proxy` (override with `PHONE_PROXY_DIR`). Ports: `PROXY_PORT`, `UI_PORT`.
- The dashboard/API only answers on localhost; the LAN only gets `/setup` and `/ca.pem`.
- Apps with certificate pinning show as `pinned` rows (host + timing only, no content).
- App attribution is heuristic (User-Agent → app headers → learned host map → time proximity for shared SDK domains). Double-click a host in the tree to relabel it.
- Keep the CA key private: anyone with `~/.phone-proxy/ca.key` can intercept traffic from a device that trusts it.

## Contributing

Issues and PRs welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Use it only on devices and apps you own or are authorized to test.
