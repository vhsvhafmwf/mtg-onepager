#!/usr/bin/env node
// 使い方: node render.mjs <data.json> <out.jpg> [--html <out.html>]
// data.json を検査 → template.html に埋め込み → はみ出しを自動で詰める → 3840x2160 JPEG と
// 確認用の 1920x1080 縮小版（<out>.preview.jpg）を書く。
// 失敗時は理由を stderr に出して exit 1（検査エラー / 縮めても収まらない / ページの例外）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const htmlIdx = args.indexOf('--html');
const htmlOut = htmlIdx >= 0 ? resolve(args[htmlIdx + 1]) : null;
const [dataPath, outPath] = htmlIdx < 0 ? args : args.filter((_, i) => i !== htmlIdx && i !== htmlIdx + 1);
if (!dataPath || !outPath) { console.error('usage: node render.mjs <data.json> <out.jpg> [--html <out.html>]'); process.exit(1); }

const fail = msg => { console.error('ERROR: ' + msg); process.exit(1); };

// ---- 1. 検査（エラーパスを先に） ----
let M;
try { M = JSON.parse(readFileSync(dataPath, 'utf8')); } catch (e) { fail(`data.json を読めない: ${e.message}`); }
const errs = [];
const need = (cond, msg) => { if (!cond) errs.push(msg); };
for (const k of ['org', 'title', 'teams', 'decisions', 'pending', 'progress', 'schedule']) need(k in M, `必須キー ${k} がない`);
if (errs.length) fail(errs.join('\n'));
const K = M.teams;
need(K && typeof K === 'object' && Object.keys(K).length > 0, 'teams が空');
for (const [k, v] of Object.entries(K)) {
  need(v && v.name, `teams.${k}.name がない`);
  need(/^#[0-9a-fA-F]{6}$/.test(v?.color || ''), `teams.${k}.color は #RRGGBB で（今: ${v?.color}）`);
}
const teamOk = (k, where) => need(k in K, `${where}: team "${k}" が teams に定義されていない`);
M.decisions.forEach((d, i) => {
  need(d.status === 'done' || d.status === 'open', `decisions[${i}].status は done / open（今: ${d.status}）`);
  teamOk(d.team, `decisions[${i}]`); need(d.q && d.a, `decisions[${i}] に q と a が要る`);
});
M.pending.forEach((p, i) => { teamOk(p.team, `pending[${i}]`); need(p.to && p.text, `pending[${i}] に to と text が要る`); });
M.progress.forEach((p, i) => {
  teamOk(p.team, `progress[${i}]`);
  (p.items || []).forEach((x, j) => need(typeof x === 'object' && x.h && x.t, `progress[${i}].items[${j}] は {h, t}（見出し＋本文）`));
});
M.schedule.forEach((s, i) => { teamOk(s.team, `schedule[${i}]`); need(s.date && s.text, `schedule[${i}] に date と text が要る`); });
need(M.schedule.filter(s => s.now).length <= 1, 'schedule の now: true は1件まで');
if (M.schedule.length > 4) errs.push('schedule は4件まで（2×2 の枠）。近い順に4件へ絞る');
if (errs.length) fail('データ検査で止めた:\n- ' + errs.join('\n- '));

// ---- 2. 埋め込み ----
const tpl = readFileSync(join(here, '../assets/template.html'), 'utf8');
const json = JSON.stringify(M).replace(/</g, '\\u003c');
const html = tpl.replace('/*__DATA__*/null', json);
const pagePath = htmlOut || join(tmpdir(), `mtg-onepager-${process.pid}.html`);
mkdirSync(dirname(pagePath), { recursive: true });
writeFileSync(pagePath, html);

// ---- 3. 描画・はみ出し検査・自動調整 ----
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { fail(`playwright が見つからない。次を実行: npm install --prefix "${here}" && npx --prefix "${here}" playwright install chromium`); }

let browser;
try { browser = await chromium.launch(); }
catch (e) { fail(`Chromium を起動できない（${e.message.split('\n')[0]}）。次を実行: npx --prefix "${here}" playwright install chromium`); }
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(e.message));
await page.goto('file://' + pagePath);
await page.waitForSelector('body[data-ready="1"]', { timeout: 15000 }).catch(() => {});
await page.evaluate(() => document.fonts.ready);
// Google Fonts が取れない環境（オフライン等）では OS の日本語フォントで描く。結果に出して目視確認を促す
const webFonts = await page.evaluate(() => document.fonts.check('700 16px "Noto Sans JP"', '決定'));
if (pageErrors.length) { await browser.close(); fail('ページで例外: ' + pageErrors.join(' / ')); }

const measure = () => page.evaluate(() => {
  const over = [];
  document.querySelectorAll('.col').forEach((c, i) => { if (c.scrollHeight > c.clientHeight + 1) over.push(`col${i + 1} +${c.scrollHeight - c.clientHeight}px`); });
  const b = document.querySelector('.board').getBoundingClientRect(), f = document.querySelector('footer').getBoundingClientRect();
  if (b.bottom > f.top + 1) over.push('board が footer に重なる');
  if (document.documentElement.scrollWidth > 1920) over.push('横にはみ出し');
  return over;
});

const fits = [1, 0.94, 0.88, 0.82];
let used = null, over = [];
for (const f of fits) {
  await page.evaluate(v => document.documentElement.style.setProperty('--fit', v), f);
  over = await measure();
  if (!over.length) { used = f; break; }
}
if (used === null) { await browser.close(); fail(`文字を ${fits.at(-1)} 倍まで縮めても収まらない: ${over.join(', ')}。本文を短くするか件数を絞る`); }

mkdirSync(dirname(resolve(outPath)), { recursive: true });
await page.screenshot({ path: outPath, type: 'jpeg', quality: 90 });
const previewPath = resolve(outPath).replace(/(\.jpe?g)?$/i, '.preview.jpg');
await page.screenshot({ path: previewPath, type: 'jpeg', quality: 85, scale: 'css' });
await browser.close();

const nOpen = M.decisions.filter(d => d.status === 'open').length + M.pending.length;
console.log(JSON.stringify({
  ok: true, out: resolve(outPath), preview: previewPath, size: '3840x2160', fit: used, webFonts,
  decided: M.decisions.filter(d => d.status === 'done').length, open: nOpen,
  progressItems: M.progress.reduce((n, p) => n + p.items.length, 0), schedule: M.schedule.length
}));
