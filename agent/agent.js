'use strict';
/**
 * Skill Workbench - Local Agent
 * Runs on the machine that owns the SKILL.md files. Connects OUT to the cloud hub,
 * scans local skills, executes them through the local WorkBuddy CLI and streams logs back.
 * No third-party dependencies (Node 18+).
 *
 * WB_DRY_RUN=1  -> simulate an execution instead of calling the CLI (link self-test only).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, 'config.json');
const DEFAULTS = {
  hubUrl: 'http://127.0.0.1:7788',
  agentToken: '',
  cliPath: '',
  skillsDirs: [],
  workDir: process.cwd(),
  permissionMode: 'bypassPermissions',
  pollIntervalMs: 1200,
  rescanIntervalMs: 30000,
  defaultModel: ''
};
let cfg = Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')));
cfg.hubUrl = String(cfg.hubUrl).replace(/\/+$/, '');
const DRY_RUN = process.env.WB_DRY_RUN === '1';

// Local mode overrides (set by local/start.js). The published/cloud mode keeps
// using agent/config.json unchanged.
if (process.env.WB_HUB_URL) cfg.hubUrl = String(process.env.WB_HUB_URL).replace(/\/+$/, '');
if (process.env.WB_AGENT_TOKEN) cfg.agentToken = process.env.WB_AGENT_TOKEN;
if (process.env.WB_SHARE_CODE !== undefined) cfg.shareCode = process.env.WB_SHARE_CODE;
if (process.env.WB_CLI_ENV_JSON) {
  try { cfg.cliEnv = Object.assign({}, cfg.cliEnv || {}, JSON.parse(process.env.WB_CLI_ENV_JSON)); }
  catch (_) { console.warn('[agent] WB_CLI_ENV_JSON is not valid JSON, ignored'); }
}
if (process.env.WB_CLI_API_KEY) {
  cfg.cliEnv = Object.assign({}, cfg.cliEnv || {}, { CODEBUDDY_API_KEY: process.env.WB_CLI_API_KEY });
}

/**
 * This WorkBuddy install only ships the "lite-wb" bundle. The desktop app injects
 * CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 into its own child processes; a plain terminal
 * (double-clicking a .bat) has no such variable and the CLI fails with
 * "Cannot find module '../dist/codebuddy'". Set it explicitly for every CLI spawn.
 */
function cliEnv() {
  const env = Object.assign({}, process.env);
  const lite = cfg.cliLiteBundle === true ||
    (cfg.cliLiteBundle == null && /app\.asar\.unpacked[\\/]cli[\\/]/i.test(String(cfg.cliPath || '')));
  if (lite) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
  else delete env.CODEBUDDY_FORCE_LITE_WB_BUNDLE;
  env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';

  // These belong to the desktop agent session, not to a standalone CLI process.
  // Leaving them in makes the CLI use the desktop's local proxy / lite bundle.
  const strip = [
    'CODEBUDDY_ENV_FILE', 'CODEBUDDY_GATEWAY_AUTH', 'CODEBUDDY_GATEWAY_PASSWORD',
    'CODEBUDDY_GATEWAY_DISABLE_API_DOCS', 'CODEBUDDY_HOST', 'CODEBUDDY_HOST_CAPABILITIES',
    'CODEBUDDY_SERVICE_PROXY_URL', 'CODEBUDDY_SAFE_DELETE_REPORT_PATH',
    'CODEBUDDY_DOCUMENT_TOKEN', 'CODEBUDDY_API_KEY_HELPER_DISABLED',
    'WORKBUDDY_PAC_RPC_TOKEN', 'WORKBUDDY_VLM_AUTH_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
    'SERVER__HOST', 'SERVER__PORT'
  ];
  for (const k of strip) delete env[k];

  // Optional local overrides, e.g. CODEBUDDY_API_KEY to skip /login entirely.
  return Object.assign(env, cfg.cliEnv || {});
}

