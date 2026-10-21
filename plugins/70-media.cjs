'use strict';
// 媒体检查：用本机 ffmpeg/ffprobe 做发布验收需要的技术检查（探测、完整解码、黑帧/静帧/静音、抽帧、尾帧、接触表、SSIM、SHA-256）。
// 只运行 ffmpeg 和 ffprobe 两个程序，参数由这里固定拼装，模型只能给文件路径和少量数值。
// 可读范围：工作区 + config.readRoots（如 E:\视频生成文件）。产物一律写到工作区的 .station/media/ 下，不改动原始素材。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFile } = require('child_process');
// 看图在 CPU 上编码，图多时要好几分钟才有第一个字节。内置 fetch 等响应头最多 5 分钟就会断开，所以这里用 http 模块自己发，最长等 20 分钟。
function slowPost(url, o) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), body = Buffer.from(o.body);
    const req = require('http').request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: Object.assign({ 'Content-Length': body.length }, o.headers) }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ ok: res.statusCode === 200, json: async () => JSON.parse(Buffer.concat(c).toString('utf8')) }));
    });
    req.setTimeout(1200000, () => req.destroy(new Error('看图超过 20 分钟没有结果（显卡可能被别的任务占着）'))); req.on('error', reject); req.end(body);
  });
}
const exe = (ctx, name) => path.join(ctx.cfg.ffmpegDir, name + '.exe');
const run = (file, args, ms = 600000) => new Promise(resolve => execFile(file, args, { timeout: ms, windowsHide: true, maxBuffer: 32e6 }, (e, out, err) => resolve({ ok: !e, out: String(out || ''), err: String(err || '') })));
const sha = file => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', d => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
const src = (ctx, p) => { const f = ctx.resolve(p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) throw new Error('找不到文件：' + p); return f; };
function outDir(ctx, file) {
  const rel = '.station/media/' + path.basename(file).replace(/[^\w.\u4e00-\u9fa5-]+/g, '_').slice(0, 40) + '-' + crypto.createHash('md5').update(file).digest('hex').slice(0, 6);
  fs.mkdirSync(ctx.resolve(rel, true), { recursive: true }); return rel;
}
async function probe(ctx, file) {
  const r = await run(exe(ctx, 'ffprobe'), ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], 60000);
  if (!r.ok) throw new Error('ffprobe 读不了这个文件：' + ctx.clip(r.err, 300));
  const j = JSON.parse(r.out), v = (j.streams || []).find(s => s.codec_type === 'video'), a = (j.streams || []).filter(s => s.codec_type === 'audio');
  const fps = v && v.avg_frame_rate && v.avg_frame_rate.includes('/') ? (n => n[1] ? n[0] / n[1] : 0)(v.avg_frame_rate.split('/').map(Number)) : 0;
  return { duration: Number((j.format || {}).duration) || 0, container: (j.format || {}).format_name, v, a, fps };
}
const P = { path: { type: 'string', description: '文件路径：工作区内用相对路径，媒体目录下用绝对路径（如 E:\\视频生成文件\\项目\\视频\\x.mp4）' } };

