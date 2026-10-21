'use strict';
// 影视制作流程（一个页面走完一集）。页面在 /studio。
// 结构：剧集（series）→ 分集（production）。一部剧共用一个资产库：通过确认的角色/场景/道具图片都会存进去，后面的分集直接复用。
// 每个元素可以有多张图：主图 + 补充图（角色的侧面/背面/面部特写/三视图，道具的不同状态，场景的其他机位）。
//   补充图一律以已确认的主图为底图生成（多角度 / 三视图 / 图生图），保证是同一个人、同一件东西、同一个地方。
//   每个镜头按需要挑图：背影镜头用背面图，伞收起之后用收拢状态的图。
// 分工：创作和看画面交给本地模型；建项目、建节点、连线、提交、轮询、质检、入库这些固定步骤由这里的代码执行。
// 你只把关三样：原文、剧本、参考图。之后一键自动完成：分镜（带场记连续性检查）→ 每个镜头的首帧和尾帧 → 用首尾帧生成视频 → 配乐合成。
// 做完后你只改不满意的小段：写一句意见，它重做那一段并重新合成。
// 占显卡的动作只在你点页面按钮时发生，一次按钮就是一批。
const fs = require('fs'), path = require('path'), http = require('http');
const { loadModel } = require('./lib/gpu.cjs');

