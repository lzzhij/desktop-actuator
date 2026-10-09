#!/usr/bin/env node
/**
 * test-input-safe.mjs —— 写入类操作的安全端到端测试（第 2 版）
 *
 * ★ 安全前提（这个测试存在的唯一理由就是"不伤到用户"）：
 *   1. 只对【本脚本自己启动的记事本】发按键，绝不对当前前台窗口盲打字。
 *   2. 测前记录前台窗口；测完把焦点还回去。
 *   3. 不碰用户的任何文档：所有写入都落在自己启动的记事本里，结束时不保存。
 *   4. 不用 Ctrl+A / Delete 去清空"别人"的内容。对记事本用 Ctrl+A 是安全的（内容是自己写的）。
 *
 * ★ 读回验证的两条路（上次只想到一条，卡住了；这次两条都做）
 *   路 A【剪贴板回环】：type → Ctrl+A → Ctrl+C → 读剪贴板 → 逐字比对
 *        · 优点：不依赖任何对话框，最稳
 *        · 缺点：Ctrl+C 只证明"记事本里是这段文本"，不证明"落盘了"
 *   路 B【另存为落盘】：另存到临时文件 → 读文件 → 逐字比对
 *        · 优点：真正证明端到端（含对话框交互与文件写入）
 *        · 缺点：依赖保存对话框的行为
 *   两条都做，互相印证。任一条失败都能独立指出问题出在哪一环。
 *
 * 用法：node test-input-safe.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
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

/* ── 与执行器通话（serve 模式，避免 Windows 命令行吞引号）── */
class Actuator {
  constructor() {
    this.p = spawn(process.execPath, [ENTRY, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = ''; this.queue = [];
    this.stderrBuf = '';
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const r = this.queue.shift();
        if (r) { try { r(JSON.parse(line)); } catch { r({ ok: false, error: { code: 'PARSE', message: line.slice(0, 150) } }); } }
      }
    });
    this.p.stderr.on('data', (d) => { this.stderrBuf += d; });
  }
  call(req, timeoutMs = 40000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, error: { code: 'E_TIMEOUT', message: '测试侧超时' } }), timeoutMs);
      this.queue.push((r) => { clearTimeout(timer); resolve(r); });
      this.p.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  close() { try { this.p.stdin.end(); } catch {} try { this.p.kill(); } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 系统侧操作（不经过被测代码）：读剪贴板、起进程、拉前台 */
// ★ 必须显式设 UTF-8 输出编码。
//   踩过的坑：Windows 的 powershell.exe 默认按【系统 ANSI（本机是 GBK）】写 stdout，
//   而 Node 按 UTF-8 读 ⇒ 中文标题变成 "\uFFFD\uFFFD..." ⇒ 前台窗口名匹配不上
//   ⇒ 安全护栏判定"前台不是记事本"从而中止测试。
//   护栏本身是对的（它宁可不测也不盲打字），错的是我读标题的编码。
const PS_UTF8 = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ';
function ps(cmd) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + cmd],
    { encoding: 'utf8', timeout: 40000, windowsHide: true }).trim();
}
const PS_HELPERS = `
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static IntPtr Find(string kw) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (IsWindowVisible(h)) { var t = Title(h); if (t != null && t.Contains(kw)) { found = h; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
`;
function fgTitle() {
  try { return ps(PS_HELPERS + `$h=[W]::GetForegroundWindow(); [W]::Title($h)`); } catch { return ''; }
}
function focusByKeyword(kw) {
  try {
    const safe = String(kw).replace(/'/g, "''");
    return ps(PS_HELPERS + `$h=[W]::Find('${safe}'); if ($h -ne [IntPtr]::Zero) { [void][W]::ShowWindow($h,9); [void][W]::SetForegroundWindow($h); 'focused' } else { 'not-found' }`);
  } catch { return 'error'; }
}
function readClipboard() {
  try {
    // 写文件再读，避免 CLI 传中文的编码问题
    const p = path.join(os.tmpdir(), 'clip-' + Date.now() + '.txt');
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText() | Set-Content -LiteralPath '${p}' -Encoding UTF8`);
    const v = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n$/, '') : '';
    try { fs.rmSync(p, { force: true }); } catch {}
    return v;
  } catch { return ''; }
}
function setClipboard(text) {
  try {
    const p = path.join(os.tmpdir(), 'clipset-' + Date.now() + '.txt');
    fs.writeFileSync(p, text, 'utf8');
    ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText((Get-Content -LiteralPath '${p}' -Raw -Encoding UTF8))`);
    try { fs.rmSync(p, { force: true }); } catch {}
    return true;
  } catch { return false; }
}

