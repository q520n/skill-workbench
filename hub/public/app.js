'use strict';
/* Skill Workbench - front end */
const MODELS = ['fast-model','balanced-model','deep-model','hy4free','hy4std','hy3','hy3-x','deepseek-v4.1-flash','glm-5.3','glm-5.3-flash','glm-5.2','space-bunny','minimax-m3.1-flash','kimi-k3.1-pro','kimi-k3-1','kimi-k2.8-preview','deepseek-v4-pro','step-5-preview','mimo-v2.6-pro'];
const MODEL_LABELS = { 'fast-model':'快速模型','balanced-model':'均衡模型','deep-model':'深度模型','hy4free':'混元4 免费','hy4std':'混元4 标准','hy3':'混元3','hy3-x':'混元3 增强','deepseek-v4.1-flash':'DeepSeek V4.1 快','glm-5.3':'智谱 GLM-5.3','glm-5.3-flash':'智谱 GLM-5.3 快','glm-5.2':'智谱 GLM-5.2','space-bunny':'SpaceBunny','minimax-m3.1-flash':'MiniMax M3.1 快','kimi-k3.1-pro':'Kimi K3.1 Pro','kimi-k3-1':'Kimi K3.1','kimi-k2.8-preview':'Kimi K2.8 预览','deepseek-v4-pro':'DeepSeek V4 Pro','step-5-preview':'Step-5 预览','mimo-v2.6-pro':'MiMo V2.6 Pro' };
const $ = (id) => document.getElementById(id);
const S = {
  boot: null, group: '全部', keyword: '', skills: [], view: 'skills',
  currentSkill: null, taskId: null, taskSource: null, globalSource: null,
  logCount: 0, pwd: localStorage.getItem('wb_pwd') || '', refreshTimer: null
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hhmmss(ts) {
  const d = new Date(ts || Date.now());
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}
function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
function toast(msg, ms) {
  const el = $('toast');
  el.textContent = msg; el.classList.remove('hidden');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('hidden'), ms || 2600);
}

async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (S.pwd) headers['x-access-password'] = S.pwd;
  const r = await fetch(path, Object.assign({}, opts, { headers }));
  let data = {};
  try { data = await r.json(); } catch (_) {}
  if (r.status === 401) { openPassword(); throw new Error('需要访问口令'); }
  if (!r.ok) throw new Error(data.error || ('请求失败 ' + r.status));
  return data;
}
const sseUrl = (p) => p + (S.pwd ? (p.includes('?') ? '&' : '?') + 'pwd=' + encodeURIComponent(S.pwd) : '');

// ---------- bootstrap & realtime ----------
async function loadBootstrap(quiet) {
  try {
    S.boot = await api('/api/bootstrap');
    S.skills = S.boot.skills || [];
    renderAll();
  } catch (e) {
    if (!quiet) toast(e.message);
    if (e.message !== '需要访问口令') {
      $('agentBadgeText').textContent = '连接失败';
      $('agentBadge').className = 'badge badge-off';
    }
  }
}
function scheduleRefresh() {
  clearTimeout(S.refreshTimer);
  S.refreshTimer = setTimeout(() => loadBootstrap(true), 350);
}
function connectEvents() {
  if (S.globalSource) S.globalSource.close();
  const es = new EventSource(sseUrl('/api/events'));
  S.globalSource = es;
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'agent-online') toast('执行端已连接');
    if (msg.type === 'agent-offline') toast('执行端已离线，技能暂时无法运行', 4000);
    if (msg.type === 'task-finished' && msg.payload && msg.payload.task) {
      const t = msg.payload.task;
      toast(t.skillTitle + '：' + ({ success: '运行完成', failed: '运行失败', canceled: '已停止' }[t.status] || t.status));
    }
    scheduleRefresh();
  };
  es.onerror = () => { /* browser auto-reconnects */ };
}

