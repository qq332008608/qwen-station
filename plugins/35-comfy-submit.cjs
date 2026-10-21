'use strict';
// ComfyUI 任务提交。写在代码里的硬规则：
//  1. 每次提交前必须由用户在界面上点“允许”（工作台手册：只有用户明确授权时才提交 GPU 任务）。
//     确认由平台内核负责；这里只提交用户确认时看到的那一份内容，没经过确认的调用直接拒绝。
//  2. 本地模型占着显存时 ComfyUI 跑不动，所以采用“交接”：卸载本地模型 → 提交 → 等任务结束 → 重新加载模型。
//  3. 不提供中断任务、清空队列的工具（AGENTS.md：不得打断正在运行的视频任务）。
const fs = require('fs'), crypto = require('crypto');
const WAIT_MINUTES = 90;
const approved = new Map();   // 确认时暂存的工作流内容，run 时取走；确认之后文件再被改动也不影响提交内容
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { unloadModel, loadModel } = require('../lib/gpu.cjs');
const portOf = (a, ctx) => { const p = a.port || ctx.cfg.comfyPorts[0]; if (!ctx.cfg.comfyPorts.includes(p)) throw new Error('port 只能是 ' + ctx.cfg.comfyPorts.join(' 或 ')); return p; };
const keyOf = (a, ctx) => `${portOf(a, ctx)}|${a.workflow_path}`;
function loadWorkflow(a, ctx) {
  let raw, wf; try { raw = fs.readFileSync(ctx.resolve(a.workflow_path), 'utf8'); wf = JSON.parse(raw); } catch (e) { throw new Error('读不了工作流文件：' + e.message); }
  if (wf && wf.prompt && typeof wf.prompt === 'object') wf = wf.prompt;
  const nodes = wf && typeof wf === 'object' ? Object.values(wf) : [];
  if (!nodes.length || wf.nodes || !nodes.every(n => n && typeof n.class_type === 'string' && n.inputs)) throw new Error('这不是 API 格式的工作流（每个节点要有 class_type 和 inputs）。界面保存的普通工作流不能直接提交，要用 ComfyUI 的“导出（API）”。');
  return { wf, hash: crypto.createHash('sha256').update(raw).digest('hex') };
}
function outputs(entry) {
  const files = [];
  for (const o of Object.values((entry && entry.outputs) || {})) for (const list of Object.values(o)) if (Array.isArray(list)) for (const f of list) if (f && f.filename) files.push((f.subfolder ? f.subfolder + '/' : '') + f.filename + (f.type ? `（${f.type}）` : ''));
  const st = (entry && entry.status) || {};
  return { done: !!entry, ok: st.status_str ? st.status_str === 'success' : !!entry, files, error: (st.messages || []).filter(m => m[0] === 'execution_error').map(m => `${m[1].node_type}: ${m[1].exception_message}`).join('; ') };
}

