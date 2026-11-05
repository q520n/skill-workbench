'use strict';
/**
 * CLI sign-in VERIFIER for the Skill Workbench.
 *
 *   node login-cli.js --check     check whether the CLI is signed in
 *   node login-cli.js             same thing (the .bat calls this after the CLI exits)
 *
 * The interactive sign-in itself is launched by login-cli.bat directly, because
 * this CLI exits immediately and silently when its stdin is not a real TTY.
 * Wrapping it in node (stdio:'inherit') can still lose the TTY, which made the
 * window flash and close. Running the CLI straight from the .bat keeps the
 * console's own terminal, and `pause` keeps that window open.
 *
 * The CLI has its own sign-in state; the desktop app's login is NOT shared.
 * One sign-in on this machine is enough for every colleague using the hub.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

// Use a clean, ordinary-terminal environment. The desktop agent session injects
// proxy/gateway variables and CODEBUDDY_FORCE_LITE_WB_BUNDLE, which would force
// the bundled lite CLI (no TUI) instead of the full CLI installed under local/cli.
const KEEP = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'TEMP', 'TMP', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT', 'USERNAME', 'USERDOMAIN',
  'PROCESSOR_ARCHITECTURE', 'OS', 'WINDIR', 'NUMBER_OF_PROCESSORS', 'COMMONPROGRAMFILES',
  'PROGRAMFILES', 'PROGRAMDATA'];
const env = {};
for (const k of KEEP) if (process.env[k] !== undefined) env[k] = process.env[k];
env.CODEBUDDY_SKIP_GIT_BASH_CHECK = '1';
if (cfg.cliLiteBundle === true) env.CODEBUDDY_FORCE_LITE_WB_BUNDLE = '1';
Object.assign(env, cfg.cliEnv || {});
const cwd = cfg.workDir || process.cwd();

if (!cfg.cliPath || !fs.existsSync(cfg.cliPath)) {
  console.error('[X] 找不到命令行程序，请检查 config.json 的 cliPath：' + cfg.cliPath);
  process.exit(1);
}

function verify() {
  return new Promise((resolve) => {
    const args = [cfg.cliPath, '-p', 'Reply with exactly: OK', '--output-format', 'text',
      '--permission-mode', cfg.permissionMode || 'dontAsk', '--port', '0', '--no-session-persistence'];
    let out = '', settled = false, child, timer;
    const done = (ok, note) => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve({ ok, note });
    };
    timer = setTimeout(() => { try { child && child.kill(); } catch (_) {} done(false, '检测超时'); }, 50000);
    try {
      child = cp.spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { return done(false, e.message); }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('error', e => done(false, e.message));
    child.on('close', () => done(!/Authentication required|Authentication failed/i.test(out),
      /Authentication required|Authentication failed/i.test(out) ? '命令行返回：需要 /login' : ''));
  });
}

if (process.argv.includes('--intro')) {
  console.log('');
  console.log('============================================');
  console.log('  技能工作台 · 命令行一次性登录');
  console.log('============================================');
  console.log('  就在【当前这个窗口】操作（脚本会自动输入 /login）：');
  console.log('    1) 若几秒后没有自动弹出浏览器，用键盘输入 /login 后回车（不要粘贴）');
  console.log('    2) 浏览器弹出登录页，用你的账号完成授权');
  console.log('    3) 回到这里输入  /exit  回车，脚本会自动验证登录结果');
  console.log('');
  console.log('  注意：窗口停在 "Press any key" 说明 CLI 没启动成功，请勿往里输 /login。');
  console.log('  这个窗口不会自动关闭；登录是一次性的，之后所有同事共用。');
  console.log('============================================');
  console.log('');
  process.exit(0);
}

(async () => {
  console.log('正在检测命令行登录状态，请稍候…');
  const r = await verify();
  console.log('');
  if (r.ok) {
    console.log('============================================');
    console.log('  [OK] 命令行已登录，工作台可以正常运行技能');
    console.log('============================================');
    console.log('  执行端会在 30 秒内自动刷新状态；也可重启 start-agent.bat 立即生效。');
  } else {
    console.log('============================================');
    console.log('  [X] 命令行仍未登录  ' + (r.note || ''));
    console.log('============================================');
    console.log('  请重新双击 login-cli.bat，在窗口里用键盘输入 /login 并回车，');
    console.log('  然后在浏览器完成授权，再输入 /exit。');
  }
  console.log('');
  process.exit(r.ok ? 0 : 2);
})();