function renderAll() {
  if (!S.boot) return;
  const b = S.boot;
  const badge = $('agentBadge');
  badge.className = 'badge ' + (b.agent.online ? 'badge-on' : 'badge-off');
  $('agentBadgeText').textContent = b.agent.online ? '执行端在线' : '执行端离线';
  const meta = b.agent.meta || {};
  const needLogin = b.agent.online && meta.cliAuth === false;
  $('footAgent').innerHTML = b.agent.online
    ? '已连接 · ' + esc(meta.hostname || '本机') + '<br>技能目录 ' + (meta.dirCount || 0) + ' 个 · CLI ' + (needLogin ? '<span style="color:#d97706">待登录</span>' : (meta.cliExists ? '已就绪' : '未找到'))
    : '未连接。需在技能所在电脑启动执行端后台。';
  $('statSkills').textContent = S.skills.length;
  $('statEnabled').textContent = S.skills.filter(s => s.enabled).length;
  $('notice').classList.toggle('hidden', b.agent.online && !needLogin);
  if (!b.agent.online) {
    $('notice').innerHTML = '<b>执行端未连接</b>：本机模式请双击项目根目录的 <code>start-local.bat</code>（会同时启动页面与执行端）。页面与技能列表仍可正常浏览。';
  } else if (needLogin) {
    $('notice').innerHTML = '<b>命令行尚未认证，技能暂时无法运行</b>：本工作台使用项目内安装的完整版 CLI。双击 <code>agent/login-cli.bat</code>（桌面那份也可以），窗口会自动输入 <code>/login</code> → 浏览器完成账号授权 → 回到窗口输入 <code>/exit</code>，脚本自动验证。<b>只需做一次</b>，约 30 秒后生效；也可用 <code>check-login.bat</code> 复查。不想登录的话，把 API Key 写进 <code>local/api-key.txt</code> 后重启 <code>start-local.bat</code> 即可免登录。';
  }
  renderGroups();
  renderCards();
  renderSidebar();
}

function renderGroups() {
  const counts = { '全部': S.skills.length };
  S.skills.forEach(s => { counts[s.group] = (counts[s.group] || 0) + 1; });
  const groups = ['全部', ...Object.keys(counts).filter(g => g !== '全部')];
  if (!groups.includes(S.group)) S.group = '全部';
  $('groupNav').innerHTML = groups.map(g =>
    '<button class="group-item ' + (g === S.group ? 'active' : '') + '" data-group="' + esc(g) + '">' +
    '<span class="g-ico">' + (g === '全部' ? '▦' : '◈') + '</span><span class="g-name">' + esc(g) + '</span>' +
    '<span class="g-num">' + (counts[g] || 0) + '</span></button>').join('');
  $('groupNav').querySelectorAll('.group-item').forEach(el => el.onclick = () => { S.group = el.dataset.group; renderGroups(); renderCards(); });
  $('pageTitle').textContent = S.group === '全部' ? '全部技能' : S.group;
  $('pageDesc').textContent = S.group === '全部' ? '点击卡片上的「运行」按钮，即可把技能交给本机执行' : '分组：' + S.group;
}

function renderCards() {
  const kw = S.keyword.trim().toLowerCase();
  const list = S.skills.filter(s => {
    if (S.group !== '全部' && s.group !== S.group) return false;
    if (!kw) return true;
    return (s.title + ' ' + s.name + ' ' + s.description + ' ' + s.group + ' ' + s.id).toLowerCase().includes(kw);
  });
  $('skillGrid').innerHTML = list.map(s => {
    const icon = s.hasIcon ? '<img src="/api/icon/' + encodeURIComponent(s.id) + (S.pwd ? '?pwd=' + encodeURIComponent(S.pwd) : '') + '" alt="">' : esc(s.emoji);
    return '<article class="card ' + (s.enabled ? '' : 'disabled') + '">' +
      '<div class="card-top"><div class="card-icon">' + icon + '</div><div class="card-head-text">' +
      '<div class="card-title" title="' + esc(s.title) + '">' + esc(s.title) + '</div>' +
      '<span class="card-group">' + esc(s.group) + '</span></div></div>' +
      '<div class="card-desc" title="' + esc(s.description) + '">' + esc(s.description || '暂无说明') + '</div>' +
      '<div class="card-foot"><span class="card-id" title="' + esc(s.id) + '">' + esc(s.id) + '</span>' +
      '<button class="btn btn-ghost btn-sm" data-open="' + esc(s.id) + '" title="查看参数与配置">参数</button>' +
      '<button class="btn btn-primary btn-sm" data-run="' + esc(s.id) + '" ' + (s.enabled ? '' : 'disabled') + '>▷ 运行</button>' +
      '</div></article>';
  }).join('');
  $('skillGrid').querySelectorAll('[data-run]').forEach(el => el.onclick = () => {
    const sk = S.skills.find(x => x.id === el.dataset.run);
    if (sk) { openDrawer(sk); startRun(sk, defaultsOf(sk)); }
  });
  $('skillGrid').querySelectorAll('[data-open]').forEach(el => el.onclick = () => {
    const sk = S.skills.find(x => x.id === el.dataset.open);
    if (sk) openDrawer(sk);
  });
  const empty = list.length === 0;
  $('emptyState').classList.toggle('hidden', !empty);
  if (empty) {
    $('emptyTitle').textContent = S.skills.length === 0 ? '还没有发现技能' : '没有匹配的技能';
    $('emptyDesc').textContent = S.skills.length === 0
      ? '执行端连接后会自动扫描本机 SKILL.md；也可以把新技能放进 skills 目录后刷新。'
      : '换个关键词或分组试试';
  }
}

