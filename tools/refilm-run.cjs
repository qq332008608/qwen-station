'use strict';
// 对标测试的无人值守跑法：node refilm-run.cjs <参考片名字>
// 代点规则（没有人看的时候）：它自己判合格的图直接通过；主图不合格重做一次，仍不合格也先用（记进日志）；补充图不合格就删掉。
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')), ST = `http://127.0.0.1:${CFG.port}`, H = { 'Content-Type': 'application/json', Origin: ST };
const name = process.argv[2], REFJ = path.join(CFG.workspace, 'references', name, 'analysis.json');
const api = async (p, body) => { const r = await fetch(ST + p, body === undefined ? {} : { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${j.error || r.status}`); return j; };
const one = s => String(s || '').replace(/\s+/g, ' '), stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }), say = s => console.log(`[${stamp()}] ${s}`);
let id; const printed = new Set(), state = () => api('/api/studio/state?id=' + encodeURIComponent(id));
async function run(action, extra) {
  say(`#### ${action}`); await api('/api/studio/run', Object.assign({ id, action }, extra));
  for (;;) { await new Promise(r => setTimeout(r, 4000)); let s; try { s = await state(); } catch (e) { continue; } for (const l of s.log) if (!printed.has(l)) { printed.add(l); if (!/\d+% /.test(l)) console.log('  ' + one(l).slice(0, 220)); } if (!s.running) return s; }
}
const mark = (target, status) => api('/api/studio/mark', { id, kind: 'image', target, status, comment: '' });
(async () => {
  let A = JSON.parse(fs.readFileSync(REFJ, 'utf8'));
  if (!A.production) { const r = spawnSync(process.execPath, [path.join(__dirname, 'refilm.cjs'), 'make', name], { encoding: 'utf8' }); console.log(r.stdout); A = JSON.parse(fs.readFileSync(REFJ, 'utf8')); }
  id = A.production; if (!id) throw new Error('没建成这一集');
  let s = await state(); for (const l of s.log) printed.add(l);
  if (!s.script || !s.script.text) { s = await run('script'); say('原文里没有的：' + JSON.stringify(s.script.added)); }
  if (!(s.elements || []).length) s = await run('elements');
  for (const e of s.elements) say(`元素｜${e.kind}｜${e.name}｜${e.images.map(i => i.label).join('、')}${e.layout ? '｜' + JSON.stringify(e.layout.camera) + (e.layout.warn.length ? '｜问题：' + e.layout.warn.join('；') : '') : ''}`);
  const masters = async () => { s = await run('images'); for (const e of s.elements) { const m = e.images[0]; if (m.status === 'review' && m.verdict === '合格') await mark(m.id, 'approved'); } s = await state(); };
  if (s.elements.some(e => ['draft', 'failed', 'rejected'].includes(e.images[0].status))) {
    await masters();
    const bad = s.elements.filter(e => e.images[0].status === 'review' && e.images[0].url);
    if (bad.length) { for (const e of bad) { say(`主图“${e.name}”不合格，重做一次：${one(e.images[0].qa).slice(-140)}`); await mark(e.images[0].id, 'rejected'); } await masters(); }
    for (const e of s.elements) { const m = e.images[0]; if (m.status !== 'approved' && m.url) { say(`主图“${e.name}”重做后仍不合格，无人值守先用它：${one(m.qa).slice(-140)}`); await mark(m.id, 'approved'); } }
    s = await state(); const dead = s.elements.filter(e => e.images[0].status !== 'approved'); if (dead.length) throw new Error('这些主图没生成出来：' + dead.map(e => e.name).join('、'));
  }
  if (s.elements.some(e => e.images.slice(1).some(i => i.status !== 'approved'))) {
    s = await run('images');
    for (const e of s.elements) for (const im of e.images.slice(1)) { if (im.status === 'approved') continue; if (im.verdict === '合格') await mark(im.id, 'approved'); else { say(`补充图“${e.name}·${im.label}”${im.verdict || '失败'}，删掉`); await api('/api/studio/save', { id, removeImage: im.id }); } }
    s = await state();
  }
  for (const e of s.elements) for (const im of e.images) say(`图｜${e.kind}｜${e.name}·${im.label}｜${im.status}｜${im.verdict || '-'}｜${im.path || ''}`);
  if (!(s.shots || []).some(x => x.kf)) { s = await run('plan'); for (const x of s.shots) say(`分镜｜${x.title}｜${x.method}｜第${x.scene}场｜${x.size}｜${one(x.action).slice(0, 80)}`); }
  s = await run('auto');
  for (const x of s.shots) say(`结果｜${x.title}｜${x.method}｜视频：${x.url ? x.verdict : '未生成'}${x.method === 'fl' ? `｜首${x.kf.first.verdict}${x.kf.first.borrowed ? '(借上一镜)' : ''} 尾${x.kf.last.verdict}` : ''}`);
  const f = s.final || {}; say(`成片：${f.status}｜${f.path}｜需要看的：${(f.flags || []).join('；')}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'refilm.cjs'), 'compare', name, id], { encoding: 'utf8' }); console.log(r.stdout, r.stderr);
  say('ALL_DONE');
})().catch(e => { say('中断：' + e.message); say('ALL_DONE'); process.exit(1); });
