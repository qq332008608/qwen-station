'use strict';
// 从一部分章的小说里取一章，建成剧集里的一集，跑到“资料图出完、等你确认”为止。
//   node episode.cjs <小说.txt> <第几章> [剧集名]
const fs = require('fs'), path = require('path');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8')), ST = `http://127.0.0.1:${CFG.port}`, H = { 'Content-Type': 'application/json', Origin: ST };
const api = async (p, body) => { const r = await fetch(ST + p, body === undefined ? {} : { method: 'POST', headers: H, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${p} → ${j.error || r.status}`); return j; };
const one = s => String(s || '').replace(/\s+/g, ' '), say = s => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
const [file, no, seriesArg] = process.argv.slice(2);
(async () => {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''), parts = text.split(/\n(?=第[一二三四五六七八九十百\d]+章)/), book = parts[0].trim().split('\n')[0].trim();
  const ch = parts[Number(no)]; if (!ch) throw new Error(`没有第 ${no} 章（共 ${parts.length - 1} 章）`);
  const title = ch.split('\n')[0].replace(/^第.+?章\s*/, '').trim(), seriesName = seriesArg || book.replace(/（.*?）/g, '').replace(/[：:]/g, '_');
  const list = await api('/api/studio/list'), has = JSON.stringify(list).includes(`"${seriesName}"`);
  const body = { title, brief: ch.trim(), book: text, ratio: '16:9', resolution: '768P', style: '东方仙侠，写实电影质感；云海与晨光，冷青、玉白与金色为主，魔族出现时转为紫红与墨黑' };
  const j = await api('/api/studio/new', Object.assign(body, has ? { series: seriesName } : { seriesName }));
  const id = j.id; say(`已新建：${id}（第 ${no} 章 ${title}，${ch.length} 字）`);
  const printed = new Set(), state = () => api('/api/studio/state?id=' + encodeURIComponent(id));
  const run = async action => { say('#### ' + action); await api('/api/studio/run', { id, action }); for (;;) { await new Promise(r => setTimeout(r, 4000)); let s; try { s = await state(); } catch (e) { continue; } for (const l of s.log) if (!printed.has(l)) { printed.add(l); if (!/\d+% /.test(l)) console.log('  ' + one(l).slice(0, 220)); } if (!s.running) return s; } };
  let s = await run('script'); say('原文里没有的：' + JSON.stringify(s.script.added)); console.log(s.script.text);
  s = await run('elements'); for (const e of s.elements) say(`元素｜${e.kind}｜${e.name}｜${e.images.map(i => i.label).join('、')}${e.lib ? '｜来自资产库' : ''}｜${one(e.description).slice(0, 120)}`);
  for (const e of s.elements) console.log(`\n【${e.kind}】${e.name}\n${e.description}\n出图提示词：${e.images[0].prompt}`);
  s = await run('plan'); for (const x of s.shots) console.log(`\n${x.title}｜第${x.scene}场｜${x.size}｜${x.method}｜${x.move}·${x.beat}\n  机位：${x.angle}\n  起始：${x.start}\n  动作：${x.action}\n  结束：${x.end}`);
  say('EP_READY ' + id);
})().catch(e => { say('中断：' + e.message); say('EP_READY'); process.exit(1); });