function renderSidebar() {
  const active = S.boot.tasks || [];
  $('runningCount').textContent = active.length;
  $('runningList').innerHTML = active.length ? active.map(t =>
    '<div class="side-task" data-task="' + esc(t.id) + '"><span class="' + (t.status === 'running' ? 'spin' : 't-dot') + '" style="' + (t.status !== 'running' ? 'background:#f0b429' : '') + '"></span>' +
    '<span class="t-name">' + esc(t.skillTitle) + '</span><span class="t-meta">' + esc(({ queued: '排队', dispatched: '派发', running: '运行中' })[t.status] || t.status) + '</span></div>').join('')
    : '<div class="side-empty">暂无运行中的任务</div>';
  $('runningList').querySelectorAll('[data-task]').forEach(el => el.onclick = () => openTaskLog(el.dataset.task));

  const hist = (S.boot.history || []).slice(0, 6);
  $('historyList').innerHTML = hist.length ? hist.map(h =>
    '<div class="side-task" data-hist="' + esc(h.id) + '"><span class="t-dot" style="background:' + (h.status === 'success' ? '#0f9d58' : h.status === 'canceled' ? '#94a3b8' : '#dc2626') + '"></span>' +
    '<span class="t-name">' + esc(h.skillTitle) + '</span><span class="t-meta">' + esc(ago(h.finishedAt)) + '</span></div>').join('')
    : '<div class="side-empty">还没有运行记录</div>';
  $('historyList').querySelectorAll('[data-hist]').forEach(el => el.onclick = () => openTaskLog(el.dataset.hist));
}

// ---------- drawer & run ----------
function defaultsOf(sk) {
  const out = {};
  (sk.params || []).forEach(p => { out[p.key] = p.default || ''; });
  return out;
}
function paramFields(sk, values) {
  if (!sk.params || !sk.params.length) return '<div class="param-empty">这个技能没有额外参数，直接点「运行技能」即可。需要固定参数可在「设置 → 技能配置」里添加。</div>';
  return sk.params.map(p => {
    const v = (values && values[p.key] != null) ? values[p.key] : (p.default || '');
    const input = p.type === 'textarea'
      ? '<textarea data-param="' + esc(p.key) + '" placeholder="' + esc(p.placeholder || '') + '">' + esc(v) + '</textarea>'
      : '<input data-param="' + esc(p.key) + '" type="' + (p.type === 'number' ? 'number' : 'text') + '" value="' + esc(v) + '" placeholder="' + esc(p.placeholder || '') + '">';
    return '<div class="field"><label>' + esc(p.label || p.key) + '</label>' + input +
      (p.hint ? '<div class="field-hint">' + esc(p.hint) + '</div>' : '') + '</div>';
  }).join('');
}
function collectParams() {
  const out = {};
  $('paramArea').querySelectorAll('[data-param]').forEach(el => { out[el.dataset.param] = el.value; });
  return out;
}
function openDrawer(sk) {
  S.currentSkill = sk;
  $('drawerEmoji').textContent = sk.emoji;
  $('drawerTitle').textContent = sk.title;
  $('drawerSub').textContent = sk.group + ' · ' + sk.name;
  $('paramArea').innerHTML = paramFields(sk);
  $('paramArea').classList.remove('hidden');
  const def = (S.boot && S.boot.config && S.boot.config.defaultModel) || '';
  const defLabel = def ? (MODEL_LABELS[def] || def) : 'CLI 内置默认';
  $('modelSelect').innerHTML = '<option value="">跟随默认（' + defLabel + '）</option>' +
    MODELS.map(m => '<option value="' + m + '">' + (MODEL_LABELS[m] || m) + '</option>').join('');
  $('promptPreview').classList.add('hidden');
  $('btnRun').classList.remove('hidden');
  $('btnRun').disabled = false;
  $('btnStop').classList.add('hidden');
  $('runStatus').textContent = '';
  clearLogs();
  $('drawerMask').classList.remove('hidden');
  $('runDrawer').classList.remove('hidden');
}
function closeDrawer() {
  $('drawerMask').classList.add('hidden');
  $('runDrawer').classList.add('hidden');
  if (S.taskSource) { S.taskSource.close(); S.taskSource = null; }
}
function clearLogs() {
  $('logBox').innerHTML = '<div class="log-placeholder">尚未开始运行。填写参数后点击「运行技能」。</div>';
  S.logCount = 0; $('logCount').textContent = '0 行';
}
function appendLine(line) {
  const box = $('logBox');
  if (S.logCount === 0) box.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'log-line log-type-' + esc(line.type || 'log');
  div.innerHTML = '<span class="log-ts">' + esc(hhmmss(line.ts)) + '</span><span class="log-text">' + esc(line.text) + '</span>';
  box.appendChild(div);
  S.logCount++;
  if (S.logCount > 600) { box.removeChild(box.firstChild); S.logCount--; }
  $('logCount').textContent = S.logCount + ' 行';
  box.scrollTop = box.scrollHeight;
}
async function openTaskLog(taskId) {
  try {
    const d = await api('/api/task/logs?id=' + encodeURIComponent(taskId));
    S.currentSkill = null;
    $('drawerEmoji').textContent = '📄';
    $('drawerTitle').textContent = '运行记录';
    $('drawerSub').textContent = taskId;
    $('paramArea').classList.add('hidden');
    $('btnRun').classList.add('hidden');
    $('btnStop').classList.add('hidden');
    $('runStatus').textContent = d.task ? (d.task.status || '') : '已归档';
    clearLogs();
    (d.logs || []).forEach(appendLine);
    $('drawerMask').classList.remove('hidden');
    $('runDrawer').classList.remove('hidden');
  } catch (e) { toast(e.message); }
}
async function startRun(sk, params) {
  if (!sk) return;
  $('btnRun').disabled = true;
  $('btnRun').querySelector('span').textContent = '运行中…';
  $('btnStop').classList.remove('hidden');
  $('runStatus').innerHTML = '<span class="spin"></span> 提交任务';
  clearLogs();
  appendLine({ type: 'info', text: '正在提交任务：' + sk.title, ts: Date.now() });
  try {
    const model = $('modelSelect') ? $('modelSelect').value : '';
    const d = await api('/api/run', { method: 'POST', body: JSON.stringify({ skillId: sk.id, params: params || {}, model }) });
    S.taskId = d.taskId;
    subscribeTask(d.taskId);
    $('promptPreview').textContent = '任务 ID：' + d.taskId + '\n参数：' + JSON.stringify(params || {}, null, 2);
    $('promptPreview').classList.remove('hidden');
    scheduleRefresh();
  } catch (e) {
    toast(e.message, 3500);
    appendLine({ type: 'error', text: '提交失败：' + e.message, ts: Date.now() });
    resetRunButtons();
  }
}
function subscribeTask(id) {
  if (S.taskSource) S.taskSource.close();
  const es = new EventSource(sseUrl('/api/task/stream?id=' + encodeURIComponent(id)));
  S.taskSource = es;
  es.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.kind === 'backfill') { clearLogs(); (msg.lines || []).forEach(appendLine); }
    else if (msg.kind === 'log') appendLine(msg.line);
    else if (msg.kind === 'done') {
      $('runStatus').textContent = ({ success: '运行完成', failed: '运行失败', canceled: '已停止' })[msg.task.status] || msg.task.status;
      resetRunButtons();
      scheduleRefresh();
    }
    if (msg.kind === 'log' && msg.line) {
      const text = msg.line.text || '';
      if (/派发|领取|启动/.test(text)) $('runStatus').innerHTML = '<span class="spin"></span> 执行端启动中';
      else if (msg.line.type === 'tool' || msg.line.type === 'text') $('runStatus').innerHTML = '<span class="spin"></span> 技能执行中';
    }
  };
  es.onerror = () => { /* reconnect handled by browser */ };
}
function resetRunButtons() {
  $('btnRun').disabled = false;
  $('btnRun').querySelector('span').textContent = '重新运行';
  $('btnStop').classList.add('hidden');
}
async function stopRun() {
  if (!S.taskId) return;
  try { await api('/api/task/stop', { method: 'POST', body: JSON.stringify({ taskId: S.taskId }) }); toast('已发送停止请求'); }
  catch (e) { toast(e.message); }
}

