'use strict';
// 对应 OpenClaw 内置项：extension / llm-task
// 保留：将独立小任务（指令+输入文本）交给本地模型单独跑一次并返回结果，避免长文本塞进主对话。
// 舍弃：OpenClaw 的 provider/auth 配置、typebox schema 校验、doctor contract、workflow 集成等复杂机制。
// 简化为：直接调用 ctx.cfg.model.baseUrl 的 /chat/completions 接口，使用 ctx.cfg.model.id 作为模型名。

const str = d => ({ type: 'string', description: d });

module.exports = {
  name: 'llm_task',
  tools: [
    {
      name: 'run_task',
      description: '把一个自成一体的小任务（给定指令和输入文本）交给本地模型单独跑一次并返回结果。用于摘要、提取、改写等，避免把长文本塞进主对话。',
      parameters: {
        type: 'object',
        properties: {
          instruction: str('给模型的指令，例如"请总结以下文章的核心观点"'),
          input_text: str('需要处理的输入文本'),
          max_tokens: { type: 'integer', description: '最大生成 token 数，默认 1024' },
          temperature: { type: 'number', description: '采样温度，默认 0.7' }
        },
        required: ['instruction', 'input_text']
      },
      async run(a, ctx) {
        const baseUrl = ctx.cfg.model.baseUrl;
        if (!baseUrl) throw new Error('未配置模型 baseUrl');
        
        const maxTokens = a.max_tokens || 1024;
        const temperature = a.temperature !== undefined ? a.temperature : 0.7;
        
        const body = {
          model: ctx.cfg.model.id,
          messages: [
            { role: 'system', content: '你是一个高效的文本处理助手。请严格按照用户指令完成任务，只输出结果本身，不要添加额外解释或前缀。' },
            { role: 'user', content: `${a.instruction}\n\n${a.input_text}` }
          ],
          max_tokens: maxTokens,
          temperature: temperature
        };

        const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
        
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          
          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            throw new Error(`模型调用失败 (HTTP ${res.status}): ${errText.slice(0, 200)}`);
          }
          
          const data = await res.json();
          const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          
          if (!content) throw new Error('模型返回内容为空');
          
          return ctx.clip(content, 8000);
        } catch (e) {
          if (e.message.startsWith('模型调用失败')) throw e;
          throw new Error(`网络请求失败: ${e.message}`);
        }
      }
    }
  ]
};
