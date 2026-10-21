'use strict';
// 对标测试：拿一段现成影片 → 拆镜头 → 反推剧情和人物/场景/道具 → 在影视页面里从头重做 → 对比差距。
//   node refilm.cjs analyze <视频路径> [起始秒] [时长秒，默认 120]   拆片并反推，结果在 workspace/references/<名字>/
//   node refilm.cjs make <名字>                                      用反推结果在平台里新建一集（之后在页面上照常确认、制作）
//   node refilm.cjs compare <名字> <这一集的编号>                    成片做完后出对比报告
// 只描述画面里看得到的东西；不认演员、不用原片的片名和角色名，人物一律用通用称呼。
const fs = require('fs'), path = require('path'), http = require('http'), { spawnSync } = require('child_process');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')), WS = CFG.workspace, ST = `http://127.0.0.1:${CFG.port}`;
const FF = path.join(CFG.ffmpegDir, 'ffmpeg.exe'), FP = path.join(CFG.ffmpegDir, 'ffprobe.exe'), REF = path.join(WS, 'references');
const ff = (args, exe) => { const r = spawnSync(exe || FF, args, { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true }); return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' }; };
const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false }), say = s => console.log(`[${stamp()}] ${s}`), r1 = v => Math.round(v * 10) / 10;
function post(url, body, timeoutMs) {   // 模型调用可能很久，不用 fetch（它 300 秒就断）
  return new Promise((res, rej) => { const u = new URL(url), data = Buffer.from(JSON.stringify(body)); const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, Origin: ST } }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => { try { const j = JSON.parse(Buffer.concat(c).toString('utf8')); r.statusCode < 300 ? res(j) : rej(new Error(j.error && (j.error.message || j.error) || r.statusCode)); } catch (e) { rej(e); } }); }); q.setTimeout(timeoutMs || 1200000, () => q.destroy(new Error('超时'))); q.on('error', rej); q.end(data); });
}
async function ask(text, images, maxTokens) {
  const content = (images || []).map(f => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + fs.readFileSync(f).toString('base64') } })).concat([{ type: 'text', text }]);
  const j = await post(CFG.model.baseUrl + '/v1/chat/completions', { model: CFG.model.id, temperature: 0.2, max_tokens: maxTokens || 900, messages: [{ role: 'user', content }] });
  return String(j.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
const json = s => { const m = s.match(/\{[\s\S]*\}/); if (!m) throw new Error('模型没有按格式回答：' + s.slice(0, 120)); return JSON.parse(m[0]); };
const sizes = list => { const c = {}; for (const s of list) c[s || '未标'] = (c[s || '未标'] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join('、'); };
function sheet(video, times, out) {   // 每个时间点取一帧，拼成一张接触表
  const dir = out + '_tmp'; fs.mkdirSync(dir, { recursive: true });
  times.forEach((t, i) => ff(['-v', 'error', '-y', '-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2', path.join(dir, String(i).padStart(3, '0') + '.jpg')]));
  const cols = 6, rows = Math.ceil(times.length / cols); ff(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(dir, '%03d.jpg'), '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-q:v', '3', out]); fs.rmSync(dir, { recursive: true, force: true });
}

async function analyze(src, start, dur) {
  if (!fs.existsSync(src)) throw new Error('找不到视频：' + src);
  const name = path.basename(src, path.extname(src)).replace(/[^\w一-龥-]+/g, '_').slice(0, 30) + (start ? `_${Math.round(start)}s` : ''), dir = path.join(REF, name), clip = path.join(dir, 'clip.mp4');
  fs.mkdirSync(path.join(dir, 'shots'), { recursive: true });
  fs.rmSync(path.join(dir, 'analysis.raw.json'), { force: true }); say('截取片段…'); let r = ff(['-v', 'error', '-y', '-ss', String(start), '-t', String(dur), '-i', src, '-vf', 'scale=960:-2', '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k', clip]); if (!r.ok) throw new Error('截取失败：' + r.err.slice(-300));
  const total = parseFloat(ff(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip], FP).out) || dur;
  say('找镜头切换点…'); r = ff(['-hide_banner', '-i', clip, '-vf', "select='gt(scene,0.30)',showinfo", '-an', '-f', 'null', '-']);
  let cuts = [...r.err.matchAll(/pts_time:([\d.]+)/g)].map(m => parseFloat(m[1])).filter(t => t > 0.4 && t < total - 0.4);
  const bounds = [0]; for (const t of cuts) if (t - bounds[bounds.length - 1] >= 0.8) bounds.push(t); bounds.push(total);   // 短于 0.8 秒的并进前一个镜头
  const shots = bounds.slice(0, -1).map((t, i) => ({ n: i + 1, t: r1(t), dur: r1(bounds[i + 1] - t) }));
  say(`共 ${shots.length} 个镜头，平均 ${r1(total / shots.length)} 秒一个。开始逐个看（每个约一分钟）…`);
  let cast = '';
  for (const s of shots) {
    const img = path.join(dir, 'shots', String(s.n).padStart(3, '0') + '.jpg'), a = s.t + s.dur * 0.12, m = s.t + s.dur * 0.5, b = s.t + s.dur * 0.88;
    ff(['-v', 'error', '-y', '-ss', String(a), '-i', clip, '-ss', String(m), '-i', clip, '-ss', String(b), '-i', clip, '-filter_complex', '[0:v]scale=640:-2[a];[1:v]scale=640:-2[b];[2:v]scale=640:-2[c];[a][b][c]hstack=inputs=3', '-frames:v', '1', '-q:v', '4', img]);
    try {
      const j = json(await ask(`这张图是一部电影里同一个镜头的三帧，从左到右是开头、中间、结尾。这个镜头长 ${s.dur} 秒。只描述看得到的东西，不要猜片名，不要认演员，人物用通用称呼。\n前面的镜头里已经出现过的人物：${cast || '（还没有）'}\n同一个人再次出现时必须沿用上面的称呼；新出现的人起一个新称呼（如“短发女人”“灰衣老人”）。\n\n输出 JSON：{"size":"远景/全景/中景/近景/特写","angle":"机位：平视/俯拍/仰拍，从正面/侧面/背后，是否在运动","place":"地点和环境、时间、光线","people":[{"name":"称呼","look":"年龄、体型、发型、服装、显眼特征"}],"props":["画面里被拿着或被用到的物件"],"start":"开头时人在哪、什么姿态","action":"这个镜头里发生的一个动作","end":"结尾时的状态","mood":"色调和气氛"}`, [img], 700));
      Object.assign(s, { size: String(j.size || ''), angle: String(j.angle || ''), place: String(j.place || ''), people: Array.isArray(j.people) ? j.people : [], props: Array.isArray(j.props) ? j.props : [], start: String(j.start || ''), action: String(j.action || ''), end: String(j.end || ''), mood: String(j.mood || '') });
      for (const p of s.people) if (p && p.name && !cast.includes(p.name)) cast += `${cast ? '；' : ''}${p.name}（${String(p.look || '').slice(0, 60)}）`;
      s.desc = `${s.place ? s.place.slice(0, 40) + '：' : ''}${s.action}`;
    } catch (e) { s.desc = '（没看出来：' + e.message.slice(0, 60) + '）'; }
    say(`镜头 ${s.n}/${shots.length}｜${s.dur} 秒｜${s.size || '?'}｜${(s.desc || '').slice(0, 70)}`);
    fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify({ name, source: src, start, seconds: r1(total), shots }, null, 1));
  }
  say('反推剧情和设定…');
  const table = shots.map(s => `${s.n}｜${s.dur}秒｜${s.size}｜${s.angle}｜${s.place}｜人物：${(s.people || []).map(p => p.name).join('、') || '无'}｜道具：${(s.props || []).join('、') || '无'}｜${s.start} → ${s.action} → ${s.end}`).join('\n');
  const syn = json(await ask(`下面是一段 ${r1(total)} 秒影片的逐镜头记录，和记录里出现过的人物。请把它反推成一份可以交给别人重新拍摄的文字材料。不要写片名、演员名和原片的角色名，人物用通用称呼或你另起的普通名字。\n\n# 人物\n${cast}\n\n# 逐镜头记录\n${table}\n\n输出 JSON：{"title":"你起的中文短标题","story":"按时间顺序把这段戏写成一段小说式的叙述（300 到 600 字）：谁、在哪、做了什么、结果怎样。只写记录里有的事","characters":[{"name":"称呼","look":"外貌和服装，写确定的特征"}],"scenes":[{"name":"地点名（记录里地点名相同的就是同一个场景，只列一次）","look":"空间、固定物件的摆放、时间和光线"}],"props":[{"name":"道具名","look":"外形；能开合的写明"}],"style":"视觉风格：色调、光线、质感、时代","craft":"原片在镜头上是怎么做的：景别怎么安排、镜头长短的节奏、机位运动的特点（3 到 5 句）"}`, [], 2500));
  const brief = `${syn.story}\n\n人物：\n${(syn.characters || []).map(c => `${c.name}：${c.look}`).join('\n')}\n\n场景：\n${(syn.scenes || []).map(c => `${c.name}：${c.look}`).join('\n')}\n\n道具：\n${(syn.props || []).map(c => `${c.name}：${c.look}`).join('\n')}`;
  sheet(clip, shots.map(s => s.t + s.dur / 2), path.join(dir, 'reference_sheet.jpg'));
  const A = { name, source: src, start, seconds: r1(total), shots, synthesis: syn, brief, stats: { shots: shots.length, asl: r1(total / shots.length), sizes: sizes(shots.map(s => s.size)) } };
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(A, null, 1));
  fs.writeFileSync(path.join(dir, '拆片报告.md'), `# 参考片拆解：${syn.title}\n\n片段长 ${A.seconds} 秒，${A.stats.shots} 个镜头，平均 ${A.stats.asl} 秒一个。景别：${A.stats.sizes}。\n\n## 原片的做法\n${syn.craft}\n\n## 视觉风格\n${syn.style}\n\n## 反推的原文\n${brief}\n\n## 镜头表\n| # | 起点 | 时长 | 景别 | 机位 | 内容 |\n|---|---|---|---|---|---|\n${shots.map(s => `| ${s.n} | ${s.t}s | ${s.dur}s | ${s.size || ''} | ${(s.angle || '').replace(/\|/g, '/')} | ${(s.desc || '').replace(/\|/g, '/')} |`).join('\n')}\n`);
  say(`完成。名字：${name}\n目录：${dir}\n下一步：node refilm.cjs make ${name}`);
}

