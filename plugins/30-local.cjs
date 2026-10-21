'use strict';
// 本机程序接入：ComfyUI 队列、AI 影视工作台任务、显卡状态。全部只读。
const { execFile } = require('child_process');
const none = { type: 'object', properties: {} };
module.exports = {
  name: 'local',
  tools: [
    { name: 'comfy_status', description: '查看 ComfyUI（8188/8189）是否在线，以及正在运行和排队的任务数。有任务时不要占用显卡做别的事。',
      parameters: none,
      async run(a, ctx) {
        const out = [];
        for (const port of ctx.cfg.comfyPorts) { const q = await ctx.getJSON(`http://127.0.0.1:${port}/queue`, 3000); out.push(q ? `${port}：在线，运行中 ${(q.queue_running || []).length}，排队 ${(q.queue_pending || []).length}` : `${port}：未运行`); }
        return out.join('\n');
      } },
    { name: 'workbench_jobs', description: '查看 AI 影视工作台的任务列表（/api/jobs）。两次查询至少间隔 60 秒。',
      parameters: none,
      async run(a, ctx) { const j = await ctx.getJSON(ctx.cfg.workbench + '/api/jobs', 5000); return j ? j : '工作台未运行（' + ctx.cfg.workbench + '）'; } },
    { name: 'gpu_status', description: '查看显卡占用：使用率、显存、温度。',
      parameters: none,
      run() { return new Promise(r => execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader'], { timeout: 8000, windowsHide: true }, (e, out) => r(e ? '读不到显卡状态：' + e.message : out.trim()))); } },
  ],
};
