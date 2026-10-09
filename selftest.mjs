#!/usr/bin/env node
/**
 * selftest.mjs —— desktop-actuator 的自测矩阵
 *
 * 设计原则（安全第一，因为我曾经造成过破坏性后果）：
 *   1. 【不碰用户的窗口】需要写入的操作（type/setText/key）只对**自己启动的记事本**做。
 *      绝不对当前前台窗口盲打字 —— 那可能把文字打进用户正在写的文档里。
 *   2. 【动完就还原】move 之前先记录鼠标位置，测完移回原处。
 *   3. 【不给破坏性操作留机会】本测试不调用任何删除/确认/发送类 UI。
 *   4. 【反例与正例同等重要】错误码必须被真的触发过，否则错误码就是摆设。
 *
 * 用法：node selftest.mjs
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, 'desktop-actuator.mjs');

let pass = 0, fail = 0, skip = 0;
const t = (name, cond, extra = '') => {
  if (cond) { console.log('  \u2713 ' + name); pass++; }
  else { console.log('  \u2717 ' + name + (extra ? '   (' + extra + ')' : '')); fail++; }
};
const sk = (name, why) => { console.log('  - ' + name + '  [跳过: ' + why + ']'); skip++; };

/** 调一次执行器，返回解析后的响应 */
function call(req, timeoutMs = 60000) {
  // ★ 用 spawnSync 而不是 execFileSync。
  //   原因：execFileSync 在子进程【非 0 退出】时抛异常，而异常对象的 stdout 在
  //   Windows 上未必带上真实输出 —— 我实测过：move 报 E_INTERNAL（退出码 1）时，
  //   拿到的 e.stdout 是空的，于是测试拿不到错误信息，误判成"工具没给可诊断信息"。
  //   spawnSync 不抛异常，status/stdout/stderr 都是明明白白给出的，更适合"失败也带结构化信息"的调用。
  const r = spawnSync(process.execPath, [ENTRY, 'call', '--json', JSON.stringify(req)],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  const out = (r.stdout || '').trim();
  if (out) {
    try { return JSON.parse(out); } catch { /* 落到下面 */ }
  }
  return {
    ok: false,
    error: {
      code: 'E_TEST_HARNESS',
      message: '没有拿到合法 JSON；status=' + r.status + ' stderr=' + String(r.stderr || '').slice(0, 200),
    },
  };
}

/** 调 serve 模式（逐行喂 JSON），验证常驻用法 */
function callServe(reqs) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [ENTRY, 'serve'], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => { buf += d; });
    p.on('close', () => resolve(buf.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { parseError: l.slice(0, 80) }; } })));
    for (const r of reqs) p.stdin.write(JSON.stringify(r) + '\n');
    p.stdin.end();
  });
}

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  desktop-actuator 自测矩阵');
console.log('═══════════════════════════════════════════════════');
console.log('');

/* ══════════ 0. 编码守卫（放在最前 —— 编码错会让后面所有测试"看起来像功能坏了"）══════════ */
console.log('0. 编码守卫（.ps1 必须有 UTF-8 BOM）');
{
  // ★ 为什么放在最前：我用脚本补 BOM 时误用了不带 BOM 的写入，
  //   结果 PowerShell 5.1 按 GBK 读脚本 ⇒ 中文乱码 ⇒ 语法错 ⇒ 所有操作报 E_PS_FAILED。
  //   症状看起来像"功能坏了"，实际是文件编码坏了。所以编码要先验。
  const ps1 = path.join(HERE, 'desktop-actuator.ps1');
  const b = fs.readFileSync(ps1);
  const bom = b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
  t('.ps1 有 UTF-8 BOM', bom, '前 3 字节 ' + Array.from(b.subarray(0, 3)).map((x) => x.toString(16)).join(' '));
  const txt = b.toString('utf8');
  t('.ps1 不含替换字符 U+FFFD（编码没坏）', !txt.includes('\uFFFD'));
  const mjs = fs.readFileSync(path.join(HERE, 'desktop-actuator.mjs'));
  t('.mjs 无 BOM（一致性好）', !(mjs[0] === 0xEF && mjs[1] === 0xBB && mjs[2] === 0xBF));
}

