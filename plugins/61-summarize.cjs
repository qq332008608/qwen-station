'use strict';
// 对应 OpenClaw 内置项：skill / summarize
// 保留：对工作区内的长文本文件进行分段摘要并合并，调用本地模型生成不超过指定字数的总摘要。
// 舍弃：URL/YouTube/PDF 支持、外部 CLI 依赖、API 密钥配置（仅使用 ctx.cfg.model.baseUrl）。

const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });

module.exports = {
  name: 'summarize',
  tools: [
    {
      name: 'summarize_file',
      description: '对工作区内的长文本文件分段摘要再合并，得到不超过指定字数的总摘要（调用本地模型）。',
      parameters: {
        type: 'object',
        properties: {
          path: str('相对工作区的文本文件路径'),
          max_chars: { type: 'integer', description: '最终摘要的最大字符数，默认 500' },
          chunk_size: { type: 'integer', description: '每段最大字符数，默认 2000' }
        },
        required: ['path']
      },
      async run(a, ctx) {
        const filePath = ctx.resolve(a.path);
        if (!fs.existsSync(filePath)) throw new Error('文件不存在');
        
        const content = fs.readFileSync(filePath, 'utf8');
        const maxChars = a.max_chars || 500;
        const chunkSize = a.chunk_size || 2000;
        
        // 分段
        const chunks = [];
        for (let i = 0; i < content.length; i += chunkSize) {
          chunks.push(content.slice(i, i + chunkSize));
        }
        
        if (chunks.length === 0) return '';
        
        // 对每段调用本地模型摘要
        const baseUrl = ctx.cfg.model.baseUrl;
        const modelId = ctx.cfg.model.id;
        const summaries = [];
        
        for (const chunk of chunks) {
          const body = JSON.stringify({
            model: modelId,
            messages: [
              { role: 'system', content: '你是一个摘要助手。请对以下文本进行简洁摘要，保留关键信息。' },
              { role: 'user', content: chunk }
            ],
            max_tokens: 500
          });
          
          const resp = await fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
          });
          
          if (!resp.ok) throw new Error('模型调用失败: ' + resp.status);
          const data = await resp.json();
          const summary = data.choices?.[0]?.message?.content || '';
          summaries.push(summary.trim());
        }
        
        // 合并摘要：如果只有一段，直接返回；否则再调一次模型合并
        let finalSummary;
        if (summaries.length === 1) {
          finalSummary = summaries[0];
        } else {
          const mergedInput = summaries.join('\n\n---\n\n');
          const body = JSON.stringify({
            model: modelId,
            messages: [
              { role: 'system', content: `请将以下多段摘要合并为一个连贯的总摘要，不超过 ${maxChars} 字符。` },
              { role: 'user', content: mergedInput }
            ],
            max_tokens: Math.ceil(maxChars / 2)
          });
          
          const resp = await fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
          });
          
          if (!resp.ok) throw new Error('模型调用失败: ' + resp.status);
          const data = await resp.json();
          finalSummary = (data.choices?.[0]?.message?.content || '').trim();
        }
        
        // 截断到 max_chars
        return ctx.clip(finalSummary, maxChars);
      }
    }
  ]
};
