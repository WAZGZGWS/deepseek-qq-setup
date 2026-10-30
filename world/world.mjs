#!/usr/bin/env node
/**
 * world —— 窗外：她得知道今天几号、外面什么天气。
 *
 * 她一直「关在屋里」：聊到「今天好冷」只能顺着说，不知道外面几度。
 * 这里每天（或开机）取一次日期/星期/天气，写 state/world.json；
 * 桥接组提示词时会把它注入【今天外面】——不用她主动查，也不会占记忆。
 *
 * 天气用 open-meteo（免 key）。坐标从 config.json 的 world.lat/lon 或
 * 环境变量 WORLD_LAT/WORLD_LON 来；没配就只写日期和时令，不硬编城市。
 *
 * 用法：node world/world.mjs  |  --once  |  --status
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, STATE, stamp } from '../lib/base.mjs';

const NAME = 'world';
const LOCK = path.join(STATE, `${NAME}.lock`);
const OUT = path.join(STATE, 'world.json');
const TICK_MS = 3 * 3600 * 1000;
const BRIDGE = path.join(ROOT, 'dsh-qq', 'qq-bridge-enhanced-v1.1.0');

const ONCE = process.argv.includes('--once');
const STATUS_ONLY = process.argv.includes('--status');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function readPid(p) { try { return Number(fs.readFileSync(p, 'utf8').trim()) || 0; } catch { return 0; } }
function pidAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function coords() {
  const out = { lat: Number(process.env.WORLD_LAT) || 0, lon: Number(process.env.WORLD_LON) || 0, city: process.env.WORLD_CITY || '' };
  try {
    const cfgPath = [path.join(BRIDGE, 'config.json'), path.join(ROOT, 'config.json')].find((f) => fs.existsSync(f));
    const cfg = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
    const w = cfg?.world || {};
    out.lat = Number(w.lat) || out.lat;
    out.lon = Number(w.lon) || out.lon;
    out.city = String(w.city || out.city || '');
  } catch {}
  return out;
}

/** WMO 天气码 → 中文（够用就行） */
function codeText(c) {
  const m = {
    0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '毛毛雨', 53: '小雨', 55: '雨', 56: '冻雨', 57: '冻雨',
    61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴',
  };
  return m[Number(c)] || '';
}

function seasonTip(d) {
  const m = d.getMonth() + 1;
  if (m >= 3 && m <= 5) return '春天，早晚还凉，出门带件外套';
  if (m >= 6 && m <= 8) return '夏天，太阳毒，别忘了喝水';
  if (m >= 9 && m <= 11) return '秋天，天干，晚上凉得快';
  return '冬天，手容易冻，出门多穿点';
}

function cnDate(d) {
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return { date: d.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), weekday: week };
}

async function fetchWeather(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Asia%2FShanghai&forecast_days=1`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const j = await r.json();
    const cur = j?.current || {};
    const daily = j?.daily || {};
    return {
      now: Number(cur.temperature_2m),
      code: Number(cur.weather_code),
      text: codeText(cur.weather_code),
      max: Array.isArray(daily.temperature_2m_max) ? Number(daily.temperature_2m_max[0]) : null,
      min: Array.isArray(daily.temperature_2m_min) ? Number(daily.temperature_2m_min[0]) : null,
    };
  } catch { return null; }
}

async function refresh() {
  const now = new Date();
  const { date, weekday } = cnDate(now);
  const { lat, lon, city } = coords();
  let weather = '';
  let obs = null;
  if (lat && lon) {
    const w = await fetchWeather(lat, lon);
    if (w && Number.isFinite(w.now)) {
      obs = w;
      const range = w.max != null && w.min != null ? `（${Math.round(w.min)}~${Math.round(w.max)}°C）` : '';
      weather = `${city ? city + ' ' : ''}${w.text || '天气'} ${Math.round(w.now)}°C${range}`;
    }
  }
  const out = {
    at: new Date().toISOString(),
    date,
    weekday,
    weather,
    city,
    tip: seasonTip(now),
    obs,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`[${stamp()}] 窗外：${date} ${weekday}${weather ? '，' + weather : ''}`);
}

function printStatus() {
  const w = readJson(OUT);
  if (!w) { console.log('窗外还没跑过'); return; }
  console.log(`窗外（${new Date(w.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}）：${w.date} ${w.weekday}`);
  console.log(`  ${w.weather || '没配坐标，只记日期'}；${w.tip || ''}`);
}

async function main() {
  if (STATUS_ONLY) { printStatus(); return; }
  if (ONCE) { await refresh(); return; }
  const old = readPid(LOCK);
  if (old && old !== process.pid && pidAlive(old)) { console.log('窗外已有实例在跑'); process.exit(3); }
  fs.writeFileSync(LOCK, String(process.pid));
  const beat = setInterval(() => { try { fs.writeFileSync(LOCK, String(process.pid)); } catch {} }, 20000);
  beat.unref?.();
  process.on('exit', () => { try { if (readPid(LOCK) === process.pid) fs.unlinkSync(LOCK); } catch {} });

  const stale = () => {
    const w = readJson(OUT);
    if (!w || !w.at) return true;
    const age = Date.now() - Date.parse(w.at);
    return age > 6 * 3600 * 1000;
  };
  for (;;) {
    try { if (stale()) await refresh(); } catch (e) { console.log(`[${stamp()}] 窗外出错：${e.message}`); }
    await sleep(TICK_MS);
  }
}

main();
