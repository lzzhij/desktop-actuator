#!/usr/bin/env node
/**
 * crosscheck-uia.mjs —— 用【独立实现的 UIA 遍历】交叉验证 MMC 的可访问性
 *
 * 为什么需要交叉验证：
 *   我的 desktop-actuator 报告"任务计划程序只暴露 14 个元素、零个可操作控件"。
 *   但这个结论来自我自己的工具 —— 如果我的工具有 bug，结论就是错的。
 *   所以这里用一套完全独立的 C# 代码（直接调 System.Windows.Automation）
 *   从零遍历，看是否得到同样的结论。
 *
 * 两种遍历方式都做，它们结果可能不同（这正是重点）：
 *   · ControlView  —— 只返回"控件"（UIA 认为用户会交互的元素）
 *   · RawView      —— 返回所有原始元素（含 UIA 认为不是控件的中间层）
 *   如果 RawView 有几百个而 ControlView 只有 14 个，那说明【元素存在但不可交互】，
 *   这对自动化意味着：只能靠坐标点，不能靠控件名。
 *
 * 用法：node crosscheck-uia.mjs "窗口标题关键词"
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const kw = process.argv[2] || '任务计划';

const CS = `
using System;
using System.Collections.Generic;
using System.Windows.Automation;

public class XCheck {
  public static string Run(string kw) {
    var root = AutomationElement.RootElement;
    AutomationElement win = null;
    foreach (AutomationElement c in root.FindAll(TreeScope.Children, Condition.TrueCondition)) {
      string n = "";
      try { n = c.Current.Name ?? ""; } catch {}
      if (n.Contains(kw)) { win = c; break; }
    }
    if (win == null) return "WINDOW_NOT_FOUND";

    var sb = new System.Text.StringBuilder();
    sb.AppendLine("WINDOW=" + (win.Current.Name ?? ""));
    var r = win.Current.BoundingRectangle;
    sb.AppendLine("BOUNDS=" + (int)r.Width + "x" + (int)r.Height + "@" + (int)r.X + "," + (int)r.Y);

    // ControlView —— UIA 认为"用户可交互"的元素
    var cv = win.FindAll(TreeScope.Descendants, Condition.TrueCondition);
    sb.AppendLine("CONTROLVIEW_COUNT=" + cv.Count);
    var types = new Dictionary<string,int>();
    int interactable = 0;
    foreach (AutomationElement e in cv) {
      string ct = "?";
      try { ct = e.Current.ControlType.ProgrammaticName.Replace("ControlType.",""); } catch {}
      if (!types.ContainsKey(ct)) types[ct] = 0;
      types[ct]++;
      try {
        object o;
        if (e.TryGetCurrentPattern(InvokePattern.Pattern, out o)) interactable++;
        else if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out o)) interactable++;
        else if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out o)) interactable++;
        else if (e.TryGetCurrentPattern(ValuePattern.Pattern, out o)) interactable++;
      } catch {}
    }
    foreach (var kv in types) sb.AppendLine("TYPE=" + kv.Key + ":" + kv.Value);
    sb.AppendLine("INTERACTABLE=" + interactable);

    // 尝试用 RawView 走到底（把它当 Walker）
    try {
      var walker = System.Windows.Automation.TreeWalker.RawViewWalker;
      int rawCount = 0;
      var stack = new Stack<AutomationElement>();
      stack.Push(win);
      while (stack.Count > 0 && rawCount < 5000) {
        var cur = stack.Pop();
        rawCount++;
        var ch = walker.GetFirstChild(cur);
        while (ch != null) { stack.Push(ch); ch = walker.GetNextSibling(ch); }
      }
      sb.AppendLine("RAWVIEW_COUNT=" + rawCount);
    } catch (Exception ex) { sb.AppendLine("RAWVIEW_ERR=" + ex.Message); }

    // 看看能不能找到任何 Tree/List（MMC 的树与列表通常是 SysTreeView32 / SysListView32 的宿主）
    string[] want = { "Tree","List","DataGrid","Table","Button","Edit","ComboBox","Tab" };
    foreach (var w in want) {
      int n = 0;
      foreach (AutomationElement e in cv) {
        try {
          string ct = e.Current.ControlType.ProgrammaticName.Replace("ControlType.","");
          if (ct == w) n++;
        } catch {}
      }
      sb.AppendLine("WANT_" + w + "=" + n);
    }
    return sb.ToString();
  }
}
`;

const tmp = path.join(os.tmpdir(), 'xcheck-' + Date.now());
fs.mkdirSync(tmp, { recursive: true });
const csFile = path.join(tmp, 'XCheck.cs');
const exeFile = path.join(tmp, 'XCheck.exe');
fs.writeFileSync(csFile, CS, 'utf8');

console.log('');
console.log('  交叉验证：用独立实现的 UIA 遍历（直接 C#，不走我的工具）');
console.log('  目标关键词: ' + kw);
console.log('');

// 找 csc.exe
const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = cscCandidates.find((p) => fs.existsSync(p));
if (!csc) { console.error('  ✗ 找不到 csc.exe（.NET Framework 编译器）'); process.exit(2); }

const refs = [
  'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\UIAutomationClient\\v4.0_4.0.0.0__31bf3856ad364e35\\UIAutomationClient.dll',
  'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\UIAutomationTypes\\v4.0_4.0.0.0__31bf3856ad364e35\\UIAutomationTypes.dll',
  'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\WindowsBase\\v4.0_4.0.0.0__31bf3856ad364e35\\WindowsBase.dll',
];
const missing = refs.filter((r) => !fs.existsSync(r));
if (missing.length) console.log('  ! 以下引用不存在（会尝试不带引用编译）: ' + missing.length + ' 个');

// ★ 编译成【库】而不是 exe —— 因为没有 Main 方法，csc 会报 CS5001。
//   本意就是让 PowerShell 用 Add-Type 反射调用，所以库更合适。
//   注意：dllFile 必须在下面拼 psScript 之前就定义好（我第一次把 const 放进了 try 块里，
//   结果模板字符串引用它时报 "dllFile is not defined" —— 块级作用域的坑）。
const dllFile = path.join(tmp, 'XCheck.dll');

try {
  const args = ['/nologo', '/target:library', '/out:' + dllFile, ...refs.filter((r) => fs.existsSync(r)).map((r) => '/r:' + r), csFile];
  const out = execFileSync(csc, args, { encoding: 'utf8', timeout: 90000 });
  if (out.trim()) console.log('  编译输出: ' + out.trim().slice(0, 300));
  console.log('  \u2713 编译成功');
} catch (e) {
  console.error('  ✗ 编译失败: ' + (e.stdout || e.message || '').toString().slice(0, 500));
  process.exit(1);
}

// 需要一个 runner 来调 XCheck.Run —— 用 PowerShell 反射加载
const psScript = `
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path '${dllFile}'
$r = [XCheck]::Run('${kw.replace(/'/g, "''")}')
Write-Output $r
`;
const psFile = path.join(tmp, 'run.ps1');
fs.writeFileSync(psFile, psScript, { encoding: 'utf8' });
// 加 BOM
const buf = fs.readFileSync(psFile);
if (!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
  fs.writeFileSync(psFile, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), buf]));
}

try {
  const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  console.log('');
  console.log('  ── 独立遍历的结果 ──');
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [k, v] = line.split('=');
    if (k === 'TYPE') {
      const [t, n] = (v || '').split(':');
      console.log('    type  ' + String(t).padEnd(18) + n);
    } else if (k && k.startsWith('WANT_')) {
      const n = v;
      if (n !== '0') console.log('    ' + k.replace('WANT_', 'found ').padEnd(24) + n);
    } else {
      console.log('    ' + String(k).padEnd(22) + v);
    }
  }
} catch (e) {
  console.error('  ✗ 运行失败: ' + (e.stdout || e.message || '').toString().slice(0, 500));
  process.exit(1);
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log('');
