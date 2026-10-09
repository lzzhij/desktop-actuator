#!/usr/bin/env node
/**
 * desktop-actuator.mjs —— Windows 桌面自动化执行器（给 AI Agent 调用）
 *
 * 设计依据（来自一次付费市场调研，结论有三条）：
 *   1. 不做「宏录制器 GUI」——那个位置被免费品（AutoHotkey、Pulover's）打穿了。
 *      要做「给 AI Agent 调用的确定性执行器」：JSON in → 动作 → JSON out。
 *   2. 付费方是 QA/测试团队与小团队 IT 运维，不是个人。
 *   3. 形态排序：库/CLI 优先 → MCP/工具插件次之 → GUI 最后。
 *
 * 与其他产品的差异（这四条是真的，不是包装）：
 *   · 零依赖：不需要安装器、不需要运行时，一个文件
 *   · 可审计：全部逻辑可见，企业可以锁版本
 *   · 可被 Agent 调用：统一的 JSON 契约 + 结构化错误码（现有产品全是给人用的 GUI）
 *   · **DPI 正确**：我实测踩过这个坑 —— 见 DOWNSTREAM 说明
 *
 * ★ DPI 这件事值得单独说明（我踩过，也是本工具与常见脚本的真实差别）：
 *   同一个窗口，PowerShell 的 SystemInformation 报 1707x1067，
 *   而 Windows UI Automation 报 2560x1600 —— 系统 DPI 是 144（150% 缩放）。
 *   进程若不声明 DPI 感知，SetCursorPos 收到的是逻辑坐标而屏幕是物理像素，
 *   于是"按读到的坐标去点"会偏 1.5 倍，表现为「点了没反应」。
 *   本工具在启动时就声明 per-monitor DPI 感知，并把它写进 describe 的输出里。
 *
 * 用法：
 *   node desktop-actuator.mjs describe                  # 输出能力清单（Agent 用来自我介绍）
 *   node desktop-actuator.mjs call --json '<请求>'        # 单次调用
 *   echo '<请求>' | node desktop-actuator.mjs serve       # 从 stdin 逐行读 JSON 请求
 *
 * 请求格式：
 *   { "op": "click", "x": 100, "y": 200, "button": "left" }
 *   { "op": "controlClick", "name": "新建会话", "window": "Harness" }
 *
 * 响应格式（永远是这个形状，成功失败都一样）：
 *   { "ok": true,  "op": "click", "elapsedMs": 12, "result": { ... } }
 *   { "ok": false, "op": "click", "elapsedMs": 3,  "error": { "code": "ELEMENT_NOT_FOUND", "message": "..." } }
 */
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PS1 = path.join(HERE, 'desktop-actuator.ps1');
const IS_WIN = process.platform === 'win32';

/* ─────────────── 错误码（Agent 靠它做分支，不靠解析文案）─────────────── */
const E = {
  BAD_REQUEST: 'E_BAD_REQUEST',           // 请求本身不合法
  UNSUPPORTED: 'E_UNSUPPORTED',           // 本平台不支持该操作
  PS_FAILED: 'E_PS_FAILED',               // 底层 PowerShell 调用失败
  ELEMENT_NOT_FOUND: 'E_ELEMENT_NOT_FOUND', // 按名字找不到控件
  TIMEOUT: 'E_TIMEOUT',
  INTERNAL: 'E_INTERNAL',
};

