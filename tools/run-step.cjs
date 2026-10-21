'use strict';
// node run-step.cjs <集编号> <动作>   跑影视页面里的一步并等它结束
const fs = require('fs'), path = require('path'), CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')), ST = `http://127.0.0.1:${CFG.port}`, H = { 'Content-Type': 'application/json', Origin: ST };
const api = async (p, body) => { const r = await fetch(ST + p, body === undefined ? {} : { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${j.error || r.status}`); return j; };
const [id, action, target] = process.argv.slice(2), one = s => String(s || '').replace(/\s+/g, ' ');
(async () => { const st = () => api('/api/studio/state?id=' + encodeURIComponent(id)); let s = await st(); const seen = new Set(s.log); await api('/api/studio/run', Object.assign({ id, action }, target ? { target } : {}));
  for (;;) { await new Promise(r => setTimeout(r, 4000)); try { s = await st(); } catch (e) { continue; } for (const l of s.log) if (!seen.has(l)) { seen.add(l); if (!/\d+% /.test(l)) console.log(one(l).slice(0, 200)); } if (!s.running) break; }
  for (const e of s.elements) for (const im of e.images) console.log(`图｜${e.name}·${im.label}｜${im.status}｜${im.verdict || '-'}｜${im.path || ''}`); console.log('STEP_DONE');
})().catch(e => { console.log('中断：' + e.message); process.exit(1); });