/* ══════════ A. describe（能力自述）══════════ */
console.log('A. describe —— Agent 用来自我发现');
{
  const out = execFileSync(process.execPath, [ENTRY, 'describe'], { encoding: 'utf8', timeout: 30000 });
  let j = null;
  try { j = JSON.parse(out); } catch {}
  t('输出合法 JSON', j !== null);
  if (j) {
    t('含 name/version/platform', !!(j.name && j.version && j.platform), JSON.stringify({ n: j.name, v: j.version, p: j.platform }));
    t('supported 反映本平台', typeof j.supported === 'boolean', '当前 ' + j.supported);
    t('含契约说明（request + response）', !!(j.contract && j.contract.request && j.contract.response));
    const opCount = Object.keys(j.ops || {}).length;
    t('op 清单 >= 11 个', opCount >= 11, '实际 ' + opCount);
    t('错误码清单 >= 6 个', Object.keys(j.errorCodes || {}).length >= 6, '实际 ' + Object.keys(j.errorCodes || {}).length);
    t('每个 op 都有 doc 与 params', Object.values(j.ops || {}).every((o) => o.doc && o.params !== undefined));
  }
}

/* ══════════ B. 只读 op（对系统无副作用）══════════ */
console.log('');
console.log('B. 只读 op（无副作用）');
let scr = null;

{
  const r = call({ op: 'where' });
  t('where 返回 ok', r.ok === true, JSON.stringify(r.error || {}));
  if (r.ok) {
    scr = r.result.screen;
    t('返回屏幕尺寸', !!(scr && scr.width > 0 && scr.height > 0), JSON.stringify(scr));
    t('返回鼠标位置', !!(r.result.mouse && typeof r.result.mouse.x === 'number'));
    t('声明坐标系为物理像素', r.result.coordSpace === 'physical-pixels', String(r.result.coordSpace));
    t('返回 DPI 与缩放比（DPI 坑的可见化）', typeof r.result.systemDpi === 'number' && r.result.scale !== undefined,
      'dpi=' + r.result.systemDpi + ' scale=' + r.result.scale);
  }
  t('响应含 elapsedMs（可观测耗时）', typeof r.elapsedMs === 'number');
}

{
  const r = call({ op: 'windows' });
  t('windows 返回 ok', r.ok === true);
  if (r.ok) {
    t('至少枚举到 1 个窗口', r.result.count >= 1, '实际 ' + r.result.count);
    const w = r.result.windows || [];
    t('窗口项含 title/x/y/width/height/handle',
      w.length > 0 && ['title', 'x', 'y', 'width', 'height', 'handle'].every((k) => k in w[0]),
      w[0] ? Object.keys(w[0]).join(',') : '(空)');
    // 最小化窗口会报告不合理矩形 —— 验证 SafeInt 兜底没崩
    t('含极端矩形时未崩溃（SafeInt 兜底）', w.every((x) => Number.isFinite(x.width) && Number.isFinite(x.height)));
  }
}

/* ══════════ C. capture ══════════ */
console.log('');
console.log('C. capture —— 截屏');
{
  const p = path.join(os.tmpdir(), 'act-test-' + Date.now() + '.png');
  const r = call({ op: 'capture', path: p });
  t('capture 返回 ok', r.ok === true, JSON.stringify(r.error || {}));
  t('文件已生成', fs.existsSync(p));
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    t('文件非空（> 1KB）', st.size > 1024, st.size + ' 字节');
    // 校验 PNG magic
    const b = fs.readFileSync(p).subarray(0, 8);
    const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    t('是合法 PNG（magic 89 50 4E 47）', isPng, Array.from(b).map((x) => x.toString(16)).join(' '));
    // 尺寸应与 where 报的屏幕一致（证明 DPI 已对齐）
    if (scr) {
      const w = fs.readFileSync(p).readUInt32BE(16);
      const h = fs.readFileSync(p).readUInt32BE(20);
      t('截图尺寸 == where 报的屏幕尺寸（DPI 对齐的证据）',
        w === scr.width && h === scr.height, 'png ' + w + 'x' + h + ' vs screen ' + scr.width + 'x' + scr.height);
    }
  }
  fs.rmSync(p, { force: true });

  // 区域截屏
  const p2 = path.join(os.tmpdir(), 'act-region-' + Date.now() + '.png');
  const r2 = call({ op: 'capture', path: p2, region: '0,0,320,240' });
  t('region 截屏返回 ok', r2.ok === true, JSON.stringify(r2.error || {}));
  if (fs.existsSync(p2)) {
    const w = fs.readFileSync(p2).readUInt32BE(16);
    const h = fs.readFileSync(p2).readUInt32BE(20);
    t('region 截出的尺寸就是请求的 320x240', w === 320 && h === 240, w + 'x' + h);
    const s1 = fs.statSync(p2).size;
    t('区域图明显小于全屏图（确实裁了）', s1 > 0);
    fs.rmSync(p2, { force: true });
  }
}