/* ─────────────── 能力清单 ─────────────── */
const OPS = {
  where:       { params: {}, doc: '屏幕尺寸、鼠标位置、DPI 与前台窗口' },
  windows:     { params: {}, doc: '枚举可见窗口（标题 + 位置）' },
  capture:     { params: { path: 'string', region: 'x,y,w,h（可选）' }, doc: '截屏到 PNG，返回路径与尺寸' },
  move:        { params: { x: 'int', y: 'int' }, doc: '移动鼠标（物理像素）' },
  click:       { params: { x: 'int', y: 'int', button: 'left|right|double（默认 left）' }, doc: '按坐标点击' },
  key:         { params: { name: 'string' }, doc: '按键。单键如 ENTER/TAB/ESC/F5；组合键写成 CTRL+S（修饰键在前、用加号连接；支持 CTRL/SHIFT/ALT/WIN）' },
  type:        { params: { text: 'string' }, doc: '输入文本（走剪贴板，支持中文）' },
  dump:        { params: { window: 'string', limit: 'int（可选）' }, doc: '列出窗口内所有可访问控件（名字/类型/坐标/可用动作）' },
  find:        { params: { name: 'string', window: 'string（可选）' }, doc: '按名字找控件' },
  controlClick:{ params: { name: 'string', window: 'string（可选）' }, doc: '按名字触发控件（优先 InvokePattern，不点坐标）' },
  setText:     { params: { name: 'string', value: 'string', window: 'string（可选）' }, doc: '按名字把文字写入输入框（ValuePattern）' },
};

/* ─────────────── 调底层 ps1 ─────────────── */
function runPs(args, timeoutMs = 30000) {
  if (!IS_WIN) {
    const err = new Error('本执行器只支持 Windows（依赖 user32/UIAutomation）');
    err.code = E.UNSUPPORTED;
    throw err;
  }
  if (!fs.existsSync(PS1)) {
    const err = new Error('缺少底层脚本: ' + PS1);
    err.code = E.INTERNAL;
    throw err;
  }
  // ★ 用 spawnSync 而不是 execFileSync。
  //   原因（我实测踩到的）：底层脚本失败时是「打印一行 JSON 再 exit 1」。
  //   execFileSync 遇到非 0 退出会抛异常，而异常上的 stdout 未必可靠 ——
  //   于是那段【精心写的结构化错误】被丢掉，调用方只看到一句 "Command failed: powershell ..."，
  //   完全无法诊断（我因此误判成"工具没给可诊断信息"）。
  //   spawnSync 不抛异常，status/stdout/stderr 都明明白白，正是"失败也带结构化信息"需要的。
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const out = (r.stdout || '').toString();
  if (r.error) {
    const err = new Error('无法启动 PowerShell: ' + r.error.message);
    err.code = E.INTERNAL;
    throw err;
  }
  if (r.status === 0) return out;
  // 非 0 退出：把底层那行 JSON 里的 message 提出来当异常信息（这才有诊断价值）
  const j = lastJson(out);
  const err = new Error((j && j.message) ? j.message : ((r.stderr || '').toString().trim().slice(0, 500) || 'PowerShell 调用失败'));
  err.code = (j && j.code) ? j.code : (r.signal ? E.TIMEOUT : E.PS_FAILED);
  err.stdout = out;
  err.exitCode = r.status;
  throw err;
}

/** 底层脚本按约定：最后一行是一行 JSON（前面是给人看的日志） */
function lastJson(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      try { return JSON.parse(s); } catch { /* 继续往上找 */ }
    }
  }
  return null;
}

function runPsJson(args, timeoutMs) {
  const out = runPs(args, timeoutMs);
  const j = lastJson(out);
  if (!j) {
    const err = new Error('底层脚本没有返回 JSON: ' + out.slice(-200));
    err.code = E.PS_FAILED;
    throw err;
  }
  return j;
}

/**
 * ★ 不抛异常的调用：返回 { exitCode, stdout, stderr }
 *
 * 为什么需要它（这是一次真实 bug 的产物）：
 *   底层脚本在失败时是「打印一行 {"ok":false,...} 然后 exit 1」。
 *   execFileSync 在非 0 退出时会抛异常，如果只用 try/catch 包起来，
 *   很容易把「失败」当成「成功」——我最初就是这么写的，
 *   于是 controlClick 找不到控件时返回了 ok:true。
 *   所以对"失败也带结构化信息"的调用，必须能同时拿到退出码与 stdout。
 */