async function synth(dir, A) {
  const shots = A.shots, cast = A.cast || '', total = A.seconds, name = A.name;
  const table = shots.map(s => `${s.n}｜${s.dur}秒｜${s.size}｜${s.angle}｜${s.place}｜人物：${(s.people || []).map(p => p.name).join('、') || '无'}｜道具：${(s.props || []).join('、') || '无'}｜${s.start} → ${s.action} → ${s.end}${s.note ? '｜通看后更正：' + s.note : ''}`).join('\n');
  const syn = json(await ask(`下面是一段 ${r1(total)} 秒影片的逐镜头记录，和记录里出现过的人物。请把它反推成一份可以交给别人重新拍摄的文字材料。不要写片名、演员名和原片的角色名，人物用通用称呼或你另起的普通名字。有“通看后更正”的以更正为准。\n\n# 人物\n${cast}\n\n# 逐镜头记录\n${table}\n\n输出 JSON：{"title":"你起的中文短标题","story":"按时间顺序把这段戏写成一段小说式的叙述（400 到 700 字）：谁、在哪、做了什么、看到了什么、结果怎样。每个镜头里的事都要写到，只写记录里有的事","characters":[{"name":"称呼","look":"外貌和服装，写确定的特征"}],"scenes":[{"name":"地点名","look":"空间、固定物件的摆放、时间和光线"}],"props":[{"name":"道具名","look":"外形；能开合的写明"}],"style":"视觉风格：色调、光线、质感、时代","craft":"原片在镜头上是怎么做的：景别怎么安排、镜头长短的节奏、机位运动的特点（3 到 5 句）"}`, [], 2800));
  const brief = `${syn.story}\n\n人物：\n${(syn.characters || []).map(c => `${c.name}：${c.look}`).join('\n')}\n\n场景：\n${(syn.scenes || []).map(c => `${c.name}：${c.look}`).join('\n')}\n\n道具：\n${(syn.props || []).map(c => `${c.name}：${c.look}`).join('\n')}`;
  Object.assign(A, { synthesis: syn, brief, stats: { shots: shots.length, asl: r1(total / shots.length), sizes: sizes(shots.map(s => s.size)) } }); delete A.production;
  fs.writeFileSync(path.join(dir, 'analysis.json'), JSON.stringify(A, null, 1));
  fs.writeFileSync(path.join(dir, '拆片报告.md'), `# 参考片拆解：${syn.title}\n\n片段长 ${A.seconds} 秒，${A.stats.shots} 个镜头，平均 ${A.stats.asl} 秒一个。景别：${A.stats.sizes}。\n\n## 原片的做法\n${syn.craft}\n\n## 视觉风格\n${syn.style}\n\n## 反推的原文\n${brief}\n\n## 镜头表\n| # | 起点 | 时长 | 景别 | 内容 | 通看后更正 |\n|---|---|---|---|---|---|\n${shots.map(s => `| ${s.n} | ${s.t}s | ${s.dur}s | ${s.size || ''} | ${(s.desc || '').replace(/\|/g, '/')} | ${(s.note || '').replace(/\|/g, '/')} |`).join('\n')}\n`);
}
// 通看：逐个镜头看的时候它认不出“这两个其实是同一个人”“这是从瞄准镜里看到的”，所以把全部镜头拼成几张大图再看一遍
async function review(name) {
  const dir = path.join(REF, name), rawF = path.join(dir, 'analysis.raw.json'); if (!fs.existsSync(rawF)) fs.copyFileSync(path.join(dir, 'analysis.json'), rawF);   // 通看每次都从逐镜头的原始记录开始，不在改过的数据上再改
  const A = JSON.parse(fs.readFileSync(rawF, 'utf8')), clip = path.join(dir, 'clip.mp4'), shots = A.shots, notes = [], placeNames = []; delete A.cast;
  if (!A.cast) { const seen = new Map(); for (const s of shots) for (const p of s.people || []) if (p && p.name && !seen.has(p.name)) seen.set(p.name, String(p.look || '').slice(0, 60)); A.cast = [...seen].map(([k, v]) => `${k}（${v}）`).join('；'); }
  for (let i = 0; i < shots.length; i += 8) {   // 每 8 个镜头一张图：两行，每个镜头一帧，图够大才看得清脸
    const part = shots.slice(i, i + 8), img = path.join(dir, `review_${i / 8 + 1}.jpg`), tmp = img + '_tmp'; fs.mkdirSync(tmp, { recursive: true });
    part.forEach((s, k) => ff(['-v', 'error', '-y', '-ss', String(s.t + s.dur / 2), '-i', clip, '-frames:v', '1', '-vf', `scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2,drawtext=text='${s.n}':x=8:y=8:fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.6`, path.join(tmp, String(k).padStart(3, '0') + '.jpg')]));
    ff(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmp, '%03d.jpg'), '-vf', 'tile=4x2', '-frames:v', '1', '-q:v', '3', img]); fs.rmSync(tmp, { recursive: true, force: true });
    say(`通看第 ${i + 1}–${i + part.length} 个镜头…`);
    try {
      const j = json(await ask(`这张图是同一段影片里连续的 ${part.length} 个镜头，每个镜头一帧，左上角的黄色数字是镜头号，顺序是从左到右、从上到下。\n之前逐个镜头看时的记录：\n${part.map(s => `${s.n}｜${s.size}｜人物：${(s.people || []).map(p => p.name).join('、') || '无'}｜${s.desc}`).join('\n')}\n之前登记的人物：${A.cast}${notes.length ? '\n前面几批通看已经确定的：' + notes.join('；') : ''}${placeNames.length ? '\n前面几批已经定名的地点（再出现时沿用同一个名字）：' + placeNames.map(k => k.name + '（' + k.look + '）').join('；') : ''}\n\n现在把这些镜头放在一起看，找出之前记录里的错误：\n1) 同一个人被当成了两个人（比对脸、发型、胡子、衣服）。\n2) 镜头其实是某个人物通过望远镜、瞄准镜、窗户、屏幕看到的画面（圆形或带黑边的视野，前后镜头里有人正在看）。\n3) 人物记错了（这个镜头里根本没有那个人，或者动作是另一个人做的）。\n4) 画面里重要的东西没记（飞行器、机器、文字标题等）。\n5) 同一个地点被当成了两个地方（比对栏杆、墙、地面、背景和光线；同一个地方换了机位仍然是同一个地点）。给每个镜头定一个地点名，同一个地点用完全相同的名字。\n\n输出 JSON：{"same":[{"names":["称呼A","称呼B"],"use":"统一后的称呼","look":"这个人确定的外貌"}],"fix":[{"n":镜头号,"note":"这个镜头实际是什么：谁、在做什么、看到的是什么"}],"places":[{"name":"地点名","look":"这个地点固定的样子","shots":[镜头号]}]}，没有就给空数组。`, [img], 1400));
      for (const m of j.same || []) { const names = (m.names || []).filter(Boolean); if (names.length < 2 || !m.use) continue; const both = shots.find(s => names.filter(nm => (s.people || []).some(p => p.name === nm)).length > 1); if (both) { say('  不合并 ' + names.join(' / ') + '：他们在镜头 ' + both.n + ' 里同时出现，是两个人'); continue; } for (const s of shots) { for (const p of s.people || []) if (names.includes(p.name)) { p.name = m.use; if (m.look) p.look = m.look; } for (const k of ['desc', 'start', 'action', 'end']) for (const nm of names) if (s[k]) s[k] = s[k].split(nm).join(m.use); } notes.push(`${names.join('、')} 是同一个人，统一叫“${m.use}”（${m.look || ''}）`); say('  同一个人：' + names.join(' = ') + ' → ' + m.use); }
      for (const pl of j.places || []) { if (!pl || !pl.name) continue; const old = placeNames.find(k => k.name === pl.name) || (placeNames.push({ name: String(pl.name).slice(0, 20), look: String(pl.look || '').slice(0, 120) }), placeNames[placeNames.length - 1]); for (const n of pl.shots || []) { const s = shots.find(x => x.n === Number(n)); if (s) s.place = `${old.name}（${old.look}）`; } }
      for (const f of j.fix || []) { const s = shots.find(x => x.n === Number(f.n)); if (s && f.note) { s.note = String(f.note).slice(0, 200); s.desc = s.note.slice(0, 160); say(`  更正镜头 ${s.n}：${s.note.slice(0, 90)}`); } }
    } catch (e) { say('  这一批没看成：' + e.message.slice(0, 80)); }
  }
  const seen = new Map(); for (const s of shots) { const u = new Map(); for (const p of s.people || []) if (p && p.name && !u.has(p.name)) u.set(p.name, p); s.people = [...u.values()]; for (const p of s.people) if (!seen.has(p.name)) seen.set(p.name, String(p.look || '').slice(0, 80)); }
  A.cast = [...seen].map(([k, v]) => `${k}（${v}）`).join('；'); A.reviewed = notes;
  say('按通看结果重新反推…'); await synth(dir, A); say('完成。人物：' + A.cast);
}

