'use strict';
// 显卡交接：本地模型占满显存，ComfyUI 任务运行前要先卸载它，结束后再加载回来。
// 统一走 model.ps1（加载时带视觉头）。不接子进程的输出管道——模型进程会继承管道，接了就等不到结束。
const path = require('path');
const { spawn } = require('child_process');
const SCRIPT = path.join(__dirname, '..', 'model.ps1');
const CODES = { 2: '缺少模型文件', 3: 'ComfyUI 还有任务在跑', 4: '模型进程启动时退出', 5: '等待模型就绪超时' };
function modelPs(mode) {
  return new Promise(resolve => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, mode], { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, text: '超过 16 分钟没有完成' }); }, 960000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, text: e.message }); });
    child.on('exit', code => { clearTimeout(timer); resolve({ ok: code === 0, text: code === 0 ? '' : `${CODES[code] || '退出码 ' + code}，日志在 D:\\openclaw\\logs` }); });
  });
}
module.exports = { unloadModel: () => modelPs('stop'), loadModel: () => modelPs('start') };
