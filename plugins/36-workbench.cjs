'use strict';
// AI 影视生成总台（工作台）接入：项目、画布节点与连线、工作流目录、批量提交生成、任务结果、素材上传、配乐混音。
// 字段和流程按工作台源码（server.py / console.js 的 runNode）与 RUNBOOK 实现，不走界面点击。
// 写在代码里的规则：
//  - 项目隔离：只能改“本平台新建的项目”或“用户点过允许的已有项目”，名单在工作区 .station/wb-projects.json。
//  - 保存永远是“读最新主档 → 改 → 带最新写入令牌保存”，不会用旧快照覆盖。
//  - 生成任务按批提交，每批由用户在界面上确认一次；批内不允许出现“依赖本批另一个节点产物”的节点（先生成、检查，再做下游）。
//  - D 档工作流不提交；视频节点不能互相串联，除非明确声明是续写。
//  - 有 GPU 任务时先卸载本地模型，全部结束后再加载回来。不提供取消、清空队列、删除素材的工具。
const fs = require('fs'), path = require('path');
const { unloadModel, loadModel } = require('../lib/gpu.cjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rid = p => p + Math.random().toString(36).slice(2, 9);
const S = d => ({ type: 'string', description: d });
const PROJECT = S('项目名称（或项目目录名）。必须精确。');
const TYPES = ['image', 'video', 'audio', 'compose'], SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'];
const CAT = { 人物: 'characters', 角色: 'characters', 场景: 'locations', 道具: 'props' };
const approved = new Map(), QUAD_ID = 'qwen21_direct_quad', QUAD_WF = 'Qwen Image 2.1 · 文生图2K（本地）';

async function api(ctx, p, body) {
  let res; try { res = await fetch(ctx.cfg.workbench + p, body === undefined ? { signal: AbortSignal.timeout(60000) } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(300000) }); }
  catch (e) { throw new Error(`工作台没有响应（${ctx.cfg.workbench}）。需要用户先启动“AI影视生成总台”。`); }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error('工作台返回错误：' + (j.error || res.status));
  return j;
}
const allowFile = ctx => ctx.resolve('.station/wb-projects.json', true);
const allowed = ctx => { try { return JSON.parse(fs.readFileSync(allowFile(ctx), 'utf8')); } catch (e) { return []; } };
const allow = (ctx, folder) => { const l = allowed(ctx); if (!l.includes(folder)) { fs.mkdirSync(path.dirname(allowFile(ctx)), { recursive: true }); fs.writeFileSync(allowFile(ctx), JSON.stringify(l.concat(folder), null, 1)); } };
async function load(ctx, ref, forWrite) {
  const data = await api(ctx, '/api/projects'), want = String(ref || '').trim();
  const hits = data.projects.filter(p => p.storageFolder === want || p.name === want);
  if (!hits.length) throw new Error(`没有名为“${want}”的项目。用 wb_projects 看准确名称；新影片用 wb_project_new 新建。`);
  if (hits.length > 1) throw new Error(`有 ${hits.length} 个项目都叫“${want}”，请改用目录名：${hits.map(p => p.storageFolder).join('、')}`);
  const p = hits[0];
  if (forWrite && !allowed(ctx).includes(p.storageFolder)) throw new Error(`“${p.name}”是已有项目，还没有获得用户许可。先调用 wb_project_open 请用户确认，不要改用别的项目。`);
  const wb = p.workbench = p.workbench || {};
  for (const k of ['canvasNodes', 'canvasEdges', 'canvasAssets']) if (!Array.isArray(wb[k])) wb[k] = [];
  return { p, wb, root: data.root };
}
const save = async (ctx, p) => (await api(ctx, '/api/projects/save', { project: p })).project;
const catalog = async ctx => (await api(ctx, '/api/workflows/catalog')).items;
const findWf = (items, name) => items.find(w => w.name === name || w.id === name);
// 项目内媒体地址 → 磁盘绝对路径（给 media_ 工具用）
function diskPath(root, url) { try { const q = new URL(url, 'http://x').searchParams; return q.get('folder') && q.get('file') ? path.join(root, q.get('folder'), q.get('file')) : ''; } catch (e) { return ''; } }
const mediaOf = n => n.type === 'asset' ? { url: n.url, kind: n.kind || 'image' } : { url: n.outputUrl, kind: n.type === 'compose' ? 'video' : n.type };
// 与界面的 incomingAssets 一致：按连线顺序取上游节点的媒体
function incoming(wb, n) {
  return wb.canvasEdges.filter(e => e.to === n.id).map(e => wb.canvasNodes.find(x => x.id === e.from)).filter(Boolean)
    .map(u => Object.assign({ id: u.id, title: u.title || u.name || u.id, category: u.category || u.assetType || '', detail: u.detail || '', src: u }, mediaOf(u)));
}
// 按界面 runNode 的规则把节点变成提交请求；有问题直接抛错
function buildRequest(p, wb, n, items, batchIds) {
  const base = { projectId: p.id, projectName: p.name, storageFolder: p.storageFolder || '', canvasNodeId: n.id }, refs = incoming(wb, n), label = `节点“${n.title || n.id}”`;
  const inBatch = refs.filter(r => batchIds.includes(r.id)); if (inBatch.length) throw new Error(`${label}依赖本批里的“${inBatch[0].title}”。先单独生成并检查上游，再提交它。`);
  const missing = refs.filter(r => !r.url); if (missing.length) throw new Error(`${label}的上游“${missing[0].title}”还没有产物，不能提交。`);
  if (n.type === 'compose') {
    const clips = refs.filter(r => r.kind === 'video'); if (clips.length < 2) throw new Error(`${label}至少要连入 2 个已完成的视频`);
    return { gpu: false, endpoint: '/api/video/merge', line: `合成 ${clips.length} 段：${clips.map(c => c.title).join(' → ')}`,
      payload: Object.assign({}, base, { episodeId: n.name || n.title || '成片', fps: Number(n.fps) || 24, transitionDuration: Number(n.transitionDuration) || 0.35, normalizeAudio: n.normalizeAudio !== false, shots: clips.map(c => ({ shotId: c.id, title: c.title, videoUrl: c.url, transitionToNext: 'direct' })) }) };   // 镜头之间一律硬切，不用叠化和黑场
  }
  const wf = findWf(items, n.templateId || n.template); if (!wf) throw new Error(`${label}的工作流“${n.template || ''}”不在目录里，用 wb_catalog 选真实名称`);
  if (wf.tier === 'D') throw new Error(`${label}用的“${wf.name}”是 D 档（本机缺模型），禁止提交`);
  const prompt = String(n.text || '').trim(); if (!prompt) throw new Error(`${label}没有填提示词`);
  const seed = /^\d+$/.test(String(n.seed || '')) ? Number(n.seed) : undefined, common = { workflowTemplate: wf.name, workflowTemplateId: wf.id, workflowParams: n.workflowParams || {}, seed };
  const tier = wf.tier && wf.tier !== 'A' ? `（${wf.tier} 档）` : '';
  if (n.type === 'image') {
    if (!String(n.name || '').trim()) throw new Error(`${label}缺素材名称 name`);
    const imgs = refs.filter(r => r.kind === 'image'), cam = n.cameraControl || {};
    if (n.characterTemplate === QUAD_ID) {   // 影视人物四视图：单张 9:16 的 2K 设定图，版式提示词用工作台自己的模板，这里只把人物描述填进去
      const tpl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'quad-prompt.txt'), 'utf8'), q = findWf(items, QUAD_WF) || wf;
      return { gpu: true, endpoint: '/api/assets/generate', line: `人物四视图｜${q.name}｜9:16 单张（正面头部、侧面头部、正面全身、背面全身）`,
        payload: Object.assign({}, base, { workflowTemplate: q.name, workflowTemplateId: q.id, workflowParams: n.workflowParams || {}, seed, assetType: 'characters', name: n.name, detail: tpl.replace('${core}', prompt), negative: '', mode: 'generate', visualMode: 'live', characterGender: { 男性: 'male', 女性: 'female' }[n.gender] || 'other', aspectRatio: '9:16', width: 1440, height: 2560, count: 1, characterGenerationTemplate: QUAD_ID, referenceImages: [] }) };
    }
    if (['multiangle', 'threeView', 'image_edit', 'upscale', 'outpaint', 'inpaint'].includes(wf.category) && !imgs.length) throw new Error(`${label}用的“${wf.name}”必须连入一张已有的图片作为底图`);
    return { gpu: true, endpoint: '/api/assets/generate', line: `图片｜${wf.name}${tier}｜${n.ratio || '16:9'}｜参考图 ${imgs.length} 张` + (wf.category === 'multiangle' ? `｜水平转 ${cam.azimuthDeg || 0}°` : ''),
      payload: Object.assign({}, base, common, wf.category === 'multiangle' ? { azimuth: cam.azimuthDeg || 0, elevation: cam.elevationDeg || 0, distance: cam.distance || 1.6 } : {}, wf.name === QUAD_WF ? ({ '16:9': { width: 2560, height: 1440 }, '9:16': { width: 1440, height: 2560 }, '1:1': { width: 2048, height: 2048 } }[n.ratio || '16:9'] || {}) : {}, { assetType: CAT[n.assetType] || 'characters', name: n.name, detail: prompt, negative: n.negative || '', mode: 'generate', visualMode: 'live', characterGender: { 男性: 'male', 女性: 'female' }[n.gender] || 'other', aspectRatio: n.ratio || '16:9', count: Number(n.count) || 1, characterGenerationTemplate: n.characterTemplate || 'normal', referenceImages: imgs.slice(0, wf.category === 'image_edit' ? 10 : 99).map((r, i) => ({ url: r.url, name: r.title, detail: wf.category !== 'image_edit' ? '' : i === 0 ? '被编辑底图' : /角色|人物/.test(r.category) ? '人物身份' : /场景/.test(r.category) ? '场景环境' : /道具/.test(r.category) ? '道具细节' : '通用参考' })) }) };   // 图片编辑类工作流：第一张连入的图是被编辑的底图
  }
  if (n.type === 'video') {
    const prof = wf.executionProfile || {}, by = k => refs.filter(r => r.kind === k);
    for (const rq of prof.requirements || []) { const have = rq.kind === 'any' ? refs.length : by(rq.kind).length; if (have < (rq.min || 1)) throw new Error(`${label}：${rq.message || '输入素材不足'}`); }
    const lack = prof.isH3 && prof.mode === 'Ref2VA' ? SECTIONS.filter(s => !prompt.includes(s)) : [];
    if (lack.length) throw new Error(`${label}的 H3 提示词缺少这些段落：${lack.join('、')}。按 h3-prompt-writing 技能写完整六段英文结构。`);
    const turbo = /双时钟|turbo/i.test(wf.name), slow = /放大_慢|二采/.test(wf.name), seconds = parseFloat(n.duration) || 5;
    const h3Mode = turbo ? 'turbo' : slow ? 'rtx_hq' : n.quality === 'RTX 增强' ? 'rtx_hq' : n.quality === '预览' ? 'pdd' : n.quality === '标准' ? 'native_fast' : 'native_hq';
    return { gpu: true, endpoint: '/api/video/generate', line: `视频｜${wf.name}${tier}｜${seconds} 秒｜${n.ratio || '16:9'}｜参考：图 ${by('image').length} 视频 ${by('video').length} 音频 ${by('audio').length}`,
      payload: Object.assign({}, base, common, { shotId: n.title || '分镜', prompt, promptIsOfficialH3: !!prof.isH3, seconds, aspectRatio: n.ratio || '16:9', steps: prof.isH3 || turbo ? 8 : Number(n.steps) || 25, h3Mode, resolution: n.quality === '预览' ? '480P' : '768P', finalResolution: n.quality === 'RTX 增强' || slow ? '1080P' : '768P', batchScale: n.batchScale || '1x', firstFrameImage: '',
        referenceImages: by('image').map(r => ({ url: r.url, name: r.title, detail: r.detail, assetType: CAT[r.category] || 'characters' })), referenceAudios: by('audio').map(r => ({ url: r.url, name: r.title, detail: r.detail })), referenceVideos: by('video').map(r => ({ url: r.url, name: r.title, detail: r.detail })) }) };
  }
  return { gpu: true, endpoint: '/api/audio/generate', line: `音频｜${wf.name}${tier}｜${Number(n.shotDuration) || 8} 秒`,
    payload: Object.assign({}, base, common, { shotId: n.title || '音频', text: prompt, speaker: n.speaker || 'Ryan', shotDuration: Number(n.shotDuration) || 8, referenceAudios: refs.filter(r => r.kind === 'audio').map(r => ({ url: r.url, name: r.title })) }) };
}
async function waitJob(ctx, id, title, minutes) {
  for (let last = '', end = Date.now() + minutes * 60000; ;) {
    await sleep(5000); if (ctx.aborted()) return { state: 'aborted' };
    let j; try { j = await api(ctx, '/api/jobs/' + encodeURIComponent(id)); } catch (e) { continue; }
    if (['complete', 'error', 'cancelled'].includes(j.state)) return j;
    const step = Math.floor((j.progress || 0) / 25); if (String(step) !== last) { last = String(step); ctx.progress(`${title}：${j.progress || 0}% ${ctx.clip(j.message || '', 60)}`); }
    if (Date.now() > end) return { state: 'timeout' };
  }
}
const resultUrl = j => { const r = j.result || {}; return r.videoUrl || r.imageUrl || r.audioUrl || r.modelUrl || j.videoUrl || j.imageUrl || j.audioUrl || ''; };
const place = wb => { const i = wb.canvasNodes.length; return { x: 80 + (i % 5) * 340, y: 80 + Math.floor(i / 5) * 280 }; };
function brief(wb, n, root) {
  const m = mediaOf(n), refs = wb.canvasEdges.filter(e => e.to === n.id).map(e => e.from);
  return `${n.id}｜${n.type}｜${n.title || n.name || ''}` + (n.template ? `｜${n.template}` : '') + (n.duration ? `｜${n.duration}` : '') + (n.type !== 'asset' && n.type !== 'compose' ? `｜提示词 ${String(n.text || '').length} 字` : '') + (refs.length ? `｜上游 ${refs.join(',')}` : '') + `｜${m.url ? '产物 ' + (diskPath(root, m.url) || m.url) : n.jobId ? '已提交未回填' : '无产物'}`;
}

