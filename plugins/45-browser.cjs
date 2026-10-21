'use strict';
// 浏览器：通过 DevTools 协议驱动本机 Chrome/Edge（无头模式，独立的空白用户目录，不带任何已登录账号）。
// 写进代码的浏览器纪律（对应 AGENTS.md）：同一网址只开一次并复用标签页；单轮对话最多 10 次浏览器调用；
// 元素编号每次读取页面时重新生成，不沿用旧编号。
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const PORT = 18801, MAX_CALLS = 10, BASE = `http://127.0.0.1:${PORT}`;
const EXES = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let proc = null, current = null, budget = { turn: -1, n: 0 };

async function ensure(ctx) {
  if (await ctx.getJSON(BASE + '/json/version', 1500)) return;
  const exe = EXES.find(e => fs.existsSync(e)); if (!exe) throw new Error('本机没找到 Chrome 或 Edge');
  proc = spawn(exe, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(ctx.root, 'browser-profile')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  process.on('exit', () => { try { proc.kill(); } catch (e) {} });
  for (let i = 0; i < 40; i++) { await sleep(250); if (await ctx.getJSON(BASE + '/json/version', 1000)) return; }
  throw new Error('浏览器启动失败');
}
function spend(ctx) {
  if (budget.turn !== ctx.turn) budget = { turn: ctx.turn, n: 0 };
  if (++budget.n > MAX_CALLS) throw new Error(`本轮浏览器调用已达 ${MAX_CALLS} 次上限。停止调用浏览器，向用户汇报做到哪了，得到“继续”后才能接着做。`);
}
function checkUrl(url, ctx) {
  const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error('只能打开 http/https 网址（file:// 会被拦截，本地文件用预览地址）');
  // 平台自己的界面和接口不许用浏览器工具打开（那里有给用户本人点的确认按钮），只放行 /preview/ 预览
  if (/^(127\.0\.0\.1|localhost)$/.test(u.hostname) && String(u.port) === String(ctx.cfg.port) && !u.pathname.startsWith('/preview/')) throw new Error('不能用浏览器工具打开平台自己的界面，只能打开 /preview/ 下的预览页');
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname) || /\.(local|lan|internal)$/.test(u.hostname)) throw new Error('不允许访问内网地址');
  return u.href;
}
const pages = async () => ((await (await fetch(BASE + '/json/list')).json()) || []).filter(t => t.type === 'page');
async function pick(id) {
  const list = await pages(), want = id || current;
  const tab = want ? list.find(t => t.id.toLowerCase().startsWith(String(want).toLowerCase())) : list[0];
  if (!tab) throw new Error(want ? `没有标签页 ${want}，先用 browser_tabs 看看` : '还没有打开任何页面，先用 browser_open');
  current = tab.id; return tab;
}
function cdp(tab, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl), timer = setTimeout(() => { ws.close(); reject(new Error('浏览器 30 秒没有响应')); }, 30000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id !== 1) return; clearTimeout(timer); ws.close(); m.error ? reject(new Error(m.error.message)) : resolve(m.result); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('连不上这个标签页')); };
  });
}
async function evalJS(tab, expression) {
  const r = await cdp(tab, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('页面脚本报错：' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text).split('\n')[0]);
  return r.result.value;
}
async function waitLoad(tab) { for (let i = 0; i < 40; i++) { await sleep(400); try { if (await evalJS(tab, 'document.readyState') === 'complete') return; } catch (e) {} } }
// 读页面：正文文字 + 可操作元素（每次重新编号，写到元素的 data-st 属性上，供 click/type 定位）
const SNAP = `(() => {
  document.querySelectorAll('[data-st]').forEach(e => e.removeAttribute('data-st'));
  const els = [...document.querySelectorAll('a[href],button,input,textarea,select,[role=button],[role=tab],[role=link],[onclick]')].filter(e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && !e.disabled; }).slice(0, 80);
  const lines = els.map((e, i) => { e.setAttribute('data-st', i + 1); const tag = e.tagName.toLowerCase(), label = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || e.title || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 60); return '[' + (i + 1) + '] ' + tag + (e.type && tag === 'input' ? ':' + e.type : '') + ' ' + label; });
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim(), els: lines, canvas: document.querySelectorAll('canvas').length };
})()`;
async function snapshot(tab, ctx) {
  const s = await evalJS(tab, SNAP);
  return `标签页 ${tab.id.slice(0, 6)}｜${s.title}\n${s.url}\n\n${ctx.clip(s.text, 5000) || '（页面没有可读文字' + (s.canvas ? `，有 ${s.canvas} 个 canvas——画布类页面读不到元素是正常的，不代表没打开` : '') + '）'}\n\n可操作元素（编号只在下次读取前有效）：\n${s.els.join('\n') || '（无）'}`;
}
const tabArg = { type: 'string', description: '标签页编号（前 6 位），不填则用当前标签页' };
const target = n => `document.querySelector('[data-st="${parseInt(n, 10)}"]')`;
const STALE = '找不到这个编号的元素——页面可能变了，先 browser_read 重新读取再操作';