async function make(name) {
  const A = JSON.parse(fs.readFileSync(path.join(REF, name, 'analysis.json'), 'utf8')); if (!A.brief) throw new Error('这个参考片还没拆完');
  const j = await post(ST + '/api/studio/new', { seriesName: '对标' + new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '') + '_' + name.slice(0, 16), title: A.synthesis.title || '对标重做', brief: A.brief, ratio: '16:9', resolution: '768P', style: A.synthesis.style || '', reference: { source: name, seconds: A.seconds, shots: A.shots.map(s => ({ t: s.t, dur: s.dur, size: s.size, desc: s.desc })) } }, 30000);
  A.production = j.id; fs.writeFileSync(path.join(REF, name, 'analysis.json'), JSON.stringify(A, null, 1)); say(`已新建：${j.id}\n在影视页面里打开它，照常走：写剧本 → 拆设定 → 出图确认 → 自动完成全片。`);
}

async function compare(name, id) {
  const dir = path.join(REF, name), A = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8')), P = JSON.parse(fs.readFileSync(path.join(WS, 'productions', id || A.production, 'production.json'), 'utf8'));
  const shots = (P.shots || []).filter(s => s.url), final = P.final && P.final.path; if (!final || !fs.existsSync(final)) throw new Error('这一集还没有成片');
  const ours = path.join(dir, 'ours_sheet.jpg'); sheet(final, shots.map((s, i) => i * 5 + 2.5), ours);
  const pass = shots.filter(s => s.verdict === '合格').length, secs = shots.length * 5;
  say('让它对着两张接触表找差距…');
  let gap = ''; try { gap = await ask(`第 1 张是一段参考影片的接触表（每个镜头一帧，按顺序从左到右、从上到下），第 2 张是照它重做出来的成片的接触表。\n参考片讲的是：${A.synthesis.story}\n\n先分别如实描述两张接触表各自看到的内容（各一段）。然后逐项比较重做版和参考片的差距，每项写具体看到的现象：1) 故事有没有讲全、顺序对不对；2) 人物是否前后一致；3) 场景和空间是否前后一致；4) 景别和构图的变化是否丰富；5) 光线、色调和质感；6) 明显的画面错误（畸形、多出来的东西、道具变样）。最后列出重做版最需要改进的三点。`, [path.join(dir, 'reference_sheet.jpg'), ours], 1800); } catch (e) { gap = '（没看成：' + e.message + '）'; }
  const md = `# 对标报告：${A.synthesis.title}\n\n| | 参考片 | 重做版 |\n|---|---|---|\n| 时长 | ${A.seconds} 秒 | ${secs} 秒 |\n| 镜头数 | ${A.stats.shots} | ${shots.length} |\n| 平均镜头长度 | ${A.stats.asl} 秒 | 5 秒（固定） |\n| 景别分布 | ${A.stats.sizes} | ${sizes(shots.map(s => s.size))} |\n| 生成方式 | — | ${sizes(shots.map(s => ({ fl: '首尾帧', ref: '参考', cont: '续接', t2v: '空镜' }[s.method] || s.method)))} |\n| 通过自动检查的镜头 | — | ${pass} / ${shots.length} |\n| 成片状态 | — | ${P.final.status} |\n\n接触表：\`reference_sheet.jpg\`（参考片）、\`ours_sheet.jpg\`（重做版）。成片：\`${final}\`\n\n## 没通过检查的镜头\n${shots.filter(s => s.verdict !== '合格').map(s => `- ${s.title}：${String(s.qa || '').replace(/\s+/g, ' ').slice(-160)}`).join('\n') || '无'}\n\n## 它自己对着两张接触表找的差距（模型的观察，未经人工核对）\n${gap}\n`;
  fs.writeFileSync(path.join(dir, '对标报告.md'), md); say('完成：' + path.join(dir, '对标报告.md'));
}

const [cmd, a, b, c] = process.argv.slice(2);
(cmd === 'analyze' ? analyze(a, parseFloat(b) || 0, parseFloat(c) || 120) : cmd === 'review' ? review(a) : cmd === 'make' ? make(a) : cmd === 'compare' ? compare(a, b) : Promise.reject(new Error('用法见文件开头'))).catch(e => { console.log('中断：' + e.message); process.exit(1); });