module.exports = {
  name: 'workbench',
  tools: [
    { name: 'wb_status', description: '开工前检查：工作台是否在线、ComfyUI 是否就绪、ComfyUI 队列、未结束的工作台任务。任何生成操作之前先调它。',
      parameters: { type: 'object', properties: {} },
      async run(a, ctx) {
        const h = await api(ctx, '/__health'), c = await api(ctx, '/api/comfy/health').catch(e => ({ ready: false, error: e.message })), q = await ctx.getJSON((c.url || 'http://127.0.0.1:8188') + '/queue', 4000);
        const live = (await api(ctx, '/api/jobs')).items.filter(j => !['complete', 'error', 'cancelled'].includes(j.state));
        return [`工作台：${h.ok ? '在线' : '异常'}（${ctx.cfg.workbench}）`, `ComfyUI：${c.ready ? '就绪' : '未就绪 ' + (c.error || '')}`, q ? `ComfyUI 队列：运行 ${(q.queue_running || []).length}，排队 ${(q.queue_pending || []).length}` : 'ComfyUI 队列：读不到',
          `未结束的工作台任务：${live.length}` + live.slice(0, 8).map(j => `\n  ${j.id}｜${j.kind}｜${j.state}｜${j.name || ''}｜项目目录 ${j.storageFolder || ''}`).join(''), `本平台可修改的项目：${allowed(ctx).join('、') || '（无）'}`].join('\n');
      } },
    { name: 'wb_catalog', description: '列出工作台里真实存在的工作流（名称、档位、特点）。工作流名称必须从这里取，不能凭印象写。默认只列 A、B 档。',
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video', 'audio', 'all'], description: '只看某一类，默认 all' }, include_c: { type: 'boolean', description: '是否包含 C 档（高耗时，只用于少量终稿）' } } },
      async run(a, ctx) {
        const audio = w => /tts|music|song|audio/i.test(w.category + w.group), k = a.kind || 'all';
        return (await catalog(ctx)).filter(w => ['A', 'B'].concat(a.include_c ? ['C'] : []).includes(w.tier)).filter(w => k === 'all' || (k === 'audio' ? audio(w) : !audio(w) && (k === 'video') === (w.group === 'video' || w.category === 'video')))
          .map(w => `${w.tier}｜${w.category}｜${w.name}｜${w.feature || ''}` + ((w.executionProfile || {}).mode ? `｜模式 ${w.executionProfile.mode}` : '') + (((w.executionProfile || {}).requirements || []).length ? `｜要求：${w.executionProfile.requirements.map(r => r.message).join('；')}` : '')).join('\n');
      } },
    { name: 'wb_projects', description: '列出工作台里的项目：名称、目录、更新时间、节点数，以及本平台是否可以修改它。',
      parameters: { type: 'object', properties: {} },
      async run(a, ctx) { const d = await api(ctx, '/api/projects'), ok = allowed(ctx); return `项目根目录：${d.root}\n` + d.projects.map(p => `${ok.includes(p.storageFolder) ? '可改' : '只读'}｜${p.name}｜目录 ${p.storageFolder}｜${String(p.updatedAt).slice(0, 10)}｜节点 ${((p.workbench || {}).canvasNodes || []).length}`).join('\n'); } },
    { name: 'wb_project_new', description: '为一部新影片新建独立的空白项目。每部新片都要新建，不复用别的项目。',
      parameters: { type: 'object', properties: { name: S('项目名称，同时作为 E 盘下的目录名；不能和已有项目重名') }, required: ['name'] },
      async run(a, ctx) {
        const name = String(a.name || '').trim(); if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('项目名不能为空，也不能包含 \\ / : * ? " < > |');
        const d = await api(ctx, '/api/projects'); if (d.projects.some(p => p.name === name || p.storageFolder === name)) throw new Error(`已经有叫“${name}”的项目了，换一个名字（例如加日期）`);
        const p = await save(ctx, { id: 'director_' + Date.now().toString(36), name, storageFolder: name, storageWriteToken: '', workbench: { canvasNodes: [], canvasEdges: [], canvasAssets: [] } });
        allow(ctx, p.storageFolder); return `已新建项目“${p.name}”，目录 ${p.storagePath}`;
      } },
    { name: 'wb_project_open', description: '请求用户许可本平台修改一个已有项目（用于继续、排错）。会弹出确认，用户点允许后才能对它建节点和提交任务。',
      parameters: { type: 'object', properties: { project: PROJECT }, required: ['project'] },
      async confirm(a, ctx) { const { p, wb } = await load(ctx, a.project); if (allowed(ctx).includes(p.storageFolder)) return null; return `允许 Qwen 修改已有项目“${p.name}”吗？\n目录：${p.storagePath}\n现有节点 ${wb.canvasNodes.length} 个、素材 ${wb.canvasAssets.length} 个。\n允许后它可以在这个项目里增改节点和连线、上传素材、提交生成任务（生成任务仍会逐批再问你）。它不能删除磁盘上的素材。`; },
      async run(a, ctx) { const { p } = await load(ctx, a.project); allow(ctx, p.storageFolder); return `可以修改项目“${p.name}”了。`; } },
    { name: 'wb_canvas', description: '查看一个项目的画布：所有节点（类型、标题、工作流、是否已有产物及其磁盘路径）和连线。产物路径可直接交给 media_check、media_look。',
      parameters: { type: 'object', properties: { project: PROJECT }, required: ['project'] },
      async run(a, ctx) { const { p, wb, root } = await load(ctx, a.project); return `项目“${p.name}”｜目录 ${p.storagePath}\n节点 ${wb.canvasNodes.length} 个：\n${wb.canvasNodes.map(n => brief(wb, n, root)).join('\n') || '（空）'}\n连线（数组顺序即合成顺序）：\n${wb.canvasEdges.map(e => `${e.from} → ${e.to}`).join('\n') || '（无）'}`; } },
    { name: 'wb_node_get', description: '读取一个节点的完整内容（含完整提示词和结果信息）。',
      parameters: { type: 'object', properties: { project: PROJECT, id: S('节点 ID') }, required: ['project', 'id'] },
      async run(a, ctx) { const { wb, root } = await load(ctx, a.project), n = wb.canvasNodes.find(x => x.id === a.id); if (!n) throw new Error('没有这个节点：' + a.id); const m = mediaOf(n); return JSON.stringify(Object.assign({}, n, { h3CompileSignature: undefined, 产物磁盘路径: m.url ? diskPath(root, m.url) : '' }), null, 1); } },
    { name: 'wb_node_set', description: '新建或修改一个生成节点。不给 id 就是新建。类型：image（图片，需 name 和 asset_type）、video（视频）、audio（配音/配乐）、compose（合成，不需要工作流和提示词）。工作流名称必须来自 wb_catalog。修改已有节点时只需给要改的字段。',
      parameters: { type: 'object', properties: { project: PROJECT, id: S('已有节点 ID；新建时不填'), type: { type: 'string', enum: TYPES }, title: S('节点标题，如“镜头01_开门”'), name: S('素材名称（image、compose 用）'), asset_type: { type: 'string', enum: ['人物', '场景', '道具'], description: 'image 节点的素材类别' },
        text: S('完整提示词。H3 参考生成视频要写完整六段英文结构'), template: S('工作流真实名称'), duration: { type: 'number', description: '视频秒数' }, ratio: S('画幅，如 16:9、9:16'), quality: { type: 'string', enum: ['预览', '标准', '高清', 'RTX 增强'] }, seed: S('整数种子；不填为随机'), shot_duration: { type: 'number', description: '音频秒数' }, camera_azimuth: { type: 'number', description: '只用于“F2K-9B-多角度”：绕主体水平转多少度，0 正面、45 四分之三侧、90 侧面、180 背面' }, camera_elevation: { type: 'number', description: '只用于多角度：俯仰角 -45 到 45，默认 0' }, character_sheet: { type: 'boolean', description: '只用于 image 节点：设为 true 时生成“影视人物四视图”——单张 9:16 的 2K 设定图（正面头部、侧面头部、正面全身、背面全身）。这是人物参考图的标准做法；此时 text 只写这个人本身（身份、年龄、五官、发型、服装、体态、标志物），版式由平台套用，工作流自动选用 Qwen Image 2.1 文生图2K。' } }, required: ['project'] },
      async run(a, ctx) {
        const { p, wb } = await load(ctx, a.project, true), items = await catalog(ctx);
        let n = a.id ? wb.canvasNodes.find(x => x.id === a.id) : null, created = false;
        if (a.id && !n) throw new Error('没有这个节点：' + a.id);
        if (!n) { if (!TYPES.includes(a.type)) throw new Error('新建节点要给 type：' + TYPES.join(' / ')); n = Object.assign({ id: rid('n_'), type: a.type }, place(wb), { title: a.title || a.name || a.type, seed: '随机', workflowParams: {} }); wb.canvasNodes.push(n); created = true; }
        else if (a.type && a.type !== n.type) throw new Error('不能改变已有节点的类型');
        if (n.type === 'asset') throw new Error('素材节点不能这样修改；新素材用 wb_upload');
        if (a.template !== undefined) { const wf = findWf(items, a.template); if (!wf) throw new Error(`工作流“${a.template}”不存在，用 wb_catalog 看真实名称`); if (wf.tier === 'D') throw new Error(`“${wf.name}”是 D 档，禁止使用`); n.template = wf.name; n.templateId = wf.id; }
        for (const [k, v] of [['title', a.title], ['name', a.name], ['assetType', a.asset_type], ['text', a.text], ['ratio', a.ratio], ['quality', a.quality]]) if (v !== undefined) n[k] = v;
        if (a.camera_azimuth !== undefined || a.camera_elevation !== undefined) n.cameraControl = Object.assign({ distance: 1.6 }, n.cameraControl, a.camera_azimuth !== undefined ? { azimuthDeg: Number(a.camera_azimuth) } : {}, a.camera_elevation !== undefined ? { elevationDeg: Number(a.camera_elevation) } : {});
        if (a.workflow_params && typeof a.workflow_params === 'object') n.workflowParams = a.workflow_params;   // 按工作流节点传参数，键是“节点号.参数名”
        if (a.character_sheet !== undefined) { if (a.character_sheet) { n.characterTemplate = QUAD_ID; n.assetType = '人物'; n.ratio = '9:16'; const q = findWf(items, QUAD_WF); if (q) { n.template = q.name; n.templateId = q.id; } } else delete n.characterTemplate; }
        if (a.duration !== undefined) n.duration = a.duration + 's'; if (a.shot_duration !== undefined) n.shotDuration = a.shot_duration; if (a.seed !== undefined) n.seed = String(a.seed);
        if (a.text !== undefined && n.type === 'video') { n.h3Compiled = true; delete n.h3CompileSignature; }
        if (!created && (a.text !== undefined || a.template !== undefined || a.duration !== undefined) && n.outputUrl) { n.versions = (n.versions || []).concat(n.outputUrl); delete n.outputUrl; delete n.jobId; }
        await save(ctx, p); return `${created ? '已新建' : '已修改'}节点 ${n.id}（${n.type}｜${n.title}）` + (!created && !n.outputUrl && n.versions ? '。内容变了，原产物已转入历史版本，需要重新生成。' : '');
      } },
    { name: 'wb_edges', description: '增加或删除连线。上游的图片/音频/视频会作为下游节点的参考输入；连入合成节点的顺序就是剪辑顺序。一张图给两个视频要建两条线。视频节点之间默认不许连线，只有同一镜头续写才连，并要声明 continuation。',
      parameters: { type: 'object', properties: { project: PROJECT, add: { type: 'array', items: { type: 'object', properties: { from: S('上游节点 ID'), to: S('下游节点 ID') }, required: ['from', 'to'] } }, remove: { type: 'array', items: { type: 'object', properties: { from: S('上游节点 ID'), to: S('下游节点 ID') }, required: ['from', 'to'] } }, continuation: { type: 'boolean', description: '确实是同一镜头的续写（用真实解码尾帧衔接）时才设为 true' } }, required: ['project'] },
      async run(a, ctx) {
        const { p, wb } = await load(ctx, a.project, true), node = id => { const n = wb.canvasNodes.find(x => x.id === id); if (!n) throw new Error('没有这个节点：' + id); return n; };
        let added = 0, removed = 0;
        for (const e of a.remove || []) { const i = wb.canvasEdges.findIndex(x => x.from === e.from && x.to === e.to); if (i >= 0) { wb.canvasEdges.splice(i, 1); removed++; } }
        for (const e of a.add || []) {
          const f = node(e.from), t = node(e.to); if (f.id === t.id) throw new Error('不能自己连自己');
          if (t.type === 'asset') throw new Error('素材节点不能作为下游');
          if (f.type === 'video' && t.type === 'video' && !a.continuation) throw new Error(`“${f.title}”→“${t.title}”是视频连视频：独立镜头之间不要串联（会造成融形和假转场）。各自连到合成节点；确实是续写才加 continuation。`);
          if (!wb.canvasEdges.some(x => x.from === f.id && x.to === t.id)) { wb.canvasEdges.push({ id: rid('e_'), from: f.id, to: t.id }); added++; }
        }
        await save(ctx, p); return `连线已保存：新增 ${added} 条，删除 ${removed} 条，现共 ${wb.canvasEdges.length} 条。`;
      } },
    { name: 'wb_run', description: '把一批节点提交生成（图片、视频、音频、合成），等全部结束后返回每个节点的结果和产物磁盘路径。平台会把这一批的清单给用户确认一次。期间本地模型会卸载让出显卡，所以这个调用可能持续很久。一批最多 12 个节点，且不能包含依赖本批其他节点产物的节点。任务成功不等于画面合格：返回后必须逐个用 media_check 和 media_look 检查，合格才能做下游。',
      parameters: { type: 'object', properties: { project: PROJECT, node_ids: { type: 'array', items: { type: 'string' }, description: '要生成的节点 ID 列表' } }, required: ['project', 'node_ids'] },
      async confirm(a, ctx) {
        const ids = [...new Set(a.node_ids || [])]; if (!ids.length || ids.length > 12) throw new Error('一批要有 1 到 12 个节点');
        const { p, wb } = await load(ctx, a.project, true), items = await catalog(ctx), lines = [];
        const st = await api(ctx, '/api/comfy/health'); if (!st.ready) throw new Error('ComfyUI 未就绪，不能提交');
        const live = (await api(ctx, '/api/jobs')).items.filter(j => !['complete', 'error', 'cancelled'].includes(j.state)); if (live.length) throw new Error(`工作台还有 ${live.length} 个任务没结束，等它们结束再提交，不要重复提交`);
        let gpu = 0;
        for (const id of ids) { const n = wb.canvasNodes.find(x => x.id === id); if (!n) throw new Error('没有这个节点：' + id); if (!TYPES.includes(n.type)) throw new Error(`节点 ${id} 是 ${n.type}，不能生成`); const r = buildRequest(p, wb, n, items, ids); if (r.gpu) gpu++; lines.push(`${lines.length + 1}. ${n.title || n.id}｜${r.line}`); }
        approved.set(p.storageFolder + '|' + ids.join(','), true);
        return `在项目“${p.name}”里提交这一批共 ${ids.length} 个任务（其中 ${gpu} 个占用显卡）：\n${lines.join('\n')}\n\n` + (gpu ? '允许后会先卸载本地模型让出显卡，逐个执行，全部结束后自动重新加载；期间对话暂停。' : '这一批不占用显卡。');
      },
      async run(a, ctx) {
        const ids = [...new Set(a.node_ids || [])]; let { p, wb, root } = await load(ctx, a.project, true);
        const key = p.storageFolder + '|' + ids.join(','); if (!approved.get(key)) throw new Error('这一批没有经过用户确认，已拒绝。'); approved.delete(key);
        const items = await catalog(ctx), plan = ids.map(id => buildRequest(p, wb, wb.canvasNodes.find(x => x.id === id), items, ids)), gpu = plan.some(r => r.gpu), out = [];
        if (gpu) { ctx.progress('正在卸载本地模型，让出显卡…'); const s = await unloadModel(); if (!s.ok) throw new Error('卸载本地模型失败，没有提交：' + s.text); }
        let aborted = false;
        for (let i = 0; i < ids.length && !aborted; i++) {
          const title = wb.canvasNodes.find(x => x.id === ids[i]).title || ids[i]; let line;
          try {
            const sub = await api(ctx, plan[i].endpoint, plan[i].payload); if (!sub.jobId) throw new Error('工作台没有返回任务编号');
            ({ p, wb } = await load(ctx, a.project, true)); wb.canvasNodes.find(x => x.id === ids[i]).jobId = sub.jobId; await save(ctx, p);
            ctx.progress(`（${i + 1}/${ids.length}）已提交“${title}”，任务 ${sub.jobId}${sub.duplicate ? '（工作台复用了已有的同名任务）' : ''}`);
            const j = await waitJob(ctx, sub.jobId, title, 90);
            if (j.state === 'aborted') { aborted = true; line = `仍在运行（用户按了停止）。任务 ${sub.jobId} 没有被中断。`; }
            else if (j.state === 'timeout') line = `等了 90 分钟仍未结束，任务 ${sub.jobId}，稍后用 wb_jobs 查看`;
            else if (j.state !== 'complete') line = `失败（${j.state}）：${ctx.clip(j.error || j.message || '', 400)}`;
            else {
              const url = resultUrl(j); ({ p, wb } = await load(ctx, a.project, true)); const n = wb.canvasNodes.find(x => x.id === ids[i]);
              if (url) { if (n.outputUrl && n.outputUrl !== url) n.versions = (n.versions || []).concat(n.outputUrl); n.outputUrl = url; n.resultMeta = j.result || {}; await save(ctx, p); }
              line = url ? `完成。产物：${diskPath(root, url) || url}` : '任务完成但没有返回产物地址';
            }
          } catch (e) { line = '出错：' + e.message; }
          out.push(`${ids[i]}｜${title}｜${line}`);
        }
        if (aborted) return out.join('\n') + '\n\n任务还在跑，没有中断；本地模型暂未恢复，等任务结束后需重新运行 start.ps1。';
        if (gpu) { ctx.progress('这一批已结束，正在释放 ComfyUI 显存并重新加载本地模型…'); await api(ctx, '/api/comfy/free', {}).catch(() => {}); const b = await loadModel(); if (!b.ok) out.push('（注意：本地模型重新加载失败：' + b.text + '）'); }
        return out.join('\n') + '\n\n下一步：对每个完成的产物先 media_check，再 media_look 按验收点检查；不合格的只改那一个节点后重做。合格之前不要提交依赖它的节点。音频产物只能做 media_check，内容（人声、风格、对白）写“未经试听，需人工确认”。';
      } },
    { name: 'wb_jobs', description: '查看某个项目最近的工作台任务状态；给 job_id 则看单个任务的详情。两次查询至少间隔 60 秒。只读。',
      parameters: { type: 'object', properties: { project: PROJECT, job_id: S('任务编号，可选') } },
      async run(a, ctx) {
        if (a.job_id) { const j = await api(ctx, '/api/jobs/' + encodeURIComponent(a.job_id)); return ctx.clip(JSON.stringify({ id: j.id, kind: j.kind, state: j.state, progress: j.progress, message: j.message, error: j.error, name: j.name, result: j.result }, null, 1), 3000); }
        const { p } = await load(ctx, a.project), list = (await api(ctx, `/api/jobs?projectId=${encodeURIComponent(p.id)}&storageFolder=${encodeURIComponent(p.storageFolder)}`)).items.filter(j => j.storageFolder === p.storageFolder);
        return list.slice(0, 20).map(j => `${j.id}｜${j.kind}｜${j.state}｜${j.progress}%｜${j.name || ''}｜${ctx.clip(j.error || j.message || '', 80)}`).join('\n') || '这个项目还没有任务';
      } },
    { name: 'wb_upload', description: '把一个本地文件（工作区里的图片/视频/音频，例如 media_frames 抽出的尾帧）存进项目素材库，并在画布上建一个素材节点。长视频续写时用它把上一段的真实尾帧变成下一段的首帧素材。返回新素材节点的 ID。',
      parameters: { type: 'object', properties: { project: PROJECT, path: S('文件路径（工作区相对路径，或媒体目录下的绝对路径）'), name: S('素材名称'), category: { type: 'string', enum: ['角色', '场景', '道具'], description: '素材类别，尾帧、成片一般用“场景”' } }, required: ['project', 'path', 'name'] },
      async run(a, ctx) {
        const { p, wb } = await load(ctx, a.project, true), file = ctx.resolve(a.path), ext = path.extname(file).toLowerCase().slice(1);
        const kind = /^(png|jpe?g|webp)$/.test(ext) ? 'image' : /^(mp4|mov|webm|mkv)$/.test(ext) ? 'video' : /^(wav|mp3|flac|m4a|ogg)$/.test(ext) ? 'audio' : null; if (!kind) throw new Error('不支持的文件类型：' + ext);
        if (fs.statSync(file).size > 200e6) throw new Error('文件超过 200MB，不能这样上传');
        const mime = `${kind}/${{ jpg: 'jpeg', mov: 'quicktime', mkv: 'x-matroska', mp3: 'mpeg', m4a: 'mp4' }[ext] || ext}`, category = a.category || '场景';
        const r = await api(ctx, '/api/assets/upload', { projectId: p.id, projectName: p.name, storageFolder: p.storageFolder, mediaKind: kind, fileName: path.basename(file), fileData: `data:${mime};base64,` + fs.readFileSync(file).toString('base64'), assetType: { 角色: 'characters', 场景: 'scenes', 道具: 'props' }[category], characterName: a.name });
        const url = r.imageUrl || r.videoUrl || r.audioUrl || r.url; if (!url) throw new Error('上传成功但工作台没有返回地址：' + ctx.clip(JSON.stringify(r), 200));
        const fresh = await load(ctx, a.project, true), node = Object.assign({ id: rid('n_'), type: 'asset' }, place(fresh.wb), { title: a.name, kind, category, url, relativeFile: r.relativeFile || '' });
        fresh.wb.canvasNodes.push(node); fresh.wb.canvasAssets.push({ id: rid('a_'), name: a.name, kind, category, url, relativeFile: r.relativeFile || '', description: '', tags: '', viewAngle: '', qualityLevel: '原始' });
        await save(ctx, fresh.p); return `已存入项目素材库并建立素材节点 ${node.id}（${kind}｜${a.name}）\n磁盘路径：${diskPath(fresh.root, url) || r.relativeFile}`;
      } },
    { name: 'wb_mix_audio', description: '把配乐混入已合成的视频（不占显卡）。画面锁定并生成好配乐之后用。返回混音后成片的磁盘路径，成片仍要做完整的发布验收。',
      parameters: { type: 'object', properties: { project: PROJECT, video_node: S('视频或合成节点 ID（已有产物）'), audio_node: S('配乐节点 ID（已有产物）'), volume: { type: 'number', description: '配乐音量 0.05–1，默认 0.22' }, output_name: S('输出名称，默认“最终成片_配乐版”') }, required: ['project', 'video_node', 'audio_node'] },
      async run(a, ctx) {
        const { p, wb, root } = await load(ctx, a.project, true), get = id => { const n = wb.canvasNodes.find(x => x.id === id), m = n && mediaOf(n); if (!m || !m.url) throw new Error(`节点 ${id} 不存在或还没有产物`); return m.url; };
        const sub = await api(ctx, '/api/video/mix-audio', { projectId: p.id, projectName: p.name, storageFolder: p.storageFolder, videoUrl: get(a.video_node), audioUrl: get(a.audio_node), musicVolume: Math.min(1, Math.max(0.05, a.volume || 0.22)), fadeOutSeconds: 1.5, outputName: a.output_name || '最终成片_配乐版' });
        const j = await waitJob(ctx, sub.jobId, '配乐混音', 20); if (j.state !== 'complete') throw new Error(`混音没有完成（${j.state}）：` + ctx.clip(j.error || j.message || '', 300));
        const url = resultUrl(j); return `混音完成：${diskPath(root, url) || url}\n这只是候选成片，还要用 media_probe、media_check、media_look、media_contact_sheet 做发布验收。\n先对它跑 media_check：如果峰值出现【警告】或【不通过】，把 volume 调低（例如减 0.06）重新混音，最多重混两次。配乐与环境声的比例是否合适你听不到，报告里写“未经试听，需人工确认”。`;
      } },
  ],
};