let cachedSkills = [];
let cachedIcons = {};
let lastSkillsJson = '';
let iconTick = 0;
let cliAuth = 'unknown';
let connected = false;
const running = new Map();      // taskId -> { child, timer, canceled }
const pendingLogs = new Map();  // taskId -> chunks[]
let flushTimer = null;

const log = (...a) => console.log('[' + new Date().toLocaleTimeString('zh-CN') + ']', ...a);

// ---------- skill discovery -------------------------------------------------
function parseFrontmatter(text) {
  const out = {};
  const m = text.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return out;
  let current = null;
  for (const raw of m[1].split(/\r?\n/)) {
    const kv = raw.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) { current = kv[1]; out[current] = kv[2].trim().replace(/^["']|["']$/g, ''); }
    else if (current && /^\s+\S/.test(raw)) out[current] += ' ' + raw.trim();
  }
  return out;
}
function readIcon(dir) {
  for (const name of ['_icon.png', '_icon.jpg', '_icon.jpeg', 'icon.png', 'icon.jpg']) {
    const f = path.join(dir, name);
    try {
      const stat = fs.statSync(f);
      if (stat.size > 120 * 1024) continue;
      return { mime: name.endsWith('.png') ? 'image/png' : 'image/jpeg', data: fs.readFileSync(f).toString('base64') };
    } catch (_) {}
  }
  return null;
}
function scanSkills() {
  const list = [];
  const icons = {};
  let dirCount = 0;
  for (const base of cfg.skillsDirs || []) {
    if (!base || !fs.existsSync(base)) continue;
    dirCount++;
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const dir = path.join(base, ent.name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      let text = '';
      try { text = fs.readFileSync(skillFile, 'utf8'); } catch (_) { continue; }
      const fm = parseFrontmatter(text);
      const id = ent.name;
      list.push({
        id,
        name: fm.name || id,
        description: fm.description || firstParagraph(text) || '',
        path: skillFile,
        source: path.basename(base) === 'skills' ? base : base,
        disableModelInvocation: /true/i.test(fm['disable-model-invocation'] || '')
      });
      const icon = readIcon(dir);
      if (icon) icons[id] = icon;
    }
  }
  // stable order
  list.sort((a, b) => a.id.localeCompare(b.id));
  cachedSkills = list;
  cachedIcons = icons;
  return dirCount;
}
function firstParagraph(text) {
  const body = text.replace(/^\s*---[\s\S]*?---\s*/, '');
  for (const line of body.split(/\r?\n/)) {
    const s = line.trim().replace(/^#+\s*/, '');
    if (s && !s.startsWith('---') && s.length > 6) return s.slice(0, 220);
  }
  return '';
}
function buildMeta() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    node: process.version,
    dirCount: (cfg.skillsDirs || []).filter(d => d && fs.existsSync(d)).length,
    cliPath: cfg.cliPath,
    cliExists: !!cfg.cliPath && fs.existsSync(cfg.cliPath),
    cliAuth,
    skillsCount: cachedSkills.length,
    dryRun: DRY_RUN,
    agentVersion: 1
  };
}

// ---------- hub communication ----------------------------------------------
function hubRoute(route) {
  // The published hub sits behind a sharecode gate; a headless agent has no cookie jar.
  const sep = route.includes('?') ? '&' : '?';
  return cfg.hubUrl + route + (cfg.shareCode ? sep + 'sharecode=' + encodeURIComponent(cfg.shareCode) : '');
}
async function post(route, body, timeoutMs) {
  const r = await fetch(hubRoute(route), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-agent-token': String(cfg.agentToken || '') },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs || 12000)
  });
  if (!r.ok) throw new Error(route + ' -> HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return r.json();
}
function queueLog(taskId, type, text) {
  if (!text) return;
  if (!pendingLogs.has(taskId)) pendingLogs.set(taskId, []);
  const arr = pendingLogs.get(taskId);
  arr.push({ type, text: String(text).slice(0, 4000), ts: Date.now() });
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  if (!flushTimer) flushTimer = setTimeout(flushLogs, 180);
}
async function flushLogs() {
  clearTimeout(flushTimer); flushTimer = null;
  for (const [taskId, chunks] of [...pendingLogs.entries()]) {
    pendingLogs.delete(taskId);
    try { await post('/api/agent/log', { taskId, chunks }, 10000); }
    catch (e) {
      const prev = pendingLogs.get(taskId) || [];
      pendingLogs.set(taskId, [...chunks, ...prev].slice(-500));
      log('log upload failed:', e.message);
    }
  }
  if (pendingLogs.size && !flushTimer) flushTimer = setTimeout(flushLogs, 1500);
}

// ---------- stream-json -> friendly log lines --------------------------------
function brief(input) {
  let s = '';
  try { s = typeof input === 'string' ? input : JSON.stringify(input || {}); } catch (_) { s = String(input); }
  s = s.replace(/\s+/g, ' ');
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}
function formatEvent(obj, taskId) {
  if (obj.type === 'system') {
    if (obj.subtype === 'init') queueLog(taskId, 'info', '会话已初始化' + (obj.model ? ' · 模型 ' + obj.model : ''));
    return;
  }
  if (obj.type === 'assistant') {
    const content = (obj.message && obj.message.content) || [];
    for (const item of content) {
      if (item.type === 'text' && item.text) queueLog(taskId, 'text', item.text);
      else if (item.type === 'tool_use') queueLog(taskId, 'tool', '⚙ 调用 ' + (item.name || '工具') + '  ' + brief(item.input));
      else if (item.type === 'thinking' && item.thinking) queueLog(taskId, 'log', '· 思考中…');
    }
    return;
  }
  if (obj.type === 'user') {
    const content = (obj.message && obj.message.content) || [];
    for (const item of content) {
      if (item.type === 'tool_result') {
        const c = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || '');
        queueLog(taskId, 'log', '   ↳ ' + brief(c));
      }
    }
    return;
  }
  if (obj.type === 'result') {
    const ok = obj.subtype === 'success' || obj.is_error === false;
    queueLog(taskId, ok ? 'result' : 'error', (ok ? '✓ ' : '✕ ') + brief(obj.result || obj.error || '结束'));
    return;
  }
  if (obj.type === 'error') queueLog(taskId, 'error', brief(obj.error || obj.message || '未知错误'));
}
function handleLine(taskId, line) {
  const s = line.trim();
  if (!s) return;
  if (/Authentication required|Authentication failed/i.test(s)) {
    cliAuth = false;
    const ctx = running.get(taskId);
    if (ctx) ctx.authFailed = true;   // only THIS run failed auth; never rely on stale cached state
    queueLog(taskId, 'error', '命令行尚未登录：请在执行端电脑双击 login-cli.bat，输入 /login 完成一次登录，登录后 30 秒内自动生效。');
    queueLog(taskId, 'error', s);
    return;
  }
  if (s.startsWith('{')) {
    try { formatEvent(JSON.parse(s), taskId); return; } catch (_) {}
  }
  if (/^\[/.test(s) && /debug|verbose/i.test(s)) return;
  queueLog(taskId, 'log', s.slice(0, 2000));
}

// ---------- task execution ---------------------------------------------------
async function finish(taskId, status, extra) {
  running.delete(taskId);
  await flushLogs();
  for (let i = 0; i < 3; i++) {
    try { await post('/api/agent/finish', Object.assign({ taskId, status }, extra || {}), 10000); return; }
    catch (e) { log('finish upload failed, retry', i + 1, e.message); await new Promise(r => setTimeout(r, 1200)); }
  }
}
function killTask(taskId) {
  const r = running.get(taskId);
  if (!r) return;
  r.canceled = true;
  queueLog(taskId, 'warn', '收到停止请求，正在终止进程…');
  try { r.child && r.child.kill(); } catch (_) {}
  clearTimeout(r.timer);
}

function runTask(task) {
  if (running.has(task.id)) return;
  const taskId = task.id;
  queueLog(taskId, 'info', '执行端已领取任务，开始启动技能');

  const model = task.model || cfg.defaultModel || '';
  queueLog(taskId, 'info', '运行模型：' + (model || '（CLI 内置默认）'));

  const ctx = { child: null, timer: null, canceled: false };
  running.set(taskId, ctx);
  ctx.timer = setTimeout(() => {
    queueLog(taskId, 'warn', '任务超时，正在终止');
    ctx.timedOut = true;
    try { ctx.child && ctx.child.kill(); } catch (_) {}
  }, Math.max(60000, Number(task.timeoutMs) || 900000));

  if (DRY_RUN) {
    // Link self-test only: never calls the CLI, never touches real skills.
    const steps = [
      ['info', '自检模式：模拟执行（未调用命令行、未运行真实技能）'],
      ['info', '已读取技能文档路径'],
      ['tool', '⚙ 调用 Read  {"file_path":"<SKILL.md>"}'],
      ['log', '   ↳ 技能文档已加载'],
      ['text', '自检通过：云端 → 执行端 → 日志回传链路正常。'],
      ['result', '✓ 自检完成']
    ];
    let i = 0;
    const t = setInterval(() => {
      if (i >= steps.length) {
        clearInterval(t); clearTimeout(ctx.timer);
        finish(taskId, 'success', { exitCode: 0 });
      } else queueLog(taskId, steps[i][0], steps[i++][1]);
    }, 260);
    ctx.child = { kill: () => { clearInterval(t); clearTimeout(ctx.timer); finish(taskId, 'canceled', {}); } };
    return;
  }

  if (!cfg.cliPath || !fs.existsSync(cfg.cliPath)) {
    clearTimeout(ctx.timer);
    queueLog(taskId, 'error', '找不到本机命令行程序，请检查 agent/config.json 里的 cliPath');
    return finish(taskId, 'failed', { error: 'CLI not found: ' + cfg.cliPath });
  }

  const args = [
    cfg.cliPath, '-p', task.prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', cfg.permissionMode || 'dontAsk',
    '--port', '0', '--no-session-persistence'
  ];
  const KB_MODELS = ['fast-model','balanced-model','deep-model','hy4free','hy4std','hy3','hy3-x','deepseek-v4.1-flash','glm-5.3','glm-5.3-flash','glm-5.2','space-bunny','minimax-m3.1-flash','kimi-k3.1-pro','kimi-k3-1','kimi-k2.8-preview','deepseek-v4-pro','step-5-preview','mimo-v2.6-pro'];
  if (model && KB_MODELS.includes(model)) args.push('--model', model);
  let child;
  try {
    child = cp.spawn(process.execPath, args, {
      cwd: cfg.workDir || process.cwd(),
      env: cliEnv(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) {
    clearTimeout(ctx.timer);
    queueLog(taskId, 'error', '启动命令行失败：' + e.message);
    return finish(taskId, 'failed', { error: e.message });
  }
  ctx.child = child;
  let outBuf = '', errBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    outBuf += chunk;
    let idx;
    while ((idx = outBuf.indexOf('\n')) >= 0) {
      const line = outBuf.slice(0, idx); outBuf = outBuf.slice(idx + 1);
      handleLine(taskId, line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errBuf += chunk;
    let idx;
    while ((idx = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, idx); errBuf = errBuf.slice(idx + 1);
      if (line.trim()) handleLine(taskId, line);
    }
  });
  child.on('error', (e) => queueLog(taskId, 'error', '进程错误：' + e.message));
  child.on('close', (code) => {
    clearTimeout(ctx.timer);
    if (outBuf.trim()) handleLine(taskId, outBuf);
    if (errBuf.trim()) handleLine(taskId, errBuf);
    if (ctx.canceled) return finish(taskId, 'canceled', { exitCode: code });
    if (ctx.timedOut) return finish(taskId, 'failed', { exitCode: code, error: '任务超时' });
    // Use the auth result of THIS run, not the cached probe: the user may have
    // just completed /login while the cached status is still stale.
    if (ctx.authFailed) return finish(taskId, 'failed', { exitCode: code, error: '命令行未登录，请先执行 login-cli.bat 完成 /login' });
    if (code === 0) cliAuth = true;
    finish(taskId, code === 0 ? 'success' : 'failed', { exitCode: code, error: code === 0 ? '' : '进程退出码 ' + code });
  });
}

// ---------- CLI sign-in probe (non-blocking) --------------------------------
let probing = false;
function probeCli() {
  if (probing) return;
  if (DRY_RUN) { cliAuth = 'dry-run'; return; }
  if (!cfg.cliPath || !fs.existsSync(cfg.cliPath)) { cliAuth = 'unknown'; return; }
  probing = true;
  const args = [cfg.cliPath, '-p', 'Reply with exactly: OK', '--output-format', 'text',
    '--permission-mode', cfg.permissionMode || 'dontAsk', '--port', '0', '--no-session-persistence'];
  let out = '', settled = false, child = null, timer = null;
  const done = (v) => {
    if (settled) return;
    settled = true; probing = false; clearTimeout(timer); cliAuth = v;
    log('命令行登录状态：' + (v === false ? '未登录（请先运行 login-cli.bat 完成 /login）' : v === true ? '已登录' : '未验证'));
  };
  timer = setTimeout(() => { try { child && child.kill(); } catch (_) {} done('unknown'); }, 45000);
  try {
    child = cp.spawn(process.execPath, args, {
      cwd: cfg.workDir || process.cwd(), env: cliEnv(), windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (e) { return done('unknown'); }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => { out += d; if (/Authentication required|Authentication failed/i.test(out)) done(false); });
  child.stderr.on('data', d => { out += d; });
  child.on('error', () => done('unknown'));
  child.on('close', () => done(/Authentication required|Authentication failed/i.test(out) ? false : true));
}

// ---------- main loop --------------------------------------------------------
let pollFailures = 0;
async function poll() {
  const payload = {
    skills: cachedSkills,
    meta: buildMeta()
  };
  // Re-send icons periodically so a restarted hub can recover them.
  if (iconTick++ % 20 === 0) payload.icons = cachedIcons;
  const data = await post('/api/agent/poll', payload, 12000);
  if (!connected) { connected = true; log('已连接工作台：' + cfg.hubUrl); }
  pollFailures = 0;
  for (const id of data.cancels || []) killTask(id);
  for (const t of data.tasks || []) runTask(t);
}
async function loop() {
  while (true) {
    try { await poll(); }
    catch (e) {
      if (connected) { connected = false; log('与工作台断开：' + e.message); }
      pollFailures++;
      if (pollFailures % 10 === 1) log('等待工作台…（' + cfg.hubUrl + '）');
    }
    await new Promise(r => setTimeout(r, Math.min(5000, Number(cfg.pollIntervalMs) || 1200)));
  }
}

const dirCount = scanSkills();
log('技能扫描完成：发现 ' + cachedSkills.length + ' 个技能，扫描目录 ' + dirCount + ' 个');
cachedSkills.forEach(s => log('  · ' + s.id));
log('工作台：' + cfg.hubUrl + (process.env.WB_LOCAL_MODE === '1' ? '  [本机模式]' : '') + (DRY_RUN ? '  [自检模式]' : ''));
if (!cfg.cliPath || !fs.existsSync(cfg.cliPath)) log('⚠ 未找到命令行程序，请检查 config.json 的 cliPath');
setInterval(() => {
  const before = JSON.stringify(cachedSkills.map(s => s.id + s.name + s.description));
  scanSkills();
  const after = JSON.stringify(cachedSkills.map(s => s.id + s.name + s.description));
  if (before !== after) { lastSkillsJson = ''; iconTick = 0; log('技能列表已更新：' + cachedSkills.length + ' 个'); }
}, Math.max(5000, Number(cfg.rescanIntervalMs) || 30000));
// Re-probe quickly while signed out so a fresh /login takes effect within ~30s.
// Once signed in, back off to 10min to avoid spawning a model call every half minute.
setTimeout(probeCli, 1500);
setTimeout(function scheduleProbe() {
  probeCli();
  setTimeout(scheduleProbe, cliAuth === false ? 30 * 1000 : 10 * 60 * 1000);
}, 45 * 1000);
loop();