module.exports = {
  name: 'comfy_submit',
  tools: [
    { name: 'comfy_submit', description: '把工作区里一个 API 格式的工作流 JSON 提交给 ComfyUI 执行。平台会先请用户在界面上确认；本地模型会暂时卸载让出显卡，任务结束后自动恢复，所以这个调用可能持续很久。返回的是执行结果和输出文件名——提交成功、执行成功、文件可解码、画面合格是四件不同的事，输出仍需另行检查。',
      parameters: { type: 'object', properties: { workflow_path: { type: 'string', description: '相对工作区的工作流 JSON 路径（API 格式）' }, port: { type: 'integer', description: 'ComfyUI 端口，默认 8188' } }, required: ['workflow_path'] },
      // 内核在 run 之前调用它，把返回的文字展示给用户并等用户点“允许”
      async confirm(a, ctx) {
        const port = portOf(a, ctx), { wf, hash } = loadWorkflow(a, ctx);
        const q = await ctx.getJSON(`http://127.0.0.1:${port}/queue`, 4000); if (!q) throw new Error(`ComfyUI 没有运行（端口 ${port}），没有提交。`);
        if ((q.queue_running || []).length || (q.queue_pending || []).length) throw new Error('ComfyUI 还有任务在跑或排队，等它空了再提交，不要重复提交。');
        approved.set(keyOf(a, ctx), { wf, hash });
        const kinds = [...new Set(Object.values(wf).map(n => n.class_type))];
        return `向 ComfyUI（端口 ${port}）提交一个 GPU 任务\n工作流文件：${a.workflow_path}\n节点数：${Object.keys(wf).length}（${kinds.slice(0, 8).join('、')}${kinds.length > 8 ? ' 等' : ''}）\n内容指纹：${hash.slice(0, 8)}\n\n允许后会先卸载本地模型让出显卡，任务结束后自动重新加载；期间对话暂停。`;
      },
      async run(a, ctx) {
        const port = portOf(a, ctx), base = `http://127.0.0.1:${port}`, ok = approved.get(keyOf(a, ctx)); approved.delete(keyOf(a, ctx));
        if (!ok) throw new Error('这次提交没有经过用户确认，已拒绝。');
        ctx.progress('正在卸载本地模型，让出显卡…');
        const stopped = await unloadModel(); if (!stopped.ok) throw new Error('卸载本地模型失败，没有提交：' + ctx.clip(stopped.text, 300));
        let note;
        try {
          const res = await fetch(base + '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: ok.wf, client_id: 'qwen-station' }), signal: AbortSignal.timeout(30000) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok || !j.prompt_id) note = '提交被 ComfyUI 拒绝：' + ctx.clip(JSON.stringify(j.error || j.node_errors || j), 800);
          else for (const id = (ctx.progress(`已提交，任务编号 ${j.prompt_id}，等待 ComfyUI 执行…`), j.prompt_id), deadline = Date.now() + WAIT_MINUTES * 60000; ;) {
            await sleep(5000);
            const h = await ctx.getJSON(`${base}/history/${id}`, 5000), r = outputs(h && h[id]);
            if (r.done) { note = r.ok ? `任务 ${id} 执行成功。输出文件：\n${r.files.join('\n') || '（历史记录里没有列出文件）'}` : `任务 ${id} 执行失败：${r.error || '见 ComfyUI 历史记录'}`; break; }
            if (ctx.aborted() || Date.now() > deadline) return `任务 ${id} 仍在运行（${ctx.aborted() ? '用户按了停止' : `已等 ${WAIT_MINUTES} 分钟`}）。没有中断它；本地模型暂未恢复，等任务结束后需重新启动模型。`;
          }
        } catch (e) { note = '提交出错：' + e.message; }
        ctx.progress('任务已结束，正在重新加载本地模型（可能要几分钟）…');
        const back = await loadModel();
        return note + (back.ok ? '' : '\n（注意：本地模型重新加载失败：' + ctx.clip(back.text, 200) + '）');
      } },
    { name: 'comfy_result', description: '按任务编号查询 ComfyUI 任务的结果和输出文件名。只读。',
      parameters: { type: 'object', properties: { prompt_id: { type: 'string', description: 'comfy_submit 返回的任务编号' }, port: { type: 'integer', description: 'ComfyUI 端口，默认 8188' } }, required: ['prompt_id'] },
      async run(a, ctx) {
        const h = await ctx.getJSON(`http://127.0.0.1:${portOf(a, ctx)}/history/${encodeURIComponent(a.prompt_id)}`, 5000); if (!h) return 'ComfyUI 没有运行';
        const r = outputs(h[a.prompt_id]); return !r.done ? '还没有结果（仍在运行、排队，或编号不对）' : r.ok ? '执行成功。输出文件：\n' + (r.files.join('\n') || '（无）') : '执行失败：' + (r.error || '未知');
      } },
  ],
};
