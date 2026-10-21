'use strict';
// 对应 OpenClaw: skill / diagram-maker
// 保留：根据节点和连线描述生成 SVG 流程图文件，保存到工作区
// 舍弃：Excalidraw 支持、HTML 包装、复杂布局算法（仅支持简单的从左到右分层布局）、外部资源引用

const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });

module.exports = {
  name: 'diagram_maker',
  tools: [
    {
      name: 'create_svg_diagram',
      description: '根据节点和连线的描述生成一张 SVG 流程图文件，保存到工作区。适用于简单的从左到右或从上到下的流程展示。会强制覆盖同名文件。',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            description: '节点列表，每个元素包含 id (字符串) 和 label (字符串)',
            items: {
              type: 'object',
              properties: {
                id: str('节点唯一标识'),
                label: str('节点显示文本')
              },
              required: ['id', 'label']
            }
          },
          edges: {
            type: 'array',
            description: '连线列表，每个元素包含 from (源节点 id) 和 to (目标节点 id)',
            items: {
              type: 'object',
              properties: {
                from: str('源节点 id'),
                to: str('目标节点 id')
              },
              required: ['from', 'to']
            }
          },
          filename: str('输出文件名，默认 diagram.svg，必须在工作区内且以 .svg 结尾'),
          direction: {
            type: 'string',
            description: '布局方向：horizontal (从左到右) 或 vertical (从上到下)，默认 horizontal'
          }
        },
        required: ['nodes', 'edges']
      },
      run(a, ctx) {
        const nodes = a.nodes || [];
        const edges = a.edges || [];
        let filename = a.filename || 'diagram.svg';
        
        // 修正：direction 缺省值为 horizontal，仅当传入非法值时报错
        let direction = 'horizontal';
        if (a.direction !== undefined && a.direction !== null) {
          if (a.direction === 'vertical') {
            direction = 'vertical';
          } else if (a.direction === 'horizontal') {
            direction = 'horizontal';
          } else {
            throw new Error('direction 必须是 "horizontal" 或 "vertical"');
          }
        }

        // 验证 filename
        if (!filename || typeof filename !== 'string') throw new Error('filename 不能为空');
        if (path.isAbsolute(filename)) throw new Error('filename 不能是绝对路径');
        if (filename.includes('..')) throw new Error('filename 不能包含 ..');
        if (!filename.endsWith('.svg')) throw new Error('filename 必须以 .svg 结尾');

        if (!nodes.length) throw new Error('节点列表不能为空');

        // 验证节点 id 唯一性
        const nodeIds = new Set();
        for (const n of nodes) {
          if (!n.id || !n.label) throw new Error('每个节点必须有 id 和 label');
          if (nodeIds.has(n.id)) throw new Error(`节点 id "${n.id}" 重复`);
          nodeIds.add(n.id);
        }

        // 验证连线引用的节点存在
        for (const e of edges) {
          if (!nodeIds.has(e.from)) throw new Error(`连线源节点 "${e.from}" 不存在`);
          if (!nodeIds.has(e.to)) throw new Error(`连线目标节点 "${e.to}" 不存在`);
        }

        // 计算拓扑层级（Kahn's algorithm）
        const inDegree = {};
        const outEdges = {};
        nodes.forEach(n => { inDegree[n.id] = 0; outEdges[n.id] = []; });
        edges.forEach(e => {
          inDegree[e.to]++;
          outEdges[e.from].push(e.to);
        });

        // 找入度为 0 的节点作为起点
        const queue = nodes.filter(n => inDegree[n.id] === 0).map(n => n.id);
        const level = {};
        let currentLevel = 0;
        
        if (queue.length === 0) {
          // 有环，所有节点放在同一层
          nodes.forEach(n => level[n.id] = 0);
        } else {
          while (queue.length > 0) {
            const nextQueue = [];
            for (const id of queue) {
              if (level[id] === undefined) level[id] = currentLevel;
              for (const toId of outEdges[id]) {
                inDegree[toId]--;
                if (inDegree[toId] === 0 && level[toId] === undefined) {
                  nextQueue.push(toId);
                }
              }
            }
            queue.length = 0;
            queue.push(...nextQueue);
            currentLevel++;
          }
          // 处理未分配的节点（环中的）
          nodes.forEach(n => {
            if (level[n.id] === undefined) level[n.id] = currentLevel;
          });
        }

        // 按层级分组
        const levels = {};
        nodes.forEach(n => {
          const l = level[n.id];
          if (!levels[l]) levels[l] = [];
          levels[l].push(n);
        });

        const maxLevel = Math.max(...Object.keys(levels).map(Number));
        
        // 布局参数
        const nodeWidth = 120;
        const nodeHeight = 50;
        const gapX = direction === 'horizontal' ? 80 : 40;
        const gapY = direction === 'horizontal' ? 40 : 80;
        const padding = 40;

        // 计算每个节点的位置
        const positions = {};
        const levelKeys = Object.keys(levels).map(Number).sort((a, b) => a - b);
        
        for (const l of levelKeys) {
          const nodesInLevel = levels[l];
          const count = nodesInLevel.length;
          
          if (direction === 'horizontal') {
            // 从左到右：x 由层级决定，y 在层内均匀分布
            const x = padding + l * (nodeWidth + gapX);
            const totalHeight = (count - 1) * (nodeHeight + gapY);
            nodesInLevel.forEach((n, i) => {
              const y = padding + i * (nodeHeight + gapY);
              positions[n.id] = { x, y };
            });
          } else {
            // 从上到下：y 由层级决定，x 在层内均匀分布
            const y = padding + l * (nodeHeight + gapY);
            const totalWidth = (count - 1) * (nodeWidth + gapX);
            nodesInLevel.forEach((n, i) => {
              const x = padding + i * (nodeWidth + gapX);
              positions[n.id] = { x, y };
            });
          }
        }

        // 计算 SVG 尺寸
        let maxX = 0, maxY = 0;
        for (const id of Object.keys(positions)) {
          const p = positions[id];
          maxX = Math.max(maxX, p.x + nodeWidth);
          maxY = Math.max(maxY, p.y + nodeHeight);
        }
        const svgWidth = maxX + padding;
        const svgHeight = maxY + padding;

        // 生成 SVG
        let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">\n`;
        svg += `  <defs>\n`;
        svg += `    <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">\n`;
        svg += `      <polygon points="0 0, 10 3.5, 0 7" fill="#666"/>\n`;
        svg += `    </marker>\n`;
        svg += `  </defs>\n`;

        // 先画连线（在节点后面）
        for (const e of edges) {
          const from = positions[e.from];
          const to = positions[e.to];
          
          let x1, y1, x2, y2;
          if (direction === 'horizontal') {
            // 从源节点右侧中点到目标节点左侧中点
            x1 = from.x + nodeWidth;
            y1 = from.y + nodeHeight / 2;
            x2 = to.x;
            y2 = to.y + nodeHeight / 2;
          } else {
            // 从源节点底部中点到目标节点顶部中点
            x1 = from.x + nodeWidth / 2;
            y1 = from.y + nodeHeight;
            x2 = to.x + nodeWidth / 2;
            y2 = to.y;
          }

          // 简单直线连接
          svg += `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#666" stroke-width="2" fill="none" marker-end="url(#arrowhead)"/>\n`;
        }

        // 再画节点
        for (const n of nodes) {
          const p = positions[n.id];
          svg += `  <rect x="${p.x}" y="${p.y}" width="${nodeWidth}" height="${nodeHeight}" rx="8" ry="8" fill="#e3f2fd" stroke="#1976d2" stroke-width="2"/>\n`;
          
          // 文本居中，考虑 padding
          const textX = p.x + nodeWidth / 2;
          const textY = p.y + nodeHeight / 2;
          svg += `  <text x="${textX}" y="${textY}" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="14" fill="#333">${escapeXml(n.label)}</text>\n`;
        }

        svg += `</svg>`;

        // 写入文件
        const filePath = ctx.resolve(filename, true);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, svg, 'utf8');

        return `已生成 SVG 流程图：${filename}\n节点数：${nodes.length}，连线数：${edges.length}\n布局方向：${direction}`;
      }
    }
  ]
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
