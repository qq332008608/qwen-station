'use strict';
// 一集的无人值守跑法。node ep-go.cjs <第几章> A   → 剧本、设定扩写、分镜、主图（停下来给人看图）
//                     node ep-go.cjs <第几章> B   → 通过全部图、出补充图、首尾帧、视频、合成
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const [no, phase] = process.argv.slice(2), TXT = 'C:/Users/llc33/Desktop/仙门守御：云海之誓（扩写完整版）.txt', WS = 'D:/openclaw/workspace', ST = 'http://127.0.0.1:18800', H = { 'Content-Type': 'application/json', Origin: ST };
const api = async (p, body) => { const r = await fetch(ST + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${j.error || r.status}`); return j; };
const node = (file, args) => spawnSync(process.execPath, [path.join(__dirname, file)].concat(args), { encoding: 'utf8', maxBuffer: 64 << 20 }).stdout || '';
const find = () => fs.readdirSync(WS + '/productions').find(d => d.startsWith(`仙门守御_云海之誓_第${no}集_`));
(async () => {
  if (phase === 'A') { console.log(node('episode.cjs', [TXT, no])); const id = find(); console.log(node('run-step.cjs', [id, 'images']).split('\n').filter(l => /图｜|中断/.test(l)).join('\n')); console.log('PHASE_DONE ' + id); return; }
  const id = find(), F = `${WS}/productions/${id}/production.json`, load = () => JSON.parse(fs.readFileSync(F, 'utf8'));
  const approveAll = async () => { for (const e of load().elements) for (const im of e.images) if (im.url && im.status !== 'approved') await api('/api/studio/mark', { id, kind: 'image', target: im.id, status: 'approved', comment: '' }); };
  const step = a => console.log(`#### ${a}\n` + node('run-step.cjs', [id, a]).split('\n').filter(l => /中断|关键帧完成|镜头完成|成片|没通过|借/.test(l)).map(l => l.slice(0, 220)).join('\n'));
  await approveAll(); if (load().elements.some(e => e.images.some(i => i.status !== 'approved'))) { step('images'); await approveAll(); }
  for (const e of load().elements) for (const im of e.images) { if (im.status !== 'approved') { console.log(`补充图“${e.name}·${im.label}”没出来，删掉`); await api('/api/studio/save', { id, removeImage: im.id }); } }
  step('auto');
  const p = load(); for (const s of p.shots) console.log(`结果｜${s.title}｜${s.method}｜${s.move}｜视频：${s.url ? s.verdict : '未生成'}｜${(String(s.qa).replace(/\s+/g, ' ').match(/结论[\s\S]{0,120}/) || [''])[0]}`);
  const f = p.final || {}; console.log(`成片：${f.status}｜${f.path}`); console.log('PHASE_DONE ' + id);
})().catch(e => { console.log('中断：' + e.message); console.log('PHASE_DONE'); process.exit(1); });
