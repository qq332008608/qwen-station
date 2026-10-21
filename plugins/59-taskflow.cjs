'use strict';
// 对应 OpenClaw 内置项：skill / taskflow
// 保留：多步骤任务拆分为有序步骤、每步状态记录（pending/done/failed）、中断后从未完成步骤继续、数据持久化在 .station/taskflow/
// 舍弃：审批暂停与恢复、子代理协调、SQLite 存储、revision 冲突处理、Lobster 集成、Workboard claims

const fs = require('fs'), path = require('path');
const str = d => ({ type: 'string', description: d });

function flowDir(ctx) {
  const dir = ctx.resolve('.station/taskflow', true);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadFlow(ctx, id) {
  if (!/^flow_\d+$/.test(id)) throw new Error('流程 id 格式无效，应为 flow_数字');
  const f = ctx.resolve('.station/taskflow/' + id + '.json', false);
  if (!fs.existsSync(f)) throw new Error('找不到流程 "' + id + '"，请先用 create_flow 创建或列出已有流程');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function saveFlow(ctx, flow) {
  const f = ctx.resolve('.station/taskflow/' + flow.id + '.json', true);
  fs.writeFileSync(f, JSON.stringify(flow, null, 2));
}

function nextId(ctx) {
  const dir = flowDir(ctx);
  let n = 1;
  while (fs.existsSync(path.join(dir, 'flow_' + n + '.json'))) n++;
  return 'flow_' + n;
}

module.exports = {
  name: 'taskflow',
  tools: [
    {
      name: 'create_flow',
      description: '创建一个多步骤任务流程。steps 是有序数组，每项包含 title（步骤名）和 optional detail（补充说明）。创建后所有步骤状态为 pending。返回流程 id 供后续操作使用。',
      parameters: {
        type: 'object',
        properties: {
          goal: str('这个流程要达成的最终目标'),
          steps: {
            type: 'array',
            description: '有序步骤列表',
            items: {
              type: 'object',
              properties: {
                title: str('步骤名称'),
                detail: str('可选，步骤的补充说明或验收标准')
              },
              required: ['title']
            }
          }
        },
        required: ['goal', 'steps']
      },
      run(a, ctx) {
        if (!Array.isArray(a.steps) || a.steps.length === 0) throw new Error('steps 必须是非空数组');
        const id = nextId(ctx);
        const flow = {
          id,
          goal: String(a.goal),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          steps: a.steps.map(s => ({
            title: String(s.title),
            detail: s.detail ? String(s.detail) : '',
            status: 'pending', // pending | done | failed
            note: ''
          }))
        };
        saveFlow(ctx, flow);
        return JSON.stringify({ id, goal: flow.goal, stepCount: flow.steps.length }, null, 2);
      }
    },
    {
      name: 'list_flows',
      description: '列出工作区内所有已创建的任务流程及其当前进度摘要。',
      parameters: { type: 'object', properties: {} },
      run(a, ctx) {
        const dir = flowDir(ctx);
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
        if (files.length === 0) return '（暂无流程）';
        const lines = [];
        for (const f of files.slice(0, 100)) {
          try {
            const flow = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const done = flow.steps.filter(s => s.status === 'done').length;
            const failed = flow.steps.filter(s => s.status === 'failed').length;
            lines.push(flow.id + ' | ' + flow.goal + ' | ' + done + '/' + flow.steps.length + ' 完成' + (failed ? ', ' + failed + ' 失败' : ''));
          } catch (_) { /* skip corrupt */ }
        }
        return lines.join('\n') + (files.length > 100 ? '\n（共 ' + files.length + ' 个，只显示前 100）' : '');
      }
    },
    {
      name: 'get_flow',
      description: '查看某个流程的完整状态：目标、每步标题/详情/当前状态/备注。用于了解进度或决定下一步做什么。',
      parameters: {
        type: 'object',
        properties: { id: str('流程 id，如 flow_1') },
        required: ['id']
      },
      run(a, ctx) {
        const flow = loadFlow(ctx, a.id);
        return JSON.stringify(flow, null, 2);
      }
    },
    {
      name: 'mark_step',
      description: '标记某一步的状态为 done 或 failed，并可附备注。这是推进流程的核心操作：完成当前步骤后调用它，然后查看下一步。中断恢复时，从第一个 pending 步骤继续即可。',
      parameters: {
        type: 'object',
        properties: {
          id: str('流程 id'),
          stepIndex: { type: 'integer', description: '步骤序号，从 0 开始' },
          status: { type: 'string', description: '设为 done 或 failed' },
          note: str('可选，备注（如失败原因、完成说明）')
        },
        required: ['id', 'stepIndex', 'status']
      },
      run(a, ctx) {
        const flow = loadFlow(ctx, a.id);
        const idx = a.stepIndex;
        if (!Number.isInteger(idx) || idx < 0 || idx >= flow.steps.length) throw new Error('步骤序号必须是 0 到 ' + (flow.steps.length - 1) + ' 的整数');
        if (a.status !== 'done' && a.status !== 'failed') throw new Error('status 只能是 done 或 failed');
        flow.steps[idx].status = a.status;
        if (a.note) flow.steps[idx].note = String(a.note);
        flow.updatedAt = new Date().toISOString();
        saveFlow(ctx, flow);
        const remaining = flow.steps.filter(s => s.status === 'pending').length;
        return '步骤 ' + idx + '（' + flow.steps[idx].title + '）已标记为 ' + a.status + '。剩余 pending 步骤：' + remaining;
      }
    },
    {
      name: 'resume_flow',
      description: '获取流程中第一个未完成（pending）的步骤，用于中断后继续工作。返回该步骤的序号、标题和详情；如果所有步骤都已完成则提示流程已结束。',
      parameters: {
        type: 'object',
        properties: { id: str('流程 id') },
        required: ['id']
      },
      run(a, ctx) {
        const flow = loadFlow(ctx, a.id);
        const idx = flow.steps.findIndex(s => s.status === 'pending');
        if (idx === -1) {
          const allDone = flow.steps.every(s => s.status === 'done');
          return allDone ? '流程已全部完成，无需继续。' : '没有 pending 步骤（可能有 failed 步骤需要处理）。';
        }
        const step = flow.steps[idx];
        return JSON.stringify({
          id: flow.id,
          nextStepIndex: idx,
          title: step.title,
          detail: step.detail || '',
          remainingPending: flow.steps.filter(s => s.status === 'pending').length
        }, null, 2);
      }
    },
    {
      name: 'delete_flow',
      description: '删除一个流程及其所有步骤记录。仅在确认不再需要时调用。',
      parameters: {
        type: 'object',
        properties: { id: str('流程 id') },
        required: ['id']
      },
      run(a, ctx) {
        if (!/^flow_\d+$/.test(a.id)) throw new Error('流程 id 格式无效，应为 flow_数字');
        const f = ctx.resolve('.station/taskflow/' + a.id + '.json', false);
        if (!fs.existsSync(f)) throw new Error('找不到流程 "' + a.id + '"');
        fs.unlinkSync(f);
        return '已删除流程 ' + a.id;
      }
    }
  ]
};
