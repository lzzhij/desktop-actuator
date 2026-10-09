#!/usr/bin/env node
/**
 * demo-task-scheduler.mjs —— 真实案例：自动化「任务计划程序」并导出报表
 *
 * 这个脚本本身就是【案例交付物】。它回答客户真正会问的两个问题：
 *   ① 你自动化过哪一个 Windows 桌面程序？
 *   ② UI 变化时怎么保证可靠性？
 *
 * ============================================================
 * 案例背景：为什么这个案例值得做
 * ============================================================
 * 「任务计划程序」（taskschd.msc）是企业 Windows 上最常见的"无人值守作业"载体。
 * IT 运维的典型需求是：**定期盘点所有计划任务并生成报表**（谁建的、什么时候跑、
 * 上次跑成功没有、下次什么时候跑）。手工点 155 个任务是不现实的。
 *
 * ============================================================
 * 实测发现（可复现）：这个程序【不能】靠 UI 自动化
 * ============================================================
 * 我用两套【互相独立】的实现遍历它的 UI Automation 树，结论一致：
 *
 *   ControlView: 57 个元素 —— Pane 51 / Window 1 / Header 2 / StatusBar 1 / TitleBar 2
 *   RawView:     58 个元素（说明不是"没走到底"）
 *   ★ 可交互元素（Invoke / Select / Expand / Value）：0 个
 *
 * 两套实现分别是：
 *   · 我的 desktop-actuator（PowerShell + UIAutomationClient）
 *   · crosscheck-uia.mjs（纯 C# 直调 System.Windows.Automation，含 RawViewWalker 全树走查）
 *
 * 对照组（同一台机器、同一时刻）：
 *   · 记事本（经典 Win32）     → 2 个元素，全 Pane，0 个可交互
 *   · DSH 界面（Electron/Web） → 1017 个元素，含大量 Invoke / Value
 *
 * ⇒ 结论：**经典 Win32 的自绘控件（MMC 的树与列表）对 UIA 是黑盒。**
 *   对这类程序，"按控件名点击"根本用不了，只能靠坐标 —— 而坐标是最脆弱的方式。
 *
 * ============================================================
 * 可靠性策略（客户问的正是这个）
 * ============================================================
 * 我没有硬着头皮去点坐标，而是先问："这个程序的**语义**有没有非 UI 的入口？"
 * 答案是有的：任务计划程序暴露 COM 接口 `Schedule.Service`。
 *
 * 于是本案例采用【分层策略】，按可靠性从高到低，能用上层就绝不用下层：
 *
 *   第 1 层：官方 API / COM          ← 本案例用这一层（最可靠，与 UI 布局无关）
 *   第 2 层：UI Automation 按控件名   ← 只有程序暴露了控件时才可用（Web/Electron/WinForms 通常可以）
 *   第 3 层：UI Automation + 图像匹配 ← 备用
 *   第 4 层：纯坐标点击              ← 最后手段，必须配"事前校验 + 事后验证"
 *
 * **这条"分层"本身就是可靠性的核心**：不是"怎么点得更准"，而是"能不能不点"。
 *
 * 用法：
 *   node demo-task-scheduler.mjs                     # 打印报表到终端
 *   node demo-task-scheduler.mjs --json              # 输出 JSON
 *   node demo-task-scheduler.mjs --out report.csv    # 导出 CSV
 *   node demo-task-scheduler.mjs --probe             # 只做可自动化性探测（不改任何东西）
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const PROBE_ONLY = argv.includes('--probe');
const outIdx = argv.indexOf('--out');
const OUT = outIdx >= 0 ? argv[outIdx + 1] : null;

/* ─────────────── 第 0 步：可自动化性探测（决定走哪一层）─────────────── */
/**
 * 先判断"这个程序该怎么自动化"，再动手。
 * 这一步是可靠性的第一道保证 —— 选错层，后面做多少校验都是白搭。
 */