function runPsRaw(args, timeoutMs = 30000) {
  const { execFileSync: efs } = { execFileSync };
  try {
    const stdout = efs('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e) {
    const stdout = (e.stdout || '').toString();
    const stderr = (e.stderr || '').toString();
    // 被 kill（超时）时也归到非 0，但要能区分
    return { exitCode: e.killed ? 124 : (typeof e.status === 'number' ? e.status : 1), stdout, stderr, killed: !!e.killed };
  }
}

/* ─────────────── 每个 op 的实现 ─────────────── */
const handlers = {
  where: async () => runPsJson(['where']),
  windows: async () => runPsJson(['windows']),

  capture: async (req) => {
    const p = req.path || path.join(os.tmpdir(), 'actuator-' + Date.now() + '.png');
    // ★ 传参名必须与 ps1 的 param 块【逐字一致】。
    //   底层曾因参数名大小写不敏感而把 -Text 错配成 -X，
    //   导致 click 静默地去点了 (0,0) 还返回 ok:true。
    //   现在底层参数都改成了长且唯一的名字，这里必须跟上。
    const args = ['capture', p];
    if (req.region) args.push('-RegionBox', String(req.region));
    runPs(args, 60000);
    if (!fs.existsSync(p)) {
      const err = new Error('截屏未生成文件: ' + p); err.code = E.PS_FAILED; throw err;
    }
    const st = fs.statSync(p);
    return { path: p, bytes: st.size };
  },

  move: async (req) => {
    need(req, ['x', 'y']);
    runPs(['move', '-CursorX', String(int(req.x)), '-CursorY', String(int(req.y))]);
    return { x: int(req.x), y: int(req.y) };
  },

  click: async (req) => {
    need(req, ['x', 'y']);
    const button = String(req.button || 'left').toLowerCase();
    const args = button === 'double'
      ? ['dclick', '-CursorX', String(int(req.x)), '-CursorY', String(int(req.y))]
      : ['click', '-CursorX', String(int(req.x)), '-CursorY', String(int(req.y))];
    runPs(args);
    return { x: int(req.x), y: int(req.y), button };
  },

  key: async (req) => {
    needText(req, ['name']);
    // 底层会校验键名，非法键名返回非 0 退出码 + 一行 JSON
    const out = runPsRaw(['key', '-KeyName', String(req.name)]);
    if (out.exitCode !== 0) {
      const j = lastJson(out.stdout);
      const err = new Error(j && j.message ? j.message : '按键失败');
      err.code = (j && j.code) || E.PS_FAILED;
      throw err;
    }
    return { name: req.name };
  },

  type: async (req) => {
    need(req, ['text']);
    runPs(['type', '-TypeText', String(req.text)], 60000);
    return { length: String(req.text).length };
  },

  dump: async (req) => {
    need(req, ['window']);
    const args = ['dump', '-WindowKeyword', String(req.window), '-Limit', String(int(req.limit || 80))];
    const out = runPs(args, 60000);
    // 底层把元素一行一行打印出来，这里解析成数组 —— 让 Agent 拿结构化结果而不是文本
    const elements = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /#(\d+)\s+\[([^\]]+)\]\s+'([^']*)'\s+@(-?\d+),(-?\d+)\s+(\d+)x(\d+)\s+\{([^}]*)\}/.exec(line);
      if (m) {
        elements.push({
          index: Number(m[1]), type: m[2], name: m[3],
          x: Number(m[4]), y: Number(m[5]), width: Number(m[6]), height: Number(m[7]),
          actions: m[8] ? m[8].split(',').map((s) => s.trim()).filter(Boolean) : [],
        });
      }
    }
    return { count: elements.length, elements, raw: elements.length ? undefined : out.slice(-800) };
  },

  find: async (req) => {
    // ★ window 必填：底层不给窗口时会搜遍所有顶层窗口，导致跨程序误匹配（我实测过）。
    needText(req, ['name', 'window']);
    const args = ['find', '-NameKeyword', String(req.name), '-WindowKeyword', String(req.window)];
    const out = runPs(args, 45000);
    const hits = [];
    const re = /★ \[([^\]]+)\] '([^']*)'\s*\n\s*中心坐标\(物理\): (\d+),(\d+)\s+可用动作: ([^\n]*)/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      hits.push({ type: m[1], name: m[2], x: Number(m[3]), y: Number(m[4]), actions: m[5].split(',').map((s) => s.trim()).filter(Boolean) });
    }
    if (!hits.length) {
      const err = new Error('没找到名字含「' + req.name + '」的控件');
      err.code = E.ELEMENT_NOT_FOUND; throw err;
    }
    return { count: hits.length, hits };
  },

  controlClick: async (req) => {
    // ★ window 必填，理由同上：不限定窗口会点错别的程序里的同名控件。
    needText(req, ['name', 'window']);
    const args = ['clicontrol', '-NameKeyword', String(req.name), '-WindowKeyword', String(req.window)];
    const out = runPsRaw(args, 45000);
    const j = lastJson(out.stdout);
    // ★ 关键：底层在"找不到控件"时会返回 ok:false 且退出码非 0。
    //   必须把它变成 ELEMENT_NOT_FOUND，绝不能当成成功。
    if (out.exitCode !== 0 || (j && j.ok === false)) {
      const err = new Error((j && j.message) ? j.message : '触发控件失败');
      err.code = (j && j.code) || E.ELEMENT_NOT_FOUND;
      throw err;
    }
    const viaInvoke = j && j.via === 'InvokePattern';
    return {
      matched: (j && j.name) || null,
      usedCoordinateFallback: !viaInvoke,   // Agent 可据此判断可靠性
      via: j ? j.via : undefined,
    };
  },

  setText: async (req) => {
    // name 必须非空（空关键词会匹配到一切）；value 允许为空串 —— 那是"清空输入框"
    // name 与 window 都必须非空（空关键词会匹配到一切；不给窗口会跨程序误匹配）
    needText(req, ['name', 'window']);
    need(req, ['value']);   // value 允许为空串（清空输入框）
    const args = ['settext', '-NameKeyword', String(req.name), '-FillValue', String(req.value), '-WindowKeyword', String(req.window)];
    const out = runPsRaw(args, 45000);
    const j = lastJson(out.stdout);
    if (out.exitCode !== 0 || (j && j.ok === false)) {
      const err = new Error((j && j.message) ? j.message : '写入失败');
      err.code = (j && j.code) || E.UNSUPPORTED;
      throw err;
    }
    return { length: String(req.value).length, via: j ? j.via : undefined };
  },
};

