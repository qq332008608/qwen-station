'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const id = '仙门守御_云海之誓_第1集_云海仙居', F = `D:/openclaw/workspace/productions/${id}/production.json`, ST = 'http://127.0.0.1:18800', H = { 'Content-Type': 'application/json', Origin: ST };
const api = async (p, body) => { const r = await fetch(ST + p, { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${j.error || r.status}`); return j; };
const load = () => JSON.parse(fs.readFileSync(F, 'utf8')), save = p => fs.writeFileSync(F, JSON.stringify(p, null, 1));
const step = (a, t) => { const r = spawnSync(process.execPath, [path.join(__dirname, 'run-step.cjs'), id, a].concat(t ? [t] : []), { encoding: 'utf8', maxBuffer: 64 << 20 }); console.log(`#### ${a} ${t || ''}\n` + (r.stdout || '').split('\n').filter(l => /中断|关键帧完成|镜头完成|成片|没通过|借/.test(l)).map(l => l.slice(0, 220)).join('\n')); };
const CRE = 'A creature design reference sheet of ONE single animal shown three times on a plain light grey studio background: left, full body side view standing on all four legs; center, full body front view standing on all four legs; right, close-up of the head in three-quarter view. The same animal in all three views, identical colors and features. A real quadruped animal: no clothing, no armor, not standing upright, no human posture, no text. The animal: ';
(async () => {
  let p = load(); const el = n => p.elements.find(e => e.name === n), yl = el('云麟'), yu = el('云纹白玉佩'), ly = el('镇派灵玉'), sc = el('沈砚青');
  yl.description = '（非人形的生物：四足着地，不穿衣服，不直立。它的参考图是同一只生物的三个角度，画面里只出现一只）云麟是一只幼狮体型的灵兽，约四个月大的小白狮，中型犬大小，可以被人用双臂抱在怀里。明确是狮子幼崽的脸：宽吻、狮鼻、圆耳、粗壮的四肢和厚实的脚掌。通体雪白色蓬松短毛。额头正中长着一支约八厘米长、晶莹透亮的水晶独角，角尖发出淡蓝色荧光，独角在任何角度都清楚可见。双眼深琥珀色。尾巴细长，尾端一撮白毛。';
  Object.assign(yl.images[0], { status: 'draft', url: '', path: '', verdict: '', qa: '', prompt: CRE + 'a young white lion cub about four months old, the size of a medium dog, clearly a lion cub and not a cat or a dog: broad muzzle, lion nose, rounded ears, sturdy legs and thick paws, pure snow-white fluffy short fur. One distinct translucent crystal horn about eight centimeters long rising from the center of its forehead, the tip glowing pale blue, clearly visible in every view. Deep amber eyes. A slender tail with a white tuft at the end. A noble little mythical beast, calm and alert. Photorealistic, cinematic, soft light, fine fur detail.' });
  save(p); step('images'); p = load(); const m = p.elements.find(e => e.name === '云麟').images[0]; console.log('云麟：' + m.verdict + '｜' + m.path); if (m.url) await api('/api/studio/mark', { id, kind: 'image', target: m.id, status: 'approved', comment: '' });
  p = load(); const S = p.shots, R = (...xs) => xs.map(([e, lab]) => { const E = p.elements.find(k => k.name === e), im = (lab && E.images.find(i => i.label === lab)) || E.images[0]; return { el: E.id, img: im.id }; });
  const sq = p.elements.find(e => /广场/.test(e.name)).name;
  Object.assign(S[1], { size: '全景', move: '静止', beat: '动作', start: '沈砚青位于画面中央的近处，站在广场中轴线上，背对镜头，面朝远处的凌霄殿，全身可见，银白长发和碧青长袍的衣摆被晨风轻轻吹动。', action: '他沿着广场中轴线缓步向前，朝凌霄殿的方向走去，一步一步走远。', end: '沈砚青位于画面中央稍远的位置，仍然背对镜头走向凌霄殿，身形比开始时小，长发和衣摆仍在飘动。', refs: R([sq], ['沈砚青']) });
  Object.assign(S[2], { size: '全景', move: '静止', beat: '动作', start: '沈砚青位于画面左侧的竹林小径上，全身可见，侧身面朝画面右侧，双臂把幼狮体型的云麟抱在胸前。', action: '他抱着云麟沿着青苔石径缓步走到画面中央的林间空地，停下脚步。', end: '沈砚青位于画面中央的林间空地，全身可见，景别和开始时一样是全景，面朝画面深处的云海，双臂仍把云麟抱在胸前，云麟半眯着眼。', refs: R(['殿后竹林'], ['沈砚青'], ['云麟']) });
  Object.assign(S[3], { size: '中景', move: '静止', beat: '动作', start: '沈砚青位于画面左侧，腰部以上可见，面朝画面右侧的云海，左臂把云麟抱在胸前，右手垂在身侧；他面前的空中什么都没有。', action: '他眉梢微动，抬起右手，指尖轻轻一弹，一枚扁平圆形、刻着云纹的白玉佩从他腰间飞出，悬停在他面前画面右侧的半空，玉佩表面迅速布满细密的裂纹。', end: '沈砚青位于画面左侧，眼神凝重地看着画面右侧半空中悬停的那一枚扁平圆形白玉佩，玉佩表面布满裂纹；他左臂仍抱着云麟，右手停在身前。', refs: R(['殿后竹林'], ['沈砚青'], ['云麟'], ['云纹白玉佩', '布满裂纹']) });
  Object.assign(S[4], { size: '中景', move: '缓慢推近', beat: '静态', start: '从沈砚青的右后方拍：他位于画面左侧，背对镜头，左臂抱着云麟；画面右侧半空悬停着那枚布满裂纹的扁平圆形白玉佩；远处是白色的云海。', action: '远处云海的白雾里慢慢透出一层紫红色的光，像血滴进牛奶一样缓缓扩散。沈砚青一动不动地望着，轻声说：“来了。”', end: '机位略微推近：沈砚青仍位于画面左侧背对镜头，左臂抱着云麟，裂纹白玉佩仍悬停在画面右侧半空；远处的云海已经被紫红色的光染透。', refs: R(['殿后竹林'], ['沈砚青'], ['云麟'], ['云纹白玉佩', '布满裂纹']) });
  for (const s of S.slice(1)) { s.method = 'fl'; s.kf = { first: { status: 'draft' }, last: { status: 'draft' } }; s.nodeId = ''; s.status = 'draft'; s.url = ''; s.verdict = ''; s.qa = ''; }
  save(p);
  for (const s of S.slice(1)) { step('keyframes', s.id); step('videos', s.id); }
  step('final');
  p = load(); for (const s of p.shots) console.log(`结果｜${s.title}｜视频：${s.url ? s.verdict : '未生成'}${s.kf && s.kf.first ? `｜首${s.kf.first.verdict}${s.kf.first.borrowed ? '(借)' : ''} 尾${s.kf.last.verdict}` : ''}｜${String(s.qa).replace(/\s+/g, ' ').slice(-110)}`);
  const f = p.final || {}; console.log(`成片：${f.status}｜${f.path}\n需要看的：${(f.flags || []).join('；')}`); console.log('EP_DONE');
})().catch(e => { console.log('中断：' + e.message); console.log('EP_DONE'); process.exit(1); });
