// Headless mode: `npm run cli` (proxy + dashboard in your browser, no Electron window).
import { exec } from "node:child_process";
import { startApp } from "./app.js";

const app = await startApp();
if (!process.env.NO_OPEN) exec(`open ${app.url}`);

const shutdown = async () => { await app.stop(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