module.exports = {
  name: 'media',
  tools: [
    { name: 'media_probe', description: '读取一个视频/音频/图片文件的真实属性：字节数、修改时间、SHA-256、容器、时长、视频编码/分辨率/帧率、音轨。发布验收和汇报里的媒体属性必须来自它，不能凭记忆写。',
      parameters: { type: 'object', properties: P, required: ['path'] },
      async run(a, ctx) {
        const f = src(ctx, a.path), st = fs.statSync(f), p = await probe(ctx, f);
        return [`文件：${f}`, `字节数：${st.size}　修改时间：${st.mtime.toISOString()}`, `SHA-256：${await sha(f)}`, `容器：${p.container}　时长：${p.duration.toFixed(3)} 秒`,
          p.v ? `视频：${p.v.codec_name} ${p.v.width}x${p.v.height} ${p.fps.toFixed(3)} fps${p.v.nb_frames ? ` ${p.v.nb_frames} 帧` : ''} ${p.v.pix_fmt || ''}` : '视频：无',
          p.a.length ? p.a.map((s, i) => `音轨${i + 1}：${s.codec_name} ${s.sample_rate}Hz ${s.channels} 声道`).join('\n') : '音轨：无'].join('\n');
      } },
    { name: 'media_check', description: '对一个视频或音频做技术质检：完整解码是否报错、黑帧段、静帧（画面冻结）段、静音段、音量、真峰值、整体响度。结果里带【不通过】或【警告】的项必须原样写进汇报。它不能代替看画面；声音内容你听不到，只能标注“未经试听”。',
      parameters: { type: 'object', properties: P, required: ['path'] },
      async run(a, ctx) {
        const f = src(ctx, a.path), p = await probe(ctx, f), out = [];
        const vf = p.v ? ['-vf', 'blackdetect=d=0.3:pix_th=0.10,freezedetect=n=0.003:d=1'] : [], af = p.a.length ? ['-af', 'silencedetect=n=-50dB:d=1,volumedetect,ebur128=peak=true'] : [];
        const r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-nostats', '-v', 'info', '-i', f, ...vf, ...af, '-f', 'null', '-']), log = r.err;
        const errs = log.split('\n').filter(l => /error|invalid data|corrupt|missing reference|concealing/i.test(l) && !/blackdetect|freezedetect|silencedetect/.test(l));
        out.push(r.ok && !errs.length ? '完整解码：通过，没有解码错误' : `完整解码：有问题（${errs.length} 条）\n` + ctx.clip(errs.slice(0, 8).join('\n'), 800));
        if (p.v) {
          const black = [...log.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map(m => `${m[1]}–${m[2]} 秒`);
          const fs0 = [...log.matchAll(/freeze_start: ([\d.]+)/g)].map(m => m[1]), fe = [...log.matchAll(/freeze_end: ([\d.]+)/g)].map(m => m[1]);
          out.push('黑帧段：' + (black.join('、') || '无'), '静帧段（冻结≥1秒）：' + (fs0.map((s, i) => `${s}–${fe[i] || '结尾'} 秒`).join('、') || '无'));
        }
        if (p.a.length) {
          const ss = [...log.matchAll(/silence_start: ([\d.]+)/g)].map(m => m[1]), se = [...log.matchAll(/silence_end: ([\d.]+)/g)].map(m => m[1]);
          const mean = (log.match(/mean_volume: (-?[\d.]+|-inf) dB/) || [])[1], max = (log.match(/max_volume: (-?[\d.]+|-inf) dB/) || [])[1];
          const lufs = ([...log.matchAll(/\bI:\s+(-?[\d.]+) LUFS/g)].pop() || [])[1], tp = ([...log.matchAll(/\bPeak:\s+(-?[\d.]+) dBFS/g)].pop() || [])[1], peak = Math.max(Number(max), tp === undefined ? -99 : Number(tp));
          out.push('静音段（≥1秒）：' + (ss.map((s, i) => `${s}–${se[i] || '结尾'} 秒`).join('、') || '无'),
            `音量：平均 ${mean} dB，采样峰值 ${max} dB` + (tp !== undefined ? `，真峰值 ${tp} dBFS` : '') + (lufs !== undefined ? `，整体响度 ${lufs} LUFS` : ''));
          if (mean === '-inf' || Number(mean) < -60) out.push('【不通过】音轨基本是静音。');
          else if (peak >= -0.1) out.push(`【不通过】峰值 ${peak} dB 已经贴顶，很可能削波。需要降低音量后重新混音或重做。`);
          else if (peak >= -1.0) out.push(`【警告】峰值 ${peak} dB，离削波不到 1 dB，余量不足。验收报告里必须把它列为问题或妥协项，不能写成通过；配乐混音时把 volume 调低后重混。`);
          if (lufs !== undefined && Number(lufs) > -10) out.push(`【警告】整体响度 ${lufs} LUFS 偏大（常见交付目标约 -16 到 -14 LUFS）。`);
          out.push('【未经试听】以上只是音量和时长的测量。声音的内容——有没有人声、是不是要的乐器和风格、对白说得对不对、配乐和环境声的比例是否合适、结尾是否自然——你听不到，无法判断。汇报和验收报告里这些项一律写“未经试听，需人工确认”，不能写通过。');
        } else out.push('音轨：无');
        return `时长 ${p.duration.toFixed(3)} 秒\n` + out.join('\n');
      } },
    { name: 'media_frames', description: '从视频里抽帧存成无损 PNG。mode=keys 抽首帧、中点、末帧；mode=tail 只抽真实解码的最后一帧（长视频续写时用它做下一段的首帧）；mode=times 按给定秒数抽。返回每张图的工作区路径、预览地址和 SHA-256。',
      parameters: { type: 'object', properties: Object.assign({ mode: { type: 'string', enum: ['keys', 'tail', 'times'] }, times: { type: 'array', items: { type: 'number' }, description: 'mode=times 时的秒数列表，最多 12 个' } }, P), required: ['path', 'mode'] },
      async run(a, ctx) {
        const f = src(ctx, a.path), p = await probe(ctx, f), dir = outDir(ctx, f), made = [];
        if (!p.v) throw new Error('这个文件没有视频画面');
        const grab = async (name, args) => { const rel = `${dir}/${name}.png`, r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-v', 'error', '-y', ...args, ctx.resolve(rel, true)], 120000); if (r.ok && fs.existsSync(ctx.resolve(rel))) made.push(rel); else throw new Error(`抽帧 ${name} 失败：` + ctx.clip(r.err, 300)); };
        const at = (name, t) => grab(name, ['-ss', String(Math.max(0, t)), '-i', f, '-frames:v', '1']);
        const tail = () => grab('tail', ['-sseof', '-3', '-i', f, '-update', '1']);   // 解码到结尾，留下的就是真实最后一帧
        if (a.mode === 'tail') await tail();
        else if (a.mode === 'keys') { await at('first', 0); await at('mid', p.duration / 2); await tail(); }
        else { const ts = (a.times || []).slice(0, 12); if (!ts.length) throw new Error('mode=times 需要 times'); for (const t of ts) await at('t' + Number(t).toFixed(2).replace('.', '_'), Number(t)); }
        const lines = []; for (const rel of made) lines.push(`${rel}\n  预览 http://127.0.0.1:${ctx.cfg.port}/preview/${rel}\n  SHA-256 ${await sha(ctx.resolve(rel))}`);
        return lines.join('\n');
      } },
    { name: 'media_contact_sheet', description: '把视频按时间均匀取若干帧拼成一张接触表图片，给用户一眼看完整段。返回预览地址，汇报时把这个地址给用户。',
      parameters: { type: 'object', properties: Object.assign({ count: { type: 'integer', description: '取多少帧，默认 12，最多 30' } }, P), required: ['path'] },
      async run(a, ctx) {
        const f = src(ctx, a.path), p = await probe(ctx, f), n = Math.min(30, Math.max(4, a.count || 12)), cols = Math.ceil(Math.sqrt(n)), rel = `${outDir(ctx, f)}/contact.jpg`;
        if (!p.v || !p.duration) throw new Error('这个文件没有可用的视频画面');
        const r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-v', 'error', '-y', '-i', f, '-vf', `fps=${(n / p.duration).toFixed(5)},scale=480:-2,tile=${cols}x${Math.ceil(n / cols)}`, '-frames:v', '1', '-q:v', '3', ctx.resolve(rel, true)]);
        if (!r.ok) throw new Error('生成接触表失败：' + ctx.clip(r.err, 300));
        return `接触表（${n} 帧，从左到右、从上到下按时间）：${rel}\n预览 http://127.0.0.1:${ctx.cfg.port}/preview/${rel}`;
      } },
    { name: 'media_look', description: '用眼睛看图片或视频并回答问题（模型的视觉头）。给一到六张图片，或一个视频（自动均匀抽帧）。每生成一张图或一段视频，都要用它检查身份、数量、构图、动作、多余的人或物、文字水印、接缝，再决定是否进入下一步。question 里写清要核对的验收点。它只是一次性观察，结论要和 media_check 的技术结果一起判断。',
      parameters: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' }, description: '一到六张图片的路径，或只放一个视频路径' }, question: { type: 'string', description: '要它看什么、核对哪些验收点' }, frames: { type: 'integer', description: '传视频时抽多少帧，默认 6，最多 8' }, references: { type: 'array', items: { type: 'string' }, description: '最多 3 张参考图的路径（角色图、道具图）。会排在最前面一起给你看，用来对照检查画面里的角色和道具是不是同一个。检查镜头和成片时都应该带上。' } }, required: ['paths', 'question'] },
      async run(a, ctx) {
        const list = (a.paths || []).slice(0, 6); if (!list.length) throw new Error('paths 不能为空');
        const tmp = '.station/media/_look'; fs.mkdirSync(ctx.resolve(tmp, true), { recursive: true });
        const SCALE = "scale='if(gt(iw,ih),min(1024,iw),-2)':'if(gt(iw,ih),-2,min(1024,ih))'", shots = [];
        const jpg = async (name, args, label) => { const rel = `${tmp}/${name}.jpg`, r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-v', 'error', '-y', ...args, '-frames:v', '1', '-vf', SCALE, '-q:v', '4', ctx.resolve(rel, true)], 120000); if (!r.ok) throw new Error(`读不了 ${label}：` + ctx.clip(r.err, 200)); shots.push({ label, data: fs.readFileSync(ctx.resolve(rel)).toString('base64') }); };
        const refs = (a.references || []).slice(0, 3);
        for (let i = 0; i < refs.length; i++) await jpg('r' + i, ['-i', src(ctx, refs[i])], '参考图·' + path.basename(refs[i]).replace(/_\d+_?\.\w+$/, ''));
        const first = src(ctx, list[0]), p0 = await probe(ctx, first);
        if (list.length === 1 && p0.v && p0.duration > 0.3 && !/\.(png|jpe?g|webp|bmp)$/i.test(first)) {
          const n = Math.min(8, Math.max(2, a.frames || 6));
          for (let i = 0; i < n; i++) { const t = i === n - 1 ? Math.max(0, p0.duration - 0.08) : p0.duration * i / (n - 1); await jpg('v' + i, ['-ss', t.toFixed(3), '-i', first], `第 ${t.toFixed(2)} 秒`); }
        } else for (let i = 0; i < list.length; i++) await jpg('i' + i, ['-i', src(ctx, list[i])], path.basename(list[i]));
        const content = [{ type: 'text', text: `下面按顺序给出 ${shots.length} 张画面：${shots.map((s, i) => `图${i + 1}=${s.label}`).join('；')}。\n\n要核对的问题：${a.question}` }, ...shots.map(s => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + s.data } }))];
        const res = await slowPost(ctx.cfg.model.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(600000),
          body: JSON.stringify({ model: ctx.cfg.model.id, temperature: 0.1, max_tokens: 1500, messages: [{ role: 'system', content: '你是严格的影视质检员。只根据画面里真实看到的内容回答，逐条回应要核对的问题，并按“图N”指明依据。看不清或无法判断的就直说看不清，不要猜，不要补充画面里没有的东西。发现多余的人或物、肢体畸形、文字水印、身份或数量变化，要主动指出。' }, { role: 'user', content }] }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok || !j.choices) throw new Error(/mmproj|image|multimodal/i.test(JSON.stringify(j)) ? '当前加载的模型没有视觉头。请运行 D:\\qwen-station\\start.ps1 重新加载模型。' : '视觉调用失败：' + ctx.clip(JSON.stringify(j), 300));
        return `（看了 ${shots.length} 张画面：${shots.map(s => s.label).join('、')}）\n` + String(j.choices[0].message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      } },
    { name: 'media_limit_peak', description: '给成片的音轨做限幅：把峰值压到约 -2 dB 以下，画面原样不动（不重新编码）。当 media_check 报峰值【警告】或【不通过】，而且调低配乐音量也解决不了（峰值来自镜头原声）时使用。输出在工作区，之后要用 wb_upload 存回项目，并对新文件重新 media_check。',
      parameters: { type: 'object', properties: P, required: ['path'] },
      async run(a, ctx) {
        const f = src(ctx, a.path), p = await probe(ctx, f); if (!p.a.length) throw new Error('这个文件没有音轨');
        const rel = `${outDir(ctx, f)}/${path.basename(f).replace(/\.[^.]+$/, '')}_限幅${p.v ? '.mp4' : '.m4a'}`;
        const r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-v', 'error', '-y', '-i', f, ...(p.v ? ['-c:v', 'copy'] : []), '-af', 'alimiter=limit=0.75:attack=5:release=80:level=disabled', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', ctx.resolve(rel, true)]);
        if (!r.ok) throw new Error('限幅失败：' + ctx.clip(r.err, 300));
        return `限幅完成，输出：${rel}\n画面没有重新编码；音轨重新编码为 AAC。请对它重新 media_check。`;
      } },
    { name: 'media_ssim', description: '比较两张图片（或两个视频的首帧）的结构相似度 SSIM，1 为完全相同。用来核对接缝处上一段尾帧和下一段首帧是否一致。',
      parameters: { type: 'object', properties: { a: { type: 'string', description: '第一个文件路径' }, b: { type: 'string', description: '第二个文件路径' } }, required: ['a', 'b'] },
      async run(a, ctx) {
        const r = await run(exe(ctx, 'ffmpeg'), ['-hide_banner', '-v', 'info', '-i', src(ctx, a.a), '-i', src(ctx, a.b), '-frames:v', '1', '-lavfi', '[0:v][1:v]scale2ref[x][y];[x][y]ssim', '-f', 'null', '-'], 120000);
        const m = r.err.match(/SSIM .*All:([\d.]+)/); if (!m) throw new Error('算不出 SSIM：' + ctx.clip(r.err, 300));
        return `SSIM = ${m[1]}` + (Number(m[1]) > 0.98 ? '（几乎相同）' : Number(m[1]) > 0.85 ? '（相近，仍需看画面）' : '（差异明显）');
      } },
  ],
};