// ---------- modals ----------
function modal(title, bodyHtml, footHtml, tabsHtml) {
  $('modalRoot').innerHTML = '<div class="modal-wrap"><div class="modal"><div class="modal-head"><h3>' + esc(title) + '</h3><button class="icon-btn" data-close><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button></div>' +
    (tabsHtml || '') + '<div class="modal-body">' + bodyHtml + '</div>' + (footHtml ? '<div class="modal-foot">' + footHtml + '</div>' : '') + '</div></div>';
  $('modalRoot').querySelector('[data-close]').onclick = closeModal;
  $('modalRoot').querySelector('.modal-wrap').onclick = (e) => { if (e.target.classList.contains('modal-wrap')) closeModal(); };
}
function closeModal() { $('modalRoot').innerHTML = ''; }

function openPassword() {
  modal('需要访问口令', '<p>这个工作台已开启访问口令，请输入后继续。</p><div class="field"><label>访问口令</label><input id="pwdInput" type="password" placeholder="请输入口令" autofocus></div>',
    '<button class="btn btn-ghost" data-close2>取消</button><button class="btn btn-primary" id="pwdOk">确定</button>');
  $('modalRoot').querySelector('[data-close2]').onclick = closeModal;
  $('pwdOk').onclick = () => {
    S.pwd = $('pwdInput').value.trim();
    localStorage.setItem('wb_pwd', S.pwd);
    closeModal(); connectEvents(); loadBootstrap();
  };
  $('pwdInput').onkeydown = (e) => { if (e.key === 'Enter') $('pwdOk').click(); };
  $('pwdInput').focus();
}

