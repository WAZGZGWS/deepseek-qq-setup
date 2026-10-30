#!/usr/bin/env node
/**
 * treasurer —— 钱包管家：不是「现在剩多少」，而是「按这个烧法还能聊多久」。
 *
 * balance-watch 管「余额到档位就省着聊」，peak-watch 管「全价时段花太猛提醒一句」。
 * 缺的是把两次余额采样连成一条线：烧多快、还能撑几小时、什么时候该提前降档。
 *
 * 每 30 分钟记一次余额（自己的历史存在 state/treasurer.json，不依赖别人的快照），
 * 用最近 6 小时的样本算燃烧速率；预计 3 小时内烧完 → 直接写省聊策略（小脑那份文件），
 * 并记一条 state/treasurer-alert.json 给主脑；余额回上来就撤掉。
 *
 * 用法：node treasurer/treasurer.mjs  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';
import { isActive } from '../lib/organ-policy.mjs';

const NAME = 'treasurer';
const LOCK = path.join(STATE, `${NAME}.lock`);
const FILE = path.join(STATE, 'treasurer.json');
const ALERT = path.join(STATE, 'treasurer-alert.json');
const TICK_MS = 30 * 60 * 1000;
const ETA_WARN_H = 3;
const KEEP = 400;

const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function balanceNow() {
  const bw = readJson(path.join(ROOT, 'state', 'balance-watch.json')) || {};
  return { balance: Number(bw.lastBalance) || 0, at: Number(bw.lastCheckAt) || 0 };
}

function compute(st) {
  const now = Date.now();
  const samples = (st.samples || []).filter((s) => s.at && s.balance > 0);
  const recent = samples.filter((s) => now - s.at < 6 * 3600 * 1000);
  if (recent.length < 2) return { burnPerHour: null, etaHours: null, balance: samples.length ? samples[samples.length - 1].balance : 0 };
  const first = recent[0];
  const last = recent[recent.length - 1];
  const hours = (last.at - first.at) / 3600000;
  const used = first.balance - last.balance;
  const burnPerHour = hours > 0 ? Math.max(0, used / hours) : null;
  const etaHours = burnPerHour && burnPerHour > 0.0001 ? last.balance / burnPerHour : null;
  return { burnPerHour, etaHours, balance: last.balance };
}

function printStatus() {
  const st = readJson(FILE) || {};
  const c = compute(st);
  console.log(`钱包管家：余额 ${c.balance} 元，烧速 ${c.burnPerHour == null ? '?' : c.burnPerHour.toFixed(2) + ' 元/小时'}，还能撑 ${c.etaHours == null ? '?' : c.etaHours.toFixed(1) + ' 小时'}`);
  const a = readJson(ALERT);
  if (a) console.log(`  已提醒主脑：${a.why}`);
}

function saveMode(on, why) {
  const p = path.join(ROOT, 'state', 'cerebellum-policy.json');
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ proactive: on ? 'off' : 'normal', why, at: new Date().toISOString() }, null, 2));
  } catch {}
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('钱包管家已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  for (;;) {
    try {
      const now = Date.now();
      const st = readJson(FILE) || { samples: [] };
      const b = balanceNow();
      if (b.balance > 0) st.samples.push({ at: b.at || now, balance: b.balance });
      st.samples = st.samples.slice(-KEEP);
      const c = compute(st);
      st.at = new Date(now).toISOString();
      st.burnPerHour = c.burnPerHour;
      st.etaHours = c.etaHours;
      st.balance = c.balance;
      fs.writeFileSync(FILE, JSON.stringify(st, null, 2));

      if (c.etaHours != null && c.etaHours < ETA_WARN_H) {
        const active = isActive(STATE, 'treasurer');
        if (active) saveMode(true, `预计 ${c.etaHours.toFixed(1)} 小时后没钱`);
        const a = readJson(ALERT) || {};
        if (!a.warned) {
          fs.writeFileSync(ALERT, JSON.stringify({ warned: true, at: new Date(now).toISOString(), balance: c.balance, burnPerHour: c.burnPerHour, etaHours: c.etaHours, why: `预计 ${c.etaHours.toFixed(1)} 小时后烧完（${c.burnPerHour.toFixed(2)} 元/小时）` }, null, 2));
          console.log(`[${stamp()}] 钱包管家：提前降档 —— ${c.why || ''} 预计 ${c.etaHours.toFixed(1)} 小时`);
        }
      } else if (c.etaHours == null || c.etaHours > ETA_WARN_H * 2) {
        // 余额回上来了：撤提醒，省聊策略也放开（小脑自己的预算仍会压）
        if (fs.existsSync(ALERT)) { fs.unlinkSync(ALERT); console.log(`[${stamp()}] 钱包管家：余额缓过来了，撤掉提前降档`); }
        const pol = readJson(path.join(ROOT, 'state', 'cerebellum-policy.json')) || {};
        if (pol.proactive === 'off' && /小时/.test(pol.why || '')) saveMode(false, '余额缓过来');
      }
    } catch (e) {
      console.log(`[${stamp()}] 钱包管家出错：${e.message}`);
    }
    await sleep(TICK_MS);
  }
}

main();
