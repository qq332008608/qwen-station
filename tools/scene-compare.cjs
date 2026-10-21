'use strict';
// 同一份提示词，两张场景图分别用几个工作流各出一版，存到 workspace/compare/ 下供挑选
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const id = '仙门守御_云海之誓_第1集_云海仙居', F = `D:/openclaw/workspace/productions/${id}/production.json`, OUT = 'D:/openclaw/workspace/compare/' + id; fs.mkdirSync(OUT, { recursive: true });
const load = () => JSON.parse(fs.readFileSync(F, 'utf8')), tag = { 'Qwen Image 2.1 · 文生图2K（本地）': 'QwenImage2K', 'Krea2-文生图-单采': 'Krea2Turbo', 'Z-Image-Turbo · 文生图高清（本地）': 'ZImageTurbo' };
const keep = () => { for (const e of load().elements.filter(x => x.kind === '场景')) { const m = e.images[0]; if (m.path && fs.existsSync(m.path)) { const to = path.join(OUT, `${e.name}_${tag[m.workflow] || 'x'}${path.extname(m.path)}`); fs.copyFileSync(m.path, to); console.log('存：' + to + '｜它的检查：' + (m.verdict || '-')); } } };
keep();
for (const wf of ['Krea2-文生图-单采', 'Z-Image-Turbo · 文生图高清（本地）']) {
  const p = load(); for (const e of p.elements.filter(x => x.kind === '场景')) Object.assign(e.images[0], { workflow: wf, status: 'draft', url: '', path: '', verdict: '', qa: '' }); fs.writeFileSync(F, JSON.stringify(p, null, 1));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run-step.cjs'), id, 'images'], { encoding: 'utf8' }); console.log((r.stdout || '').split('\n').filter(l => /中断|提交 /.test(l)).join('\n')); keep();
}
console.log('COMPARE_DONE');
