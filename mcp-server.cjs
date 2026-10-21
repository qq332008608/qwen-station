#!/usr/bin/env node
'use strict';
// 让其他智能体（Claude Code、OpenClaw、Codex 等支持 MCP 的客户端）把任务委托给 Qwen Station。
// 这是一个标准输入输出方式的 MCP 服务：对方发来任务，这里转给本机平台的 /api/agent/task，跑完一整轮后把回答交回去。
// 平台必须已经在运行。需要用户点确认的操作（提交 GPU 任务、修改已有项目、把内容发给外部服务）在委托模式下会被自动拒绝。
// 在 Claude Code 里登记：claude mcp add qwen-station -- node D:\qwen-station\mcp-server.cjs
const fs = require('fs'), path = require('path'), readline = require('readline');
const PORT = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')).port, BASE = `http://127.0.0.1:${PORT}`;
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
const TOOLS = [
  { name: 'qwen_station_task', description: 'Delegate a task to the local Qwen Station agent (a local Qwen3.8 27B model with vision, running on this machine with tools: workspace files, web search and fetch, headless browser, GitHub read, knowledge base and memory, media inspection with ffmpeg, and read access to the AI film workbench). It runs one full agent turn and returns its final answer. Runs unattended: anything needing the user\'s on-screen approval (GPU generation, editing existing film projects, sending content to external services) is refused. Write the task so it stands alone. Pass the returned session id to continue the same conversation.',
    inputSchema: { type: 'object', properties: { task: { type: 'string', description: 'Complete, self-contained task description' }, session: { type: 'string', description: 'Session id from a previous call, to continue that conversation' }, from: { type: 'string', description: 'Name of the calling agent' } }, required: ['task'] } },
  { name: 'qwen_station_status', description: 'Check whether Qwen Station is running, whether its local model is loaded, whether it is busy, and which tools it has.', inputSchema: { type: 'object', properties: {} } },
];
async function callTool(name, a) {
  if (name === 'qwen_station_status') { const s = await (await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(8000) })).json(); return `model: ${s.model} (${s.modelReady ? 'loaded' : 'NOT loaded'})\nbusy: ${s.busy}\ntools (${s.tools.length}): ${s.tools.join(', ')}`; }
  if (name !== 'qwen_station_task') throw new Error('unknown tool ' + name);
  const res = await fetch(BASE + '/api/agent/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: a.task, session: a.session, from: a.from }), signal: AbortSignal.timeout(3600000) });
  const j = await res.json(); if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
  return (j.text || '(no answer)') + `\n\n---\nsession: ${j.session}\ntools used: ${j.tools.join(', ') || 'none'}` + (j.deniedConfirmations ? `\nrefused (needed user approval): ${j.deniedConfirmations}` : '') + (j.error ? `\nerror: ${j.error}` : '');
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let m; try { m = JSON.parse(line); } catch (e) { return; }
  if (m.id === undefined) return;   // 通知类消息不需要回复
  try {
    if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: (m.params || {}).protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'qwen-station', version: '1.0.0' } } });
    if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
    if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    if (m.method === 'tools/call') {
      try { return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: await callTool(m.params.name, m.params.arguments || {}) }] } }); }
      catch (e) { return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: /fetch failed|ECONNREFUSED/.test(String(e.cause || e.message)) ? `Qwen Station is not running on ${BASE}. Ask the user to start it (desktop shortcut "Qwen Station").` : String(e.message) }] } }); }
    }
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found: ' + m.method } });
  } catch (e) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e.message) } }); }
});
