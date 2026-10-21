'use strict';
// 对应 OpenClaw 内置项: extension / document-extract
// 保留了：从工作区内的文档提取纯文本（txt, md, json, csv, html）
// 舍弃了：PDF 支持（依赖 clawpdf，违反硬性限制）、图片提取、其他复杂格式

const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });

function extractText(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    
    // 先检查是否为文件，避免目录读取报错
    let stat;
    try {
        stat = fs.statSync(absPath);
    } catch (e) {
        throw new Error(`无法访问路径: ${absPath}`);
    }
    
    if (!stat.isFile()) {
        throw new Error(`不是文件（可能是目录）: ${absPath}`);
    }

    const content = fs.readFileSync(absPath, 'utf8');
    
    switch (ext) {
        case '.txt':
        case '.md':
            return content;
            
        case '.json':
            try {
                const parsed = JSON.parse(content);
                return JSON.stringify(parsed, null, 2);
            } catch (e) {
                throw new Error('JSON 解析失败: ' + e.message);
            }
            
        case '.csv':
            // 简单 CSV：按行返回，保持原始格式
            return content;
            
        case '.html':
            // 简单 HTML 文本提取：去除标签
            const text = content
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            return text;
            
        default:
            const extDisplay = ext || '(无扩展名)';
            throw new Error(`不支持的文件格式: ${extDisplay}。支持: .txt, .md, .json, .csv, .html`);
    }
}

module.exports = {
    name: 'document_extract',
    tools: [
        {
            name: 'extract_text',
            description: '从工作区内的文档提取纯文本。支持 txt、md、json、csv、html 格式。不支持的格式会明确报错。',
            parameters: {
                type: 'object',
                properties: {
                    path: str('相对工作区的文件路径')
                },
                required: ['path']
            },
            run(a, ctx) {
                const absPath = ctx.resolve(a.path);
                
                // 检查是否存在
                if (!fs.existsSync(absPath)) {
                    throw new Error(`文件不存在: ${a.path}`);
                }
                
                const text = extractText(absPath);
                // 截断过长文本
                return ctx.clip(text, 100000);
            }
        }
    ]
};
