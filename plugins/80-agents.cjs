'use strict';
// 和其他智能体协作（向外）：把一个子任务交给本机安装的 DeepSeek Harness，取回它的回答。
// DeepSeek 是外部云服务，发过去的文字会离开本机，所以每次都要用户在界面上看过内容并点允许（AGENTS.md：未经用户明确同意，不把本地内容发给外部服务）。
// 其他智能体找本平台干活（向内）走 /api/agent/task 或 mcp-server.cjs，不在这里。
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const EXE = 'D:\\DeepSeek\\DeepSeek Harness.exe', CLI = 'D:\\DeepSeek\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';
const compose = a => String(a.task || '').trim() + (a.context ? '\n\n# 附带的资料\n' + String(a.context) : '');
module.exports = {
  name: 'agents',
  tools: [
    { name: 'ask_deepseek', description: '把一个自成一体的子任务交给 DeepSeek（外部云端模型）并取回回答。适合：需要更强推理的难题、复核你自己的结论、长文润色。发送的内容会离开本机，所以平台会先把全文给用户确认。不要把用户的隐私、密钥或未经同意的本地文件内容放进去。',
      parameters: { type: 'object', properties: { task: { type: 'string', description: '交给 DeepSeek 的完整任务说明，要让它不看上下文也能明白' }, context: { type: 'string', description: '需要一起发过去的资料原文（可选，越少越好）' } }, required: ['task'] },
      confirm(a) {
        if (!fs.existsSync(EXE)) throw new Error('本机没有找到 DeepSeek Harness（D:\\DeepSeek），无法委托。');
        const text = compose(a); if (!text) throw new Error('task 不能为空'); if (text.length > 60000) throw new Error('内容超过 6 万字，先精简');
        return `把下面这段内容发送给 DeepSeek（外部云服务，内容会离开本机），共 ${text.length} 字：\n\n${text.length > 3000 ? text.slice(0, 2000) + `\n\n……（中间省略 ${text.length - 3000} 字）……\n\n` + text.slice(-1000) : text}`;
      },
      run(a, ctx) {
        const text = compose(a), cwd = path.join(ctx.root, 'sessions', '_deepseek'); fs.mkdirSync(cwd, { recursive: true });
        return new Promise((resolve, reject) => {
          const child = spawn(EXE, ['--expose-internals', CLI, 'headless', '-'], { cwd, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), windowsHide: true });
          const out = [], timer = setTimeout(() => { child.kill(); reject(new Error('DeepSeek 10 分钟没有回答')); }, 600000);
          child.stdout.on('data', c => out.push(c)); child.stderr.on('data', () => {});
          child.on('error', e => { clearTimeout(timer); reject(new Error('启动 DeepSeek Harness 失败：' + e.message)); });
          child.on('exit', code => { clearTimeout(timer); const t = Buffer.concat(out).toString('utf8').trim(); code === 0 && t ? resolve('DeepSeek 的回答（它是另一个模型，回答可能有错，采用前要自己核对）：\n\n' + ctx.clip(t, 11000)) : reject(new Error('DeepSeek 没有返回内容（退出码 ' + code + '）')); });
          child.stdin.end(Buffer.from('【规则】你正在协助另一个智能体：不要调用任何工具，不要读写文件，不要反问，直接用文字回答。\n\n' + text, 'utf8'));
        });
      } },
  ],
};
