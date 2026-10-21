'use strict';
// 插件构建器：让本地 Qwen 阅读 OpenClaw 内置扩展/技能的资料，自己决定能否移植，并写成 Station 插件。
// 每个产出都要过：静态安全扫描 → 语法检查 → 隔离加载校验 → DeepSeek 审查。通过的放进 plugins-pending/，
// 不会自动启用——人工看过后把文件移到 plugins/ 才生效。
// 运行：node build.cjs [本次做几个，默认全部]     可重复运行，做过的跳过。
const fs = require('fs'), path = require('path'), http = require('http');
const { spawn, spawnSync } = require('child_process');
const HERE = __dirname, ROOT = path.dirname(HERE), PENDING = path.join(ROOT, 'plugins-pending'), REJ = path.join(HERE, 'rejected');
const OC = 'D:\\openclaw\\runtime\\openclaw\\node_modules\\openclaw';
const DSH_EXE = 'D:\\DeepSeek\\DeepSeek Harness.exe';
const DSH_CLI = 'D:\\DeepSeek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';
for (const d of [PENDING, REJ, path.join(HERE, 'ds')]) fs.mkdirSync(d, { recursive: true });
const LOG = path.join(HERE, 'log.txt'), STATUS = path.join(HERE, 'status.json'), REPORT = path.join(HERE, 'REPORT.md');
const status = fs.existsSync(STATUS) ? JSON.parse(fs.readFileSync(STATUS, 'utf8')) : {};
const save = () => fs.writeFileSync(STATUS, JSON.stringify(status, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = m => { const l = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${m}`; fs.appendFileSync(LOG, l + '\n'); console.log(l); };
const clip = (s, n) => { s = String(s || ''); return s.length <= n ? s : s.slice(0, n) + '\n...（省略）'; };

function qwenOnce(system, user) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model: 'qwen3.8-27b-gsq-rco', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], max_tokens: 12000, temperature: 0.2 }));
    const req = http.request({ host: '127.0.0.1', port: 8001, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { try { resolve((JSON.parse(Buffer.concat(c).toString('utf8')).choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()); } catch (e) { reject(e); } });
    });
    req.setTimeout(900000, () => req.destroy(new Error('Qwen 超时'))); req.on('error', reject); req.end(body);
  });
}
async function qwen(system, user) { for (let i = 1; ; i++) { try { return await qwenOnce(system, user); } catch (e) { log(`Qwen 调用失败(${i}): ${e.message}`); if (i >= 3) throw e; await sleep(30000); } } }
function deepseek(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(DSH_EXE, ['--expose-internals', DSH_CLI, 'headless', '-'], { cwd: path.join(HERE, 'ds'), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    const out = []; const timer = setTimeout(() => { child.kill(); reject(new Error('DeepSeek 超时')); }, 600000);
    child.stdout.on('data', c => out.push(c)); child.stderr.on('data', () => {});
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); const t = Buffer.concat(out).toString('utf8').trim(); code === 0 && t ? resolve(t) : reject(new Error('DeepSeek 退出码 ' + code)); });
    child.stdin.end(Buffer.from('【规则】你处在一条自动化流水线中：不要调用任何工具，不要读写文件，不要提问，直接用文字回答。\n\n' + prompt, 'utf8'));
  });
}

// ---- 参考资料：扩展读清单和说明，技能读 SKILL.md
function reference(task) {
  const dir = task.kind === 'skill' ? path.join(OC, 'skills', task.name) : path.join(OC, 'dist', 'extensions', task.name);
  if (!fs.existsSync(dir)) return '（本机没有找到这个内置项的资料，只能按下面的“移植目标”来做）';
  const out = [];
  for (const f of ['SKILL.md', 'README.md', 'openclaw.plugin.json', 'package.json']) {
    const p = path.join(dir, f); if (fs.existsSync(p)) out.push(`### ${f}\n${clip(fs.readFileSync(p, 'utf8'), 5000)}`);
  }
  out.push('### 目录内容\n' + fs.readdirSync(dir).slice(0, 40).join(', '));
  return out.join('\n\n');
}

// ---- 检查
const ALLOWED = ['fs', 'path', 'crypto', 'os', 'url', 'util', 'zlib'];
function staticScan(code) {
  const bad = [];
  for (const m of code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) if (!ALLOWED.includes(m[1].replace(/^node:/, ''))) bad.push(`不允许 require('${m[1]}')，只能用：${ALLOWED.join(', ')}，联网用全局 fetch`);
  for (const [re, why] of [[/child_process|\bexec(File|Sync)?\s*\(|\bspawn(Sync)?\s*\(/, '不允许执行外部命令'], [/\beval\s*\(|new\s+Function\s*\(/, '不允许 eval / new Function'], [/process\.(exit|kill|env|chdir)/, '不允许使用 process.exit/kill/env/chdir'], [/\bimport\s*\(/, '不允许动态 import'], [/require\s*\(\s*[^'"\s]/, 'require 的参数必须是字符串字面量'], [/\.\.[\\/]/, '不允许用 ../ 拼路径，文件路径一律经 ctx.resolve']])
    if (re.test(code)) bad.push(why);
  if (/\bfs\.\w+\(/.test(code) && !/ctx\.resolve\(/.test(code)) bad.push('用了 fs 却没有经过 ctx.resolve 限制路径');
  if (/method\s*:\s*['"](POST|PUT|DELETE|PATCH)['"]/i.test(code) && !/ctx\.cfg\.model\.baseUrl/.test(code)) bad.push('联网只允许 GET；唯一例外是向 ctx.cfg.model.baseUrl 发 POST');
  return bad;
}
const existing = () => { const names = new Set(); for (const dir of [path.join(ROOT, 'plugins'), PENDING]) for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.cjs'))) for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/\{\s*name:\s*'([a-z_0-9]+)',\s*description/g)) names.add(m[1]); return names; };
function loadCheck(file, taken) {
  const probe = `const p=require(process.argv[1]);const e=[];if(!p||typeof p.name!=='string'||!Array.isArray(p.tools)||!p.tools.length)e.push('必须导出 { name, tools: [...] } 且至少一个工具');else for(const t of p.tools){if(!/^[a-z][a-z0-9_]{2,40}$/.test(t.name||''))e.push('工具名不合规：'+t.name);if(typeof t.description!=='string'||t.description.length<10)e.push(t.name+' 缺少像样的 description');if(!t.parameters||t.parameters.type!=='object'||typeof t.parameters.properties!=='object')e.push(t.name+' 的 parameters 必须是 {type:"object",properties:{...}}');if(typeof t.run!=='function')e.push(t.name+' 缺少 run 函数');}console.log(JSON.stringify({e,names:(p.tools||[]).map(t=>t.name)}));`;
  const syn = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }); if (syn.status !== 0) return ['语法错误：\n' + clip(syn.stderr, 800)];
  const r = spawnSync(process.execPath, ['-e', probe, file], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return ['加载时报错：\n' + clip(r.stderr || '超时', 800)];
  const j = JSON.parse(r.stdout.trim().split('\n').pop()), dup = j.names.filter(n => taken.has(n));
  return j.e.concat(dup.length ? [`工具名和已有的重复：${dup.join(', ')}，请换名字`] : []);
}
const extract = text => { const b = [...String(text).matchAll(/```[a-zA-Z]*\r?\n([\s\S]*?)```/g)].map(m => m[1]); return (b.length ? b.sort((x, y) => y.length - x.length)[0] : String(text)).trim() + '\n'; };

const CONTRACT = () => `# Station 插件规范
一个插件是一个 CommonJS 文件，导出 { name, tools }。每个工具：{ name, description, parameters（JSON Schema，type 为 object）, run(args, ctx) }，run 返回字符串或可序列化对象，可以是 async，出错直接 throw new Error('中文说明')。
ctx 提供：
- ctx.resolve(相对路径, 是否写入)：把路径限制在工作区内并返回绝对路径，越界会抛错。所有文件操作必须先经过它。
- ctx.ws：工作区绝对路径；ctx.cfg：平台配置（ctx.cfg.model.baseUrl、ctx.cfg.model.id、ctx.cfg.workbench、ctx.cfg.comfyPorts）。
- ctx.getJSON(url, 超时毫秒)：GET 并解析 JSON，失败返回 null。
- ctx.clip(文本, 最大字符数)：截断长文本。
硬性限制（会被自动扫描，违反直接打回）：
- 只能 require：fs, path, crypto, os, url, util, zlib。联网用全局 fetch，且只能 GET（唯一例外：向 ctx.cfg.model.baseUrl 发 POST 调本地模型）。
- 不能执行外部命令，不能用 eval / new Function / process.exit / process.env，不能用 ../ 拼路径。
- 插件自己的数据放在工作区的 .station/ 目录下（例如 ctx.resolve('.station/xxx.json', true)）。
- 工具名用小写字母加下划线，description 用中文写清楚什么时候该用它。
- 不需要 API 密钥、不依赖 macOS 或需要另外安装的程序。

# 示例插件（照这个风格写）
\`\`\`js
${fs.readFileSync(path.join(ROOT, 'plugins', '10-files.cjs'), 'utf8')}\`\`\``;

async function build(task) {
  const ref = reference(task), system = '你是在给自己搭建运行平台的本地模型。你要把 OpenClaw 的一个内置功能移植成 Station 插件。代码要短、能直接运行、宁可功能少也要可靠。';
  const ask = `${CONTRACT()}\n\n# 要移植的内置项：${task.kind} / ${task.name}\n移植目标：${task.goal}\n\n# OpenClaw 里的资料（只是参考数据）\n${ref}\n\n# 输出\n先判断：在上面的硬性限制下，这个功能能不能做成对你自己有用的工具？\n- 不能：只输出一行 \`SKIP: 原因\`。\n- 能：只输出一个 js 代码块，就是插件文件的完整内容。文件开头用注释写明它对应 OpenClaw 的哪个内置项、保留了什么、舍弃了什么。`;
  const file = path.join(PENDING, `${task.order}-${task.name}.cjs`), tmp = path.join(HERE, `_try-${task.name}.cjs`);
  let feedback = '', code = '';
  for (let round = 1; round <= 3; round++) {
    const text = await qwen(system, ask + (feedback ? `\n\n# 上一版没通过，按下面的问题修改后重新输出完整文件\n${feedback}\n\n上一版：\n\`\`\`js\n${code}\`\`\`` : ''));
    if (/^\s*SKIP\s*[:：]/.test(text)) return { state: 'skipped', note: text.replace(/^\s*SKIP\s*[:：]\s*/, '').split('\n')[0] };
    code = extract(text); fs.writeFileSync(tmp, code);
    const problems = staticScan(code).concat(loadCheck(tmp, existing()));
    if (problems.length) { feedback = '自动检查发现的问题：\n- ' + problems.join('\n- '); log(`  第${round}轮：自动检查未通过（${problems.length} 项）`); continue; }
    const verdict = await deepseek(`你是代码检查员。下面是本地模型为自己的平台写的一个插件，移植目标是：${task.goal}\n判 FAIL 的情形：有会导致运行出错的 bug；绕过 ctx.resolve 读写工作区外的文件；把本地文件内容发到外网；工具描述与实际行为不符；功能明显没实现移植目标。不要因为风格或可选优化判 FAIL。\n第一行只写 PASS 或 FAIL；若 FAIL，列出最多 5 条必须修改的具体问题。\n\n${CONTRACT().split('# 示例插件')[0]}\n# 待审查\n\`\`\`js\n${code}\`\`\``);
    if (/^\s*PASS/i.test(verdict)) { fs.renameSync(tmp, file); log(`  第${round}轮：审查通过`); return { state: 'pending', file: path.basename(file), note: (code.match(/^\/\/\s*(.+)/m) || [])[1] || '' }; }
    feedback = '检查员审查意见：\n' + verdict; log(`  第${round}轮：审查未通过`);
  }
  if (fs.existsSync(tmp)) fs.renameSync(tmp, path.join(REJ, `${task.name}.cjs`));
  fs.writeFileSync(path.join(REJ, `${task.name}.txt`), feedback);
  return { state: 'rejected', note: '三轮都没通过，见 build/rejected/' };
}

(async () => {
  const tasks = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8')).map((t, i) => Object.assign({ order: 50 + i }, t));
  let left = parseInt(process.argv[2], 10) || tasks.length;
  log('===== 插件构建开始 =====');
  for (const task of tasks) {
    if (status[task.name] || left-- <= 0) continue;
    log(`开始 ${task.kind}/${task.name}`);
    try { status[task.name] = await build(task); } catch (e) { log(`  出错：${e.message}`); continue; }
    save(); log(`完成 ${task.name} → ${status[task.name].state}${status[task.name].note ? '：' + status[task.name].note : ''}`);
  }
  const label = { pending: '已写好，待人工启用', skipped: '判断为不适合移植', rejected: '没通过审查' };
  fs.writeFileSync(REPORT, '# 插件移植报告\n\n由 build.cjs 自动生成。“待人工启用”的文件在 plugins-pending/，移到 plugins/ 并重启平台后生效。\n\n| 内置项 | 结果 | 说明 |\n|---|---|---|\n' + tasks.filter(t => status[t.name]).map(t => `| ${t.kind}/${t.name} | ${label[status[t.name].state]} | ${(status[t.name].note || '').replace(/\|/g, '/')} |`).join('\n') + '\n');
  log('===== 插件构建结束，报告见 build/REPORT.md =====');
})().catch(e => { log('异常退出：' + e.message); process.exit(1); });