function openHelp() {
  modal('使用说明',
    '<h4>同事怎么用</h4><p>打开这个链接 → 找到需要的技能 → 点卡片上的 <b>「运行」</b>。不需要安装任何东西，也不用登录。</p>' +
    '<p>运行过程会实时显示在右侧面板，多人同时点击会按顺序排队执行。历史记录里可以回看每次运行的日志。</p>' +
    '<h4>技能在哪里执行</h4><p><b>本机模式</b>：页面服务和执行端都跑在这台电脑上，技能读取本机的 SKILL.md、本地文件与已授权账号，数据不出本机。双击项目根目录的 <code>start-local.bat</code> 一键启动，浏览器打开 <code>http://127.0.0.1:7788</code>。</p>' +
    '<h4>怎么新增技能</h4><ul><li>把新的技能文件夹放进执行端电脑的 <code>skills</code> 目录（内含 <code>SKILL.md</code>）；</li><li>执行端会自动扫描并同步，刷新页面即可看到新卡片；</li><li>在「设置 → 技能配置」里可以改显示名、分组、图标、参数和提示词模板。</li></ul>' +
    '<h4>常见问题</h4><ul><li><b>执行端离线</b>：没有运行 <code>start-local.bat</code>，或服务窗口被关闭。</li><li><b>命令行未认证 / Authentication required</b>：CLI 有独立登录态，和桌面端不共用。双击 <code>agent/login-cli.bat</code>（完整版 CLI，带交互界面）→ 自动输入 <code>/login</code> → 浏览器授权 → <code>/exit</code>，只需一次。或者把 API Key 写进 <code>local/api-key.txt</code> 并重启，即可完全免登录。</li><li><b>任务一直排队</b>：执行端并发已满或掉线；可在设置里调并发数。</li></ul>' +
    '<div class="callout">提示：运行技能等同于让 AI 在那台电脑上按技能文档操作，点之前确认技能用途与参数。</div>',
    '<button class="btn btn-primary" data-close3>知道了</button>');
  $('modalRoot').querySelector('[data-close3]').onclick = closeModal;
}

