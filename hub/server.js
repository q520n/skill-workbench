'use strict';
/**
 * Skill Workbench - Cloud Hub
 * A single-port HTTP service for the team-facing workbench.
 * The machine that owns the skills runs agent/agent.js and connects OUT to this hub.
 * No third-party dependencies.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PORT = Number(process.env.PORT || 7788);
const HOST = process.env.HOST || '0.0.0.0';
const AGENT_OFFLINE_MS = 12000;

// Result-files panel: in local mode the hub and the agent run on the same box,
// so the hub can serve the agent's workDir directly. Override with WB_FILES_ROOT.
const FILES_ROOT = (() => {
  const r = process.env.WB_FILES_ROOT ? path.resolve(process.env.WB_FILES_ROOT) : path.resolve(ROOT, '..', '..');
  return r;
})();
const TEXT_EXT = new Set(['.txt', '.json', '.csv', '.tsv', '.md', '.log', '.js', '.ts', '.tsx', '.py', '.html', '.htm', '.xml', '.yaml', '.yml', '.css', '.ini', '.conf', '.sh', '.bat', '.ps1', '.sql', '.gitignore', '.env', '.toml']);
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
function safeResolve(rel) {
  const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const target = path.resolve(FILES_ROOT, clean);
  const root = path.resolve(FILES_ROOT);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}
function imgMime(ext) {
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml' })[ext] || 'image/png';
}

// Models accepted by the project-bundled CLI (--model). Kept in sync with `codebuddy --help`.
const MODELS = ['fast-model', 'balanced-model', 'deep-model', 'hy4free', 'hy4std', 'hy3', 'hy3-x', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'space-bunny', 'minimax-m3.1-flash', 'kimi-k3.1-pro', 'kimi-k3-1', 'kimi-k2.8-preview', 'deepseek-v4-pro', 'step-5-preview', 'mimo-v2.6-pro'];
const isModel = (m) => typeof m === 'string' && MODELS.includes(m);

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); return true; }
  catch (e) { console.error('[hub] cannot persist', path.basename(file), e.message); return false; }
}

const DEFAULT_CONFIG = {
  version: 1,
  agentToken: 'wb-agent-skillhub-20261104',
  accessPassword: '',
  skills: {},
  settings: { maxConcurrent: 2, runTimeoutMs: 900000 },
  defaultModel: ''
};

let config = Object.assign({}, DEFAULT_CONFIG, readJson(CONFIG_FILE, {}));
config.settings = Object.assign({}, DEFAULT_CONFIG.settings, config.settings || {});
config.skills = config.skills || {};
if (!config.agentToken) config.agentToken = DEFAULT_CONFIG.agentToken;
let history = readJson(HISTORY_FILE, []);
if (!Array.isArray(history)) history = [];

const state = {
  agent: { online: false, lastSeen: 0, meta: {}, skills: [] },
  icons: new Map(),
  tasks: new Map(),
  queue: [],
  cancels: new Set(),
  globalSubs: new Set(),
  taskSubs: new Map()
};

const now = () => Date.now();
const uid = (p) => p + '-' + crypto.randomBytes(5).toString('hex');

function emitGlobal(type, payload) {
  const msg = 'data: ' + JSON.stringify({ type, payload, ts: now() }) + '\n\n';
  for (const res of state.globalSubs) { try { res.write(msg); } catch (_) {} }
}
function emitTask(taskId, chunk) {
  const subs = state.taskSubs.get(taskId);
  if (!subs) return;
  const msg = 'data: ' + JSON.stringify(chunk) + '\n\n';
  for (const res of subs) { try { res.write(msg); } catch (_) {} }
}
function addLog(task, chunk) {
  const line = { type: chunk.type || 'log', text: String(chunk.text ?? ''), ts: chunk.ts || now() };
  task.logs.push(line);
  if (task.logs.length > 3000) task.logs.splice(0, task.logs.length - 3000);
  emitTask(task.id, { kind: 'log', line });
}
function openSse(req, res, subs) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  subs.add(res);
  const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
  req.on('close', () => { clearInterval(timer); subs.delete(res); });
}

function guessEmoji(id) {
  const s = String(id).toLowerCase();
  if (/oa|approval|审批/.test(s)) return '\uD83D\uDCCB';
  if (/watermark|去水印/.test(s)) return '\uD83E\uDDFD';
  if (/jtbd|voc/.test(s)) return '\uD83C\uDFAF';
  if (/browser|cdp|浏览器/.test(s)) return '\uD83C\uDF10';
  if (/dingtalk|钉钉|bot/.test(s)) return '\uD83E\uDD16';
  if (/hub|工作台/.test(s)) return '\uD83C\uDFE0';
  if (/pdf|doc|文档/.test(s)) return '\uD83D\uDCDA';
  if (/image|图片|ppt/.test(s)) return '\uD83C\uDFA8';
  return '\uD83E\uDDE9';
}

function mergedSkills() {
  return (state.agent.skills || []).map((s, i) => {
    const c = config.skills[s.id] || {};
    return {
      id: s.id,
      name: s.name || s.id,
      title: c.title || s.name || s.id,
      description: s.description || '',
      group: c.group || '未分组',
      emoji: c.emoji || guessEmoji(s.id),
      enabled: c.enabled !== false,
      order: typeof c.order === 'number' ? c.order : i,
      params: Array.isArray(c.params) ? c.params : [],
      promptTemplate: c.promptTemplate || '',
      hasIcon: state.icons.has(s.id),
      path: s.path || '',
      source: s.source || ''
    };
  }).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'zh-CN'));
}

function activeTasks() {
  return [...state.tasks.values()]
    .filter(t => ['queued', 'dispatched', 'running'].includes(t.status))
    .sort((a, b) => b.createdAt - a.createdAt);
}
function publicTask(t) {
  return {
    id: t.id, skillId: t.skillId, skillTitle: t.skillTitle, status: t.status,
    createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    exitCode: t.exitCode, error: t.error, logCount: t.logs.length
  };
}

function finishTask(t, status, extra) {
  if (!['queued', 'dispatched', 'running'].includes(t.status)) return;
  t.status = status;
  t.finishedAt = now();
  Object.assign(t, extra || {});
  addLog(t, { type: 'status', text: status === 'success' ? '✓ 运行完成' : status === 'canceled' ? '■ 已停止' : '✕ 运行结束（' + status + '）' });
  emitTask(t.id, { kind: 'done', task: publicTask(t) });
  emitGlobal('task-finished', { task: publicTask(t) });
  history.unshift({
    id: t.id, skillId: t.skillId, skillTitle: t.skillTitle, status,
    createdAt: t.createdAt, startedAt: t.startedAt, finishedAt: t.finishedAt,
    exitCode: t.exitCode, error: t.error || '', params: t.params || {},
    logs: t.logs.slice(-200)
  });
  history = history.slice(0, 60);
  writeJson(HISTORY_FILE, history);
  setTimeout(() => state.tasks.delete(t.id), 10 * 60 * 1000);
}

function buildPrompt(skill, params) {
  const extras = Object.entries(params || {})
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => '- ' + k + '：' + String(v).trim()).join('\n');
  const tpl = skill.promptTemplate ||
    '请执行技能「{name}」。\n技能文档：{path}\n请先用 Read 工具阅读该技能文档，然后严格按文档中的流程完成任务。\n{params}';
  return tpl
    .replace(/\{name\}/g, skill.name)
    .replace(/\{path\}/g, skill.path || '')
    .replace(/\{params\}/g, extras ? '\n' + extras + '\n' : '')
    .trim();
}

// ---- HTTP helpers ----------------------------------------------------------
function sendJson(res, code, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  }, extraHeaders || {}));
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 2 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(parts).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function passwordOk(req, url) {
  if (!config.accessPassword) return true;
  const given = req.headers['x-access-password'] || url.searchParams.get('pwd') || '';
  return String(given) === String(config.accessPassword);
}
function agentOk(req, url) {
  const given = req.headers['x-agent-token'] || url.searchParams.get('agentToken') || '';
  return String(given) === String(config.agentToken);
}
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (rel.includes('..') || rel.includes('\\')) return sendJson(res, 403, { error: 'forbidden' });
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

// ---- Router ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;

  if (req.method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, agentOnline: state.agent.online, version: 1 });
  }

  // Agent relay endpoints (token protected, never exposed to browser users)
  if (p.startsWith('/api/agent/')) {
    if (!agentOk(req, url)) return sendJson(res, 401, { error: 'bad agent token' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }

    if (p === '/api/agent/poll' && req.method === 'POST') {
      state.agent.lastSeen = now();
      const wasOnline = state.agent.online;
      state.agent.online = true;
      state.agent.meta = body.meta || {};
      if (Array.isArray(body.skills)) state.agent.skills = body.skills;
      if (body.icons && typeof body.icons === 'object') {
        for (const [id, icon] of Object.entries(body.icons)) {
          if (icon && icon.data && icon.mime) state.icons.set(id, { mime: icon.mime, data: icon.data });
        }
      }
      if (!wasOnline) emitGlobal('agent-online', { meta: state.agent.meta });

      let running = 0;
      for (const t of state.tasks.values()) if (['dispatched', 'running'].includes(t.status)) running++;
      const slots = Math.max(0, (config.settings.maxConcurrent || 2) - running);
      const dispatch = [];
      while (dispatch.length < slots && state.queue.length) {
        const t = state.queue.shift();
        if (!['queued'].includes(t.status)) continue;
        t.status = 'dispatched';
        t.dispatchedAt = now();
        addLog(t, { type: 'info', text: '已派发到执行端，等待本机命令行启动…' });
        dispatch.push({ id: t.id, prompt: t.prompt, timeoutMs: config.settings.runTimeoutMs || 900000, model: t.model || config.defaultModel || '' });
        emitGlobal('task-started', { task: publicTask(t) });
      }
      const cancels = [...state.cancels];
      state.cancels.clear();
      return sendJson(res, 200, { serverTime: now(), tasks: dispatch, cancels });
    }

    if (p === '/api/agent/log' && req.method === 'POST') {
      const t = state.tasks.get(body.taskId);
      if (!t) return sendJson(res, 404, { error: 'task not found' });
      if (t.status === 'dispatched') {
        t.status = 'running';
        t.startedAt = t.startedAt || now();
        emitGlobal('task-running', { task: publicTask(t) });
      }
      const chunks = Array.isArray(body.chunks) ? body.chunks : [];
      for (const c of chunks) addLog(t, c);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/agent/finish' && req.method === 'POST') {
      const t = state.tasks.get(body.taskId);
      if (!t) return sendJson(res, 404, { error: 'task not found' });
      finishTask(t, body.status || 'failed', { exitCode: body.exitCode, error: body.error || '' });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'unknown agent endpoint' });
  }

  if (p.startsWith('/api/')) {
    if (!passwordOk(req, url)) return sendJson(res, 401, { error: '需要访问口令' });

    if (p === '/api/bootstrap' && req.method === 'GET') {
      return sendJson(res, 200, {
        agent: {
          online: state.agent.online,
          lastSeen: state.agent.lastSeen,
          meta: state.agent.meta,
          skillsCount: (state.agent.skills || []).length
        },
        skills: mergedSkills(),
        groups: [...new Set(mergedSkills().map(s => s.group))],
        config: { settings: config.settings, hasPassword: !!config.accessPassword, defaultModel: config.defaultModel || '', models: MODELS, filesRoot: FILES_ROOT },
        tasks: activeTasks().map(publicTask),
        history: history.slice(0, 30).map(h => Object.assign({}, h, { logs: undefined }))
      });
    }

    if (p === '/api/config' && req.method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      if (body.skills && typeof body.skills === 'object') config.skills = body.skills;
      if (body.settings && typeof body.settings === 'object') {
        config.settings = Object.assign({}, config.settings, {
          maxConcurrent: Math.min(8, Math.max(1, Number(body.settings.maxConcurrent) || 2)),
          runTimeoutMs: Math.max(60000, Number(body.settings.runTimeoutMs) || 900000)
        });
      }
      if (Object.prototype.hasOwnProperty.call(body, 'defaultModel')) config.defaultModel = isModel(body.defaultModel) ? body.defaultModel : '';
      if (Object.prototype.hasOwnProperty.call(body, 'accessPassword')) {
        config.accessPassword = String(body.accessPassword || '');
      }
      writeJson(CONFIG_FILE, config);
      emitGlobal('config-changed', {});
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/run' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const skill = mergedSkills().find(s => s.id === body.skillId);
      if (!skill) return sendJson(res, 404, { error: '技能不存在或执行端尚未同步' });
      if (!skill.enabled) return sendJson(res, 403, { error: '该技能已被停用' });
      if (!state.agent.online) return sendJson(res, 503, { error: '执行端离线：运行工作台的电脑需要启动执行端后台' });
      const model = isModel(body.model) ? body.model : '';
      const t = {
        id: uid('run'), skillId: skill.id, skillTitle: skill.title,
        prompt: buildPrompt(skill, body.params), params: body.params || {}, model,
        status: 'queued', logs: [], createdAt: now(), startedAt: 0, finishedAt: 0
      };
      addLog(t, { type: 'info', text: '任务已创建，等待执行端领取…' });
      addLog(t, { type: 'prompt', text: t.prompt });
      state.tasks.set(t.id, t);
      state.queue.push(t);
      emitGlobal('task-queued', { task: publicTask(t) });
      return sendJson(res, 200, { taskId: t.id });
    }

    if (p === '/api/task/stop' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      const t = state.tasks.get(body.taskId);
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      if (t.status === 'queued') {
        state.queue = state.queue.filter(x => x.id !== t.id);
        finishTask(t, 'canceled', {});
      } else if (['dispatched', 'running'].includes(t.status)) {
        state.cancels.add(t.id);
        addLog(t, { type: 'warn', text: '正在请求停止…' });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/task/logs' && req.method === 'GET') {
      const t = state.tasks.get(url.searchParams.get('id') || '') || history.find(h => h.id === url.searchParams.get('id'));
      if (!t) return sendJson(res, 404, { error: '任务不存在' });
      return sendJson(res, 200, { logs: t.logs || [], task: t.status ? publicTask(t) : null });
    }

    if (p === '/api/files' && req.method === 'GET') {
      const rel = url.searchParams.get('dir') || '';
      const dir = safeResolve(rel);
      if (!dir) return sendJson(res, 400, { error: '非法路径' });
      let entries;
      try {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        entries = items.filter(it => !it.name.startsWith('.')).map(it => {
          const fp = path.join(dir, it.name);
          let size = 0, mtime = 0, isDir = it.isDirectory();
          try { const st = fs.statSync(fp); size = st.size; mtime = st.mtimeMs; isDir = st.isDirectory(); } catch (_) {}
          const ext = isDir ? '' : path.extname(it.name).toLowerCase();
          const kind = isDir ? 'dir' : (IMG_EXT.has(ext) ? 'image' : (TEXT_EXT.has(ext) || ext === '' ? 'text' : 'binary'));
          return { name: it.name, isDir, size, mtime, ext, kind };
        });
        entries.sort((a, b) => (a.isDir === b.isDir) ? a.name.localeCompare(b.name, 'zh-CN') : (a.isDir ? -1 : 1));
      } catch (e) { return sendJson(res, 500, { error: '读取目录失败：' + e.message }); }
      const parentRel = rel ? rel.replace(/[/\\][^/\\]+$/, '') : '';
      return sendJson(res, 200, { path: rel, parent: parentRel, entries, root: FILES_ROOT });
    }

    if (p === '/api/file' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const fp = safeResolve(rel);
      if (!fp) return sendJson(res, 400, { error: '非法路径' });
      let st;
      try { st = fs.statSync(fp); } catch (_) { return sendJson(res, 404, { error: '文件不存在' }); }
      if (st.isDirectory()) return sendJson(res, 400, { error: '这是目录' });
      const ext = path.extname(fp).toLowerCase();
      const download = url.searchParams.get('download') === '1';
      if (download) {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(fp)) + '"',
          'Content-Length': st.size,
          'Cache-Control': 'no-store'
        });
        return fs.createReadStream(fp).pipe(res);
      }
      if (IMG_EXT.has(ext)) {
        res.writeHead(200, { 'Content-Type': imgMime(ext), 'Cache-Control': 'no-store' });
        return fs.createReadStream(fp).pipe(res);
      }
      if (TEXT_EXT.has(ext) || ext === '') {
        const max = 1.5 * 1024 * 1024;
        const realSize = st.size;
        const slice = Math.min(realSize, max);
        let content = '';
        try {
          const buf = Buffer.alloc(slice);
          const fd = fs.openSync(fp, 'r');
          try { fs.readSync(fd, buf, 0, slice, 0); } finally { fs.closeSync(fd); }
          content = buf.toString('utf8');
        } catch (e) { return sendJson(res, 500, { error: '读取文件失败：' + e.message }); }
        return sendJson(res, 200, { kind: 'text', name: path.basename(fp), size: realSize, truncated: realSize > max, content });
      }
      return sendJson(res, 200, { kind: 'binary', name: path.basename(fp), size: st.size });
    }

    if (p === '/api/events' && req.method === 'GET') {
      const subs = state.globalSubs;
      return openSse(req, res, subs);
    }
    if (p === '/api/task/stream' && req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      if (!state.taskSubs.has(id)) state.taskSubs.set(id, new Set());
      const subs = state.taskSubs.get(id);
      openSse(req, res, subs);
      const t = state.tasks.get(id);
      if (t) {
        const backfill = t.logs.slice(-300);
        res.write('data: ' + JSON.stringify({ kind: 'backfill', lines: backfill }) + '\n\n');
        if (!['queued', 'dispatched', 'running'].includes(t.status)) {
          res.write('data: ' + JSON.stringify({ kind: 'done', task: publicTask(t) }) + '\n\n');
        }
      }
      return;
    }
    if (p.startsWith('/api/icon/') && req.method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/icon/'.length));
      const icon = state.icons.get(id);
      if (!icon) return sendJson(res, 404, { error: 'no icon' });
      try {
        const buf = Buffer.from(icon.data, 'base64');
        res.writeHead(200, { 'Content-Type': icon.mime, 'Cache-Control': 'public, max-age=3600' });
        return res.end(buf);
      } catch (_) { return sendJson(res, 404, { error: 'bad icon' }); }
    }
    return sendJson(res, 404, { error: 'unknown endpoint' });
  }

  if (req.method === 'GET') return serveStatic(res, p);
  return sendJson(res, 405, { error: 'method not allowed' });
});

// ---- Housekeeping ----------------------------------------------------------
setInterval(() => {
  if (state.agent.online && state.agent.lastSeen && now() - state.agent.lastSeen > AGENT_OFFLINE_MS) {
    state.agent.online = false;
    emitGlobal('agent-offline', {});
    for (const t of state.tasks.values()) {
      if (['dispatched', 'running'].includes(t.status)) finishTask(t, 'failed', { error: '执行端离线，任务中断' });
    }
  }
  for (const t of state.tasks.values()) {
    const limit = (config.settings.runTimeoutMs || 900000) + 120000;
    if (['queued', 'dispatched', 'running'].includes(t.status) && now() - t.createdAt > limit) {
      finishTask(t, 'failed', { error: '任务超时' });
      state.cancels.add(t.id);
    }
  }
}, 3000);

server.listen(PORT, HOST, () => {
  console.log('[hub] Skill Workbench hub listening on http://' + HOST + ':' + PORT);
  console.log('[hub] agent token configured:', !!config.agentToken, '| access password:', config.accessPassword ? 'ON' : 'OFF');
});
