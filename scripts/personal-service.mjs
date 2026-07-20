#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const LABEL = "dev.wardrobe.personal";
const root = path.resolve(import.meta.dirname, "..");
const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const logsDir = path.join(os.homedir(), "Library", "Logs");
const serviceFile = path.join(agentsDir, `${LABEL}.plist`);
const serviceTarget = `gui/${process.getuid()}/${LABEL}`;

function launchctl(...arguments_) {
  return spawnSync("launchctl", arguments_, { stdio: "inherit" });
}

function stopLoadedService() {
  return spawnSync("launchctl", ["bootout", serviceTarget], { stdio: "ignore" });
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function uninstall() {
  stopLoadedService();
  await rm(serviceFile, { force: true });
  console.log("Wardrobe will no longer start at login. Your wardrobe data was not changed.");
}

async function install() {
  if (process.platform !== "darwin") throw new Error("The start-at-login helper currently supports macOS only.");
  const vite = path.join(root, "node_modules", "vite", "bin", "vite.js");
  await access(vite).catch(() => {
    throw new Error("Run npm install before installing the personal service.");
  });

  const build = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
  if (build.status !== 0) throw new Error("The production build failed, so the login service was not installed.");

  await mkdir(agentsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(vite)}</string>
    <string>preview</string>
    <string>--host</string>
    <string>127.0.0.1</string>
    <string>--port</string>
    <string>4173</string>
    <string>--strictPort</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(logsDir, "Wardrobe.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(logsDir, "Wardrobe.error.log"))}</string>
</dict>
</plist>
`;

  stopLoadedService();
  await writeFile(serviceFile, plist, { mode: 0o600 });
  const result = launchctl("bootstrap", `gui/${process.getuid()}`, serviceFile);
  if (result.status !== 0) throw new Error(`Could not start the login service. Check ${path.join(logsDir, "Wardrobe.error.log")}.`);
  console.log("Wardrobe is running at http://127.0.0.1:4173 and will start whenever you log in.");
}

const action = process.argv[2];
if (action === "install") await install();
else if (action === "uninstall") await uninstall();
else throw new Error("Use: personal-service.mjs install|uninstall");
