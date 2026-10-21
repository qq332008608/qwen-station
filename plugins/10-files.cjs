'use strict';
// 工作区文件读写。路径一律经 ctx.resolve 限制在工作区内。
const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });
module.exports = {
  name: 'files',
  tools: [
    { name: 'read', description: '读取工作区内的文本文件。大文件用 offset/limit 按行分段读。',
      parameters: { type: 'object', properties: { path: str('相对工作区的路径'), offset: { type: 'integer', description: '起始行，从 1 开始' }, limit: { type: 'integer', description: '读多少行' } }, required: ['path'] },
      run(a, ctx) {
        const lines = fs.readFileSync(ctx.resolve(a.path), 'utf8').split('\n'), from = Math.max(1, a.offset || 1);
        const part = lines.slice(from - 1, a.limit ? from - 1 + a.limit : undefined);
        return part.join('\n') + (from > 1 || part.length < lines.length ? `\n\n（第 ${from}–${from + part.length - 1} 行，共 ${lines.length} 行）` : '');
      } },
    { name: 'write', description: '把完整内容写入工作区内的文件（覆盖已有文件，自动建目录）。',
      parameters: { type: 'object', properties: { path: str('相对工作区的路径'), content: str('文件的完整内容') }, required: ['path', 'content'] },
      run(a, ctx) { const f = ctx.resolve(a.path, true); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(a.content)); return `已写入 ${a.path}（${Buffer.byteLength(String(a.content))} 字节）`; } },
    { name: 'edit', description: '把文件里的一段原文替换成新内容。old 必须在文件中恰好出现一次。',
      parameters: { type: 'object', properties: { path: str('相对工作区的路径'), old: str('要被替换的原文，需精确匹配'), new: str('替换成的内容') }, required: ['path', 'old', 'new'] },
      run(a, ctx) {
        const f = ctx.resolve(a.path, true), text = fs.readFileSync(f, 'utf8'), n = text.split(a.old).length - 1;
        if (n !== 1) throw new Error(n ? `old 在文件里出现了 ${n} 次，请多带些上下文让它唯一` : '文件里找不到 old，请先 read 确认原文');
        fs.writeFileSync(f, text.replace(a.old, () => a.new)); return `已修改 ${a.path}`;
      } },
    { name: 'list', description: '列出工作区内某个目录的内容。',
      parameters: { type: 'object', properties: { path: str('相对工作区的目录，根目录用 "."') }, required: ['path'] },
      run(a, ctx) {
        const items = fs.readdirSync(ctx.resolve(a.path), { withFileTypes: true }).filter(e => e.name !== '.git');
        return items.slice(0, 300).map(e => e.isDirectory() ? e.name + '/' : e.name).join('\n') + (items.length > 300 ? `\n（共 ${items.length} 项，只显示前 300）` : '');
      } },
  ],
};