module.exports = {
  name: 'browser',
  tools: [
    { name: 'browser_open', description: '在浏览器里打开一个网址并返回页面文字和可操作元素。同一个网址已经打开时会直接复用那个标签页，不会重复打开。',
      parameters: { type: 'object', properties: { url: { type: 'string', description: '完整网址' } }, required: ['url'] },
      async run(a, ctx) {
        spend(ctx); await ensure(ctx); const url = checkUrl(a.url, ctx), list = await pages();
        let tab = list.find(t => t.url.replace(/\/$/, '') === url.replace(/\/$/, '')), reused = !!tab;
        if (!tab) {
          tab = list.find(t => t.url === 'about:blank') || await (await fetch(BASE + '/json/new?about:blank', { method: 'PUT' })).json();
          const nav = await cdp(tab, 'Page.navigate', { url }); if (nav.errorText) throw new Error('打不开：' + nav.errorText);
          await waitLoad(tab);
        }
        current = tab.id; return (reused ? '（这个网址已经开着，直接复用）\n' : '') + await snapshot(tab, ctx);
      } },
    { name: 'browser_read', description: '重新读取标签页当前的文字和可操作元素。点击、输入或页面变化之后要先读再继续操作。',
      parameters: { type: 'object', properties: { tab: tabArg } },
      async run(a, ctx) { spend(ctx); await ensure(ctx); return snapshot(await pick(a.tab), ctx); } },
    { name: 'browser_click', description: '点击页面上的一个元素，index 是最近一次读取页面时给出的编号。',
      parameters: { type: 'object', properties: { index: { type: 'integer', description: '元素编号' }, tab: tabArg }, required: ['index'] },
      async run(a, ctx) {
        spend(ctx); await ensure(ctx); const tab = await pick(a.tab);
        const ok = await evalJS(tab, `(() => { const e = ${target(a.index)}; if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true; })()`);
        if (!ok) throw new Error(STALE);
        await sleep(800); await waitLoad(tab); return '已点击。\n' + await snapshot(await pick(tab.id), ctx);
      } },
    { name: 'browser_type', description: '往输入框里填文字，index 是最近一次读取页面时给出的编号。enter 为 true 时填完按回车。',
      parameters: { type: 'object', properties: { index: { type: 'integer', description: '元素编号' }, text: { type: 'string', description: '要填的文字' }, enter: { type: 'boolean', description: '填完是否按回车' }, tab: tabArg }, required: ['index', 'text'] },
      async run(a, ctx) {
        spend(ctx); await ensure(ctx); const tab = await pick(a.tab);
        const ok = await evalJS(tab, `(() => { const e = ${target(a.index)}; if (!e) return false; e.focus(); const p = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, d = Object.getOwnPropertyDescriptor(p, 'value'); if (d && 'value' in e) d.set.call(e, ${JSON.stringify(String(a.text))}); else e.textContent = ${JSON.stringify(String(a.text))}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
        if (!ok) throw new Error(STALE);
        if (a.enter) { for (const type of ['keyDown', 'keyUp']) await cdp(tab, 'Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined }); await sleep(800); await waitLoad(tab); }
        return '已输入' + (a.enter ? '并回车' : '') + '。\n' + await snapshot(await pick(tab.id), ctx);
      } },
    { name: 'browser_eval', description: '在页面里执行一段 JavaScript 表达式并返回结果（例如检查 canvas 是否存在）。读不到元素的画布类页面用它检查。',
      parameters: { type: 'object', properties: { js: { type: 'string', description: 'JavaScript 表达式，结果要能序列化' }, tab: tabArg }, required: ['js'] },
      async run(a, ctx) { spend(ctx); await ensure(ctx); const v = await evalJS(await pick(a.tab), a.js); return ctx.clip(typeof v === 'string' ? v : JSON.stringify(v, null, 1), 6000) || '（没有返回值）'; } },
    { name: 'browser_tabs', description: '列出当前打开的所有标签页。',
      parameters: { type: 'object', properties: {} },
      async run(a, ctx) { spend(ctx); await ensure(ctx); return (await pages()).map(t => `${t.id.slice(0, 6)}${t.id === current ? '（当前）' : ''}｜${t.title}｜${t.url}`).join('\n') || '没有打开的标签页'; } },
    { name: 'browser_close', description: '关闭一个标签页。任务结束时要把自己打开的标签页关掉。',
      parameters: { type: 'object', properties: { tab: tabArg } },
      async run(a, ctx) { await ensure(ctx); const tab = await pick(a.tab); await fetch(BASE + '/json/close/' + tab.id); current = null; return `已关闭标签页 ${tab.id.slice(0, 6)}`; } },
  ],
};