module.exports = function ({ CFG, WS, ctx: baseCtx, tools, send, readBody, lock }) {
  const DIR = path.join(WS, 'productions'), SDIR = path.join(WS, 'series'), clip = baseCtx.clip, T2I = 'F2K-9B-文生+图生', EDIT = 'Qwen Image 2.1 · 十图全能编辑（本地）', QUAD = 'Qwen Image 2.1 · 文生图2K（本地）', SCENE_VIEWS = 0;   // 一个场景除主图外再出几张机位图。现在是 0：整场只用主图一个机位，先保证空间不变
  fs.mkdirSync(DIR, { recursive: true }); fs.mkdirSync(SDIR, { recursive: true });
  const safe = s => String(s || '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50);
  const rid = k => k + Math.random().toString(36).slice(2, 8);
  const read = f => { try { return fs.readFileSync(path.join(WS, f), 'utf8'); } catch (e) { return ''; } };
  const file = id => path.join(DIR, safe(id), 'production.json'), sfile = sid => path.join(SDIR, safe(sid), 'series.json');
  const save = p => { p.updatedAt = Date.now(); fs.mkdirSync(path.dirname(file(p.id)), { recursive: true }); fs.writeFileSync(file(p.id), JSON.stringify(p, null, 1)); };
  const loadSeries = sid => JSON.parse(fs.readFileSync(sfile(sid), 'utf8'));
  function saveSeries(s) {
    fs.mkdirSync(path.dirname(sfile(s.id)), { recursive: true }); fs.writeFileSync(sfile(s.id), JSON.stringify(s, null, 1));
    // 给人看的资产清单，和图片放在一起
    fs.writeFileSync(path.join(SDIR, s.id, '资产清单.md'), `# 《${s.name}》资产库\n\n画幅 ${s.ratio}｜视频分辨率 ${s.resolution}｜风格：${s.style || '未填'}\n\n` + ['角色', '场景', '道具'].map(k => `## ${k}\n\n` + (s.assets.filter(a => a.kind === k).map(a => `### ${a.name}\n\n${a.description}\n\n` + a.images.map(i => `- ${i.label}：\`${i.file}\`（来自 ${i.from}）`).join('\n')).join('\n\n') || '（暂无）')).join('\n\n') + `\n\n## 分集\n\n` + (s.episodes.map(e => `- 第 ${e.n} 集 ${e.title}：${e.summary || '（未完成）'}`).join('\n') || '（暂无）') + '\n');
  }
  // 旧版数据（每个元素只有一张图）转成新结构
  function load(id) {
    const p = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    for (const e of p.elements || []) if (!e.images) e.images = [{ id: rid('im_'), label: '主图', mode: 't2i', prompt: e.prompt || '', workflow: e.workflow || T2I, nodeId: e.nodeId, url: e.url, path: e.path, qa: e.qa, verdict: e.verdict, status: e.status || 'draft' }];
    for (const s of p.shots || []) s.refs = (s.refs || []).map(r => typeof r === 'string' ? (e => e ? { el: e.id, img: e.images[0].id } : null)((p.elements || []).find(e => e.id === r)) : r).filter(Boolean);
    return p;
  }
  let job = null;
  const log = (p, t) => { const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${t}`; (p.log = p.log || []).push(line); if (p.log.length > 200) p.log.splice(0, p.log.length - 200); save(p); };
  const stopIf = () => { if (job && job.abort) throw new Error('已按你的要求停止'); };

  // ---- 调本地模型
  const guard = { fired: 0, rescued: 0, failed: 0 }; let lastAnswer = '';
  async function llm(system, user, o = {}) {
    let note = '';
    for (let i = 0; ; i++) {
      const r = await llmOnce(system, user + note, o), t = r.text, norm = t.replace(/\s+/g, ' ');
      const why = t.length < (o.minChars || 2) ? '没有给出内容' : r.finish === 'length' ? '写到一半被截断了，没有写完' : (t.match(/```/g) || []).length % 2 ? '代码块没有闭合，内容不完整' : !o.json && norm.length > 200 && norm === lastAnswer ? '和上一次的回答一字不差' : '';
      if (!why) { lastAnswer = norm; if (i) guard.rescued++; return t; }
      guard.fired++; console.log(`[交付护栏] 第 ${i + 1} 次没通过：${why}（累计触发 ${guard.fired}，救回 ${guard.rescued}，失败 ${guard.failed}）`); if (i >= 2) { guard.failed++; throw new Error(`本地模型连续 3 次没有交付（${why}）`); }
      note = `\n\n【交付检查未通过 · 第 ${i + 1} 次重试】上一次的回答${why}。现在只做一件事：立刻输出完整、写完的内容；篇幅不够就先精简，但必须写完；不要只写计划，不要重复上一次的措辞。`;
    }
  }
  function llmOnce(system, user, o = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(CFG.model.baseUrl + '/v1/chat/completions');
      const body = Buffer.from(JSON.stringify(Object.assign({ model: CFG.model.id, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: o.maxTokens || 5000, temperature: o.temperature === undefined ? 0.5 : o.temperature }, o.json ? { response_format: { type: 'json_object' } } : {})));
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => { try { const j = JSON.parse(Buffer.concat(c).toString('utf8')); resolve({ text: String(j.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), finish: j.choices[0].finish_reason }); } catch (e) { reject(new Error('本地模型没有正常返回')); } });
      });
      req.setTimeout(900000, () => req.destroy(new Error('本地模型超时'))); req.on('error', e => reject(new Error('连不上本地模型：' + e.message))); req.end(body);
    });
  }
  async function llmJSON(system, user, o = {}) {
    for (let i = 0; ; i++) {
      const t = await llm(system, user + '\n\n只输出一个 JSON 对象，不要任何解释。', Object.assign({ json: true, temperature: 0.3 }, o));
      try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch (e) { guard.fired++; if (i >= 2) { guard.failed++; throw new Error('模型三次都没有输出合法的 JSON'); } user += `\n\n【交付检查未通过 · 第 ${i + 1} 次重试】上一次输出的不是合法的 JSON（${String(e.message).slice(0, 60)}）。这次只输出一个完整闭合的 JSON 对象，字符串里的引号和换行要转义。`; }
    }
  }
  async function ensureModel(p) {
    if ((await baseCtx.getJSON(CFG.model.baseUrl + '/health', 3000) || {}).status === 'ok') return;
    log(p, '本地模型没在运行，正在加载…'); const r = await loadModel(); if (!r.ok) throw new Error('本地模型加载失败：' + r.text);
  }

  // ---- 调平台工具（工作台、媒体检查）。带确认的工具：你在页面上点按钮就是确认，这里先跑它的预检再执行。
  const tctx = p => Object.assign(Object.create(baseCtx), { progress: t => log(p, t), aborted: () => !!(job && job.abort) });
  async function call(p, name, args) {
    const t = tools.get(name); if (!t) throw new Error('平台缺少工具 ' + name);
    const c = tctx(p); if (t.confirm) await t.confirm(args, c);
    const o = await t.run(args, c); return typeof o === 'string' ? o : JSON.stringify(o);
  }
  const node = async (p, id) => JSON.parse(await call(p, 'wb_node_get', { project: p.project, id }));
  // 空间锁定表：场景里每件固定物的坐标 + 主机位的镜位卡（画面左、中、右各是什么）。出图、首帧和检查都以它为准
  const num = v => Math.round((Number(v) || 0) * 10) / 10;
  const cleanLayout = L => { if (!L || typeof L !== 'object' || !Array.isArray(L.items)) return null; const c = L.camera || {}; const items = L.items.filter(i => i && i.name).slice(0, 14).map(i => ({ name: String(i.name).slice(0, 12), x1: num(Math.min(i.x1, i.x2)), y1: num(Math.min(i.y1, i.y2)), x2: num(Math.max(i.x1, i.x2)), y2: num(Math.max(i.y1, i.y2)) })); if (!items.length) return null;
    const w = num(L.w) || 4, d = num(L.d) || 3, DIRS = { 东: [1, 0], 西: [-1, 0], 南: [0, 1], 北: [0, -1], 东北: [.71, -.71], 东南: [.71, .71], 西北: [-.71, -.71], 西南: [-.71, .71] }, facing = DIRS[String(c.facing)] ? String(c.facing) : '北', f = DIRS[facing];   // “北”在这里就是朝远墙看
    const cam = { x: Math.min(Math.max(c.x === undefined ? w / 2 : num(c.x), 0), w), y: Math.min(Math.max(c.y === undefined ? d : num(c.y), 0), d), facing }, side = { left: [], center: [], right: [], hidden: [] }, warn = [];
    for (const i of items) {   // 每件东西相对机位的方位：正前方左右各 15 度以内算中间，背后的算看不到
      const dx = (i.x1 + i.x2) / 2 - cam.x, dy = (i.y1 + i.y2) / 2 - cam.y, ang = Math.atan2(f[0] * dy - f[1] * dx, f[0] * dx + f[1] * dy) * 180 / Math.PI;
      side[Math.abs(ang) > 80 ? 'hidden' : ang < -15 ? 'left' : ang > 15 ? 'right' : 'center'].push(i.name);
      if (i.x1 < -0.05 || i.y1 < -0.05 || i.x2 > w + 0.05 || i.y2 > d + 0.05) warn.push(`“${i.name}”超出了房间范围`);
    }
    for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) { const p = items[a], q = items[b], thin = n => /门|窗/.test(n.name); if (!thin(p) && !thin(q) && Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1) > 0.15 && Math.min(p.y2, q.y2) - Math.max(p.y1, q.y1) > 0.15) warn.push(`“${p.name}”和“${q.name}”重叠了`); }
    if (w <= 12 && d <= 12 && !items.some(i => /门/.test(i.name))) warn.push('没有标门的位置'); if (side.hidden.length) warn.push(`主机位看不到：${side.hidden.join('、')}`);
    for (const i of items) if (/窗/.test(i.name)) { const wall = i.x2 <= 0.3 ? '西' : i.x1 >= w - 0.3 ? '东' : i.y2 <= 0.3 ? '北' : i.y1 >= d - 0.3 ? '南' : ''; if (!wall) warn.push(`“${i.name}”没有贴着墙`); }
    return { w, d, items, light: String(L.light || '').slice(0, 60), camera: Object.assign(cam, { left: side.left.join('、'), center: side.center.join('、'), right: side.right.join('、') }), warn: warn.slice(0, 8) }; };
  const lockText = e => { const L = e && e.layout; if (!L) return ''; const c = L.camera; return `【空间锁定】房间左右宽 ${L.w} 米、前后深 ${L.d} 米（x 从画面左墙到右墙，y 从远墙到机位身后的近墙）：${L.items.map(i => `${i.name} x=${i.x1}–${i.x2} y=${i.y1}–${i.y2}`).join('；')}。${L.light ? '光线：' + L.light + '。' : ''}【镜位卡】机位在 (${c.x}, ${c.y}) 朝远墙看：画面左侧是${c.left || '—'}；中间是${c.center || '—'}；右侧是${c.right || '—'}。`; };
  const lockQA = e => { const L = e && e.kind === '场景' && e.layout; return L ? `\n4) 按镜位卡核对方位：画面左侧应当是${L.camera.left}，中间应当是${L.camera.center}，右侧应当是${L.camera.right}。先分别写出你在画面左、中、右实际看到的固定物，再逐样比对；任何一样换了位置、左右镜像、缺失，或者多出了锁定表里没有的家具，都是不合格。锁定表里的固定物：${L.items.map(i => i.name).join('、')}。` : ''; };
  const cleanRef = r => { if (!r || !Array.isArray(r.shots) || !r.shots.length) return undefined; return { source: String(r.source || '').slice(0, 200), seconds: num(r.seconds), shots: r.shots.slice(0, 80).map(s => ({ t: num(s.t), dur: num(s.dur), size: String(s.size || '').slice(0, 8), desc: String(s.desc || '').slice(0, 160) })) }; };
  const refText = p => p.reference ? `\n\n# 参考片的镜头表（这一集是照一段 ${p.reference.seconds} 秒、${p.reference.shots.length} 个镜头的现成影片重做的；镜头的顺序、景别和内容照它来。原片的每个镜头对应我们的一个镜头，一个都不要漏，尤其是主观视角、插入的特写和远景；只有短于 2 秒的才允许并进相邻镜头。镜头总数必须在 ${Math.max(4, Math.min(24, p.reference.shots.length) - 2)} 到 ${Math.min(24, p.reference.shots.length)} 个之间）\n${p.reference.shots.map((s, i) => `${i + 1}｜${s.dur} 秒｜${s.size}｜${s.desc}`).join('\n')}` : '';
  // 个别工作流的固定参数（键是“节点号.参数名”）。Krea2 的出厂模板带一个转动漫 LoRA、10 步、simple 调度；用户要的是 8 步、CFG 1、euler + beta、不加 LoRA
  const WF_PARAMS = { 'Krea2-文生图-单采': { '158.steps': 8, '158.cfg': 1, '158.sampler_name': 'euler', '158.scheduler': 'beta', '161.strength_model': 0 } };
  const needApproved = p => { if (!(p.elements || []).length || p.elements.some(e => e.images.some(i => i.status !== 'approved'))) throw new Error('还有参考图没确认（或者有不想要的补充图没删掉）。全部点“通过”后才能开始做视频。'); };
  const nodeId = s => (String(s).match(/节点 (n_[a-z0-9]+)/) || [])[1];
  const mediaUrl = u => u ? CFG.workbench + u : '';
  function pathToUrl(disk) { const root = (CFG.readRoots || [])[0] || '', rel = path.relative(root, disk).split(path.sep); return rel.length > 1 && rel[0] !== '..' ? `${CFG.workbench}/api/project-media?folder=${encodeURIComponent(rel[0])}&file=${encodeURIComponent(rel.slice(1).join('/'))}` : ''; }
  async function catalog() { const j = await baseCtx.getJSON(CFG.workbench + '/api/workflows/catalog', 8000); if (!j) throw new Error('影视工作台没有运行。请先用桌面的“Qwen Station 影视制作”启动，或启动 AI影视生成总台。'); return j.items; }
  const imageWorkflows = items => items.filter(w => w.category === 'image' && !['C', 'D'].includes(w.tier)).map(w => w.name);
  async function gpuFree() {
    for (const port of CFG.comfyPorts) { const q = await baseCtx.getJSON(`http://127.0.0.1:${port}/queue`, 3000); if (q && ((q.queue_running || []).length || (q.queue_pending || []).length)) throw new Error(`ComfyUI（${port}）里还有别的任务在跑或排队。等它结束再点，不会去打断它。`); }
  }
  async function ensureProject(p) {
    if (p.project) return; p.project = p.id; save(p);
    try { log(p, await call(p, 'wb_project_new', { name: p.project })); } catch (e) { if (!/已经有/.test(e.message)) { p.project = ''; save(p); throw e; } await call(p, 'wb_canvas', { project: p.project }); }
  }
  const verdict = t => { const m = String(t).match(/结论[:：]\s*\**\s*(不合格|合格)/); return m ? m[1] : '未判定'; };
  const VERDICT_ASK = '\n最后单独一行写“结论：合格”或“结论：不合格”，不合格时在后面用一句话写原因。';
  const GUIDE = () => read('knowledge/workflow-routing.md');
  const DIRECTOR = '你是这部剧的导演和编剧，为本地 AI 影视工作台（ComfyUI）准备可执行的内容。写得具体、可拍、克制：每个镜头只有一个主要动作，画面里不要出现文字，除非需求明确要求。不要编造工作流名称。';

  // 写剧本、写分镜、设计首尾帧时带上导演手册（knowledge/director-handbook.md）
  const CRAFT = () => DIRECTOR + '\n\n# 导演手册（必须遵守）\n' + read('knowledge/director-handbook.md');

  const METHOD = { ref: '参考', fl: '首尾帧', cont: '续接', t2v: '空镜' };

  // ---- 元素与图片
  const master = e => e.images[0];
  const WORD = { 角色: '角色', 场景: '地点', 道具: '物品' };
  // 补充图用什么方式生成：角色的侧/背/四分之三走多角度工作流（真实转动相机），三视图走三视图工作流，其余（面部特写、换造型、道具状态、场景其他机位）走图生图
  function variantSpec(kind, label) {
    if (kind === '角色' && label !== '四视图' && false) {   // 人物统一用单张四视图设定图，不再分开出侧面、背面
      if (/三视图/.test(label)) return { mode: 'threeview', workflow: 'Krea-三视图' };
      const az = /背/.test(label) ? 180 : /四分之三|斜侧|3\/4/.test(label) ? 45 : /侧/.test(label) ? 90 : null;
      if (az !== null) return { mode: 'angle', workflow: 'F2K-9B-多角度', azimuth: az };
    }
    return { mode: 'i2i', workflow: EDIT };   // 实测：普通图生图改不动状态和机位，还会把东西换掉；指令式编辑模型才能“同一件东西，换个状态”
  }
  function newVariant(e, label, prompt) {
    label = String(label || '').trim().slice(0, 20); if (!label || e.images.some(i => i.label === label || i.label === `主图（${label}）`)) return null;   // 主图已经是这个状态就不重复出
    const spec = variantSpec(e.kind, label);
    const auto = spec.mode === 'angle' ? `The same character as in the reference image, seen from a different camera angle (${label}), full body, same outfit and hairstyle, clean light background.` : spec.mode === 'threeview' ? 'Character turnaround sheet of the same character from the reference image: front view, side view and back view, full body, same outfit, clean light background.' : /面部|脸|特写/.test(label) && e.kind === '角色' ? 'Close-up portrait of the same person as in the reference image, head and shoulders, facing camera, neutral expression, same hairstyle and same clothing, clean light background, sharp facial details.' : '';
    const im = Object.assign({ id: rid('im_'), label, prompt: String(prompt || '').trim() || auto, status: 'draft' }, spec); e.images.push(im); return im;
  }
  const refOf = (p, r) => { const e = (p.elements || []).find(x => x.id === r.el); const im = e && (e.images.find(i => i.id === r.img) || e.images[0]); return e && im ? { e, im } : null; };
  // 通过确认的图存进剧集资产库（复制一份到工作区，之后的分集直接用）
  function toLibrary(p, e, im) {
    if (!p.series || im.fromLibrary || !im.path || !fs.existsSync(im.path)) return;
    const s = loadSeries(p.series); let a = s.assets.find(x => x.id === e.lib) || s.assets.find(x => x.kind === e.kind && x.name === e.name);
    if (!a) { a = { id: rid('as_'), kind: e.kind, name: e.name, description: '', images: [] }; s.assets.push(a); }
    e.lib = a.id; a.description = e.description;
    const rel = `assets/${a.kind}/${safe(a.name)}/${safe(im.label)}${path.extname(im.path) || '.png'}`, dst = path.join(SDIR, s.id, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(im.path, dst);
    a.images = a.images.filter(i => i.label !== im.label).concat({ label: im.label, mode: im.mode, azimuth: im.azimuth, workflow: im.workflow, prompt: im.prompt, file: rel, from: p.name, at: Date.now() });
    saveSeries(s);
  }
  function seriesContext(p) {
    if (!p.series) return ''; const s = loadSeries(p.series), prev = s.episodes.filter(e => e.n < p.episode && e.summary);
    return `\n\n# 这是剧集《${s.name}》的第 ${p.episode} 集\n全剧统一的视觉风格（必须沿用）：${s.style || '未指定'}` + (s.bible ? `\n世界观与人物关系：${s.bible}` : '') + (prev.length ? `\n前情提要：\n${prev.map(e => `第 ${e.n} 集《${e.title}》：${e.summary}`).join('\n')}` : '') + (s.assets.length ? `\n资产库里已有的角色/场景/道具（外貌已经定型，剧本里出现它们时沿用同样的名字，不要改外貌）：\n${s.assets.map(a => `${a.kind}｜${a.name}｜${a.description}`).join('\n')}` : '');
  }

  // ================= 各阶段 =================
  const ACTIONS = {
    // 1 剧本：把原文改编成“分场 + 镜头”的剧本。按导演手册：先分场，每场讲清一件事，镜头宁少勿多，每个镜头写清起始→动作→结束
    async script(p) {
      await ensureModel(p); log(p, '正在把原文改编成剧本…');
      p.script = { confirmed: false, text: await llm(CRAFT(), `把下面的原文（或需求）改编成这一集的拍摄剧本。只改编给到的内容，不添加原文没有的情节、人物和道具。\n\n# 原文\n${p.brief}\n\n画幅：${p.ratio}。视觉风格：${p.style || '由你根据原文决定，并写明'}。${seriesContext(p)}${refText(p)}\n\n# 写法\n- 先分场（同一地点、连续时间为一场），每场先写“本场要让观众看懂的一件事”。\n- 每场 2 到 5 个镜头，全集一般不超过 12 个（有参考片镜头表时以镜头表为准）；时长不预设，镜头数由内容决定，宁少勿多。连续的小动作合并成一个镜头（例如“收伞、推门、走进去”是一个镜头）。\n- 每场第一个镜头要交代清楚地点和人物位置。\n- 每个镜头约 5 秒，写成“起始状态 → 一个动作 → 结束状态”。状态要写明：人在画面的什么位置、面朝哪边、手里拿着什么及其状态、门窗等是开是关。同一场里下一个镜头的起始状态必须等于上一个镜头的结束状态；人物只往前走，不折返；行进方向保持一致。\n\n# 输出格式（纯文本，不要 Markdown 符号）\n片名：\n一句话梗概：\n视觉风格：（时代、色调、光线方向和时间、质感）\n声音设计：（环境声、是否有配乐、是否有对白）\n\n第1场　地点｜时间｜内景或外景\n本场要看懂的事：\n镜头1｜景别｜机位（从正面/侧面/背后，在人物行进路线的哪一侧）\n  起始：\n  动作：\n  结束：\n  观众新知道了：\n镜头2｜……\n\n第2场　……\n\n需要准备的参考图：\n角色：每个人物或动物一行，写外貌要点；注明会从哪些角度拍到（正面/侧面/背后）\n场景：每个地点一行，写空间和光线；注明会用到哪几个机位或区域\n道具：角色拿的、用的、被特写的每一样物品一行，写外形；会变化状态的（打开/关闭、撑开/收拢）要把每种状态都写出来`, { maxTokens: 5000, temperature: 0.6 }) };
      p.stage = 'script'; save(p);
      try { const j = await llmJSON(DIRECTOR, `对照原文和剧本，找出剧本里出现、但原文里完全没有提到的人物、动物和道具（物品）。原文提到过的、或者只是换了个说法的不算；场景里的普通陈设不算。

# 原文
${p.brief}

# 剧本
${p.script.text}

输出格式：{"added":["名称"]}，没有就输出 {"added":[]}`, { maxTokens: 400 }); p.script.added = (j.added || []).map(x => String(x).slice(0, 20)).filter(Boolean).slice(0, 8); } catch (e) { p.script.added = []; }
      log(p, p.script.added.length ? '剧本写好了。注意：剧本里有原文没有的东西——' + p.script.added.join('、') + '。不想要就在剧本里删掉再确认。' : '剧本写好了，请在页面上看、改，然后确认。');
    },
    // 2 设定：拆角色/场景/道具。资产库里有的直接复用；新的写提示词、选工作流，并按剧本需要列出补充图
    async elements(p) {
      if (!p.script || !p.script.text) throw new Error('还没有剧本');
      await ensureModel(p); const items = await catalog(), allowed = imageWorkflows(items), s = p.series ? loadSeries(p.series) : null, lib = s ? s.assets : [];
      log(p, '正在从剧本里拆角色、场景、道具…');
      const j = await llmJSON(DIRECTOR, `根据下面确认过的剧本，列出这一集需要的全部参考图元素（角色、场景、道具）。\n\n# 剧本\n${p.script.text}\n\n# 剧集资产库里已有的元素（外貌已定型并有图）\n${lib.map(a => `${a.id}｜${a.kind}｜${a.name}｜${a.description}｜已有的图：${a.images.map(i => i.label).join('、')}`).join('\n') || '（空，这是第一集）'}\n\n# 工作流选用表\n${GUIDE()}\n\n# 新元素主图可选的图片工作流（workflow 必须逐字取自这里）\n${allowed.join('\n')}\n\n# 要求\n- 剧本里出现的元素如果资产库里已经有，必须复用：library 填它的编号，name 和 kind 照抄，不要写 prompt。资产库里没有的才是新元素，library 留空。\n- 角色、场景、道具三类都要列全，总数不超过 16 个；同一个地方只列一个场景（不要因为机位不同拆成两个），只是摆在场景里的陈设（床垫、台灯、蜡烛）不单列为道具。道具必须列：凡是角色手里拿的、用的、背的、穿戴的显眼物件，以及被特写或被操作的物体，每一样都单独列为一个道具。\n- kind 只能是“角色”“场景”“道具”。description 用中文写死它不变的特征：每个特征只能有一个确定的说法，不许出现“或”“可能”“之类”（例如写“深棕色弯钩木柄”，不要写“黑色或深色手柄”）。\n- 道具还要填 state：主图画的是它的哪种状态（如“撑开”“收拢”“合上”“打开”）；没有状态变化的填空字符串。\n- 人物：每个角色只出一张“四视图”设定图（单张 9:16 的 2K 图，四格：正面头部、侧面头部、正面全身、背面全身），版式由平台自动套用，你不用写版式。人物的 prompt 用中文，只写这个人本身：身份、年龄、五官、发型、服装（每一件的款式和颜色）、体态和标志物；不写背景、不写动作、手里不拿任何东西。\n- 动物、灵兽、怪物等不是人形的角色：nonhuman 填 true，prompt 用英文只写这只生物本身的外形（体型像什么、毛色、角、眼睛、尾巴等），不写衣服、不写背景；平台会自动出一张多角度设定图。人形角色 nonhuman 填 false。
- 场景的 description 只写不变的东西；会随剧情变化的（灯亮不亮、天色后来变红）不要写进 description，那是镜头里的事。
- 场景：先在 description 里把空间定死——这个地方有哪些固定的东西、各在什么方位（门在哪一侧、窗在哪、柜台/桌椅/书架怎么摆、光从哪边来、什么时间），之后所有机位都按这个布局。主图的 prompt 用英文写最主要的机位，要写成一张电影剧照而不是说明图（至少 90 个英文词）：先写镜头和构图（焦段感、前景中景远景各是什么、纵深），再写材质细节（石、木、玉、金属的质感和年代感）、大气（雾、云、尘、体积光）、主光的方向和色温、色彩关系，最后写画质（photorealistic cinematic film still, shot on large-format camera, natural depth of field, fine detail）；原文里对这个地方的具体描写要全部用上。没有人物的空镜，按 description 的布局逐样写出物品的位置，写清时间和光线方向，带上视觉风格。\n- 场景还必须填 layout（空间锁定表，之后所有镜头都以它为准）：{"w":房间左右宽几米,"d":前后深几米,"items":[{"name":"书桌","x1":0,"y1":0,"x2":0,"y2":0}],"light":"光从画面的左边、右边还是正对面来，什么时间"}。坐标不用东南西北，一律按“主图的机位看过去”来定：摄影机站在近处这面墙的正中间，朝正对面的远墙看；x 是从画面左边的墙（0）到右边的墙（w），y 是从正对面的远墙（0）到摄影机身后的近墙（d），单位米。所以 x 小的东西在画面左边，x 大的在右边，y 小的在远处。先决定主图要正对着哪面墙拍（一般正对着最重要的那件家具或窗），再填坐标；items 列出门、窗和每一件固定家具（门窗贴着墙写成 0.1 米厚的薄条），互相不重叠；只列原文和剧本里有的东西，不许添加，原文写了位置关系的（靠窗、左手边、右手边）必须照做。主图的 prompt 必须按从画面左到右的顺序逐样写出这些东西（on the left … in the center … on the right …），并且不出现 items 以外的家具。角色和道具的 layout 填 null。\n- 道具：主图的 prompt 用英文写单个完整物体、干净的浅色背景。不能打开的道具只要这一张。能打开、展开或撑开的道具要两张：主图画合上（收拢、关闭）的样子，state 填“关闭”或“收拢”；另一张放在 extras 里。\n- 提示词里不要写参数和负面词。\n- extras 是补充图，都以主图为底图生成（资产库里已有的图不要重复列）：\n  · 人物：一般不需要。只有剧中换了造型（换装、淋湿、受伤）才加一张，label 写造型名，prompt 用中文写明这个造型和原来相比变了什么，其余不变。\n  · 道具：能打开的才加一张，label 写“打开”（或“撑开”“展开”），prompt 用英文写：the same object as in the reference image, now opened ……，并重复它不变的特征。最多 1 张。\n  · 场景：一个场景总共 1 到 4 张。剧本用到的其他机位或区域各加一张（最多 3 张），label 写机位名（如“从店内看向门口”“书架区近景”），prompt 用英文写：the same location as in the reference image, seen from ……，并按 description 的布局写明这个机位能看到哪些固定物品、各在画面的什么位置；保持同样的建筑、材质、时间和光线，没有人物。\n\n输出格式：{"elements":[{"library":"","kind":"角色","name":"简短中文名","description":"……","prompt":"……","workflow":"……","nonhuman":false,"state":"","layout":null,"extras":[{"label":"背面","prompt":""}]}]}`, { maxTokens: 6000 });
      const list = (j.elements || []).filter(e => e && ['角色', '场景', '道具'].includes(e.kind) && e.name).slice(0, 16);
      if (!list.length) throw new Error('模型没有拆出任何元素，请检查剧本后重试');
      const keep = (p.elements || []).filter(e => master(e).status === 'approved'), out = keep.slice();
      await ensureProject(p);
      for (const x of list) {
        const a = lib.find(k => k.id === x.library) || lib.find(k => k.kind === x.kind && k.name === x.name); let e = out.find(k => k.name === x.name && k.kind === x.kind);
        if (!e && a) {   // 从资产库复用：把库里的图导入这一集的工作台项目
          e = { id: rid('el_'), kind: a.kind, name: a.name, description: a.description, lib: a.id, images: [] }; log(p, `从资产库复用“${a.name}”（${a.images.length} 张图）…`);
          for (const i of a.images) {
            const up = await call(p, 'wb_upload', { project: p.project, path: path.relative(WS, path.join(SDIR, s.id, i.file)), name: `${a.name}_${i.label}`, category: a.kind === '角色' ? '角色' : a.kind });
            const disk = ((up.match(/磁盘路径：(.+)/) || [])[1] || '').trim();
            e.images.push({ id: rid('im_'), label: i.label, mode: i.mode, azimuth: i.azimuth, workflow: i.workflow, prompt: i.prompt, nodeId: nodeId(up), path: disk, url: pathToUrl(disk), status: 'approved', verdict: '合格', fromLibrary: true, qa: `来自剧集资产库（${i.from} 时确认）。` });
          }
          out.push(e);
        } else if (!e) {
          if (!x.prompt) continue;
          e = { id: rid('el_'), kind: x.kind, name: String(x.name).slice(0, 30), description: String(x.description || ''), images: [{ id: rid('im_'), label: x.kind === '道具' && x.state ? `主图（${String(x.state).slice(0, 8)}）` : '主图', mode: 't2i', prompt: String(x.prompt), workflow: 'Krea2-文生图-单采', status: 'draft' }] }; if (e.kind === '角色' && x.nonhuman) { Object.assign(e.images[0], { label: '设定图', mode: 't2i', workflow: QUAD, prompt: "A creature design reference sheet of ONE single animal shown three times on a plain light grey studio background: left, full body side view standing on all four legs; center, full body front view standing on all four legs; right, close-up of the head in three-quarter view. The same animal in all three views, identical colors and features. A real quadruped animal: no clothing, no armor, not standing upright, no human posture, no text. The animal: " + String(x.prompt) }); e.nonhuman = true; e.description = '（非人形的生物：四足着地，不穿衣服，不直立。它的参考图是同一只生物的三个角度，画面里只出现一只）' + e.description; } else if (e.kind === '角色') Object.assign(e.images[0], { label: '四视图', mode: 'quad', workflow: QUAD }); if (e.kind === '场景') { const L = cleanLayout(x.layout); if (L) { e.layout = L; if (!L.warn.length) e.images[0].prompt += ` Composition must be exactly: on the left of frame: ${L.camera.left || 'nothing'}; in the center of frame: ${L.camera.center || 'nothing'}; on the right of frame: ${L.camera.right || 'nothing'}. No furniture other than these.`; if (L.warn.length) log(p, `注意：场景“${e.name}”的空间锁定表有问题，请在页面上改坐标——${L.warn.join('；')}`); } } out.push(e);
        }
        for (const v of (Array.isArray(x.extras) ? x.extras : []).slice(0, x.kind === '场景' ? SCENE_VIEWS : 1)) if (v && v.label) newVariant(e, v.label, v.prompt);
        save(Object.assign(p, { elements: out }));
      }
      const book = p.book || p.brief;
      for (const e of out) {
        if (e.lib || master(e).status === 'approved' || e.expanded) continue; stopIf(); log(p, `正在扩写“${e.name}”的设定…`);
        const ask = e.kind === '角色' && !e.nonhuman ? `description：中文 200 到 350 字，分项写死这个人的外形：年龄感和气质、身高体型、脸型五官、肤色、发型发色和发饰、每一件服装的款式颜色材质纹样（从里到外、从上到下）、腰间和身上佩戴的每一样东西及其位置、鞋。prompt：把同样的内容写成一段中文出图描述（只写这个人本身，不写背景、不写动作、手里不拿东西）。`
          : e.kind === '角色' ? `description：中文 150 到 250 字，写死这只生物的外形：整体像什么动物、体型大小、毛或鳞的颜色质感、头部（角、耳、眼睛颜色）、四肢和爪、尾巴、发光或特殊的部位。四足着地，不穿衣服。prompt：英文，只写这只生物本身的外形，同样的细节，不写背景。`
          : e.kind === '场景' ? `description：中文 200 到 350 字，把这个地方写死：建筑和地面的形制与材质、每一样固定的东西及其方位（从主机位看过去的左、中、右、远、近）、远景是什么、时间、主光从哪边来、雾气云气、色彩。只写不随剧情变化的内容。prompt：英文，至少 100 个词，写成一张电影剧照：先写镜头和构图（焦段感，前景、中景、远景各是什么），再写材质细节、大气（雾、云、体积光）、主光方向和色温、色彩关系，最后写 photorealistic cinematic film still, shot on a large-format cinema camera, natural depth of field, extremely fine detail, no people, no text。`
          : `description：中文 100 到 200 字，写死这件东西：大小、形状、材质、颜色、纹样、每个部件、怎么佩戴或拿握。prompt：英文，单个完整物体、干净的浅色背景、棚拍质感，同样的细节，no text。`;
        try {
          const j = await llmJSON(DIRECTOR, `为这部剧的一个${e.kind}写详细设定。通读下面的小说全文，把原文里关于它的每一处描写都用上（不同章节里的也要），原文没写到的地方按它的身份和整体风格补全，但不能和原文矛盾。\n\n# 要写的元素\n${e.kind}：${e.name}\n目前的简述：${e.description}\n\n# 视觉风格\n${p.style}\n\n# 小说全文\n${clip(book, 24000)}\n\n# 输出\n${ask}\n每个特征只能有一个确定的说法，不许出现“或”“可能”“之类”。\n\n输出格式：{"description":"……","prompt":"……"}`, { maxTokens: 2500 });
          if (j.description && String(j.description).length > 60) { e.description = (e.nonhuman ? '（非人形的生物：四足着地，不穿衣服，不直立。它的参考图是同一只生物的三个角度，画面里只出现一只）' : '') + String(j.description); if (j.prompt) { const m = master(e); m.prompt = (e.nonhuman ? "A creature design reference sheet of ONE single animal shown three times on a plain light grey studio background: left, full body side view standing on all four legs; center, full body front view standing on all four legs; right, close-up of the head in three-quarter view. The same animal in all three views, identical colors and features. A real quadruped animal: no clothing, no armor, not standing upright, no human posture, no text. The animal: " : '') + String(j.prompt) + (e.kind === '场景' && e.layout && !e.layout.warn.length ? ` Composition must be exactly: on the left of frame: ${e.layout.camera.left || 'nothing'}; in the center of frame: ${e.layout.camera.center || 'nothing'}; on the right of frame: ${e.layout.camera.right || 'nothing'}.` : ''); } e.expanded = true; save(Object.assign(p, { elements: out })); }
        } catch (err) { log(p, `“${e.name}”的设定没扩写成（${err.message}），先用简述。`); }
      }
      p.elements = out; p.script.confirmed = true; p.stage = 'elements';
      const n = out.reduce((a, e) => a + e.images.length, 0), reuse = out.filter(e => e.images.some(i => i.fromLibrary)).length;
      log(p, `共 ${out.length} 个元素、${n} 张图${reuse ? `，其中 ${reuse} 个元素来自资产库` : ''}。请检查描述、提示词和要补充哪些图，可以改、加、删，然后点“生成图片”。主图通过后再点一次，才会生成它的补充图。`);
    },
    // 3 参考图：主图直接生成；补充图要等主图通过后，以主图为底图生成。逐张看图给出检查意见，等你确认
    async images(p, body) {
      const all = (p.elements || []).flatMap(e => e.images.map(im => ({ e, im })));
      const targets = all.filter(({ e, im }) => body.target ? im.id === body.target : ['draft', 'rejected', 'failed'].includes(im.status) && (im === master(e) || master(e).status === 'approved'));
      if (!targets.length) throw new Error(all.some(({ e, im }) => im !== master(e) && im.status === 'draft') ? '补充图要等它的主图通过后才能生成。请先确认主图。' : '没有需要生成的图片');
      for (const { e, im } of targets) if (im !== master(e) && master(e).status !== 'approved') throw new Error(`“${e.name}”的主图还没通过，不能生成它的“${im.label}”`);
      await catalog(); await gpuFree(); await ensureModel(p); await ensureProject(p);
      for (const { e, im } of targets) {
        if (im.status === 'rejected' && im.comment && im.mode !== 'angle' && im.mode !== 'threeview') { log(p, `按你的意见改写“${e.name}·${im.label}”的提示词…`); im.prompt = await llm(DIRECTOR, `下面这张参考图没有通过。请根据意见改写出图提示词，只输出改好的英文提示词本身。\n元素：${e.kind}｜${e.name}｜${e.description}\n这张图是：${im.label}${im === master(e) ? '' : '（以主图为底图生成，必须和主图是同一个' + WORD[e.kind] + '）'}\n原提示词：${im.prompt}\n上次看图的检查结果：${clip(im.qa || '无', 600)}\n用户的意见：${im.comment}`, { maxTokens: 800 }); }
        im.comment = ''; const created = !im.nodeId;
        im.nodeId = nodeId(await call(p, 'wb_node_set', Object.assign({ project: p.project, title: `${e.kind}_${e.name}_${im.label}`, name: `${e.name}_${im.label}`, asset_type: e.kind === '角色' ? '人物' : e.kind, text: im.prompt || `${e.name} ${im.label}`, template: im.workflow, workflow_params: WF_PARAMS[im.workflow] || {}, ratio: im.mode === 'quad' ? '9:16' : p.ratio }, im.mode === 'quad' ? { character_sheet: true } : {}, im.mode === 'angle' ? { camera_azimuth: im.azimuth, camera_elevation: 0 } : {}, created ? { type: 'image' } : { id: im.nodeId }))) || im.nodeId;
        if (created && im !== master(e)) await call(p, 'wb_edges', { project: p.project, add: [{ from: master(e).nodeId, to: im.nodeId }] });
        im.status = 'generating'; im.url = ''; im.qa = ''; im.verdict = ''; save(p);
      }
      for (let i = 0; i < targets.length; i += 12) { stopIf(); log(p, `提交 ${Math.min(12, targets.length - i)} 张图片…`); log(p, await call(p, 'wb_run', { project: p.project, node_ids: targets.slice(i, i + 12).map(t => t.im.nodeId) })); }
      for (const { e, im } of targets) {
        stopIf(); const n = await node(p, im.nodeId);
        if (!n.outputUrl) { im.status = 'failed'; im.qa = '生成失败，详见进度记录。'; save(p); continue; }
        im.url = mediaUrl(n.outputUrl); im.path = n['产物磁盘路径']; log(p, `正在看“${e.name}·${im.label}”…`);
        const rule = e.kind === '角色' ? (im.mode === 'quad' ? '这应当是一张竖版四格人物设定图：左上正面头部、右上侧面头部、左下正面全身（按规范这一格的脸是空白的，是故意的，不算错）、右下背面全身。是否正好四格、每格一个人；四格是不是同一个人、同一发型、同一套服装；两格全身是否从头到脚完整；手里有没有多拿东西' : '是否只有一个主体、身体完整、四肢和五官有没有畸形、背景是否干净、手里有没有多拿东西') : e.kind === '道具' ? '是否只有一个完整的物体、有没有被裁切或重复' : '是否是没有人物的空镜、空间和光线是否符合描述';
        const ask = im === master(e) ? { paths: [im.path], question: `这是参考图“${e.name}”（${e.kind}）的主图。它应当是：${e.description}。请核对：1) 是否符合这段描述；2) ${rule}；3) 有没有文字、水印或描述里没有的多余主体。${lockQA(e)}` + VERDICT_ASK }
          : { paths: [im.path], references: [master(e).path], question: `第 1 张是${e.kind}“${e.name}”已确认的主图（标准样子），第 2 张是以它为底图新生成的“${im.label}”。${im.mode === 'threeview' ? '第 2 张应当是同一个角色的三视图设定表（正面、侧面、背面）。' : im.mode === 'angle' ? `第 2 张应当是同一个角色换了拍摄角度（${im.label}）。` : `第 2 张的要求：${im.prompt}`}\n第一步，先不管要求，分别如实描述两张图里看到的：整体轮廓、各个部件或特征的样子和状态，每张图单独写一段。\n第二步，再逐项核对（任何一项不满足都是不合格）：1) 是不是同一个${WORD[e.kind]}——${e.kind === '角色' ? '脸（看得到的话）、发型、体型、服装（除非这张图就是要换造型）' : e.kind === '道具' ? '形状、颜色、材质、把手和部件，只是状态不同' : '建筑结构、材质、陈设、时间和光线'}是否一致；2) 是否做到了“${im.label}”；3) ${rule}；4) 有没有文字、水印或多余主体。` + VERDICT_ASK };
        try { im.qa = await call(p, 'media_look', ask); } catch (err) { im.qa = '看图失败：' + err.message; }
        im.verdict = verdict(im.qa); im.status = 'review'; save(p);
      }
      p.stage = 'images'; const wait = (p.elements || []).some(e => master(e).status !== 'approved' && e.images.length > 1);
      log(p, '图片已生成并检查完，请逐张确认：通过，或写意见后重做。' + (wait ? '主图通过后再点一次“生成图片”，会生成它们的补充图。' : '全部通过后就可以开始做视频。'));
    },
    // 4 分镜：按剧本逐个镜头写成“起始 → 动作 → 结束”，给每个镜头挑图；再由“场记”逐对检查连续性并改正
    async plan(p) {
      const els = p.elements || []; if (!els.length) throw new Error('还没有拆设定');
      await ensureModel(p); log(p, '正在写分镜，并给每个镜头挑参考图…');
      const table = els.map((e, i) => `${i + 1}｜${e.kind}｜${e.name}｜${e.description}${e.kind === '场景' ? lockText(e) : ''}｜可用的图：${(e.kind === '场景' && !SCENE_VIEWS ? [master(e)] : e.images).map(im => im.label).join('、')}`).join('\n');
      const FORMAT = '{"shots":[{"scene":1,"location":2,"title":"镜头01_简短名","purpose":"观众在这个镜头里新知道了什么","size":"全景/中景/近景/特写","angle":"机位：从正面、侧面还是背后拍，摄影机在人物行进路线的哪一侧","move":"静止/缓慢推近/缓慢拉远/缓慢横移","beat":"动作/静态","start":"起始状态","action":"一个有起点和终点的动作","end":"结束状态","method":"参考/首尾帧/续接/空镜","why":"为什么这个镜头用这种方式","absent":[],"views":{"1":"背面","3":"收拢"}}]}';
      let j = await llmJSON(CRAFT(), `根据确认过的剧本写分镜表。\n\n# 剧本\n${p.script.text}${refText(p)}\n\n# 已确认的参考图（用编号指代；每个元素可能有好几张图）\n${table}\n\n# 要求\n- 镜头的数量、顺序、内容以剧本为准；如果剧本里有可以合并的连续小动作，或删掉也不影响理解的镜头，直接合并或删掉。每个镜头 5 秒。\n- scene 是第几场；location 填这一场所在场景的编号（同一场的镜头必须是同一个场景元素）。\n- start 和 end 都要写明四样：人在画面的什么位置（左/右/中、近/远）、面朝哪边、手里拿着什么及其状态、门窗等环境物件的状态。start 和 end 必须不同。\n- 同一场里，下一个镜头的 start 必须等于上一个镜头的 end；人物只往前走不折返；行进方向保持一致。\n- 每一场的第一个镜头用全景或中景交代地点和人物位置。\n- absent 填这个镜头画面里完全看不到的角色或道具的编号。\n- beat：人物有明确的位置或姿态变化（走、坐下、拿起、转身、开合东西）填“动作”；人物基本不动、靠神情和气氛的镜头（凝视、瞄准、呼吸、等待、空镜）填“静态”。静态镜头的 start 和 end 可以只差神情或很小的变化，不要硬编大动作。\n- move 是摄影机的运动。静态镜头必须用“缓慢推近”“缓慢拉远”或“缓慢横移”，靠摄影机运动撑住画面；动作镜头一般用“静止”，让动作本身清楚。参考片镜头表里写了推进、平移的，照它来。\n- method 按导演手册第四部分给每个镜头选生成方式，不要全片用同一种：建立镜头、换场或跳时间后的第一个镜头、人物自由活动、只有场景的空镜用“参考”；动作有明确起点终点且位置关系关键（进门、出门、坐下、从 A 走到 B、递东西、开关门）用“首尾帧”；同一场同一机位、动作不间断接着上一镜往下演用“续接”（每一场的第一个镜头不能用）；纯转场或气氛、画面里没有需要保持一致的角色和道具用“空镜”。why 用一句话说明理由。\n- views 给这个镜头里出现的每个元素挑一张最合适的图，写成 {"编号":"图的名字"}：人物一般只有一张“四视图”，就用它（有换造型的图时，按这个镜头里的造型挑）；道具按这个镜头开始时它的状态挑；场景按机位挑。名字必须逐字取自“可用的图”。\n- 场景图里已经摆好的道具（比如桌上的匣子、台灯）就在原地用：打开、合上、点亮都在它原来的位置做，不要写成把它拿到手里或腿上；只有剧本明确要求拿走时才移动它。从里面取出来的小东西（信、钥匙）可以拿在手里。\n- 机位只能用场景已有的图：每个镜头的画面就是它挑的那张场景图的机位和布局，angle 照着那张图写，不许设计场景图里没有的新机位。想换机位，只能换成这个场景的另一张图；场景只有一张图时，这一场所有镜头都用这个机位，景别只能在这张图的范围内收紧（如从全景收到中景）。\n\n输出格式：${FORMAT}`, { maxTokens: 9000 });
      let shots = (j.shots || []).filter(s => s && s.start && s.end).slice(0, 24); if (!shots.length) throw new Error('模型没有写出分镜');
      log(p, `初稿 ${shots.length} 个镜头，正在逐对检查连续性…`);
      try {
        const r = await llmJSON(CRAFT(), `你是场记，检查下面这份分镜表的连续性并改正它。\n\n# 分镜表\n${JSON.stringify({ shots }, null, 1)}\n\n# 逐对检查（按导演手册第三部分）\n1. 同一场里，镜头 N+1 的 start 是否和镜头 N 的 end 一致（位置、朝向、手里的东西及状态、门的开关）。\n2. 人物有没有往回走：已经进了门，后面又在门外；已经走到深处，后面又在门口。\n3. 行进方向有没有突然反过来。\n4. 道具有没有凭空出现、消失或变了状态。\n5. 有没有镜头删掉也不影响理解，或者相邻两个镜头其实是同一个动作应当合并。\n6. 每一场的第一个镜头有没有交代地点和人物位置。\n9. 有没有镜头的 angle 用了场景图里没有的机位：有就改成它挑的那张场景图的机位。\n7. views 挑的图和镜头是否相符（背后拍却没用背面图、伞已经收了却还用撑开的图）。\n8. method 选得对不对：有没有把建立镜头、换场后的第一个镜头或转场硬做成“首尾帧”；有没有该用“首尾帧”锁住位置的动作（进门、出门、坐下）却用了“参考”；每一场的第一个镜头有没有误用“续接”。\n\n先在 issues 里逐条写出发现的问题（每条一句话、不超过 40 个字，只写结论不写推理过程；没有就给空数组），然后在 shots 里输出改正后的完整分镜表，字段和原来完全一样，没问题的镜头原样保留。\n\n输出格式：{"issues":["镜头3 的起始写她在门外，但镜头2 结束时她已经进门"],"shots":[……]}`, { maxTokens: 9000 });
        const fixed = (r.shots || []).filter(s => s && s.start && s.end).slice(0, 24);
        for (const t of (r.issues || []).slice(0, 8)) log(p, '场记：' + clip(String(t), 90));
        if (fixed.length) { log(p, `场记检查完：${(r.issues || []).length} 处问题已改，定稿 ${fixed.length} 个镜头。`); shots = fixed; }
      } catch (e) { log(p, '场记检查没有完成（' + e.message + '），先用初稿。'); }
      const scenes = els.filter(e => e.kind === '场景'), subjects = els.filter(e => e.kind !== '场景');
      const pick = (e, label) => { label = String(label || ''); return e.images.find(i => i.label === label) || (label && e.images.find(i => i.label.includes(label) || label.includes(i.label))) || master(e); };
      p.shots = shots.map((s, i) => {
        const gone = new Set((Array.isArray(s.absent) ? s.absent : []).map(Number)), views = s.views || {}, refs = [], add = (e, im) => { if (refs.length < 6 && !refs.some(r => r.img === im.id)) refs.push({ el: e.id, img: im.id }); };
        const sc = els[Number(s.location) - 1], scene = sc && sc.kind === '场景' ? sc : scenes[0]; if (scene) add(scene, SCENE_VIEWS ? pick(scene, views[els.indexOf(scene) + 1]) : master(scene));   // 场景图排第一：它是首帧的底图
        for (const e of subjects) { const n = els.indexOf(e) + 1; if (!gone.has(n)) add(e, pick(e, views[n])); }
        const firstOfScene = i === 0 || Number(shots[i - 1].scene) !== Number(s.scene); let method = /首尾/.test(s.method) ? 'fl' : /续/.test(s.method) ? 'cont' : /空|转场/.test(s.method) ? 't2v' : 'ref';
        if (method === 'cont' && firstOfScene) method = 'ref'; if (method === 't2v') refs.length = 0;
        if (method === 'ref' && refs.some(r => (els.find(e => e.id === r.el) || {}).kind === '角色')) method = 'fl';   // 续接不能用在一场的开头；空镜不连任何图
        return { id: rid('sh_'), scene: Number(s.scene) || 1, title: String(s.title || `镜头${String(i + 1).padStart(2, '0')}`).slice(0, 30), purpose: String(s.purpose || ''), size: String(s.size || ''), angle: String(s.angle || ''), start: String(s.start), action: String(s.action || ''), end: String(s.end), seconds: 5, refs, status: 'draft', method, why: String(s.why || ''), move: /推/.test(s.move) ? '缓慢推近' : /拉/.test(s.move) ? '缓慢拉远' : /移|摇/.test(s.move) ? '缓慢横移' : /静/.test(s.beat) ? '缓慢推近' : '静止', beat: /静/.test(s.beat) ? '静态' : '动作', kf: method === 'fl' ? { first: { status: 'draft' }, last: { status: 'draft' } } : {} };
      });
      p.final = null; p.seconds = p.shots.length * 5; p.stage = 'plan'; log(p, `分镜定稿：${new Set(p.shots.map(s => s.scene)).size} 场 ${p.shots.length} 个镜头，全片约 ${p.seconds} 秒。生成方式：${p.shots.map(s => METHOD[s.method]).join('、')}。`);
    },
    // 5 关键帧：每个镜头先出首帧（起始状态）和尾帧（结束状态）两张定格画面，把人在哪、朝哪、拿着什么锁死。
    //   首帧 = 以场景图为底图，把角色和道具按起始状态放进去；尾帧 = 以首帧为底图，同机位同背景，只改成结束状态。
    async keyframes(p, body) {
      needApproved(p);
      const shots = (p.shots || []).filter(s => s.kf && s.method === 'fl'); if (!shots.length) throw new Error('没有需要生成的关键帧（没有用“首尾帧”方式的镜头）');
      const todo = f => !f.url || ['draft', 'rejected', 'failed'].includes(f.status);
      const list = body.target ? shots.filter(s => s.id === body.target) : shots.filter(s => todo(s.kf.first) || todo(s.kf.last));
      if (!list.length) throw new Error('没有需要生成的关键帧');
      await catalog(); await gpuFree(); await ensureModel(p);
      const dep = s => { const i = p.shots.indexOf(s), d = i > 0 ? p.shots[i - 1] : null; return d && d.scene === s.scene && d.method === 'fl' && d.kf ? d : null; };   // 同一场里紧挨着的上一个首尾帧镜头：它的尾帧是这个镜头首帧的依据
      const used = s => s.refs.map(r => refOf(p, r)).filter(Boolean), subj = s => used(s).filter(x => x.e.kind !== '场景');
      const write = async (s, extra) => {
        const u = used(s), others = subj(s), d = dep(s), pv = d && d.kf.last.url && !todo(d.kf.last) ? d : null; s.kf.first.prev = pv ? pv.id : '';
        const j = await llmJSON(CRAFT(), `为这个镜头写两条英文的图片编辑指令：首帧（起始状态）和尾帧（结束状态）。图片编辑模型会按指令把参考图合成为一张电影定格画面。\n\n镜头：${s.title}｜${s.size}｜${s.angle}\n起始状态：${s.start}\n动作：${s.action}\n结束状态：${s.end}\n摄影机运动：${s.move || '静止'}。这是${s.beat === '静态' ? '静态气氛镜头：人物基本不动，尾帧和首帧只差神情或很小的姿态变化' : '动作镜头'}。\n\n首帧用到的图片，按这个顺序：\n${u.map((x, i) => `Image ${i + 1} = ${x.e.kind}“${x.e.name}”的${x.im.label}：${x.e.description}${x.e.kind === '场景' ? lockText(x.e) : ''}${i === 0 ? '（底图：就在这张图的地点里合成）' : ''}`).join('\n')}${pv ? `\nImage ${u.length + 1} = 同一场里上一个镜头“${pv.title}”的最后一帧（这个镜头紧接着它发生）` : ''}\n\n尾帧用到的图片，按这个顺序：\nImage 1 = 这个镜头的首帧（底图）\n${others.map((x, i) => `Image ${i + 2} = ${x.e.kind}“${x.e.name}”的${x.im.label}`).join('\n')}\n\n# 要求\n- first：完整描述首帧画面。写清景别和机位；每个角色在画面的什么位置（left / right / center of frame，near / far）、面朝哪边、什么姿态、手里拿着什么及其状态；门窗等是开是关。人物的 Image 是一张四格人物设定图（正面头部、侧面头部、正面全身、背面全身，其中正面全身那一格的脸是空白的），它只用来确定这个人的长相、发型和服装：画面里只放这一个人、脸是正常的，绝不能出现四格版式或空白的脸，指令里要写明 exactly one instance of the person from the four-panel character sheet in Image N, with a normal face, not a sheet layout。角色和道具的外貌严格取自对应的 Image，写成 “the woman from Image 2”“the umbrella from Image 3”。保持 Image 1 的建筑、光线和色调。机位和空间布局就是 Image 1 的：指令里要写明 keep the exact camera position, room layout and every piece of furniture of Image 1 unchanged, do not add any furniture, lamp or object that is not in Image 1 or listed here；景别比 Image 1 紧时写成 a tighter framing of the same view of Image 1，不许换到别的角度。每样道具在画面里只能有一个：Image 1 里已经有的道具（比如已经摆在桌上的）不要再放一个，只写它的状态和位置；指令里对每样道具写明 exactly one。${pv ? `这个镜头和 Image ${u.length + 1} 是同一时刻换了个机位：人物的服装、姿态、所在位置，以及桌上每样东西的样子、状态（开/关、亮/灭）和摆放位置，都必须和 Image ${u.length + 1} 一致，指令里要逐样写明 exactly as in Image ${u.length + 1}；只有景别和机位不同。` : ''}画面里没有文字，没有多余的人。\n- last：${s.move === '缓慢推近' ? '以 “Same camera direction, same background and lighting as Image 1, but the camera has slowly pushed in: the framing is about 20% tighter on the main subject. Besides that, only these things change:” 开头，' : s.move === '缓慢拉远' ? '以 “Same camera direction, same background and lighting as Image 1, but the camera has slowly pulled back: the framing is about 20% wider, showing more of the same surroundings. Besides that, only these things change:” 开头，' : '以 “Same camera, same framing, same background and lighting as Image 1. Only these things change:” 开头，'}然后只写结束状态相对首帧改变了什么（人物的位置、朝向、姿态、道具状态、门的开关）。改变的幅度要是 5 秒内做得完的。道具改变状态或被拿起时，写明是同一个东西变了（the same box, now open / moved from the desk to his hands），原来位置上不能再留一个：every prop still appears exactly once。${extra || ''}\n\n输出格式：{"first":"……","last":"……"}`, { maxTokens: 1800 });
        s.kf.first.prompt = String(j.first || ''); s.kf.last.prompt = String(j.last || ''); if (!s.kf.first.prompt || !s.kf.last.prompt) throw new Error(`“${s.title}”的关键帧指令没有写出来`);
      };
      const make = async (items, which) => {   // items: 要生成的镜头；which: first / last
        if (!items.length) return; const label = which === 'first' ? '首帧' : '尾帧';
        for (const s of items) {
          stopIf(); const f = s.kf[which]; if (f.borrowed) { f.nodeId = ''; f.borrowed = false; } const created = !f.nodeId;
          f.nodeId = nodeId(await call(p, 'wb_node_set', Object.assign({ project: p.project, title: `${s.title}_${label}`, name: `${s.title}_${label}`, asset_type: '场景', text: f.prompt, template: EDIT, ratio: p.ratio }, created ? { type: 'image' } : { id: f.nodeId }))) || f.nodeId;
          if (created) await call(p, 'wb_edges', { project: p.project, add: (which === 'first' ? used(s).map(x => x.im.nodeId).concat(s.kf.first.prev ? [shots.find(k => k.id === s.kf.first.prev).kf.last.nodeId] : []) : [s.kf.first.nodeId].concat(subj(s).map(x => x.im.nodeId))).map(from => ({ from, to: f.nodeId })) });
          Object.assign(f, { status: 'generating', url: '', qa: '', verdict: '' }); save(p);
        }
        for (let i = 0; i < items.length; i += 12) { stopIf(); log(p, `提交 ${Math.min(12, items.length - i)} 张${label}…`); log(p, await call(p, 'wb_run', { project: p.project, node_ids: items.slice(i, i + 12).map(s => s.kf[which].nodeId) })); }
        for (const s of items) {
          stopIf(); const f = s.kf[which], n = await node(p, f.nodeId);
          if (!n.outputUrl) { f.status = 'failed'; f.verdict = '不合格'; f.qa = '生成失败，详见进度记录。'; save(p); continue; }
          f.url = mediaUrl(n.outputUrl); f.path = n['产物磁盘路径']; log(p, `正在看“${s.title}”的${label}…`);
          const ids = subj(s).slice(0, 2), want = which === 'first' ? s.start : s.end, pvf = which === 'first' && f.prev ? shots.find(k => k.id === f.prev) : null;
          const ask = which === 'first'
            ? { paths: [f.path], references: ids.map(x => x.im.path).concat(pvf ? [pvf.kf.last.path] : []), question: `${ids.length ? `前 ${ids.length} 张是参考图：${ids.map(x => `${x.e.kind}“${x.e.name}”的${x.im.label}`).join('、')}；最后一张` : '这张'}是镜头“${s.title}”的首帧，应当是${s.size}、${s.angle}。它应当呈现的起始状态：${want}。\n第一步，先如实描述最后一张图：地点、每个人物在画面的什么位置、面朝哪边、姿态、手里拿着什么及其状态、门窗状态。\n第二步，核对（任何一项不满足都是不合格）：1) 画面是否符合起始状态，尤其是人物的位置、朝向和手里的道具状态；2) 角色和道具是否和参考图是同一个；3) 有没有肢体畸形、多出来的人或物、文字水印；4) 把每样道具各数一遍：同一样道具在画面里是否只有一个。${pvf ? `\n另外，倒数第 2 张是同一场上一个镜头“${pvf.title}”的最后一帧，这个镜头紧接着它发生。5) 和它相比：人物的服装和所在位置、每件家具的样子、门窗的开关、道具的状态是否一致（只允许景别不同）。椅子换了样子、门从开变成关、东西挪了位置，都是不合格。` : ''}` + VERDICT_ASK }
            : { paths: [f.path], references: [s.kf.first.path], question: `第 1 张是镜头“${s.title}”的首帧，第 2 张是它的尾帧。尾帧应当呈现的结束状态：${want}。这个镜头的动作是：${s.action}。\n第一步，先如实分别描述两张图里人物的位置、朝向、姿态、手里的道具及其状态、门窗状态。\n第二步，核对（任何一项不满足都是不合格）：1) 尾帧是否到达了结束状态；2) 两张图是不是同一个拍摄方向、同一个背景和光线，人物是不是同一个；3) ${s.beat === '静态' ? '这是静态气氛镜头，尾帧和首帧只有神情、很小的姿态或景别松紧的差别是对的，不算问题' : '尾帧和首帧相比确实发生了变化，而且变化是 5 秒内做得完的'}${s.move && s.move !== '静止' ? '（摄影机在' + s.move + '，所以景别松紧不同是对的）' : ''}；4) 有没有肢体畸形、多出来的人或物、文字水印；5) 把尾帧里每样道具各数一遍：同一样道具是否只有一个（比如桌上一个、手里又一个就是不合格）。` + VERDICT_ASK };
          try { f.qa = await call(p, 'media_look', ask); } catch (e) { f.qa = '看图失败：' + e.message; }
          f.verdict = verdict(f.qa); f.status = 'review'; save(p);
        }
      };
      const round = async (items, which, fresh) => {
        if (!items.length) return;
        if (fresh) for (const s of items) { stopIf(); log(p, `正在设计“${s.title}”的首尾帧…`); await write(s); Object.assign(s.kf.first, { status: 'draft', url: '' }); Object.assign(s.kf.last, { status: 'draft', url: '' }); save(p); }
        await make(items, which);
        const bad = items.filter(s => s.kf[which].verdict === '不合格' && !s.kf[which].retried && s.kf[which].url);
        if (bad.length) {
          log(p, `${bad.length} 张${which === 'first' ? '首帧' : '尾帧'}没通过检查，各自动重做一次…`);
          for (const s of bad) { const keep = s.kf[which === 'first' ? 'last' : 'first'].prompt; s.kf[which].retried = true; const qa = clip(s.kf[which].qa, 500); await write(s, `\n- 上一次生成的${which === 'first' ? '首帧' : '尾帧'}没通过检查：${qa}。这次的指令要专门防止这个问题。`); if (which === 'last') s.kf.first.prompt = keep; save(p); }
          await make(bad, which);
        }
      };
      // 同一场里后一个镜头的首帧要照着前一个镜头的尾帧来（东西的样子和位置才不会变），所以按依赖一轮一轮做
      const firstDone = new Set(), lastDone = new Set();
      for (const s of list) { s.kf.first.retried = s.kf.last.retried = false; if (!body.target && s.kf.first.prompt && !todo(s.kf.first)) firstDone.add(s.id); }
      for (let r = 0; r < list.length * 2 + 2; r++) {
        const waiting = list.filter(s => !firstDone.has(s.id)), free = waiting.filter(s => { const d = dep(s); return !d || !list.includes(d) || lastDone.has(d.id); });
        const A = free.length ? free : waiting.slice(0, 1); for (const s of A) firstDone.add(s.id); await round(A, 'first', true);
        for (const s of A) { const d = dep(s), f = s.kf.first; if (f.verdict === '不合格' && d && d.kf.last.url && d.kf.last.verdict === '合格') { Object.assign(f, { nodeId: d.kf.last.nodeId, path: d.kf.last.path, url: d.kf.last.url, verdict: '合格', status: 'review', borrowed: true, qa: `重做后仍不合格，改用上一个镜头“${d.title}”的尾帧当首帧（同机位接着演）。` }); log(p, `“${s.title}”的首帧重做后仍不合格，改用上一个镜头的尾帧当首帧。`); save(p); } }
        const B = list.filter(s => firstDone.has(s.id) && !lastDone.has(s.id)); for (const s of B) lastDone.add(s.id); await round(B.filter(s => todo(s.kf.last) && s.kf.first.url), 'last', false);
        if (!A.length && !B.length) break;
      }
      p.stage = 'keyframes'; log(p, '关键帧完成：' + list.map(s => `${s.title}（首${s.kf.first.verdict || '-'}/尾${s.kf.last.verdict || '-'}）`).join('、'));
    },
    // 6 视频：按分镜里给每个镜头选好的方式生成。
    //   参考：连角色/道具/场景参考图（建立镜头、换场后的第一个镜头、自由活动、空镜只连场景）
    //   首尾帧：把设计好的首帧演到尾帧（进门、坐下这类位置关系关键的动作）
    //   续接：拿上一个镜头的真实最后一帧当首帧接着演（同机位不间断的长动作）——必须等上一个镜头做完
    //   空镜：纯文字生成（转场、时间流逝，不连任何图）
    async videos(p, body) {
      needApproved(p);
      const shots = (p.shots || []).filter(s => s.kf); if (!shots.length) throw new Error('还没有分镜');
      const prevOf = s => shots[shots.indexOf(s) - 1];
      const ready = s => s.method === 'fl' ? !!(s.kf.first.url && s.kf.last.url) : s.method === 'cont' ? !!(prevOf(s) && prevOf(s).path) : true;
      const want = s => body.recheck ? !!s.url : body.target ? s.id === body.target : ['draft', 'rejected', 'failed'].includes(s.status);
      if (!shots.some(want)) throw new Error(body.recheck ? '没有可检查的镜头' : '没有可以生成的镜头');
      await catalog(); await gpuFree(); await ensureModel(p);
      const base = clip(read('skills/h3-prompt-writing/references/base-en.txt'), 15000), full = clip(read('skills/h3-prompt-writing/references/ref-en.txt'), 14000);
      const used = s => s.refs.map(r => refOf(p, r)).filter(Boolean);
      const MOVE = { 缓慢推近: 'slow, steady push-in toward the subject over the whole shot', 缓慢拉远: 'slow, steady pull-back over the whole shot', 缓慢横移: 'slow, steady lateral tracking move over the whole shot', 静止: 'locked-off static camera' };
      const brief = s => `Shot: ${s.title}. Shot size: ${s.size}. Camera: ${s.angle}. Camera movement: ${MOVE[s.move] || MOVE.静止}.${s.beat === '静态' ? ' This is a quiet, held shot: the performer only breathes, blinks and makes tiny shifts; the camera movement carries the shot. Do not invent a big action.' : ''} Duration: ${s.seconds} seconds, aspect ratio ${p.ratio}.\nStart state (Chinese): ${s.start}\nAction (Chinese): ${s.action}\nEnd state (Chinese): ${s.end}\nVisual style from the script:\n${clip(p.script.text, 900)}`;
      const COMMON = ' Ambient sound only; non_diegetic_music is none (music is added in post). No on-screen text, no extra people or animals.';
      const writePrompt = async (s, extra) => {
        if (s.method === 'ref') {
          const u = used(s);
          for (let i = 0; ; i++) {
            const t = await llm('You write MiniMax H3 full-reference (Ref2VA) video prompts. Follow the format guide exactly.\n\n' + full, `Write the complete six-section English prompt for this shot.\n\n${brief(s)}\n\nReference pictures connected to this shot, in this exact order:\n${u.map(({ e, im }, k) => `<Picture ${k + 1}> = ${e.kind}“${e.name}”的${im.label}：${e.description}`).join('\n')}\n\nRules: use the six sections subject_definitions, summary, retention_analysis, detailed_description, overall_soundscape, non_diegetic_music, in that order, each starting with its name and a colon. A character's picture is a four-panel reference sheet of ONE person (front head, side head, front full body whose face is intentionally left blank, back full body): use the four panels together to define that single character. The video shows exactly one instance of that person with a normal face; it never shows panels, a split layout or a blank face. Every character, prop and location that has a picture must be defined as a <Subject N> from its <Picture N> and must actually appear: never drop, replace or merge one. Props keep the exact shape, color, material and parts shown in their picture; a prop changing state is the same object changing state. Mark each fully_preserved in retention_analysis. The shot must open in the start state and finish in the end state; state positions in the frame (left / right / near / far) and which way the character faces and moves. One main action only.${COMMON}${extra || ''}\nOutput only the six sections.`, { maxTokens: 2500, temperature: 0.4 });
            if (['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'].every(k => t.includes(k)) || i >= 1) return t;
          }
        }
        const mode = s.method === 'fl' ? 'FL2VA' : s.method === 'cont' ? 'I2VA' : 'T2VA';
        const how = s.method === 'fl' ? '<Picture 1> is the first frame and <Picture 2> is the last frame of the same single shot. Describe the path from the first frame to the last frame as one physically plausible action with observable intermediate steps; the camera moves smoothly from the framing of the first frame to the framing of the last frame. Nothing appears or disappears except what the two frames show.'
          : s.method === 'cont' ? '<Picture 1> is the actual first frame: it is the real last frame of the previous shot, so this shot continues that action without a visible cut. Keep the same camera position, framing, characters, props and lighting as the picture, and develop the action forward from it to the end state.'
          : 'There are no reference pictures. This is a transitional / atmosphere shot: describe the environment, light and motion fully in text. Do not include any identifiable recurring character or prop.';
        return llm(`You write MiniMax H3 video prompts in ${mode} mode. Follow the guide exactly: the mode's instruction line first, then integrated_multimodal_description, overall_soundscape, non_diegetic_music.\n\n` + base, `Write the complete ${mode} prompt for this shot.\n\n${how}\n\n${brief(s)}\n\nRules: one continuous shot, no cuts.${COMMON}${extra || ''}\nOutput only the prompt.`, { maxTokens: 2000, temperature: 0.4 });
      };
      const TEMPLATE = { ref: 'H3-全能参考-双时钟', fl: 'H3-首尾帧-双时钟', cont: 'H3尾帧续段_I2VA手动循环（单次已测）', t2v: 'H3-文生视频-双时钟' };
      const submit = async list => {
        if (!body.recheck) for (const s of list) {
          stopIf();
          if (s.method === 'cont') {   // 抽上一个镜头的真实尾帧，存进项目，作为这一镜的首帧
            const prev = prevOf(s), rel = ((await call(p, 'media_frames', { path: prev.path, mode: 'tail' })).match(/^(\S+tail\.png)/m) || [])[1]; if (!rel) throw new Error(`抽不出“${prev.title}”的尾帧`);
            const up = await call(p, 'wb_upload', { project: p.project, path: rel, name: `${s.title}_承接尾帧`, category: '场景' }), disk = ((up.match(/磁盘路径：(.+)/) || [])[1] || '').trim();
            s.kf.first = { nodeId: nodeId(up), path: disk, url: pathToUrl(disk), status: 'approved', verdict: '', tail: true }; if (s.nodeId) { s.nodeId = ''; }   // 首帧换了，视频节点重建以便重新连线
          }
          const created = !s.nodeId;
          s.nodeId = nodeId(await call(p, 'wb_node_set', Object.assign({ project: p.project, title: s.title, text: s.prompt, template: TEMPLATE[s.method], duration: s.seconds, ratio: p.ratio, quality: { '480P': '预览', '1080P': 'RTX 增强' }[p.resolution] || '高清' }, created ? { type: 'video' } : { id: s.nodeId }))) || s.nodeId;
          const from = s.method === 'ref' ? used(s).map(x => x.im.nodeId) : s.method === 'fl' ? [s.kf.first.nodeId, s.kf.last.nodeId] : s.method === 'cont' ? [s.kf.first.nodeId] : [];   // 首尾帧的连线顺序：先首帧后尾帧
          if (created && from.length) await call(p, 'wb_edges', { project: p.project, add: from.map(f => ({ from: f, to: s.nodeId })) });
          Object.assign(s, { status: 'generating', url: '', path: '', qa: '', check: '' }); save(p);
        }
        if (!body.recheck) for (let i = 0; i < list.length; i += 12) { stopIf(); log(p, `提交 ${Math.min(12, list.length - i)} 个镜头，每个大约三四分钟…`); log(p, await call(p, 'wb_run', { project: p.project, node_ids: list.slice(i, i + 12).map(s => s.nodeId) })); }
        for (const s of list) {
          stopIf(); const n = await node(p, s.nodeId);
          if (!n.outputUrl) { s.status = 'failed'; s.qa = '生成失败，详见进度记录。'; s.verdict = '不合格'; save(p); continue; }
          s.url = mediaUrl(n.outputUrl); s.path = n['产物磁盘路径']; log(p, `正在检查“${s.title}”…`);
          try { s.check = await call(p, 'media_check', { path: s.path }); } catch (e) { s.check = '技术质检失败：' + e.message; }
          const subj = used(s).filter(x => x.e.kind !== '场景' && x.im.path).slice(0, 2);
          const refs = s.method === 'fl' ? [s.kf.first.path, s.kf.last.path] : s.method === 'cont' ? [s.kf.first.path] : s.method === 'ref' ? subj.map(x => x.im.path) : [];
          const lead = s.method === 'fl' ? '前 2 张是这个镜头设计好的首帧和尾帧，' : s.method === 'cont' ? '第 1 张是上一个镜头的最后一帧（这个镜头应当从它接着演），' : refs.length ? `前 ${refs.length} 张是参考图：${subj.map(x => `${x.e.kind}“${x.e.name}”的${x.im.label}`).join('、')}，` : '';
          try { s.qa = await call(p, 'media_look', { paths: [s.path], frames: 4, references: refs, question: `${lead}${lead ? '后面' : '这'} 4 张是生成的视频“${s.title}”按时间顺序的抽帧。\n这个镜头应当从这个状态开始：${s.start}\n动作：${s.action}\n到这个状态结束：${s.end}\n第一步，按时间顺序如实描述 4 张抽帧里画面的内容：${s.method === 't2v' ? '环境、光线和运动' : '人物的位置、朝向、姿态和手里的道具'}。\n第二步，核对（任何一项不满足都是不合格）：1) 开头和结尾是否分别符合起始状态和结束状态${s.method === 'fl' ? '（即首帧和尾帧）' : s.method === 'cont' ? '，开头是否和上一镜的最后一帧接得上' : ''}；2) ${s.beat === '静态' ? '这是静态气氛镜头：人物只有呼吸、眨眼、细微的神情变化是对的，“基本不动”不算问题；只检查有没有倒着走、瞬移、画面突变或卡住不动的死帧' : '中间是不是一个连贯的动作，有没有倒着走、瞬移、原地不动'}${s.move && s.move !== '静止' ? '；摄影机应当在' + s.move : ''}；3) ${s.method === 't2v' ? '画面有没有畸形、融化或突变' : '人物和道具是否' + (s.method === 'ref' ? '和参考图是同一个，并且' : '') + '始终没有变样、消失、肢体畸形或融化'}；4) 有没有多出来的人或物、文字水印。` + VERDICT_ASK }); } catch (e) { s.qa = '看画面失败：' + e.message; }
          s.verdict = /完整解码：有问题|黑帧段：(?!无)/.test(s.check) ? '不合格' : verdict(s.qa); s.status = 'review'; save(p);
        }
      };
      // 续接的镜头要等它前一个镜头做完，所以一轮一轮来：每轮做“现在已经具备条件”的镜头
      const done = new Set();
      for (let round = 0; round < shots.length + 1; round++) {
        const list = shots.filter(s => want(s) && !done.has(s.id) && (body.recheck || ready(s))); if (!list.length) break;
        for (const s of list) done.add(s.id);
        if (!body.recheck) for (const s of list) { stopIf(); log(p, `正在为“${s.title}”写视频提示词（${METHOD[s.method]}）…`); s.prompt = await writePrompt(s); s.retried = false; save(p); }
        await submit(list);
        const bad = body.recheck || !body.retry ? [] : list.filter(s => s.verdict === '不合格' && !s.retried && s.url);   // 默认不自动重做：重做很少救得回来，却要多花一倍时间，留给用户用“改这一段”决定
        if (bad.length) {
          log(p, `${bad.length} 个镜头没通过检查，各自动重做一次…`);
          for (const s of bad) { s.retried = true; s.prompt = await writePrompt(s, `\nThe previous take failed visual QA: ${clip(s.qa, 500)}\nRewrite to prevent exactly that failure. Keep the same action, characters and props.`); save(p); }
          await submit(bad);
        }
      }
      const left = shots.filter(s => want(s) && !done.has(s.id));
      p.stage = 'videos'; log(p, '镜头完成：' + shots.filter(s => done.has(s.id)).map(s => `${s.title}（${METHOD[s.method]}·${s.verdict}）`).join('、') + (left.length ? `；还有 ${left.length} 个没做（首尾帧或上一个镜头还没准备好）：${left.map(s => s.title).join('、')}` : ''));
    },
    // 7 成片：配乐（已有就复用）+ 合成 + 混音（峰值超限先调低配乐，再不行做限幅）+ 发布验收；给剧集记一段本集概要
    async final(p, body) {
      const all = p.shots || [], shots = all.filter(s => s.url); if (shots.length < 2) throw new Error('至少要有 2 个生成好的镜头才能合成');
      await catalog(); await gpuFree(); await ensureModel(p);
      const total = shots.reduce((a, s) => a + s.seconds, 0), old = p.final || {}, f = p.final = { status: 'working', music: old.music, musicNode: old.musicNode };
      if (body.newMusic || !f.musicNode || !(await node(p, f.musicNode)).outputUrl) {
        log(p, '正在写配乐提示词…');
        f.music = await llm(DIRECTOR, `为这一集写一段纯配乐的生成提示词（中文，一段话）：无人声无歌词、用什么乐器、速度、情绪、强弱变化、时长约 ${total} 秒、结尾自然收束。只输出提示词本身。\n\n剧本：\n${clip(p.script.text, 1500)}`, { maxTokens: 500 });
        f.musicNode = nodeId(await call(p, 'wb_node_set', { project: p.project, type: 'audio', title: '全片配乐', text: f.music, template: 'MiniMax Music 3 纯配乐（默认）', shot_duration: total }));
      } else { f.reusedMusic = true; log(p, '沿用已有的配乐，只重新合成画面。'); }
      f.composeNode = nodeId(await call(p, 'wb_node_set', { project: p.project, type: 'compose', title: '成片', name: p.name }));
      await call(p, 'wb_edges', { project: p.project, add: shots.map(s => ({ from: s.nodeId, to: f.composeNode })) }); save(p);   // 镜头之间一律硬切
      log(p, f.reusedMusic ? '提交合成…' : '提交配乐和合成…'); log(p, await call(p, 'wb_run', { project: p.project, node_ids: (f.reusedMusic ? [] : [f.musicNode]).concat(f.composeNode) }));
      const flags = [], hot = t => /【不通过】峰值|【警告】峰值/.test(t); let path0 = '';
      for (const vol of [0.22, 0.12]) {
        stopIf(); log(p, `混入配乐（音量 ${vol.toFixed(2)}）…`);
        path0 = ((await call(p, 'wb_mix_audio', { project: p.project, video_node: f.composeNode, audio_node: f.musicNode, volume: vol, output_name: p.name + '_成片' })).match(/混音完成：(.+)/) || [])[1];
        if (!path0) throw new Error('混音没有返回成片路径'); path0 = path0.trim(); f.check = await call(p, 'media_check', { path: path0 }); f.musicVolume = vol;
        if (!hot(f.check)) break; log(p, '峰值余量不足…');
      }
      if (hot(f.check)) {
        log(p, '调低配乐没有解决，峰值来自镜头原声。对音轨做限幅（画面不动）并存回项目…');
        const rel = ((await call(p, 'media_limit_peak', { path: path0 })).match(/输出：(.+)/) || [])[1];
        const up = await call(p, 'wb_upload', { project: p.project, path: rel.trim(), name: p.name + '_成片_限幅', category: '场景' });
        path0 = ((up.match(/磁盘路径：(.+)/) || [])[1] || '').trim(); if (!path0) throw new Error('限幅后的成片没能存回项目');
        f.check = await call(p, 'media_check', { path: path0 }); f.limited = true;
      }
      f.path = path0; f.url = pathToUrl(f.path); f.probe = await call(p, 'media_probe', { path: f.path });
      f.sheet = ((await call(p, 'media_contact_sheet', { path: f.path, count: Math.min(30, Math.max(12, shots.length * 2)) })).match(/预览 (\S+)/) || [])[1] || '';
      const subj = (p.elements || []).filter(e => e.kind !== '场景' && master(e).path).slice(0, 2);
      log(p, '正在看成片…'); try { f.qa = await call(p, 'media_look', { paths: [f.path], frames: Math.min(8, Math.max(4, shots.length)), references: subj.map(e => master(e).path), question: `${subj.length ? `前 ${subj.length} 张是参考图：${subj.map(e => `${e.kind}“${e.name}”`).join('、')}；后面是成片按时间顺序的抽帧。` : '这是成片按时间顺序的抽帧。'}这部片子要讲的事依次是：${shots.map(s => s.action).join(' → ')}。\n第一步，按顺序如实描述每张抽帧里人物在哪里、在做什么。\n第二步，核对：1) 只看这些画面，故事的先后顺序是否讲得通，人物有没有往回走、位置前后矛盾；2) 角色在全片是否是同一个人；3) 道具在不同镜头之间是否是同一件东西，有没有无故消失；4) 有没有多余的人、物、文字或水印。` + VERDICT_ASK }); } catch (e) { f.qa = '看成片失败：' + e.message; }
      for (const l of f.check.split('\n')) if (/【不通过】|【警告】/.test(l)) flags.push(l);
      if (/完整解码：有问题/.test(f.check)) flags.push('完整解码有错误'); if (verdict(f.qa) !== '合格') flags.push('整片的画面检查没有给出“合格”结论，见检查意见');
      for (const s of all) { if (!s.url) flags.push(`“${s.title}”没有生成成功，成片里缺这一段`); else if (s.verdict !== '合格') flags.push(`“${s.title}”没通过检查，成片里用的是最后一版，建议你看一下这一段`); }
      f.flags = flags; f.pending = ['配乐内容（有没有人声、乐器和风格对不对）：未经试听，需你确认', '配乐与环境声的比例：未经试听，需你确认', '正常速度完整看一遍：需你确认'];
      f.status = flags.length ? 'NOT PASSED' : 'UNVERIFIED'; p.stage = 'final';
      if (p.series) {
        const s = loadSeries(p.series), summary = await llm(DIRECTOR, `用两三句话概括这一集发生了什么，并写明结束时每个角色在哪里、是什么状态、手里拿着什么（给下一集衔接用）。只输出概括。\n\n${clip(p.script.text, 3000)}`, { maxTokens: 400 }).catch(() => '');
        s.episodes = s.episodes.filter(e => e.id !== p.id).concat({ id: p.id, n: p.episode, title: p.title, summary, seconds: total, file: f.path }).sort((a, b) => a.n - b.n); saveSeries(s);
      }
      log(p, flags.length ? `成片已生成，有 ${flags.length} 项需要你看，见成片区。` : '成片已生成，技术检查和画面检查通过；声音需要你亲自听过才算完成。');
    },
    // 一键自动制作：分镜 → 关键帧 → 视频 → 成片，中间不再等你确认。每一步的结果都留在页面上，做完后你只改不满意的小段
    async auto(p) {
      needApproved(p);
      if (!(p.shots || []).some(s => s.kf)) await ACTIONS.plan(p, {});
      stopIf(); try { await ACTIONS.keyframes(p, {}); } catch (e) { if (!/没有需要生成/.test(e.message)) throw e; }
      stopIf(); try { await ACTIONS.videos(p, {}); } catch (e) { if (!/没有可以生成/.test(e.message)) throw e; }
      stopIf(); await ACTIONS.final(p, {});
    },
    // 改一小段：按你的意见调整这个镜头的起始/动作/结束，重做它的首尾帧和视频，然后沿用配乐重新合成
    async redo(p, body) {
      const shots = p.shots || [], i = shots.findIndex(s => s.id === body.target), s = shots[i]; if (!s || !s.kf) throw new Error('没有这个镜头');
      await ensureModel(p);
      if (String(body.comment || '').trim()) {
        log(p, `按你的意见修改“${s.title}”：${body.comment}`);
        const prev = shots[i - 1], next = shots[i + 1];
        const j = await llmJSON(CRAFT(), `用户对这个镜头不满意，请按意见修改它，并保持和前后镜头接得上。\n\n这个镜头：${JSON.stringify({ title: s.title, size: s.size, angle: s.angle, start: s.start, action: s.action, end: s.end })}\n${prev && prev.scene === s.scene ? `上一个镜头的结束状态（本镜头的起始应当与它一致，除非用户要求改变）：${prev.end}` : '它是这一场的第一个镜头。'}\n${next && next.scene === s.scene ? `下一个镜头的起始状态（本镜头的结束应当与它一致）：${next.start}` : '它是这一场的最后一个镜头。'}\n上一版的检查意见：${clip(s.qa || '无', 400)}\n用户的意见：${body.comment}\n\n当前的生成方式是“${METHOD[s.method]}”；如果用户的意见说明应当换一种方式（参考/首尾帧/续接/空镜），就改 method，否则照抄。\n\n输出格式：{"size":"……","angle":"……","start":"……","action":"……","end":"……","method":"${METHOD[s.method]}"}`, { maxTokens: 1200 });
        for (const k of ['size', 'angle', 'start', 'action', 'end']) if (j[k]) s[k] = String(j[k]);
        const m = /首尾/.test(j.method) ? 'fl' : /续/.test(j.method) ? 'cont' : /空|转场/.test(j.method) ? 't2v' : /参考/.test(j.method) ? 'ref' : s.method;
        if (m !== s.method && !(m === 'cont' && (!prev || prev.scene !== s.scene))) { log(p, `生成方式从“${METHOD[s.method]}”改为“${METHOD[m]}”。`); s.method = m; s.kf = m === 'fl' ? { first: { status: 'draft' }, last: { status: 'draft' } } : {}; s.nodeId = ''; }
      } else log(p, `原样重做“${s.title}”…`);
      s.status = 'draft'; save(p);
      if (s.method === 'fl') { await ACTIONS.keyframes(p, { target: s.id }); stopIf(); } await ACTIONS.videos(p, { target: s.id }); stopIf(); await ACTIONS.final(p, {});
    },
  };

  function start(p, action, body) {
    if (job && job.running) throw new Error('上一步还在进行中');
    if (lock.get()) throw new Error('日常助手那边正在对话，等它结束再点');
    job = { id: p.id, action, running: true, abort: false }; lock.set({ abort() { job.abort = true; } });
    (async () => { try { await ACTIONS[action](p, body || {}); } catch (e) { log(p, '出错：' + e.message); } finally { for (const x of (p.elements || []).flatMap(e => e.images).concat(p.shots || [], (p.shots || []).flatMap(s => s.kf ? [s.kf.first, s.kf.last] : []).filter(Boolean))) if (x.status === 'generating') x.status = x.url ? 'review' : 'failed'; if (p.final && p.final.status === 'working') p.final.status = 'failed'; save(p); job.running = false; lock.set(null); } })();
  }
  const seriesView = sid => { try { const s = loadSeries(sid); return { id: s.id, name: s.name, ratio: s.ratio, resolution: s.resolution, style: s.style, bible: s.bible || '', episodes: s.episodes, assets: s.assets.map(a => ({ id: a.id, kind: a.kind, name: a.name, description: a.description, images: a.images.map(i => ({ label: i.label, from: i.from, url: '/preview/' + ['series', s.id].concat(i.file.split('/')).map(encodeURIComponent).join('/') })) })) }; } catch (e) { return null; } };

  async function handle(req, res, u, p) {
    if (p === '/studio') return send(res, 200, fs.readFileSync(path.join(__dirname, 'studio.html')), 'text/html; charset=utf-8');
    const running = id => !!(job && job.running && job.id === id);
    if (p === '/api/studio/list') return send(res, 200, { productions: fs.readdirSync(DIR).filter(d => fs.existsSync(file(d))).map(d => { const x = load(d); return { id: x.id, name: x.name, series: x.series || '', stage: x.stage, updatedAt: x.updatedAt }; }).sort((a, b) => b.updatedAt - a.updatedAt), series: fs.readdirSync(SDIR).filter(d => fs.existsSync(sfile(d))).map(d => { const s = loadSeries(d); return { id: s.id, name: s.name, ratio: s.ratio, resolution: s.resolution, style: s.style, episodes: s.count || 0, assets: s.assets.length }; }) });
    if (p === '/api/studio/workflows') { const items = await catalog(); return send(res, 200, { image: imageWorkflows(items) }); }
    if (p === '/api/studio/state') { const x = load(u.searchParams.get('id')); return send(res, 200, Object.assign({}, x, { running: running(x.id), action: running(x.id) ? job.action : '', busyElsewhere: !!(lock.get() && !running(x.id)), log: (x.log || []).slice(-40), seriesInfo: x.series ? seriesView(x.series) : null })); }
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const b = await readBody(req);
    if (p === '/api/studio/new') {
      const title = String(b.title || '').trim(); if (!title || !String(b.brief || '').trim()) throw new Error('本集标题和需求都要填');
      let s;
      if (b.series) s = loadSeries(b.series);
      else { const name = String(b.seriesName || '').trim(), sid = safe(name); if (!sid) throw new Error('新剧集要填剧集名'); if (fs.existsSync(sfile(sid))) throw new Error('已经有同名的剧集了，直接在“所属剧集”里选它'); s = { id: sid, name, ratio: ['16:9', '9:16', '1:1'].includes(b.ratio) ? b.ratio : '16:9', resolution: ['480P', '768P', '1080P'].includes(b.resolution) ? b.resolution : '768P', style: String(b.style || '').trim(), bible: '', count: 0, episodes: [], assets: [], createdAt: Date.now() }; }
      s.count = (s.count || 0) + 1; const id = safe(`${s.name}_第${s.count}集_${title}`); if (fs.existsSync(file(id))) throw new Error('这一集已经存在，换一个标题');
      saveSeries(s); save({ id, name: `${s.name} 第${s.count}集 ${title}`, series: s.id, episode: s.count, title, brief: String(b.brief).trim(), book: String(b.book || '').slice(0, 40000), reference: cleanRef(b.reference), seconds: 0, ratio: s.ratio, resolution: s.resolution, style: s.style, stage: 'new', createdAt: Date.now(), elements: [], shots: [], log: [] });
      return send(res, 200, { id });
    }
    const x = load(b.id);
    if (p === '/api/studio/stop') { if (running(x.id)) { job.abort = true; log(x, '收到停止请求：正在运行的生成任务不会被打断，但后面的步骤不再继续。'); } return send(res, 200, { ok: true }); }
    if (running(x.id)) return send(res, 409, { error: '这一集有一步正在进行，等它结束再操作' });
    if (p === '/api/studio/save') {   // 你在页面上的修改
      if (typeof b.script === 'string') x.script = { text: b.script, confirmed: false };
      if (typeof b.bible === 'string' && x.series) { const s = loadSeries(x.series); s.bible = b.bible; saveSeries(s); }
      for (const e of b.elements || []) {
        const t = (x.elements || []).find(k => k.id === e.id); if (!t) continue;
        for (const k of ['name', 'description']) if (typeof e[k] === 'string') t[k] = e[k];
        if (t.kind === '场景' && e.layout && typeof e.layout === 'object') { const L = cleanLayout(e.layout); if (!L) throw new Error(`“${t.name}”的空间锁定表格式不对`); t.layout = L; }
        for (const i of e.images || []) { const im = t.images.find(k => k.id === i.id); if (!im || im.fromLibrary) continue; const changed = (typeof i.prompt === 'string' && i.prompt !== im.prompt) || (typeof i.workflow === 'string' && i.workflow !== im.workflow); if (typeof i.prompt === 'string') im.prompt = i.prompt; if (typeof i.workflow === 'string' && im === t.images[0]) im.workflow = i.workflow; if (changed && im.status !== 'draft') im.status = 'draft'; }
      }
      if (b.addImage) { const t = (x.elements || []).find(k => k.id === b.addImage.el); if (!t || !newVariant(t, b.addImage.label, b.addImage.prompt)) throw new Error('加不了：名字为空，或者这个元素已经有同名的图'); }
      if (b.removeImage) for (const t of x.elements || []) { const i = t.images.findIndex(k => k.id === b.removeImage); if (i > 0) t.images.splice(i, 1); else if (i === 0) throw new Error('主图不能单独删；不要这个元素的话删除整个元素'); }
      if (b.removeElement) { const used = (x.shots || []).some(s => s.refs.some(r => r.el === b.removeElement)); if (used) throw new Error('已有镜头用到了它，不能删'); x.elements = (x.elements || []).filter(k => k.id !== b.removeElement); }
      if (b.addElement) x.elements.push({ id: rid('el_'), kind: ['角色', '场景', '道具'].includes(b.addElement.kind) ? b.addElement.kind : '道具', name: String(b.addElement.name || '新元素').slice(0, 30), description: '', images: [{ id: rid('im_'), label: '主图', mode: 't2i', prompt: '', workflow: T2I, status: 'draft' }] });
      save(x); return send(res, 200, { ok: true });
    }
    if (p === '/api/studio/upload') {   // 用你自己的图顶替这一张（比如在别处按平面图做好的场景图）
      let t, e; for (const k of x.elements || []) { const im = k.images.find(i => i.id === b.target); if (im) { t = im; e = k; } }
      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(String(b.data || '')); if (!t || !m) throw new Error('只能上传 PNG、JPG 或 WebP 图片');
      const buf = Buffer.from(m[2], 'base64'); if (buf.length > 20 * 1024 * 1024) throw new Error('图片超过 20MB');
      const dir = path.join(DIR, x.id, 'uploads'); fs.mkdirSync(dir, { recursive: true }); const file = path.join(dir, `${t.id}_${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`); fs.writeFileSync(file, buf);
      await ensureProject(x); const up = await call(x, 'wb_upload', { project: x.project, path: path.relative(WS, file), name: `${e.name}_${t.label}`, category: e.kind });
      const disk = ((up.match(/磁盘路径：(.+)/) || [])[1] || '').trim(); if (!disk) throw new Error('导入工作台失败：' + clip(up, 200));
      Object.assign(t, { nodeId: nodeId(up) || t.nodeId, path: disk, url: pathToUrl(disk), status: 'review', verdict: '', qa: '这是你自己上传的图，没有经过它的检查。', uploaded: true }); save(x);
      log(x, `你为“${e.name}·${t.label}”上传了自己的图，看过后点“通过”。`); return send(res, 200, { ok: true });
    }
    if (p === '/api/studio/mark') {   // 你对一张图或一个镜头的确认
      let t, e = null, label;
      if (b.kind === 'shot') { t = (x.shots || []).find(k => k.id === b.target); label = t && t.title; }
      else { for (const k of x.elements || []) { const im = k.images.find(i => i.id === b.target); if (im) { t = im; e = k; label = `${k.name}·${im.label}`; } } }
      if (!t || !t.url) throw new Error('没有可确认的产物');
      t.status = b.status === 'approved' ? 'approved' : 'rejected'; t.comment = String(b.comment || '');
      if (e && t.status === 'approved') toLibrary(x, e, t);
      log(x, `你把“${label}”标为${t.status === 'approved' ? '通过' + (e && x.series && !t.fromLibrary ? '，已存入剧集资产库' : '') : '不通过' + (t.comment ? '：' + t.comment : '')}`); return send(res, 200, { ok: true });
    }
    if (p === '/api/studio/run') { if (!ACTIONS[b.action]) throw new Error('未知操作'); start(x, b.action, b); return send(res, 200, { ok: true }); }
    send(res, 404, { error: 'not found' });
  }
  return { handle };
};
