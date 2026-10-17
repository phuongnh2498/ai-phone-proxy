import net from "node:net";

// Uncommon defaults so we don't collide with dev servers (3000, 5173, 8080, 8000, 8888, ...).
export const DEFAULT_PROXY_PORT = 47821;
export const DEFAULT_UI_PORT = 47822;

export function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "0.0.0.0");
  });
}

// Preferred port if free, otherwise the next free one above it (skipping `avoid`).
export async function pickPort(preferred, avoid = []) {
  for (let p = preferred; p < preferred + 200 && p < 65535; p++) {
    if (!avoid.includes(p) && (await isFree(p))) return p;
  }
  throw new Error(`no free port near ${preferred}`);
}
