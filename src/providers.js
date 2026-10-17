// Ask AI through the user's own subscription CLIs (Claude Code, Codex, Antigravity) instead of an API key.
import { spawn, execFile, execFileSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
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

// How to get each CLI working, shown when it's missing or a call fails.
export const SETUP = {
  claude: { install: "curl -fsSL https://claude.ai/install.sh | bash", login: "claude", docs: "https://docs.claude.com/en/docs/claude-code/setup", plan: "a Claude Pro or Max plan" },
  codex: { install: "npm install -g @openai/codex", login: "codex login", docs: "https://github.com/openai/codex", plan: "a ChatGPT Plus, Pro or Team plan" },
  agy: { install: null, login: "agy", docs: "https://antigravity.google", plan: "a Google account with Antigravity access" },
};

// Turn a raw CLI failure into a next step the user can actually take.
export function setupHint(provider, error = "") {
  const s = SETUP[provider];
  if (!s) return null;
  const e = String(error);
  if (/not found|ENOENT/i.test(e)) {
    return `Install it: ${s.install ? `\`${s.install}\`` : `see ${s.docs}`}, then run \`${s.login}\` once in Terminal to sign in. Phone Proxy picks it up within 30 seconds. Needs ${s.plan}.`;
  }
  if (/log ?in|logged in|sign ?in|auth|unauthori[sz]ed|401|403|credential|token expired/i.test(e)) {
    return `Sign in: run \`${s.login}\` in Terminal and finish the login, then try again.`;
  }
  if (/usage|credits|quota|rate limit|429|limit reached/i.test(e)) {
    return "Your plan's usage limit is reached. Pick another model or engine, or wait for the limit to reset.";
  }
  if (/model/i.test(e)) return "That model isn't available on your plan. Pick Default or another model.";
  if (/timed out/i.test(e)) return "The CLI took too long. Ask a narrower question or pick a faster model.";
  return `Check that \`${s.login}\` works in Terminal on its own. Setup guide: ${s.docs}`;
}

// Re-checked every 30s so a CLI installed while the app runs shows up without a restart.
let cache, cacheAt = 0;
export function availableProviders() {
  if (!cache || Date.now() - cacheAt > 30_000) {
    cache = Object.entries(PROVIDERS).map(([id, p]) => {
      const available = p.bin ? Boolean(which(p.bin)) : true;
      return { id, label: p.label, available, ...(available || !SETUP[id] ? {} : { hint: setupHint(id, "not found") }) };
    });
    cacheAt = Date.now();
  }
  return cache;
}

// ---------- model lists ----------
// Each CLI knows its own catalog; we ask it instead of hardcoding names that go stale.
export const DEFAULT_API_MODEL = process.env.PHONE_PROXY_MODEL || "claude-opus-5-5";
const MODELS_TTL_MS = 10 * 60 * 1000;
const CLAUDE_ALIASES = [ // Claude Code resolves these to the newest model of each family
  { id: "fable", label: "Fable" },
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
];
const CLAUDE_RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
const CLAUDE_RESOLVED_PATH = path.join(DATA_DIR, "claude-models.json");
const modelCache = new Map(); // provider -> { at, models }

// Model names go into argv, so only allow plain ids (no leading "-" that a CLI could read as a flag).
export const isValidModel = (m) => typeof m === "string" && /^[A-Za-z0-9][\w.:@\/\[\]-]{0,99}$/.test(m);

function capture(bin, args) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    execFile(bin, args, { cwd: WORK_DIR, env: childEnv(), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

async function anthropicModels() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) return [];
  const out = [];
  for await (const m of new Anthropic().models.list({ limit: 100 })) out.push({ id: m.id, label: `${m.display_name} (${m.id})` });
  return out;
}