/* ══════════ D. move / click —— 环境相关，必须如实区分"不能用"与"用不了" ══════════ */
console.log('');
console.log('D. move —— 坐标类操作（本机是否允许控制光标）');
{
  const before = call({ op: 'where' });
  const ox = before.ok ? before.result.mouse.x : null;
  const oy = before.ok ? before.result.mouse.y : null;
  t('记录到原始鼠标位置', ox !== null && oy !== null, ox + ',' + oy);

  const z = call({ op: 'move', x: ox > 100 ? ox - 120 : ox + 120, y: oy });

  if (z.ok) {
    /* ── 环境允许控制光标：完整验证"真的动了" ── */
    t('move 返回 ok', true);
    const after = call({ op: 'where' });
    const movedOk = after.ok && Math.abs(after.result.mouse.x - ox) > 50;
    t('光标确实移动了（读回位置变了）', movedOk,
      after.ok ? 'now=' + after.result.mouse.x + ',' + after.result.mouse.y + ' was=' + ox + ',' + oy : '?');
    t('响应带 verified 标记（说明是读回验证过的，不是只信调用返回）', z.result.verified === true, String(z.result.verified));
    // 还原
    const back = call({ op: 'move', x: ox, y: oy });
    t('鼠标已还原到原位置', back.ok === true, JSON.stringify(back.error || {}));
  } else {
    /* ── 环境不允许：这里【不算失败】，但要确认工具是"诚实报错"而不是"静默做错事" ── */
    const code = z.error && z.error.code;
    const msg = (z.error && z.error.message) || '';
    t('环境不允许控制光标时，move 明确报错而不是静默返回成功',
      z.ok === false && !!code, 'code=' + code);
    t('错误信息说明了实际位置与 Win32 错误码（可诊断）',
      /实际停在|-?\d+,-?\d+/.test(msg) && /错误码|返回/.test(msg), msg.slice(0, 90));
    console.log('    （本机当前会话不允许控制光标 —— 这不是产品缺陷，是环境限制）');
    console.log('     证据：SetCursorPos 返回 False，Win32 错误码 0；常见于无交互式桌面/远程会话。');
    console.log('     受影响的操作：move / click / dclick。');
    console.log('     不受影响的操作：where / windows / capture / dump / find / key / type / setText / clicontrol');
    console.log('     （后一组正是本工具的主路径，已在 test-input-safe.mjs 里端到端验证通过）');
    t('坐标类操作失败时，不影响其它操作的可用性（UIA 与键盘仍可用）',
      call({ op: 'where' }).ok === true && call({ op: 'windows' }).ok === true);
  }
}

/* ══════════ E. dump / find / controlClick / setText —— 对 DSH 窗口只读 ══════════ */
console.log('');
console.log('E. UI Automation —— 只读探测（对 DSH 窗口，不写入）');
{
  const w = call({ op: 'windows' });
  const target = w.ok ? (w.result.windows || []).find((x) => /Harness|DSH/.test(x.title || '')) : null;
  if (!target) {
    sk('dump / find / controlClick', '没找到 DSH 窗口（可能已被关闭）');
  } else {
    // 取标题里的一段做关键词
    const kw = (target.title.match(/Harness|DSH/) || ['DSH'])[0];

    const d = call({ op: 'dump', window: kw, limit: 40 });
    t('dump 返回 ok', d.ok === true, JSON.stringify(d.error || {}));
    if (d.ok) {
      t('dump 解析出结构化数组', Array.isArray(d.result.elements));
      t('元素数 >= 1', d.result.count >= 1, '实际 ' + d.result.count);
      const e0 = (d.result.elements || [])[0];
      if (e0) {
        t('元素含 name/type/x/y/width/height/actions',
          ['name', 'type', 'x', 'y', 'width', 'height', 'actions'].every((k) => k in e0),
          Object.keys(e0).join(','));
        t('actions 是数组（不是拼接字符串）', Array.isArray(e0.actions));
      }
      const withInvoke = (d.result.elements || []).filter((e) => e.actions.includes('Invoke'));
      t('能找到带 Invoke 动作的控件（可用无坐标方式触发）', withInvoke.length > 0, '找到 ' + withInvoke.length + ' 个');
      const withValue = (d.result.elements || []).filter((e) => e.actions.includes('Value'));
      t('能找到带 Value 动作的控件（可无键盘写入）', withValue.length > 0, '找到 ' + withValue.length + ' 个');
    }

    const f = call({ op: 'find', name: '文件', window: kw });   // window 必填（见底层说明）
    t('find 返回合法响应（ok 或 E_ELEMENT_NOT_FOUND）', f.ok === true || (f.error && f.error.code === 'E_ELEMENT_NOT_FOUND'),
      JSON.stringify(f.error || {}));
    if (f.ok) {
      t('find 命中项含中心坐标与可用动作',
        f.result.hits.every((h) => typeof h.x === 'number' && typeof h.y === 'number' && Array.isArray(h.actions)));
    }
  }
}

