'use strict';
// 对应 OpenClaw 内置项: extension / policy
// 保留功能：查看当前生效的策略文件列表、大小、最后修改时间（只读）
// 舍弃功能：policy doctor checks, workspace repairs, hash locking, CLI commands
const fs = require('fs'), path = require('path');

module.exports = {
  name: 'policy',
  tools: [
    {
      name: 'list_policy_files',
      description: '列出工作区内当前生效的策略文件（如 AGENTS.md, policy.jsonc 等）的名称、大小和最后修改时间。用于自查规则是否被改动。',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      },
      run(a, ctx) {
        const ws = ctx.ws;
        // 常见的策略文件名列表
        const policyFiles = [
          'AGENTS.md',
          'policy.jsonc',
          'policy.json',
          'CLAUDE.md',
          '.station/policy.json',
          '.station/AGENTS.md'
        ];

        const results = [];
        
        for (const relPath of policyFiles) {
          try {
            // 使用 ctx.resolve 确保路径在工作区内
            const absPath = ctx.resolve(relPath);
            if (fs.existsSync(absPath)) {
              const stat = fs.statSync(absPath);
              results.push({
                path: relPath,
                size: stat.size,
                mtime: stat.mtime.toISOString()
              });
            }
          } catch (e) {
            // 忽略不存在或无法访问的文件
          }
        }

        if (results.length === 0) {
          return '未找到任何策略文件。';
        }

        const lines = results.map(r => 
          `${r.path} (${r.size} bytes, modified: ${r.mtime})`
        );
        
        return `发现 ${results.length} 个策略文件:\n${lines.join('\n')}`;
      }
    }
  ]
};