let settingsTab = 'skills';
function openSettings() {
  const tabs = '<div class="tabs"><button class="tab" data-tab="skills">技能配置</button><button class="tab" data-tab="general">常规设置</button><button class="tab" data-tab="about">关于 / 环境</button></div>';
  modal('工作台设置', '<div id="settingsBody"></div>', '<button class="btn btn-ghost" data-close4>关闭</button>', tabs);
  $('modalRoot').querySelector('[data-close4]').onclick = closeModal;
  $('modalRoot').querySelectorAll('.tab').forEach(t => t.onclick = () => { settingsTab = t.dataset.tab; renderSettingsTab(); });
  renderSettingsTab();
}
function renderSettingsTab() {
  $('modalRoot').querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === settingsTab));
  const b = S.boot || { config: { settings: {} }, agent: { meta: {} } };
  if (settingsTab === 'skills') {
    const opts = S.skills.map(s => '<option value="' + esc(s.id) + '">' + esc(s.title) + '（' + esc(s.id) + '）</option>').join('');
    $('settingsBody').innerHTML = '<div class="field"><label>选择要配置的技能</label><select id="cfgSkill">' + (opts || '<option value="">（暂无技能）</option>') + '</select></div><div id="cfgForm" style="margin-top:16px"></div>' +
      '<div class="modal-foot" style="padding:14px 0 0;background:transparent;border:0"><button class="btn btn-primary" id="cfgSave">保存该技能配置</button></div>';
    $('cfgSkill').onchange = renderSkillForm;
    if (S.skills.length) renderSkillForm();
    $('cfgSave').onclick = saveSkillConfig;
  } else if (settingsTab === 'general') {
    const st = b.config.settings || {};
    $('settingsBody').innerHTML = '<div class="form-grid">' +
      '<div class="field"><label>最大并发任务数</label><input id="setConcurrent" type="number" min="1" max="8" value="' + (st.maxConcurrent || 2) + '"><div class="field-hint">同时执行的技能数量，建议 2–3</div></div>' +
      '<div class="field"><label>单任务超时（毫秒）</label><input id="setTimeout" type="number" min="60000" step="60000" value="' + (st.runTimeoutMs || 900000) + '"><div class="field-hint">默认 900000 = 15 分钟</div></div>' +
      '<div class="field"><label>默认运行模型</label><select id="setModel">' + MODELS.map(m => '<option value="' + m + '"' + (m === (b.config.defaultModel || '') ? ' selected' : '') + '>' + (MODEL_LABELS[m] || m) + '</option>').join('') + '</select><div class="field-hint">所有技能默认使用的模型；每次运行前仍可在抽屉里临时切换。</div></div>' +
      '<div class="field full"><label>访问口令（留空 = 不设权限，谁都能用）</label><input id="setPassword" type="text" value="" placeholder="' + (b.config.hasPassword ? '已设置，留空则保持不变；输入新值可修改' : '不设置口令') + '"><div class="field-hint">公网链接建议设置口令，避免链接被转发后任何人都能触发技能。开启后所有同事需输入一次口令。</div></div></div>' +
      '<div class="callout">当前状态：<b>' + (b.config.hasPassword ? '已开启访问口令' : '未开启（按你的选择，任何人拿到链接都能使用）') + '</b></div>' +
      '<div class="modal-foot" style="padding:14px 0 0;background:transparent;border:0"><button class="btn btn-ghost" id="setDisablePwd">关闭口令</button><button class="btn btn-primary" id="setSave">保存设置</button></div>';
    $('setSave').onclick = saveGeneral;
    $('setDisablePwd').onclick = async () => {
      try { await api('/api/config', { method: 'PUT', body: JSON.stringify({ accessPassword: '' }) }); S.pwd = ''; localStorage.removeItem('wb_pwd'); toast('已关闭访问口令'); closeModal(); connectEvents(); loadBootstrap(); }
      catch (e) { toast(e.message); }
    };
  } else {
    const m = b.agent.meta || {};
    $('settingsBody').innerHTML = '<h4>架构</h4><p><b>本机模式</b>：本机页面服务 ↔ 本机执行端 ↔ 项目内的完整版 CLI → SKILL.md 技能。全部进程与数据都在这台电脑上，不依赖公网、不需要账号分享链接。</p>' +
      '<h4>执行端状态</h4><div class="kv"><b>连接</b><span>' + (b.agent.online ? '在线' : '离线') + '</span></div>' +
      '<div class="kv"><b>主机</b><span>' + esc(m.hostname || '-') + '</span></div>' +
      '<div class="kv"><b>技能目录</b><span>' + (m.dirCount || 0) + ' 个</span></div>' +
      '<div class="kv"><b>命令行</b><span>' + (m.cliExists ? '已找到' : '未找到') + '</span></div>' +
      '<div class="kv"><b>登录状态</b><span>' + (m.cliAuth === false ? '<span style="color:#d97706">未登录</span>' : m.cliAuth === true ? '已登录' : '检测中') + '</span></div>' +
      '<div class="kv"><b>已发现技能</b><span>' + (b.agent.skillsCount || 0) + ' 个</span></div>' +
      '<h4>首次使用前置步骤</h4><p>CLI 有独立登录态，和桌面端不共用。双击 <code>agent/login-cli.bat</code>（脚本会自动输入 <code>/login</code>）→ 浏览器完成授权 → 输入 <code>/exit</code>，脚本自动验证；只需一次，约 30 秒后生效。另一种完全免登录的做法：把 CodeBuddy API Key 写进 <code>local/api-key.txt</code> 后重启 <code>start-local.bat</code>。</p>' +
      '<div class="callout blue">技能列表、配置和运行历史都保存在本机 <code>hub/data/</code>，技能本体也留在本机，不会上传到任何地方。</div>';
  }
}
function renderSkillForm() {
  const id = $('cfgSkill').value;
  const sk = S.skills.find(s => s.id === id);
  if (!sk) { $('cfgForm').innerHTML = ''; return; }
  const rows = (sk.params || []).map((p, i) => paramRowHtml(p, i)).join('');
  $('cfgForm').innerHTML = '<div class="form-grid">' +
    '<div class="field"><label>显示名称</label><input id="cfgTitle" value="' + esc(sk.title) + '"></div>' +
    '<div class="field"><label>分组</label><input id="cfgGroup" value="' + esc(sk.group) + '" placeholder="例如：办公自动化"></div>' +
    '<div class="field"><label>图标 Emoji</label><input id="cfgEmoji" value="' + esc(sk.emoji) + '" maxlength="4"></div>' +
    '<div class="field"><label>排序（数字越小越靠前）</label><input id="cfgOrder" type="number" value="' + (sk.order || 0) + '"></div>' +
    '<div class="field full"><label>提示词模板</label><textarea id="cfgPrompt" placeholder="留空使用默认模板">' + esc(sk.promptTemplate) + '</textarea><div class="field-hint">可用变量：{name} 技能名、{path} SKILL.md 路径、{params} 用户填写的参数</div></div>' +
    '</div>' +
    '<div class="switch-row" style="margin:14px 0"><span>在工作台显示并允许运行</span><label class="switch"><input id="cfgEnabled" type="checkbox" ' + (sk.enabled ? 'checked' : '') + '><span></span></label></div>' +
    '<h4>运行参数</h4><div class="param-editor" id="paramEditor">' + rows + '</div>' +
    '<button class="btn btn-ghost btn-sm" id="addParam" style="margin-top:9px">+ 添加参数</button>' +
    '<div class="field-hint" style="margin-top:6px">参数会在运行前显示给同事填写；key 建议使用英文，label 是页面上看到的名称。</div>';
  $('addParam').onclick = () => {
    $('paramEditor').insertAdjacentHTML('beforeend', paramRowHtml({ key: '', label: '', type: 'text', placeholder: '' }, -1));
    bindParamRows();
  };
  bindParamRows();
}
function paramRowHtml(p, i) {
  return '<div class="param-row"><input data-k="key" value="' + esc(p.key) + '" placeholder="key">' +
    '<input data-k="label" value="' + esc(p.label || '') + '" placeholder="显示名称">' +
    '<input data-k="placeholder" value="' + esc(p.placeholder || '') + '" placeholder="提示文字">' +
    '<button class="mini-del" title="删除">×</button></div>';
}
function bindParamRows() {
  $('paramEditor').querySelectorAll('.mini-del').forEach(btn => btn.onclick = () => btn.closest('.param-row').remove());
}
async function saveSkillConfig() {
  const id = $('cfgSkill').value;
  if (!id) return toast('暂无技能可配置');
  const params = [];
  $('paramEditor').querySelectorAll('.param-row').forEach(row => {
    const key = row.querySelector('[data-k="key"]').value.trim();
    if (!key) return;
    params.push({ key, label: row.querySelector('[data-k="label"]').value.trim() || key, type: 'text', placeholder: row.querySelector('[data-k="placeholder"]').value.trim(), default: '' });
  });
  const patch = {
    title: $('cfgTitle').value.trim(), group: $('cfgGroup').value.trim() || '未分组',
    emoji: $('cfgEmoji').value.trim() || '🧩', order: Number($('cfgOrder').value) || 0,
    promptTemplate: $('cfgPrompt').value, enabled: $('cfgEnabled').checked, params
  };
  const skills = {};
  S.skills.forEach(s => { skills[s.id] = { title: s.title, group: s.group, emoji: s.emoji, order: s.order, promptTemplate: s.promptTemplate, enabled: s.enabled, params: s.params }; });
  skills[id] = patch;
  try { await api('/api/config', { method: 'PUT', body: JSON.stringify({ skills }) }); toast('已保存：' + patch.title); await loadBootstrap(true); }
  catch (e) { toast(e.message); }
}
async function saveGeneral() {
  const pwd = $('setPassword').value.trim();
  const body = { settings: { maxConcurrent: Number($('setConcurrent').value) || 2, runTimeoutMs: Number($('setTimeout').value) || 900000 }, defaultModel: $('setModel') ? $('setModel').value : '' };
  if (pwd) body.accessPassword = pwd;
  try {
    await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    if (pwd) { S.pwd = pwd; localStorage.setItem('wb_pwd', pwd); connectEvents(); }
    toast('设置已保存'); closeModal(); await loadBootstrap(true);
  } catch (e) { toast(e.message); }
}

