'use strict';
// 两个推理引擎的同题对比：node engine-bench.cjs <名字> <baseUrl> <modelId>
// 同一批题：速度（自然中文写作）、工具调用、结构化 JSON、长文找事实（6 千字和 2 万多 token 两档）。结果写到 tools/bench-<名字>.json
const fs = require('fs'), path = require('path'), http = require('http');
const [name, base, model] = process.argv.slice(2);
function chat(body, timeoutMs) {
  return new Promise((res, rej) => { const u = new URL(base + '/v1/chat/completions'), data = Buffer.from(JSON.stringify(Object.assign({ model, temperature: 0.2, stream: false }, body))), t0 = Date.now();
    const q = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => { const s = Buffer.concat(c).toString('utf8'); try { const j = JSON.parse(s); if (r.statusCode >= 300) return rej(new Error(`HTTP ${r.statusCode} ${s.slice(0, 200)}`)); res({ j, sec: (Date.now() - t0) / 1000 }); } catch (e) { rej(new Error(`HTTP ${r.statusCode} ${s.slice(0, 200)}`)); } }); });
    q.setTimeout(timeoutMs || 600000, () => q.destroy(new Error('超时'))); q.on('error', rej); q.end(data); });
}
const text = m => String(m.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const TOOLS = [
  { type: 'function', function: { name: 'read_file', description: '读取工作区里的一个文本文件', parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'comfy_status', description: '查看 ComfyUI 队列是否空闲', parameters: { type: 'object', properties: {} } } },
];
// 长文：编号的仓库流水，其中埋三条要找的事实（开头、中间、结尾各一条）
function longDoc(lines) {
  const goods = ['螺栓', '轴承', '密封圈', '滤芯', '传感器', '线缆', '阀门', '垫片'], out = []; let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  for (let i = 1; i <= lines; i++) out.push(`第${i}条：${2020 + rnd(6)}年${1 + rnd(12)}月${1 + rnd(28)}日，${['一', '二', '三', '四'][rnd(4)]}号库入库${goods[rnd(8)]} ${10 + rnd(990)} 件，经手人编号 ${1000 + rnd(9000)}。`);
  out[Math.floor(lines * 0.05)] += ' 备注：本批货的保管柜密码是 青松-4471。'; out[Math.floor(lines * 0.5)] += ' 备注：质检员老何的分机号是 6038。'; out[Math.floor(lines * 0.93)] += ' 备注：下次盘点定在 冬至后第三天。';
  return out.join('\n');
}
const FACTS = [['保管柜密码是什么', '4471'], ['质检员老何的分机号是多少', '6038'], ['下次盘点定在什么时候', '冬至后第三天']];
(async () => {
  const R = { name, base, model, at: new Date().toISOString(), tests: [] }, add = (t, o) => { R.tests.push(Object.assign({ t }, o)); console.log(`[${t}] ${JSON.stringify(o).slice(0, 260)}`); fs.writeFileSync(path.join(__dirname, `bench-${name}.json`), JSON.stringify(R, null, 1)); };
  const run = async (t, fn) => { try { add(t, await fn()); } catch (e) { add(t, { ok: false, error: e.message.slice(0, 200) }); } };
  await run('热身', async () => { const { sec } = await chat({ messages: [{ role: 'user', content: '说“好”。' }], max_tokens: 20 }); return { ok: true, sec }; });
  for (const [k, prompt] of [['写作A', '用中文写一段 500 字左右的短文，讲一个修钟表的老人在雨天等一位老顾客的故事。只写正文。'], ['写作B', '用中文解释一下为什么冬天早晨的湖面会起雾，写 400 字左右，分三段。']])
    await run('速度·' + k, async () => { const { j, sec } = await chat({ messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.7 }); const u = j.usage || {}, out = text(j.choices[0].message); return { ok: out.length > 200, sec: +sec.toFixed(1), completion: u.completion_tokens, tokPerSec: +(u.completion_tokens / sec).toFixed(1), chars: out.length, finish: j.choices[0].finish_reason, head: out.slice(0, 40) }; });
  for (const [k, q, want] of [['读文件', '帮我看看 notes/todo.md 里写了什么。', 'read_file'], ['查队列', 'ComfyUI 现在有任务在跑吗？', 'comfy_status'], ['联网', '查一下 Blender 基金会的《Tears of Steel》是哪一年发布的。', 'web_search'], ['不该调', '3 乘以 17 等于多少？直接回答。', null]])
    await run('工具·' + k, async () => { const { j, sec } = await chat({ messages: [{ role: 'system', content: '你是本地助手。需要时调用工具，不需要时直接回答。' }, { role: 'user', content: q }], tools: TOOLS, max_tokens: 400 }); const m = j.choices[0].message, c = (m.tool_calls || [])[0]; let args = null, argsOk = true; if (c) { try { args = JSON.parse(c.function.arguments || '{}'); } catch (e) { argsOk = false; } } const got = c ? c.function.name : null; return { ok: got === want && argsOk, sec: +sec.toFixed(1), called: got, args, reply: c ? '' : text(m).slice(0, 60) }; });
  await run('JSON·分镜', async () => { const { j, sec } = await chat({ messages: [{ role: 'user', content: '把这段话拆成 3 个镜头，只输出 JSON，不要别的文字：“傍晚，老周走进书房，在书桌前坐下，拧亮台灯，打开木匣取出一封旧信。”\n格式：{"shots":[{"title":"","size":"全景/中景/近景/特写","start":"","action":"","end":""}]}' }], max_tokens: 900 }); const out = text(j.choices[0].message); let ok = false, n = 0; try { const o = JSON.parse(out.match(/\{[\s\S]*\}/)[0]); n = o.shots.length; ok = n === 3 && o.shots.every(s => s.title && s.size && s.start && s.action && s.end); } catch (e) {} return { ok, sec: +sec.toFixed(1), shots: n, tail: out.slice(-50) }; });
  for (const [k, lines] of [['约6千token', 150], ['约2.5万token', 620]]) {
    const doc = longDoc(lines);
    for (const [q, want] of FACTS) await run(`长文·${k}·${want}`, async () => { const { j, sec } = await chat({ messages: [{ role: 'user', content: `下面是一份仓库流水记录。\n\n${doc}\n\n问题：记录的备注里写的${q}？只回答那一项内容。` }], max_tokens: 200 }, 900000); const out = text(j.choices[0].message); return { ok: out.includes(want), sec: +sec.toFixed(1), prompt: (j.usage || {}).prompt_tokens, reply: out.slice(0, 60) }; });
  }
  const ok = R.tests.filter(t => t.ok).length; console.log(`\n${name}：${ok}/${R.tests.length} 通过`); console.log('BENCH_DONE');
})();
