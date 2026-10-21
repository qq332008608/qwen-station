'use strict';
// GitHub 只读接入（REST API）。不设令牌也能用，但每小时限 60 次；设了环境变量 GITHUB_TOKEN 后限额更高，并能读私有仓库。
const str = d => ({ type: 'string', description: d });
async function gh(p) {
  const headers = { 'User-Agent': 'qwen-station', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const res = await fetch('https://api.github.com' + p, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}` + (res.status === 403 ? '（可能触发了限额；设置 GITHUB_TOKEN 可提高）' : ''));
  return res.json();
}
const repoPath = r => { if (!/^[\w.-]+\/[\w.-]+$/.test(r)) throw new Error('repo 要写成 owner/name'); return r; };
module.exports = {
  name: 'github',
  tools: [
    { name: 'github_search', description: '搜索 GitHub 仓库，返回名称、星数和简介。',
      parameters: { type: 'object', properties: { query: str('搜索词，可用 GitHub 搜索语法') }, required: ['query'] },
      async run(a) { const j = await gh('/search/repositories?per_page=8&q=' + encodeURIComponent(a.query)); return j.items.map(r => `${r.full_name}  ★${r.stargazers_count}  ${r.description || ''}`).join('\n') || '没有结果'; } },
    { name: 'github_list', description: '列出仓库里某个目录的文件。',
      parameters: { type: 'object', properties: { repo: str('owner/name'), path: str('目录路径，根目录留空') }, required: ['repo'] },
      async run(a) { const j = await gh(`/repos/${repoPath(a.repo)}/contents/${encodeURI(a.path || '')}`); return (Array.isArray(j) ? j : [j]).map(e => e.type === 'dir' ? e.path + '/' : `${e.path}  (${e.size})`).join('\n'); } },
    { name: 'github_read', description: '读取仓库里的一个文本文件（如 README.md）。',
      parameters: { type: 'object', properties: { repo: str('owner/name'), path: str('文件路径') }, required: ['repo', 'path'] },
      async run(a, ctx) { const j = await gh(`/repos/${repoPath(a.repo)}/contents/${encodeURI(a.path)}`); if (j.encoding !== 'base64') throw new Error('不是可读的文件'); return ctx.clip(Buffer.from(j.content, 'base64').toString('utf8'), 10000); } },
    { name: 'github_issues', description: '列出仓库最近的 issue 和 PR 标题。',
      parameters: { type: 'object', properties: { repo: str('owner/name'), state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['repo'] },
      async run(a) { const j = await gh(`/repos/${repoPath(a.repo)}/issues?per_page=15&state=${a.state || 'open'}`); return j.map(i => `#${i.number} [${i.pull_request ? 'PR' : 'issue'}] ${i.title}`).join('\n') || '没有'; } },
  ],
};