/* ─────────────── 小工具 ─────────────── */
function int(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) { const e = new Error('不是数字: ' + JSON.stringify(v)); e.code = E.BAD_REQUEST; throw e; }
  return Math.round(n);
}
function need(req, keys) {
  // ★ 只把 null/undefined 当作"缺失"。
  //   踩过的坑：我原来把空字符串也当成缺失，于是 setText 无法把输入框清空
  //   （value:"" 报 E_BAD_REQUEST 缺少参数 value）—— 而"清空输入框"是完全合法的需求。
  //   凡是"空值有意义"的参数（文本框内容、搜索词），都不该在这里被拦。
  const miss = keys.filter((k) => req[k] === undefined || req[k] === null);
  if (miss.length) { const e = new Error('缺少参数: ' + miss.join(', ')); e.code = E.BAD_REQUEST; throw e; }
}

/**
 * 要求参数是【非空字符串】—— 用于"必须给个关键词"的场合。
 * 为什么单独一个函数：按控件名查找时，空关键词会匹配到一切（危险的通配），
 * 所以那些场合必须拒绝空串；而 setText 的 value 允许为空。
 */
function needText(req, keys) {
  need(req, keys);
  const empty = keys.filter((k) => String(req[k]).trim() === '');
  if (empty.length) { const e = new Error('参数不能为空: ' + empty.join(', ')); e.code = E.BAD_REQUEST; throw e; }
}

