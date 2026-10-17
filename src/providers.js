// Ask AI through the user's own subscription CLIs (Claude Code, Codex, Antigravity) instead of an API key.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./store.js";

const HOME = os.homedir();
const EXTRA_PATHS = [`${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", `${HOME}/.npm-global/bin`, `${HOME}/.bun/bin`, `${HOME}/.volta/bin`];
const TIMEOUT_MS = 5 * 60 * 1000;
const WORK_DIR = path.join(DATA_DIR, "ai-work"); // empty cwd so CLIs don't pick up some random project
const MCP_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "mcp.js");

export const PROVIDERS = {
  api: { label: "Anthropic API key", bin: null },
  claude: { label: "Claude Code (subscription)", bin: "claude" },
  codex: { label: "Codex CLI (ChatGPT subscription)", bin: "codex" },
  agy: { label: "Antigravity CLI (Google subscription)", bin: "agy" },
};

// Apps launched from Finder get a bare PATH; ask the login shell for the real one once.
let shellPath;
function fullPath() {
  if (shellPath) return shellPath;
  let fromShell = "";
  try {
    fromShell = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", "echo -n $PATH"], { timeout: 5000, encoding: "utf8" });
  } catch {}
  shellPath = [...new Set([...fromShell.split(":"), ...(process.env.PATH || "").split(":"), ...EXTRA_PATHS].filter(Boolean))].join(":");
  return shellPath;
}

function which(bin) {
  for (const dir of fullPath().split(":")) {
    const p = path.join(dir, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch {}
  }
  return null;
}

let cache;
export function availableProviders() {
  if (!cache) {
    cache = Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, available: p.bin ? Boolean(which(p.bin)) : true }));
  }
  return cache;
}

function childEnv(provider) {
  const env = { ...process.env, PATH: fullPath() };
  delete env.ELECTRON_RUN_AS_NODE;
  // If an API key is in the env, Claude Code bills the key instead of the subscription.
  if (provider === "claude") { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
  return env;
}

function mcpServerSpec() {
  return { command: process.execPath, args: [MCP_SCRIPT], env: { ELECTRON_RUN_AS_NODE: "1", PHONE_PROXY_DIR: DATA_DIR } };
}

function run(bin, args, provider) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: WORK_DIR, env: childEnv(provider), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`${provider} timed out after ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${provider} exited ${code}: ${(err || out).trim().slice(-800)}`));
    });
  });
}

export async function askViaCli(provider, prompt) {
  const meta = PROVIDERS[provider];
  const bin = meta?.bin && which(meta.bin);
  if (!bin) throw new Error(`${meta?.label || provider} not found. Install it and sign in, then restart Phone Proxy.`);

  if (provider === "claude") {
    const cfgPath = path.join(DATA_DIR, "mcp-claude.json");
    fs.writeFileSync(cfgPath, JSON.stringify({ mcpServers: { "phone-proxy": mcpServerSpec() } }));
    return run(bin, [
      "-p", prompt,
      "--output-format", "text",
      "--setting-sources", "project,local",       // skip the user's own hooks/plugins/output styles
      "--mcp-config", cfgPath, "--strict-mcp-config",
      "--tools", "",                              // no built-in file/shell tools
      "--allowedTools", "mcp__phone-proxy",       // traffic tools run without prompts
    ], provider);
  }

  if (provider === "codex") {
    const outFile = path.join(WORK_DIR, `codex-${Date.now()}.txt`);
    const spec = mcpServerSpec();
    const toml = (v) => JSON.stringify(v);
    await run(bin, [
      "exec", "--skip-git-repo-check", "--ephemeral", "--color", "never",
      "-s", "read-only",
      "-c", `mcp_servers.phone-proxy.command=${toml(spec.command)}`,
      "-c", `mcp_servers.phone-proxy.args=${toml(spec.args)}`,
      "-c", `mcp_servers.phone-proxy.default_tools_approval_mode="approve"`,
      "-c", `mcp_servers.phone-proxy.env={ELECTRON_RUN_AS_NODE=${toml("1")},PHONE_PROXY_DIR=${toml(DATA_DIR)}}`,
      "-o", outFile,
      prompt,
    ], provider);
    try { return fs.readFileSync(outFile, "utf8"); } finally { fs.rmSync(outFile, { force: true }); }
  }

  if (provider === "agy") {
    return run(bin, ["-p", prompt, "--output-format", "text", "--disable-slash-commands"], provider);
  }

  throw new Error(`unknown provider ${provider}`);
}