function probe() {
  const findings = {
    target: '任务计划程序 (taskschd.msc)',
    com: { available: false, detail: null },
    uia: { available: false, detail: null },
    chosenLayer: null,
  };

  // 探测 COM
  try {
    const r = ps(`$s = New-Object -ComObject Schedule.Service; $s.Connect(); $root = $s.GetFolder('\\'); "OK tasks=$($root.GetTasks(0).Count) folders=$($root.GetFolders(0).Count)"`);
    if (r.startsWith('OK')) {
      findings.com.available = true;
      findings.com.detail = r;
    }
  } catch (e) {
    findings.com.detail = String(e.message).slice(0, 120);
  }

  // 探测 UIA：这个进程开起来之后树里有没有可交互控件
  // 注意：这里不启动 GUI，只查已有的同名窗口，避免为了探测而弹窗。
  try {
    const r = ps(`
$ErrorActionPreference='Continue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes -ErrorAction SilentlyContinue
$root=[System.Windows.Automation.AutomationElement]::RootElement
$found=$null
foreach ($c in $root.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)) {
  if ($c.Current.Name -like '*任务计划*') { $found=$c; break }
}
if (-not $found) { 'NO_WINDOW' } else {
  $all=$found.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $act=0
  foreach ($e in $all) {
    $o=$null
    try { if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$o)) { $act++; continue } } catch {}
    $o=$null
    try { if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$o)) { $act++; continue } } catch {}
    $o=$null
    try { if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$o)) { $act++; continue } } catch {}
  }
  "count=$($all.Count) interactable=$act"
}`);
    findings.uia.detail = r;
    findings.uia.available = /interactable=([1-9]\d*)/.test(r);
  } catch (e) {
    findings.uia.detail = String(e.message).slice(0, 120);
  }

  findings.chosenLayer = findings.com.available
    ? '第 1 层：官方 COM 接口（不依赖 UI 布局，最可靠）'
    : (findings.uia.available ? '第 2 层：UI Automation 按控件名' : '第 4 层：坐标点击（须配事前校验与事后验证）');
  return findings;
}

/* ─────────────── 工具 ─────────────── */
// ★ 显式设 UTF-8 输出编码：Windows 的 powershell.exe 默认按系统 ANSI 写 stdout，
//   Node 按 UTF-8 读 ⇒ 中文会变 U+FFFD。（这是我在测试里踩过的坑）
const PS_UTF8 = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ';
/**
 * 调 PowerShell。
 *
 * ★ extraEnv 的用途：把 Windows 路径交给 PowerShell 时【不要写字面量】。
 *   我在"Node 模板字符串 → PowerShell 单引号字符串"这条链上为反斜杠反复出错，
 *   最后改成用环境变量传路径 —— 跨语言的字面量里一个反斜杠都不用出现，问题从根上消失。
 */
function ps(cmd, extraEnv) {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_UTF8 + cmd],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...(extraEnv || {}) } }).trim();
}