// ---------- result files panel ----------
let filesRel = '';
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(2) + ' MB';
}
function authQuery() { return S.pwd ? '&pwd=' + encodeURIComponent(S.pwd) : ''; }
function setView(v) {
  S.view = v;
  $('btnFiles').classList.toggle('active', v === 'files');
  const gridHidden = v === 'files';
  $('skillGrid').classList.toggle('hidden', gridHidden);
  $('emptyState').classList.toggle('hidden', gridHidden);
  $('filesView').classList.toggle('hidden', !gridHidden);
  if (v === 'files') {
    $('pageTitle').textContent = '结果文件';
    $('pageDesc').textContent = '执行端在本机 ' + (S.boot && S.boot.filesRoot ? esc(S.boot.filesRoot) : '项目目录') + ' 下产生的文件。点文件夹进入，点文件预览或下载。';
    loadFiles('');
  } else { renderGroups(); renderCards(); }
}
async function loadFiles(rel) {
  filesRel = rel || '';
  try {
    const d = await api('/api/files?dir=' + encodeURIComponent(filesRel));
    renderFiles(d);
  } catch (e) { toast(e.message); }
}
function renderFiles(d) {
  const root = (S.boot && S.boot.filesRoot) ? S.boot.filesRoot : '根目录';
  let crumbs = '<span class="crumb root" data-rel="">📂 ' + esc(root) + '</span>';
  if (d.path) {
    const parts = d.path.split(/[/\\]/).filter(Boolean);
    let acc = '';
    for (const part of parts) { acc = acc ? acc + '/' + part : part; crumbs += '<span class="crumb-sep">/</span><span class="crumb" data-rel="' + esc(acc) + '">' + esc(part) + '</span>'; }
  }
  $('filesCrumbs').innerHTML = crumbs;
  $('filesCrumbs').querySelectorAll('.crumb').forEach(el => el.onclick = () => loadFiles(el.dataset.rel));
  if (!d.entries.length) { $('filesList').innerHTML = '<div class="files-empty">这个目录是空的</div>'; return; }
  const rows = d.entries.map(e => {
    const icon = e.isDir ? '📁' : (e.kind === 'image' ? '🖼️' : e.kind === 'text' ? '📄' : '📦');
    return '<div class="file-row" data-rel="' + esc(d.path ? d.path + '/' + e.name : e.name) + '" data-dir="' + e.isDir + '" data-kind="' + esc(e.kind) + '">' +
      '<span class="f-ico">' + icon + '</span>' +
      '<span class="f-name" title="' + esc(e.name) + '">' + esc(e.name) + '</span>' +
      '<span class="f-meta">' + (e.isDir ? '目录' : fmtSize(e.size)) + '</span>' +
      '<span class="f-time">' + esc(new Date(e.mtime).toLocaleString('zh-CN')) + '</span>' +
      '</div>';
  }).join('');
  $('filesList').innerHTML = rows;
  $('filesList').querySelectorAll('.file-row').forEach(el => el.onclick = () => {
    if (el.dataset.dir === 'true') loadFiles(el.dataset.rel);
    else openFilePreview(el.dataset.rel, el.dataset.kind);
  });
}
async function openFilePreview(rel, kind) {
  try {
    const d = await api('/api/file?path=' + encodeURIComponent(rel));
    let bodyHtml;
    if (d.kind === 'image') {
      bodyHtml = '<div style="text-align:center"><img src="/api/file?path=' + encodeURIComponent(rel) + authQuery() + '" style="max-width:100%;max-height:62vh;border:1px solid var(--line);border-radius:10px"></div>';
    } else if (d.kind === 'text') {
      const note = d.truncated ? ('仅显示前 ' + fmtSize(d.size) + '，') : ('共 ' + fmtSize(d.size) + '，');
      bodyHtml = '<div class="field-hint" style="margin:0 0 8px">' + esc(d.name) + ' · ' + note + (d.truncated ? '完整内容请下载' : '已全部显示') + '</div>' +
        '<pre class="preview-pre">' + esc(d.content) + '</pre>';
    } else {
      bodyHtml = '<p>这是一个二进制文件（' + esc(d.name) + '，' + fmtSize(d.size) + '），无法在线预览。</p>';
    }
    const dl = '/api/file?path=' + encodeURIComponent(rel) + '&download=1' + authQuery();
    modal('预览 · ' + esc(d.name || rel), bodyHtml, '<a class="btn btn-ghost" href="' + dl + '">下载文件</a><button class="btn btn-primary" data-close6>关闭</button>');
    $('modalRoot').querySelector('[data-close6]').onclick = closeModal;
  } catch (e) { toast(e.message); }
}

