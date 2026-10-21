'use strict';
// 对应 OpenClaw 内置项：workboard
// 保留：任务看板核心功能（新增、改状态、列出）
// 舍弃：多板管理、附件、通知、worker dispatch、SQLite 存储等复杂特性

const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });

function loadTasks(ctx) {
  const f = ctx.resolve('.station/workboard.json', true);
  if (!fs.existsSync(f)) return [];
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    throw new Error('任务数据文件损坏，请检查 .station/workboard.json');
  }
}

function saveTasks(ctx, tasks) {
  const f = ctx.resolve('.station/workboard.json', true);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(tasks, null, 2));
}

module.exports = {
  name: 'workboard',
  tools: [
    {
      name: 'add_task',
      description: '新增一个任务到看板。状态默认为"待办"。',
      parameters: {
        type: 'object',
        properties: {
          title: str('任务标题'),
          status: { type: 'string', description: '初始状态：待办/进行中/完成，默认待办' }
        },
        required: ['title']
      },
      run(a, ctx) {
        const tasks = loadTasks(ctx);
        const validStatuses = ['待办', '进行中', '完成'];
        const status = a.status && validStatuses.includes(a.status) ? a.status : '待办';
        const task = { id: Date.now().toString(36), title: String(a.title).trim(), status, created: new Date().toISOString() };
        if (!task.title) throw new Error('任务标题不能为空');
        tasks.push(task);
        saveTasks(ctx, tasks);
        return `已添加任务：${task.title}（状态：${status}）`;
      }
    },
    {
      name: 'update_status',
      description: '修改指定任务的状态。需要提供任务 ID 和新状态。',
      parameters: {
        type: 'object',
        properties: {
          id: str('任务 ID'),
          status: { type: 'string', description: '新状态：待办/进行中/完成' }
        },
        required: ['id', 'status']
      },
      run(a, ctx) {
        const tasks = loadTasks(ctx);
        const validStatuses = ['待办', '进行中', '完成'];
        if (!validStatuses.includes(a.status)) throw new Error('无效状态，必须是：待办/进行中/完成');
        const task = tasks.find(t => t.id === a.id);
        if (!task) throw new Error(`找不到 ID 为 ${a.id} 的任务`);
        task.status = a.status;
        saveTasks(ctx, tasks);
        return `任务「${task.title}」状态已更新为：${a.status}`;
      }
    },
    {
      name: 'list_tasks',
      description: '列出所有任务，可按状态过滤。不传 status 则显示全部。',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: '可选：按状态过滤（待办/进行中/完成）' }
        },
        required: []
      },
      run(a, ctx) {
        const tasks = loadTasks(ctx);
        let filtered = tasks;
        if (a.status) {
          const validStatuses = ['待办', '进行中', '完成'];
          if (!validStatuses.includes(a.status)) throw new Error('无效状态，必须是：待办/进行中/完成');
          filtered = tasks.filter(t => t.status === a.status);
        }
        if (filtered.length === 0) return '没有任务';
        const lines = filtered.map(t => `[${t.id}] ${t.title}（${t.status}）`);
        return lines.join('\n');
      }
    },
  ],
};