// Claude Code has no "list models" command and its aliases move with each release, so ask it:
// a one-word prompt per alias, run with the same flags as Ask AI, reports the exact model in modelUsage.
let claudeResolving = null;
function readClaudeResolved() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_RESOLVED_PATH, "utf8")); } catch { return null; }
}
async function probeClaude(bin, alias) {
  const args = ["-p", "Reply with OK", "--output-format", "json", "--setting-sources", "project,local", "--tools", "", ...(alias ? ["--model", alias] : [])];
  try {
    const out = JSON.parse(await new Promise((resolve, reject) => {
      execFile(bin, args, { cwd: WORK_DIR, env: childEnv("claude"), timeout: 90_000 }, (err, stdout) => (stdout ? resolve(stdout) : reject(err)));
    }));
    // Claude Code also makes a small side call to haiku (e.g. session title), so prefer the other model.
    const used = Object.keys(out.modelUsage || {});
    const model = used.find((m) => !/haiku/i.test(m)) || used[0] || null;
    return out.is_error || !model ? { error: String(out.result || "no model reported").slice(0, 160) } : { model };
  } catch (e) {
    return { error: String(e.message || e).split("\n")[0].slice(0, 160) };
  }
}
function resolveClaude(bin) {
  claudeResolving ??= (async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const map = {};
    for (const alias of ["", ...CLAUDE_ALIASES.map((a) => a.id)]) map[alias] = await probeClaude(bin, alias); // one at a time: parallel runs collide
    fs.writeFileSync(CLAUDE_RESOLVED_PATH, JSON.stringify({ at: Date.now(), map }));
  })().finally(() => { claudeResolving = null; modelCache.delete("claude"); });
  return claudeResolving;
}
function claudeList(bin, refresh) {
  const saved = readClaudeResolved();
  const stale = !saved || Date.now() - saved.at > CLAUDE_RESOLVE_TTL_MS;
  if (bin && (refresh || stale)) resolveClaude(bin);
  const r = (alias) => saved?.map?.[alias];
  const describe = (name, alias) => {
    const x = r(alias);
    if (!x) return { label: `${name} (latest)` };
    if (x.model) return { label: `${name} → ${x.model}` };
    return { label: `${name} (unavailable: ${x.error})`, unavailable: true };
  };
  return {
    pending: Boolean(claudeResolving),
    defaultLabel: describe("Default", "").label,
    models: CLAUDE_ALIASES.map((a) => ({ id: a.id, ...describe(a.label, a.id) })),
  };
}

// Codex's default is whatever ~/.codex/config.toml says; otherwise Codex picks.
function codexDefault() {
  try {
    const toml = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml"), "utf8");
    const m = toml.split(/^\s*\[/m)[0].match(/^\s*model\s*=\s*"([^"]+)"/m); // top-level key only, not a [profile]
    return m ? `Default → ${m[1]} (from ~/.codex/config.toml)` : null;
  } catch { return null; }
}

async function codexModels(bin) {
  const { models = [] } = JSON.parse(await capture(bin, ["debug", "models"]));
  return models.filter((m) => m.visibility === "list").sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
}

async function agyModels(bin) {
  return (await capture(bin, ["models"])).split("\n").map((l) => l.split("\t")).filter((c) => c.length >= 2 && isValidModel(c[0].trim()))
    .map(([id, label]) => ({ id: id.trim(), label: label.trim() || id.trim() }));
}

// [{ id, label }]; id "" means "let the CLI / app pick its default".
export async function listModels(provider, { refresh = false } = {}) {
  const hit = modelCache.get(provider);
  if (hit && !refresh && Date.now() - hit.at < MODELS_TTL_MS) return hit;
  const bin = PROVIDERS[provider]?.bin && which(PROVIDERS[provider].bin);
  let models = [], error = null, pending = false;
  let defaultLabel = { api: `Default → ${DEFAULT_API_MODEL}`, codex: codexDefault() || "Default (Codex picks)", agy: "Default (Antigravity's setting)" }[provider] || "Default";
  try {
    if (provider === "api") models = await anthropicModels();
    else if (provider === "claude") {
      const c = claudeList(bin, refresh);
      ({ pending, defaultLabel } = c);
      models = [...c.models, ...(await anthropicModels().catch(() => []))];
    }
    else if (provider === "codex" && bin) models = await codexModels(bin);
    else if (provider === "agy" && bin) models = await agyModels(bin);
  } catch (e) {
    error = `Couldn't list models: ${String(e.message || e).split("\n")[0].slice(0, 200)}`;
  }
  const out = { at: Date.now(), models: [{ id: "", label: defaultLabel }, ...models], error, pending };
  if (!error && !pending) modelCache.set(provider, out);
  return out;
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

export async function askViaCli(provider, prompt, model) {
  const meta = PROVIDERS[provider];
  const bin = meta?.bin && which(meta.bin);
  if (!bin) throw new Error(`${meta?.label || provider} not found.`);
  const modelArgs = (flag) => (isValidModel(model) ? [flag, model] : []);

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
      ...modelArgs("--model"),
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
      ...modelArgs("-m"),
      prompt,
    ], provider);
    try { return fs.readFileSync(outFile, "utf8"); } finally { fs.rmSync(outFile, { force: true }); }
  }

  if (provider === "agy") {
    return run(bin, ["-p", prompt, "--output-format", "text", "--disable-slash-commands", ...modelArgs("--model")], provider);
  }

  throw new Error(`unknown provider ${provider}`);
}
