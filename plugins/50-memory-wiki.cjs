'use strict';
// 对应 OpenClaw 内置项：memory-wiki (wiki_search)
// 保留：在工作区 knowledge/ 和 memory/ 目录下按关键词进行全文检索，返回命中文件路径及行号。
// 舍弃：Wiki 编译、Obsidian 集成、Bridge 模式、状态迁移、复杂配置等所有非核心搜索功能。

const fs = require('fs');
const path = require('path');

module.exports = {
  name: 'memory_wiki',
  tools: [
    {
      name: 'knowledge_search',
      description: '在工作区的 knowledge/ 和 memory/ 目录中按关键词全文检索，返回命中的文件路径和所在行。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜索的关键词' }
        },
        required: ['query']
      },
      run(a, ctx) {
        const dirs = ['knowledge', 'memory'];
        const results = [];
        const q = String(a.query).toLowerCase();

        for (const dir of dirs) {
          let absDir;
          try {
            absDir = ctx.resolve(dir);
          } catch (e) {
            continue; // 目录不存在则跳过
          }
          
          if (!fs.existsSync(absDir)) continue;
          if (!fs.statSync(absDir).isDirectory()) continue;

          const walk = (currentPath) => {
            let entries;
            try {
              entries = fs.readdirSync(currentPath, { withFileTypes: true });
            } catch (e) {
              return;
            }
            
            for (const entry of entries) {
              const fullPath = path.join(currentPath, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile() && entry.name.endsWith('.md')) {
                try {
                  const content = fs.readFileSync(fullPath, 'utf8');
                  const lines = content.split('\n');
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(q)) {
                      results.push({
                        file: path.relative(ctx.ws, fullPath),
                        line: i + 1,
                        snippet: ctx.clip(lines[i].trim(), 200)
                      });
                    }
                  }
                } catch (e) {
                  // 忽略读取错误
                }
              }
            }
          };

          walk(absDir);
        }

        if (results.length === 0) {
          return '未找到匹配内容';
        }

        return results.map(r => `${r.file}:${r.line} - ${r.snippet}`).join('\n');
      }
    }
  ]
};