// ---------- events ----------
$('searchInput').addEventListener('input', (e) => { S.keyword = e.target.value; renderCards(); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') { e.preventDefault(); $('searchInput').focus(); }
  if (e.key === 'Escape') { closeModal(); closeDrawer(); }
});
$('btnRefresh').onclick = () => { loadBootstrap(); toast('已刷新'); };
$('btnHelp').onclick = openHelp;
$('btnSettings').onclick = openSettings;
$('btnCloseDrawer').onclick = closeDrawer;
$('drawerMask').onclick = closeDrawer;
$('btnClearLog').onclick = clearLogs;
$('btnStop').onclick = stopRun;
$('btnRun').onclick = () => {
  if (!S.currentSkill) return;
  startRun(S.currentSkill, collectParams());
};
$('btnAllHistory').onclick = () => openHistoryModal();
$('btnFiles').onclick = () => setView(S.view === 'files' ? 'skills' : 'files');
$('btnFilesRoot').onclick = () => loadFiles('');
$('btnFilesRefresh').onclick = () => loadFiles(filesRel);
async function openHistoryModal() {
  try {
    const b = await api('/api/bootstrap');
    const rows = (b.history || []).map(h => '<div class="kv"><b>' + esc(h.status) + '</b><span>' + esc(h.skillTitle) + ' · ' + esc(ago(h.finishedAt)) + ' <button class="link-btn" data-log="' + esc(h.id) + '">查看日志</button></span></div>').join('');
    modal('全部运行记录', rows || '<p>还没有运行记录。</p>', '<button class="btn btn-primary" data-close5>关闭</button>');
    $('modalRoot').querySelector('[data-close5]').onclick = closeModal;
    $('modalRoot').querySelectorAll('[data-log]').forEach(el => el.onclick = () => { closeModal(); openTaskLog(el.dataset.log); });
  } catch (e) { toast(e.message); }
}

loadBootstrap();
connectEvents();
setInterval(() => loadBootstrap(true), 30000);