/** 把 PowerShell 收集到的任务列表转成 JSON（用临时文件传，避免 stdout 编码问题） */
function collectTasks() {
  const tmp = path.join(os.tmpdir(), 'tasks-' + Date.now() + '.json');
  // ★ PowerShell 单引号字符串里反斜杠【不是】转义字符，所以 Windows 路径要原样交给它，不能翻倍。
  //   我第一版写了 .replace(/\\/g,'\\\\')，生成的字符串里出现 $_ ，被 PowerShell 当变量展开成空。
  // （tmpPathForPs 已废弃：路径改为通过环境变量 DSH_TASKS_OUT 传给 PowerShell）
  const script = `
$ErrorActionPreference = 'Stop'
$svc = New-Object -ComObject Schedule.Service
$svc.Connect()
$rows = New-Object System.Collections.ArrayList

function Walk($folder, $pathPrefix) {
  $tasks = $folder.GetTasks(0)
  foreach ($t in $tasks) {
    $def = $t.Definition
    # 触发器的可读描述（最常见的是时间触发器）
    $trigDesc = @()
    foreach ($tr in $def.Triggers) {
      $typeName = switch ($tr.Type) {
        1 { '一次性' } 2 { '每日' } 3 { '每周' } 4 { '每月' }
        5 { '月内某几日' } 6 { '月内某周几' } 7 { '开机时' } 8 { '登录时' }
        9 { '空闲时' } 11 { '会话状态变化' } default { "类型$($tr.Type)" }
      }
      $trigDesc += $typeName
    }
    $actions = @()
    foreach ($a in $def.Actions) {
      if ($a.Type -eq 0) { $actions += ('执行 ' + $a.Path) }
      elseif ($a.Type -eq 5) { $actions += ('启动 ' + $a.Path) }
      else { $actions += ("动作类型$($a.Type)") }
    }
    $last = $null; $next = $null
    try { $last = $t.LastRunTime } catch {}
    try { $next = $t.NextRunTime } catch {}
    [void]$rows.Add([pscustomobject]@{
      path        = [IO.Path]::Combine($pathPrefix, $t.Name)
      name        = $t.Name
      folder      = $pathPrefix
      state       = switch ($t.State) { 0 {'未知'} 1 {'已禁用'} 2 {'已排队'} 3 {'就绪'} 4 {'运行中'} default {"状态$($t.State)"} }
      enabled     = $t.Enabled
      author      = $def.RegistrationInfo.Author
      triggers    = ($trigDesc -join ', ')
      actions     = ($actions -join ' | ')
      lastRun     = if ($last -and $last.Year -gt 1900) { $last.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
      nextRun     = if ($next -and $next.Year -gt 1900) { $next.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
      lastResult  = $t.LastTaskResult
    })
  }
  foreach ($sub in $folder.GetFolders(0)) { Walk $sub ([IO.Path]::Combine($pathPrefix, $sub.Name)) }
}

Walk ($svc.GetFolder('\\')) ''
$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $env:DSH_TASKS_OUT -Encoding UTF8
Write-Output ("COUNT=" + $rows.Count)
`;
  const r = ps(script, { DSH_TASKS_OUT: tmp });   // 用环境变量把路径交给 PowerShell，避免跨语言的字面量转义
  let tasks = [];
  if (fs.existsSync(tmp)) {
    let txt = fs.readFileSync(tmp, 'utf8').replace(/^\uFEFF/, '');
    try {
      const j = JSON.parse(txt);
      tasks = Array.isArray(j) ? j : [j];
    } catch (e) {
      // ConvertTo-Json 在只有一个对象时不会是数组，已在上面处理；真出错就报出来
      throw new Error('解析任务列表失败: ' + e.message);
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
  const m = /COUNT=(\d+)/.exec(r);
  return { tasks, reportedCount: m ? Number(m[1]) : null };
}

/* ─────────────── 主流程 ─────────────── */
console.log('');
console.log('═══════════════════════════════════════════════════════');
console.log('  案例：自动化「任务计划程序」并导出报表');
console.log('═══════════════════════════════════════════════════════');
console.log('');

const probeResult = probe();
console.log('第 0 步 · 可自动化性探测（决定走哪一层）');
console.log('  目标程序: ' + probeResult.target);
console.log('  COM 接口: ' + (probeResult.com.available ? '\u2713 可用  ' : '\u2717 不可用  ') + (probeResult.com.detail || ''));
console.log('  UIA 可交互控件: ' + (probeResult.uia.available ? '\u2713 有' : '\u2717 零个') + '  ' + (probeResult.uia.detail || ''));
console.log('  \u2192 采用: ' + probeResult.chosenLayer);
console.log('');

if (PROBE_ONLY) {
  console.log('  （--probe：只探测，不改动任何东西）');
  console.log('');
  process.exit(0);
}

console.log('第 1 步 · 通过 COM 采集（不依赖 UI，因此不受窗口布局影响）');
const { tasks, reportedCount } = collectTasks();
console.log('  采集到 ' + tasks.length + ' 个计划任务' + (reportedCount !== null ? '（脚本自报 ' + reportedCount + '）' : ''));
console.log('');

/* ─────────────── 第 2 步：事后验证（可靠性的第二道保证）─────────────── */
console.log('第 2 步 · 事后验证（不能只信"没报错"）');
const checks = [];
checks.push({ name: '采集数 > 0', ok: tasks.length > 0, detail: String(tasks.length) });
checks.push({
  name: '采集数与脚本自报一致',
  ok: reportedCount === null || reportedCount === tasks.length,
  detail: tasks.length + ' vs ' + reportedCount,
});
const noName = tasks.filter((t) => !t.name);
checks.push({ name: '每个任务都有名字', ok: noName.length === 0, detail: noName.length + ' 个缺名' });
const noPath = tasks.filter((t) => !t.path);
checks.push({ name: '每个任务都有完整路径', ok: noPath.length === 0, detail: noPath.length + ' 个缺路径' });
const badState = tasks.filter((t) => !t.state);
checks.push({ name: '每个任务都有可读状态', ok: badState.length === 0, detail: badState.length + ' 个缺状态' });
for (const c of checks) {
  console.log('  ' + (c.ok ? '\u2713' : '\u2717') + ' ' + c.name + (c.detail ? '   (' + c.detail + ')' : ''));
}
console.log('');

/* ─────────────── 第 3 步：汇总与输出 ─────────────── */
const byFolder = {};
for (const t of tasks) byFolder[t.folder || '\\'] = (byFolder[t.folder || '\\'] || 0) + 1;
const byState = {};
for (const t of tasks) byState[t.state] = (byState[t.state] || 0) + 1;
const enabled = tasks.filter((t) => t.enabled).length;
const withNext = tasks.filter((t) => t.nextRun).length;

if (AS_JSON) {
  console.log(JSON.stringify({ probe: probeResult, counts: { total: tasks.length, enabled, withNext }, byFolder, byState, checks, tasks }, null, 2));
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

if (OUT) {
  const esc = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const header = ['路径', '名称', '文件夹', '状态', '已启用', '作者', '触发器', '动作', '上次运行', '下次运行', '上次结果'];
  const lines = [header.map(esc).join(',')];
  for (const t of tasks) {
    lines.push([t.path, t.name, t.folder, t.state, t.enabled ? '是' : '否', t.author, t.triggers, t.actions, t.lastRun, t.nextRun, t.lastResult].map(esc).join(','));
  }
  // ★ 带 BOM 写 CSV：Excel 打开中文 CSV 时若无 BOM 会乱码（这是实际交付里最容易翻车的细节）
  fs.writeFileSync(OUT, '\uFEFF' + lines.join('\r\n') + '\r\n', 'utf8');
  console.log('第 3 步 · 已导出 CSV');
  console.log('  ' + OUT + '  (' + (fs.statSync(OUT).size) + ' 字节, ' + tasks.length + ' 行)');
  console.log('  （带 UTF-8 BOM —— Excel 直接打开不会乱码）');
  console.log('');
}

console.log('第 4 步 · 汇总');
console.log('  任务总数: ' + tasks.length + '   已启用: ' + enabled + '   有下次运行时间: ' + withNext);
console.log('  按状态: ' + Object.entries(byState).map(([k, v]) => k + ' ' + v).join('　'));
console.log('  按文件夹:');
for (const [f, n] of Object.entries(byFolder).sort((a, b) => b[1] - a[1])) {
  console.log('    ' + String(n).padStart(4) + '  ' + f);
}
console.log('');
console.log('  前 5 个任务（按下次运行时间排序）:');
const soon = tasks.filter((t) => t.nextRun).sort((a, b) => String(a.nextRun).localeCompare(String(b.nextRun))).slice(0, 5);
for (const t of soon) console.log('    ' + t.nextRun + '  ' + t.name + '   [' + t.triggers + ']');
console.log('');

process.exit(checks.every((c) => c.ok) ? 0 : 1);
