'use strict';
// 对应 OpenClaw 内置项: extension / logbook
// 保留: 带时间戳的工作日志追加、按日期查看、关键词搜索
// 舍弃: 自动截屏、视觉模型分析、节点配对、快照保留策略（依赖外部能力，Station 限制下不可行）
const fs = require('fs'), path = require('path');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadEntries(ctx) {
  const file = ctx.resolve('.station/logbook/entries.json', false);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    throw new Error('日志文件损坏，请检查 .station/logbook/entries.json');
  }
}

function saveEntries(ctx, entries) {
  const file = ctx.resolve('.station/logbook/entries.json', true);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
}

const str = d => ({ type: 'string', description: d });

module.exports = {
  name: 'logbook',
  tools: [
    {
      name: 'add_entry',
      description: '追加一条带时间戳的工作日志。记录做了什么、结果如何。',
      parameters: {
        type: 'object',
        properties: {
          what: str('做了什么，简短描述'),
          result: str('结果如何，可选'),
          tags: str('逗号分隔的标签，可选')
        },
        required: ['what']
      },
      run(a, ctx) {
        const entries = loadEntries(ctx);
        const entry = {
          id: Date.now().toString(36),
          timestamp: new Date().toISOString(),
          what: String(a.what).trim(),
          result: a.result ? String(a.result).trim() : '',
          tags: a.tags ? String(a.tags).split(',').map(t => t.trim()).filter(Boolean) : []
        };
        entries.push(entry);
        saveEntries(ctx, entries);
        return `已记录：${entry.what}${entry.result ? ' → ' + entry.result : ''}`;
      }
    },
    {
      name: 'view_by_date',
      description: '按日期查看日志。date 格式 YYYY-MM-DD，不传则显示今天。',
      parameters: {
        type: 'object',
        properties: {
          date: str('日期，YYYY-MM-DD，默认今天')
        },
        required: []
      },
      run(a, ctx) {
        const entries = loadEntries(ctx);
        const targetDate = a.date || new Date().toISOString().slice(0, 10);
        const filtered = entries.filter(e => e.timestamp.slice(0, 10) === targetDate);
        if (filtered.length === 0) return `${targetDate} 没有日志记录`;
        return filtered.map(e => {
          const time = e.timestamp.slice(11, 16);
          let line = `[${time}] ${e.what}`;
          if (e.result) line += ` → ${e.result}`;
          if (e.tags.length) line += ` (#${e.tags.join(' #')})`;
          return line;
        }).join('\n');
      }
    },
    {
      name: 'find_entries',
      description: '按关键词搜索日志，返回匹配的条目。',
      parameters: {
        type: 'object',
        properties: {
          keyword: str('要搜索的关键词'),
          limit: { type: 'integer', description: '最多返回多少条，默认 20' }
        },
        required: ['keyword']
      },
      run(a, ctx) {
        const entries = loadEntries(ctx);
        const kw = String(a.keyword).toLowerCase();
        const limit = Math.max(1, a.limit || 20);
        const matches = entries.filter(e => {
          const text = (e.what + ' ' + e.result + ' ' + e.tags.join(' ')).toLowerCase();
          return text.includes(kw);
        }).slice(-limit); // 取最近的
        if (matches.length === 0) return `没有找到包含 "${a.keyword}" 的日志`;
        return matches.map(e => {
          const dt = e.timestamp.slice(0, 16).replace('T', ' ');
          let line = `[${dt}] ${e.what}`;
          if (e.result) line += ` → ${e.result}`;
          if (e.tags.length) line += ` (#${e.tags.join(' #')})`;
          return line;
        }).join('\n');
      }
    },
    {
      name: 'recent',
      description: '查看最近 N 条日志，默认 10 条。',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: '显示多少条，默认 10' }
        },
        required: []
      },
      run(a, ctx) {
        const entries = loadEntries(ctx);
        const count = Math.max(1, a.count || 10);
        const recent = entries.slice(-count);
        if (recent.length === 0) return '还没有日志记录';
        return recent.map(e => {
          const dt = e.timestamp.slice(0, 16).replace('T', ' ');
          let line = `[${dt}] ${e.what}`;
          if (e.result) line += ` → ${e.result}`;
          if (e.tags.length) line += ` (#${e.tags.join(' #')})`;
          return line;
        }).join('\n');
      }
    }
  ]
};
