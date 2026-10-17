import { app, BrowserWindow, Menu, clipboard, dialog, shell, Notification } from "electron";
import path from "node:path";

app.setName("Phone Proxy");

if (!app.requestSingleInstanceLock()) app.quit();

let backend;
let win;

function mcpCommand() {
  const script = path.join(app.getAppPath(), "src", "mcp.js");
  return `claude mcp add phone-proxy -e ELECTRON_RUN_AS_NODE=1 -- "${process.execPath}" "${script}"`;
}

function copy(text, label) {
  clipboard.writeText(text);
  if (Notification.isSupported()) new Notification({ title: "Phone Proxy", body: `${label} copied` }).show();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 600,
    title: "Phone Proxy",
    backgroundColor: "#0f1115",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.loadURL(backend.url);
  // Links that leave the dashboard open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(backend.url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on("closed", () => { win = null; });
}

function buildMenu() {
  const template = [
    { role: "appMenu" },
    { role: "editMenu" },
    {
      label: "Proxy",
      submenu: [
        { label: `Proxy address: ${backend.proxyAddr}`, enabled: false },
        { label: "Copy Proxy Address", click: () => copy(backend.proxyAddr, "Proxy address") },
        { label: "Copy Phone Setup URL", click: () => copy(backend.setupUrl, "Setup URL") },
        { type: "separator" },
        { label: "Copy Claude Code MCP Command", click: () => copy(mcpCommand(), "MCP command") },
        { label: "Open Data Folder", click: () => shell.openPath(path.join(app.getPath("home"), ".phone-proxy")) },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(async () => {
  try {
    const { startApp } = await import("../src/app.js");
    backend = await startApp();
  } catch (e) {
    const inUse = /EADDRINUSE/.test(String(e?.code || e?.message || e));
    dialog.showErrorBox(
      "Phone Proxy failed to start",
      inUse
        ? "Couldn't get a free port. Quit any other Phone Proxy instance (or `npm run cli`) and try again."
        : String(e?.stack || e),
    );
    app.exit(1);
    return;
  }
  buildMenu();
  createWindow();
  if (backend.proxyMoved) {
    dialog.showMessageBox({ type: "info", message: "Proxy port changed", detail: `The usual port was in use by another program. Phone Proxy now listens on ${backend.proxyAddr}. Update the port in your phone's Wi-Fi proxy settings.` });
  }
  app.on("activate", () => { if (!win) createWindow(); });
});

// Closing the window quits everything: proxy, dashboard server, DB. Nothing left running.
app.on("window-all-closed", () => app.quit());

let stopping = false;
app.on("before-quit", async (e) => {
  if (stopping || !backend) return;
  e.preventDefault();
  stopping = true;
  const hardExit = setTimeout(() => app.exit(0), 4000); // never hang on quit
  await backend.stop().catch(() => {});
  clearTimeout(hardExit);
  app.exit(0);
});
