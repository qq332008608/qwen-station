'use strict';
// 对应 OpenClaw memory-core：保留"追加当天记忆"和"列出最近几天记忆文件"两个核心功能。
// 舍弃：搜索、索引、SQLite 迁移、dreaming 后台任务、KNN 检索等复杂机制。
const fs = require('fs'), path = require('path');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

module.exports = {
  name: 'memory',
  tools: [
    {
      name: 'memory_append',
      description: '把一条值得长期记住的内容追加到当天的 memory/YYYY-MM-DD.md 文件末尾。只追加，不改写已有内容。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要追加的记忆内容' }
        },
        required: ['content']
      },
      run(a, ctx) {
        const date = todayStr();
        const relPath = `memory/${date}.md`;
        const absPath = ctx.resolve(relPath, true);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        const entry = `\n- ${a.content.trim()}\n`;
        fs.appendFileSync(absPath, entry, 'utf8');
        return `已追加到 ${relPath}`;
      }
    },
    {
      name: 'memory_list_recent',
      description: '列出最近 N 天（默认 7 天）的记忆文件及其大小。',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', description: '回溯天数，默认 7' }
        },
        required: []
      },
      run(a, ctx) {
        const n = Math.max(1, a.days || 7);
        const memDir = ctx.resolve('memory');
        if (!fs.existsSync(memDir)) return 'memory/ 目录不存在，还没有任何记忆。';
        const files = fs.readdirSync(memDir).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse();
        const recent = files.slice(0, n);
        if (!recent.length) return '最近没有记忆文件。';
        return recent.map(f => {
          const stat = fs.statSync(path.join(memDir, f));
          return `${f}  (${stat.size} bytes)`;
        }).join('\n');
      }
    },
  ],
};