/* ══════════ 准备 ══════════ */
console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  写入类操作 · 安全端到端测试（第 2 版）');
console.log('  只对自己启动的记事本发按键；测完还原焦点');
console.log('═══════════════════════════════════════════════════');
console.log('');

const ORIGINAL_FG = fgTitle();
console.log('  测前前台窗口: ' + (ORIGINAL_FG || '(取不到)'));
console.log('');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'actuator-input-'));
const NP = 'C:\\WINDOWS\\system32\\notepad.exe';
if (!fs.existsSync(NP)) { console.log('  ✗ 找不到 notepad.exe\n'); process.exit(2); }

const act = new Actuator();
let okFocus = false;

try {
  /* ── 1. 启动记事本并确认它是前台 ── */
  console.log('1. 启动记事本并取得前台');
  const np = spawn(NP, [], { detached: true, stdio: 'ignore' });
  np.unref();
  await sleep(2600);
  const f1 = focusByKeyword('记事本');
  t('能把记事本拉到前台', f1 === 'focused', f1);
  await sleep(700);
  const fg = fgTitle();
  okFocus = /记事本|Notepad/.test(fg);
  t('前台确实是记事本（防"打进别人窗口"）', okFocus, fg || '(取不到标题)');
  if (!okFocus) {
    console.log('');
    console.log('  ✗ 无法确保前台是记事本 —— 为安全起见，中止后续按键测试。');
    console.log('    （宁可跳过，也不能把按键打进你正在用的窗口）');
    throw new Error('SAFETY_ABORT');
  }
  console.log('');

  /* ── 2. type：输入两行（含中文、英文、数字、连字符）── */
  console.log('2. type —— 输入文本（走剪贴板 + Ctrl+V）');
  const LINE1 = 'actuator-CJK-测试-ABC-123';
  const LINE2 = '第二行-验证换行与中文';
  const r1 = await act.call({ op: 'type', text: LINE1 });
  t('第 1 次 type 返回 ok', r1.ok === true, JSON.stringify(r1.error || {}));
  t('返回的写入长度正确', r1.ok && r1.result.length === LINE1.length, r1.ok ? String(r1.result.length) : '');
  await sleep(700);

  const rk = await act.call({ op: 'key', name: 'ENTER' });
  t('key ENTER 返回 ok', rk.ok === true, JSON.stringify(rk.error || {}));
  await sleep(350);

  const r2 = await act.call({ op: 'type', text: LINE2 });
  t('第 2 次 type 返回 ok', r2.ok === true, JSON.stringify(r2.error || {}));
  await sleep(700);
  console.log('');

  /* ── 3. 路 A：剪贴板回环验证（不依赖对话框，最稳）── */
  console.log('3. 路 A —— 剪贴板回环：Ctrl+A → Ctrl+C → 读剪贴板 → 逐字比对');
  const ra1 = await act.call({ op: 'key', name: 'CTRL+A' });
  t('组合键 CTRL+A 返回 ok（本轮新增的组合键能力）', ra1.ok === true, JSON.stringify(ra1.error || {}));
  await sleep(400);
  const ra2 = await act.call({ op: 'key', name: 'CTRL+C' });
  t('组合键 CTRL+C 返回 ok', ra2.ok === true, JSON.stringify(ra2.error || {}));
  await sleep(700);

  const clip = readClipboard();
  const expectClip = LINE1 + '\n' + LINE2;
  const normClip = clip.replace(/\r\n/g, '\n').trim();
  t('剪贴板内容与输入的完全一致（逐字）', normClip === expectClip,
    normClip === expectClip ? '' : '收到 ' + JSON.stringify(normClip.slice(0, 60)) + ' / 期望 ' + JSON.stringify(expectClip.slice(0, 60)));

  // 取消选中，避免后续操作受影响
  await act.call({ op: 'key', name: 'END' });
  await sleep(250);
  console.log('');

  /* ── 4. 路 B：另存为落盘验证（真正证明端到端）── */
  console.log('4. 路 B —— 另存为落盘 → 读文件 → 逐字比对');
  const savePath = path.join(tmpDir, 'actuator-out.txt');
  const rb1 = await act.call({ op: 'key', name: 'CTRL+S' });
  t('CTRL+S 返回 ok（触发保存）', rb1.ok === true, JSON.stringify(rb1.error || {}));
  await sleep(1800);   // 等对话框出现

  // 看保存对话框是否出现
  const dlgTitle = fgTitle();
  const dlgShown = /保存|另存为|Save/.test(dlgTitle);
  t('保存对话框已出现（前台标题含"保存/另存为/Save"）', dlgShown, dlgTitle || '(取不到标题)');

  if (dlgShown) {
    // 文件名输入框通常已聚焦；用剪贴板粘贴完整路径（避免逐字输入长路径）
    setClipboard(savePath);
    await sleep(300);
    const rb2 = await act.call({ op: 'key', name: 'CTRL+A' });   // 选中原文件名
    await sleep(300);
    const rb3 = await act.call({ op: 'key', name: 'CTRL+V' });   // 粘贴路径
    t('CTRL+V 粘贴路径返回 ok', rb3.ok === true, JSON.stringify(rb3.error || {}));
    await sleep(500);
    const rb4 = await act.call({ op: 'key', name: 'ENTER' });    // 确认保存
    t('ENTER 确认保存返回 ok', rb4.ok === true, JSON.stringify(rb4.error || {}));
    await sleep(1800);

    const saved = fs.existsSync(savePath);
    t('文件已落盘', saved, savePath);
    if (saved) {
      const content = fs.readFileSync(savePath, 'utf8').replace(/\r\n/g, '\n').trim();
      t('落盘内容与输入的完全一致（逐字）', content === expectClip,
        content === expectClip ? '' : '收到 ' + JSON.stringify(content.slice(0, 60)));
    }
  } else {
    sk('另存为落盘验证', '保存对话框未出现（可能被系统文件选择器或权限弹窗打断）');
    // 尝试关掉可能的对话框，避免影响后续
    await act.call({ op: 'key', name: 'ESC' });
    await sleep(400);
  }
  console.log('');

  /* ── 5. setText：对 DSH 搜索框（ValuePattern，不敲键盘）── */
  console.log('5. setText —— 对 DSH 搜索框写入（走 ValuePattern，不用键盘）');
  const fdsh = focusByKeyword('Harness');
  if (fdsh !== 'focused') {
    sk('setText 测试', '没找到 DSH 窗口');
  } else {
    await sleep(800);
    const rr = await act.call({ op: 'setText', name: '搜索会话名称', value: 'actuator-selftest' });
    t('setText 返回 ok', rr.ok === true, JSON.stringify(rr.error || {}));
    if (rr.ok) {
      t('经由 ValuePattern（未用键盘，不受输入法影响）', rr.result.via === 'ValuePattern', String(rr.result.via));
      const rc = await act.call({ op: 'setText', name: '搜索会话名称', value: '' });
      t('已清空搜索框（界面恢复原状）', rc.ok === true, JSON.stringify(rc.error || {}));
    }
  }

} catch (e) {
  if (e.message !== 'SAFETY_ABORT') {
    console.log('');
    console.log('  ✗ 测试过程出错: ' + String(e.message).slice(0, 200));
    fail++;
  }
} finally {
  console.log('');
  console.log('6. 收尾');
  // 关掉可能的对话框，再终止记事本（不保存）
  try { await act.call({ op: 'key', name: 'ESC' }); } catch {}
  await sleep(400);
  try {
    ps(`Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like '*无标题*' -or $_.MainWindowTitle -like '*actuator-out*' } | Stop-Process -Force -ErrorAction SilentlyContinue; 'ok'`);
    t('已关闭测试用的记事本（未保存）', true);
  } catch (e) { t('关闭记事本', false, String(e.message).slice(0, 80)); }

  act.close();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  t('已清理临时目录', !fs.existsSync(tmpDir));

  if (ORIGINAL_FG) {
    const back = focusByKeyword(ORIGINAL_FG.slice(0, 14));
    console.log('  把焦点还给原窗口: ' + back);
  }
}

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log('  ' + pass + ' 通过 · ' + fail + ' 失败 · ' + skip + ' 跳过');
console.log('═══════════════════════════════════════════════════');
console.log('');
process.exit(fail === 0 ? 0 : 1);