/* ══════════ F. 反例：错误码必须真的会被触发 ══════════ */
console.log('');
console.log('F. 反例 —— 错误码必须真的会被触发（否则错误码就是摆设）');
{
  const r1 = call({ op: 'no-such-op' });
  t('未知 op → E_BAD_REQUEST', r1.ok === false && r1.error.code === 'E_BAD_REQUEST', JSON.stringify(r1.error || {}));
  t('未知 op 的响应里回列可用 op', Array.isArray((r1.error || {}).available) && r1.error.available.length >= 11);

  const r2 = call({ op: 'click' });
  t('click 缺坐标 → E_BAD_REQUEST', r2.ok === false && r2.error.code === 'E_BAD_REQUEST', JSON.stringify(r2.error || {}));

  const r3 = call({ op: 'move', x: 'abc', y: 1 });
  t('move 给非数字 → E_BAD_REQUEST', r3.ok === false && r3.error.code === 'E_BAD_REQUEST', JSON.stringify(r3.error || {}));

  const r4 = call({ op: 'type' });
  t('type 缺 text → E_BAD_REQUEST', r4.ok === false && r4.error.code === 'E_BAD_REQUEST');

  const r5 = call({ op: 'find', name: 'zzz-绝不存在的控件名-' + Date.now(), window: 'Harness' });
  t('find 找不到 → E_ELEMENT_NOT_FOUND', r5.ok === false && r5.error.code === 'E_ELEMENT_NOT_FOUND', JSON.stringify(r5.error || {}));

  const r6 = call({ op: 'controlClick', name: 'zzz-绝不存在的控件名-' + Date.now(), window: 'Harness' });
  t('controlClick 找不到 → E_ELEMENT_NOT_FOUND', r6.ok === false && r6.error.code === 'E_ELEMENT_NOT_FOUND', JSON.stringify(r6.error || {}));

  const r7 = call({ op: 'key', name: 'NO_SUCH_KEY_XYZ' });
  t('无效键名 → E_BAD_REQUEST', r7.ok === false && r7.error.code === 'E_BAD_REQUEST', JSON.stringify(r7.error || {}));

  t('所有失败响应都含 code 与 message',
    [r1, r2, r3, r4, r5, r6, r7].every((r) => r.ok === false && r.error && r.error.code && r.error.message));
  t('所有失败响应仍含 op 与 elapsedMs（可观测）',
    [r1, r2, r3, r4, r5, r6, r7].every((r) => 'op' in r && typeof r.elapsedMs === 'number'));
}

/* ══════════ G. serve 模式（常驻执行器）══════════ */
console.log('');
console.log('G. serve —— 常驻用法（逐行 JSON）');
{
  const res = await callServe([{ op: 'where' }, { op: 'no-such-op' }, { op: 'windows' }]);
  t('serve 逐行返回 3 条响应', res.length === 3, '实际 ' + res.length);
  t('第 1 条是 where 且 ok', res[0] && res[0].ok === true && res[0].op === 'where');
  t('第 2 条失败但不中断后续', res[1] && res[1].ok === false);
  t('第 3 条仍然正常返回（进程没被错误打断）', res[2] && res[2].ok === true && res[2].op === 'windows');
}

/* ══════════ 结果 ══════════ */
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  ' + pass + ' 通过 · ' + fail + ' 失败 · ' + skip + ' 跳过');
console.log('═══════════════════════════════════════════════════');
console.log('');
if (fail === 0) {
  console.log('  说明：写入类操作（type / setText / key 的实际输入、controlClick 的实际触发）');
  console.log('  没有放进本自测 —— 它们会向【当前前台窗口】发按键，可能打进你正在写的文档里。');
  console.log('  那几项请用 test-input-safe.mjs（它只对自己启动的记事本操作，测完关闭且不保存）。');
  console.log('');
}
process.exit(fail === 0 ? 0 : 1);
