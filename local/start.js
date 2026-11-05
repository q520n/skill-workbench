'use strict';
/**
 * Skill Workbench - LOCAL all-in-one launcher.
 *
 * Starts both halves on this machine in one process group:
 *   hub/server.js    -> HTTP service + web page (127.0.0.1 by default)
 *   agent/agent.js   -> scans SKILL.md, runs the local CLI, streams logs back
 *
 * No cloud, no share code, no third-party dependencies.
 * Close this window (or Ctrl+C) to stop everything.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.WB_HOST || '127.0.0.1';
const HUB_URL = 'http://127.0.0.1:' + PORT;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const hubCfg = readJson(path.join(ROOT, 'hub', 'data', 'config.json'), {});
const agentToken = hubCfg.agentToken || 'wb-agent-skillhub-20261104';

// Optional: local/api-key.txt holds a CodeBuddy API key. When present, the CLI
// authenticates through CODEBUDDY_API_KEY and needs no interactive /login.
const keyFile = path.join(__dirname, 'api-key.txt');
let apiKey = (process.env.WB_CLI_API_KEY || '').trim();
if (!apiKey && fs.existsSync(keyFile)) {
  apiKey = fs.readFileSync(keyFile, 'utf8')
    .split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !s.startsWith('#'))[0] || '';
}

const baseEnv = Object.assign({}, process.env, {
  PORT: String(PORT),
  HOST: HOST,
  WB_LOCAL_MODE: '1'
});
const agentEnv = Object.assign({}, baseEnv, {
  WB_HUB_URL: HUB_URL,
  WB_AGENT_TOKEN: agentToken,
  WB_SHARE_CODE: '',
  WB_CLI_API_KEY: apiKey
});

console.log('============================================');
console.log('  Skill Workbench / LOCAL MODE');
console.log('  Page : http://127.0.0.1:' + PORT);
if (HOST !== '127.0.0.1') console.log('  LAN  : http://<this-pc-ip>:' + PORT + '  (WB_HOST=0.0.0.0)');
console.log('  Skills run on THIS machine only.');
console.log('  API key : ' + (apiKey ? 'loaded (CLI login not required)' : 'NOT SET'));
console.log('  Close this window to stop everything.');
console.log('============================================');

let shuttingDown = false;
let hub = null;
let agent = null;

function spawnHub() {
  hub = cp.spawn(process.execPath, [path.join(ROOT, 'hub', 'server.js')], {
    cwd: path.join(ROOT, 'hub'), env: baseEnv, stdio: 'inherit', windowsHide: true
  });
  hub.on('exit', (code) => {
    if (shuttingDown) return;
    console.error('[launcher] hub exited (' + code + '), stopping everything.');
    shutdown(code || 0);
  });
}

function spawnAgent() {
  agent = cp.spawn(process.execPath, [path.join(ROOT, 'agent', 'agent.js')], {
    cwd: path.join(ROOT, 'agent'), env: agentEnv, stdio: 'inherit', windowsHide: true
  });
  agent.on('exit', (code) => {
    if (shuttingDown) return;
    console.error('[launcher] agent exited (' + code + '), restarting in 3s ...');
    setTimeout(spawnAgent, 3000);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (hub) hub.kill(); } catch (_) {}
  try { if (agent) agent.kill(); } catch (_) {}
  setTimeout(() => process.exit(code || 0), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Open the browser automatically once the hub is ready.
function openBrowser(attempt) {
  if (shuttingDown || process.env.WB_NO_BROWSER === '1') return;
  const req = http.get(HUB_URL + '/api/health', (res) => {
    res.resume();
    if (res.statusCode === 200) {
      const child = cp.spawn('cmd.exe', ['/c', 'start', '', HUB_URL], {
        detached: true, stdio: 'ignore', windowsHide: true
      });
      child.on('error', () => {});
      if (child.unref) child.unref();
    } else if (attempt < 12) {
      setTimeout(() => openBrowser(attempt + 1), 800);
    }
  });
  req.on('error', () => { if (attempt < 12) setTimeout(() => openBrowser(attempt + 1), 800); });
  req.setTimeout(2000, () => {
    req.destroy();
    if (attempt < 12) setTimeout(() => openBrowser(attempt + 1), 800);
  });
}

spawnHub();
setTimeout(spawnAgent, 1200);
setTimeout(() => openBrowser(0), 1500);