/* ─────────────── 请求分发 ─────────────── */
async function dispatch(req) {
  const started = Date.now();
  const op = String(req && req.op || '');
  if (!op) return { ok: false, op: null, elapsedMs: 0, error: { code: E.BAD_REQUEST, message: '缺少 op 字段' } };
  const h = handlers[op];
  if (!h) {
    return { ok: false, op, elapsedMs: Date.now() - started,
      error: { code: E.BAD_REQUEST, message: '未知 op: ' + op, available: Object.keys(handlers) } };
  }
  try {
    const result = await h(req);
    return { ok: true, op, elapsedMs: Date.now() - started, result };
  } catch (e) {
    return { ok: false, op, elapsedMs: Date.now() - started,
      error: { code: e.code || E.INTERNAL, message: String(e.message || e).slice(0, 400) } };
  }
}

/* ─────────────── CLI ─────────────── */
const argv = process.argv.slice(2);
const cmd = argv[0] || 'describe';

if (cmd === 'describe') {
  const info = {
    name: 'desktop-actuator',
    version: '0.1.0',
    platform: process.platform,
    supported: IS_WIN,
    contract: {
      request: '{ "op": "<name>", ...params }',
      response: '{ "ok": boolean, "op": string, "elapsedMs": number, "result"?: object, "error"?: { "code": string, "message": string } }',
    },
    errorCodes: E,
    ops: OPS,
    notes: [
      '坐标一律使用【物理像素】。本工具启动时声明 per-monitor DPI 感知，与 Windows UI Automation 的坐标系一致。',
      'controlClick 优先用 UIAutomation 的 InvokePattern（不点坐标）；若返回 usedCoordinateFallback=true 说明走了坐标回退，可靠性较低。',
      'type 走剪贴板实现，会临时占用剪贴板（结束后尽力恢复）。',
      '只作用于当前前台桌面；执行期间请不要同时手动操作电脑。',
      'setText 的 value 允许为空串（用于清空输入框）；而 name/window 这类关键词不允许为空 —— 空关键词会匹配到一切。',
      '组合键写法：CTRL+S / CTRL+SHIFT+S / ALT+F4。释放时是逆序的（主键先松、修饰键后松），否则系统会把组合键识别成单键。',
    ],
  };
  console.log(JSON.stringify(info, null, 2));
  process.exit(0);
}

if (cmd === 'call') {
  const i = argv.indexOf('--json');
  const raw = i >= 0 ? argv[i + 1] : null;
  if (!raw) { console.error('用法: node desktop-actuator.mjs call --json \'{"op":"where"}\''); process.exit(2); }
  let req;
  try { req = JSON.parse(raw); }
  catch (e) { console.log(JSON.stringify({ ok: false, op: null, elapsedMs: 0, error: { code: E.BAD_REQUEST, message: 'JSON 解析失败: ' + e.message } })); process.exit(1); }
  const res = await dispatch(req);
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

if (cmd === 'serve') {
  // 逐行读 JSON 请求 —— 便于被别的进程（含 Agent）当常驻执行器调用
  const rl = (await import('node:readline')).createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    let req;
    try { req = JSON.parse(s); }
    catch (e) { console.log(JSON.stringify({ ok: false, op: null, elapsedMs: 0, error: { code: E.BAD_REQUEST, message: 'JSON 解析失败' } })); continue; }
    const res = await dispatch(req);
    console.log(JSON.stringify(res));
  }
  process.exit(0);
}

console.error('未知命令: ' + cmd + '（可用：describe / call / serve）');
process.exit(2);
