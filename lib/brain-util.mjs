/**
 * lib/brain-util.mjs —— 主脑的纯工具（从 brain.mjs 抽出来的）。
 *
 * 这些函数只做「进程/文件/端口」这类没状态的事，抽出来的目的：
 * 主脑只剩仲裁和调度，改工具函数不会牵动调度逻辑。
 * 依赖注入用不到的全局，一律通过参数传（ROOT/STATE/BRIDGE 来自 lib/base.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT, STATE, BRIDGE } from './base.mjs';

export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function isNodePid(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
    });
    return /node\.exe/i.test(out);
  } catch { return false; }
}

export function killTree(pid, image = 'node.exe') {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    return true;
  } catch { return false; }
}

export function readPidFile(f) {
  try { return Number(fs.readFileSync(f, 'utf8').trim()) || 0; } catch { return 0; }
}

export function lockAge(name) {
  try { return Math.round((Date.now() - fs.statSync(path.join(STATE, `${name}.lock`)).mtimeMs) / 1000); } catch { return -1; }
}

export function tail(file, lines = 40) {
  try { return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n'); } catch { return ''; }
}

export function registry() {
  const file = path.join(ROOT, 'supervisor', 'workers.mjs');
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const m of text.matchAll(/name:\s*'([^']+)'[\s\S]{0,200}?file:\s*path\.join\(ROOT,\s*'([^']+)',\s*'([^']+)'\)/g)) {
    out.push({ name: m[1], file: path.join(ROOT, m[2], m[3]) });
  }
  return out;
}

export function spawnBridge() {
  try {
    const out = fs.openSync(path.join(STATE, 'bridge-run.log'), 'a');
    const child = spawn(process.execPath, [path.join(BRIDGE, 'src', 'bridge.js')], {
      cwd: BRIDGE, stdio: ['ignore', out, out], windowsHide: true, detached: true,
    });
    child.unref();
    try { fs.closeSync(out); } catch {}
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

export function spawnNapcat() {
  try {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'napcat-start.mjs'), '--as-user'], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

export function runDoctor() {
  try { execFileSync('schtasks', ['/run', '/tn', 'QQStackDoctor'], { stdio: 'ignore', windowsHide: true, timeout: 15000 }); return { ok: true }; } catch (e) { return { ok: false, err: e.message }; }
}

export function runScript(rel, args = []) {
  try {
    const file = path.join(ROOT, rel);
    const child = spawn(process.execPath, [file, ...args], {
      cwd: path.dirname(file), stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

export function sendMail(subject, body) {
  try {
    const file = path.join(ROOT, 'tools', 'notify-offline.mjs');
    if (!fs.existsSync(file)) return { ok: false, err: '没有 notify-offline.mjs' };
    const child = spawn(process.execPath, [file, `--subject=${subject}`, `--body=${body}`], {
      cwd: ROOT, stdio: 'ignore', windowsHide: true, detached: true,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e) { return { ok: false, err: e.message }; }
}

export function writeSaveMode(on, why = '') {
  try {
    const p = path.join(ROOT, 'state', 'cerebellum-policy.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ proactive: on ? 'off' : 'normal', why, at: new Date().toISOString() }, null, 2));
    return { ok: true };
  } catch (e) { return { ok: false, err: e.message }; }
}

export function trimLogs(onTrim) {
  let trimmed = 0;
  for (const dir of [STATE, path.join(ROOT, 'stack-guard'), path.join(ROOT, 'stack-doctor')]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')); } catch { continue; }
    for (const f of files) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (st.size < LOG_MAX_BYTES) continue;
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').split('\n').slice(-1500).join('\n'));
        trimmed += 1;
        decide('日志-太大', '裁剪 ' + f, `${Math.round(st.size / 1048576)}MB → 1500 行`);
      } catch {}
    }
  }
  return { ok: true, trimmed };
}

export function killExtraQQ() {
  let keep = 0;
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    for (const line of out.split('\n')) {
      if (!/:3000\b/.test(line) || !/LISTEN/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      keep = Number(cols[cols.length - 1]) || keep;
    }
  } catch {}
  let pids = [];
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq QQ.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    pids = [...out.matchAll(/"QQ\.exe","(\d+)"/gi)].map((m) => Number(m[1]));
  } catch {}
  const extras = pids.filter((p) => p !== keep);
  let killed = 0;
  for (const p of extras) { if (killTree(p)) killed += 1; }
  return { ok: killed > 0, keep, killed, extras };
}
