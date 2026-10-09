# desktop-actuator.ps1 —— 底层执行器（被 desktop-actuator.mjs 调用）
#
# 约定（很重要，改这个文件时必须遵守）：
#   1. 人类可读的日志打到 stdout 前面，**最后一行必须是一行合法 JSON**。
#      Node 侧是从后往前找第一个 `{...}` 行来解析的。
#   2. 启动时立刻声明 DPI 感知 —— 否则坐标会偏（下面有说明）。
#
# ★ 为什么必须声明 DPI 感知（我实测踩过这个坑）：
#   同一个窗口，PowerShell 的 SystemInformation 报 1707x1067，
#   Windows UI Automation 报 2560x1600 —— 系统 DPI 是 144（150% 缩放）。
#   进程不声明感知时，SetCursorPos 收到的是【逻辑坐标】，而屏幕是【物理像素】，
#   于是"按读到的坐标去点"会偏 1.5 倍，表现为「点了没反应」或「点错地方」。
#   声明之后，本脚本的坐标与 UIAutomation 的坐标统一为物理像素，可以直接互相使用。

[CmdletBinding()]
param(
  [Parameter(Position=0, Mandatory=$true)]
  [ValidateSet('where','windows','capture','move','click','clicontrol','dclick','key','type','dump','find','settext')]
  [string]$Command,
  [Parameter(Position=1)][string]$OutPath,
  [string]$RegionBox,
  # ★ 鼠标坐标默认用哨兵 [int]::MinValue，【不能】用 0 ——
  #   0 是合法坐标，用 0 当默认就无法区分"没传坐标"与"要操作 (0,0)"。
  #   这正是"静默点了屏幕左上角"那个 bug 的根源。
  [int]$CursorX = [int]::MinValue,
  [int]$CursorY = [int]::MinValue,
  [string]$KeyName,
  [string]$TypeText,
  [string]$FillValue,
  [string]$WindowKeyword,
  [string]$NameKeyword,
  [int]$Limit = 80
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

# ── DPI 感知：必须在任何坐标/截图调用之前 ──
try {
  Add-Type @"
using System;using System.Runtime.InteropServices;
public class DaDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern int GetDpiForSystem();
}
"@ -ErrorAction SilentlyContinue
  try { [void][DaDpi]::SetProcessDpiAwareness(2) } catch { try { [void][DaDpi]::SetProcessDPIAware() } catch {} }
} catch {}
$dpiMode = 'unknown'
try { if ([DaDpi]::GetDpiForSystem() -gt 0) { $dpiMode = "dpi=$([DaDpi]::GetDpiForSystem())" } } catch {}

Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ── user32 ──
if (-not ('DaInput' -as [type])) {
  Add-Type @"
using System;using System.Runtime.InteropServices;
public class DaInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010, KEYUP=0x0002;
}
"@ -ErrorAction SilentlyContinue
}

# ── 安全取整（最小化窗口会报无穷大矩形，裸 [int] 转换会抛）──
function SafeInt($v) {
  try {
    $d = [double]$v
    if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return -1 }
    if ($d -gt 2147483647) { return 2147483647 }
    if ($d -lt -2147483648) { return -2147483648 }
    return [int]$d
  } catch { return -1 }
}

function Out-Json($obj) { Write-Output ($obj | ConvertTo-Json -Compress -Depth 6) }
# Fail —— 输出一行 JSON 并**以非 0 退出码结束**
# ★ 为什么退出码重要：Node 侧曾用退出码判断成败，而这里原本是 exit 0，
#   于是"底层失败了"与"底层成功了"在退出码上无法区分。
#   现在改成 exit 1；同时 Node 侧也不只靠退出码（双保险）。
function Fail($code, $msg) { Out-Json @{ ok = $false; code = $code; message = $msg }; exit 1 }

switch ($Command) {

  'where' {
    try {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $p = [System.Windows.Forms.Cursor]::Position
      $fg = [DaInput]::GetForegroundWindow()
      $sb = New-Object System.Text.StringBuilder 512
      [DaInput]::GetWindowText($fg, $sb, 512) | Out-Null
      $sysDpi = 0; try { $sysDpi = [DaDpi]::GetDpiForSystem() } catch {}
      Out-Json @{
        ok = $true
        screen = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
        mouse  = @{ x = $p.X; y = $p.Y }
        foreground = $sb.ToString()
        systemDpi = $sysDpi
        scale = if ($sysDpi -gt 0) { [math]::Round($sysDpi / 96.0, 4) } else { $null }
        coordSpace = 'physical-pixels'
      }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'windows' {
    try {
      $list = New-Object System.Collections.ArrayList
      $cb = [DaInput+EnumWindowsProc]{
        param($hWnd, $lParam)
        if ([DaInput]::IsWindowVisible($hWnd)) {
          $sb = New-Object System.Text.StringBuilder 512
          [DaInput]::GetWindowText($hWnd, $sb, 512) | Out-Null
          $t = $sb.ToString()
          if ($t.Trim().Length -gt 0) {
            $r = New-Object DaInput+RECT
            [void][DaInput]::GetWindowRect($hWnd, [ref]$r)
            [void]$list.Add(@{
              title = $t
              x = (SafeInt $r.Left); y = (SafeInt $r.Top)
              width = (SafeInt ($r.Right - $r.Left)); height = (SafeInt ($r.Bottom - $r.Top))
              handle = $hWnd.ToInt64()
            })
          }
        }
        return $true
      }
      [void][DaInput]::EnumWindows($cb, [IntPtr]::Zero)
      Out-Json @{ ok = $true; count = $list.Count; windows = $list }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'capture' {
    if (-not $OutPath) { Fail 'E_BAD_REQUEST' '缺少输出路径' }
    try {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $x = $vs.X; $y = $vs.Y; $w = $vs.Width; $h = $vs.Height
      if ($RegionBox) {
        $p = $RegionBox.Split(',')
        if ($p.Count -eq 4) { $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3] }
      }
      $bmp = New-Object System.Drawing.Bitmap($w, $h)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
      $g.Dispose()
      $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      Out-Json @{ ok = $true; path = $OutPath; width = $w; height = $h; dpi = $dpiMode }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'move' {
    if ($CursorX -eq [int]::MinValue -or $CursorY -eq [int]::MinValue) {
      Fail 'E_BAD_REQUEST' 'move 需要 -CursorX 与 -CursorY'
    }
    # ★ 不只是"调用没报错"，而是要【验证光标真的动了】。
    #   我在实测里遇到：SetCursorPos 在某些会话下会失败（GetLastError=203），
    #   而只信返回值就会报 ok:true —— 又一个"静默做错事"。
    #   所以这里改成：调用 → 读回实际位置（用与 where 相同的读法）→ 比对。
    $r = [DaInput]::SetCursorPos($CursorX, $CursorY)
    Start-Sleep -Milliseconds 80
    # 用 [System.Windows.Forms.Cursor]::Position 读回 —— 与 where 分支保持同一种读法，
    # 避免"写入用一套 API、读出用另一套"导致坐标口径不一致。
    $after = [System.Windows.Forms.Cursor]::Position
    if ($after.X -ne $CursorX -or $after.Y -ne $CursorY) {
      $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      Fail 'E_INTERNAL' ("光标未能移动到 " + $CursorX + "," + $CursorY + "；实际停在 " + $after.X + "," + $after.Y + "；SetCursorPos 返回 " + $r + "；Win32 错误码 " + $err + "（常见原因：无交互式桌面会话、远程会话、或系统策略限制光标控制）")
    }
    Out-Json @{ ok = $true; x = $after.X; y = $after.Y; verified = $true }
  }

  'click' {
    # ★ 护栏：必须显式传坐标。
    #   踩过的坑：$CursorX/$CursorY 是 [int] 参数，默认值就是 0，
    #   于是"没传坐标"与"要点击 (0,0)"在底层无法区分 ——
    #   我实测时 `click -NameKeyword 某控件`（参数传错）导致它静默地去点了 (0,0) 并返回 ok:true。
    #   这类"静默做错事"比直接报错危险得多。
    if ($CursorX -eq [int]::MinValue -or $CursorY -eq [int]::MinValue) {
      Fail 'E_BAD_REQUEST' 'click 需要 -CursorX 与 -CursorY（按控件名点击请用 Node 侧的 controlClick）'
    }
    try {
      [void][DaInput]::SetCursorPos($CursorX, $CursorY)
      Start-Sleep -Milliseconds 60
      [DaInput]::mouse_event([DaInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      [DaInput]::mouse_event([DaInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Out-Json @{ ok = $true; x = $CursorX; y = $CursorY; button = 'left' }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'dclick' {
    if ($CursorX -eq [int]::MinValue -or $CursorY -eq [int]::MinValue) {
      Fail 'E_BAD_REQUEST' 'dclick 需要 -CursorX 与 -CursorY'
    }
    try {
      [void][DaInput]::SetCursorPos($CursorX, $CursorY)
      Start-Sleep -Milliseconds 60
      1..2 | ForEach-Object {
        [DaInput]::mouse_event([DaInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
        [DaInput]::mouse_event([DaInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 40
      }
      Out-Json @{ ok = $true; x = $CursorX; y = $CursorY; button = 'double' }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'key' {
    # 支持两种写法：
    #   单键：-KeyName ENTER
    #   组合键：-KeyName "CTRL+S"
    # ★ 组合键是刚需 —— 我实测时想"另存为"来验证输入内容，发现发不了 Ctrl+S。
    #   保存/复制/粘贴/关闭窗口全靠组合键，缺了它这个执行器在很多真实流程里没法用。
    if (-not $KeyName) { Fail 'E_BAD_REQUEST' '缺少 -KeyName' }
    try {
      $map = @{ 'ENTER'=0x0D; 'TAB'=0x09; 'ESC'=0x1B; 'ESCAPE'=0x1B; 'SPACE'=0x20
                'BACK'=0x08; 'BACKSPACE'=0x08; 'DELETE'=0x2E; 'DEL'=0x2E
                'UP'=0x26; 'DOWN'=0x28; 'LEFT'=0x25; 'RIGHT'=0x27
                'HOME'=0x24; 'END'=0x23; 'PGUP'=0x21; 'PGDN'=0x22
                'CTRL'=0x11; 'CONTROL'=0x11; 'SHIFT'=0x10; 'ALT'=0x12; 'WIN'=0x5B
                'F1'=0x70;'F2'=0x71;'F3'=0x72;'F4'=0x73;'F5'=0x74;'F6'=0x75
                'F7'=0x76;'F8'=0x77;'F9'=0x78;'F10'=0x79;'F11'=0x7A;'F12'=0x7B }

      # 按 '+' 拆成组合键；没有 '+' 就是单键
      # ★ 语法要严格：CTRL+ / CTRL++S / +S 这类写法必须拒绝 ——
      #   否则 CTRL+ 会被当成单键 CTRL 静默接受（我实测发现了这个瑕疵）。
      $rawParts = $KeyName -split '\+'
      $emptyCount = @($rawParts | Where-Object { $_.Trim().Length -eq 0 }).Count
      if ($rawParts.Count -gt 1 -and $emptyCount -gt 0) {
        Fail 'E_BAD_REQUEST' ('组合键语法不对: ' + $KeyName + '（正确写法如 CTRL+S，加号两侧都不能为空）')
      }
      $parts = @($rawParts | Where-Object { $_.Trim().Length -gt 0 })
      $vks = New-Object System.Collections.ArrayList
      foreach ($pp in $parts) {
        $kk = $pp.Trim().ToUpper()
        $vk = -1
        if ($map.ContainsKey($kk)) { $vk = [int]$map[$kk] }
        elseif ($kk.Length -eq 1) { $vk = [int][char]$kk }
        if ($vk -lt 0) {
          Fail 'E_BAD_REQUEST' ("不支持的键名: " + $pp + "（可用 ENTER/TAB/ESC/F1-F12/CTRL/SHIFT/ALT/单字符；组合键写成 CTRL+S）")
        }
        [void]$vks.Add($vk)
      }
      if ($vks.Count -eq 0) { Fail 'E_BAD_REQUEST' '键名为空' }

      # 按下：修饰键先按、主键最后
      foreach ($vk in $vks) { [DaInput]::keybd_event([byte]$vk, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 20 }
      Start-Sleep -Milliseconds 40
      # 释放：逆序（主键先松、修饰键后松）—— 顺序反了组合键会被识别成单键
      for ($i = $vks.Count - 1; $i -ge 0; $i--) {
        [DaInput]::keybd_event([byte]$vks[$i], 0, [DaInput]::KEYUP, [IntPtr]::Zero); Start-Sleep -Milliseconds 20
      }

      Out-Json @{ ok = $true; key = $KeyName; vk = @($vks); combo = ($vks.Count -gt 1) }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  'type' {
    if ($null -eq $TypeText) { Fail 'E_BAD_REQUEST' '缺少 -Text' }
    try {
      # 用剪贴板粘贴实现，支持中文。尽力恢复原剪贴板。
      $old = $null
      try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $old = [System.Windows.Forms.Clipboard]::GetText() } } catch {}
      [System.Windows.Forms.Clipboard]::SetText($TypeText)
      Start-Sleep -Milliseconds 120
      # Ctrl+V
      [DaInput]::keybd_event(0x11, 0, 0, [IntPtr]::Zero)
      [DaInput]::keybd_event(0x56, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [DaInput]::keybd_event(0x56, 0, [DaInput]::KEYUP, [IntPtr]::Zero)
      [DaInput]::keybd_event(0x11, 0, [DaInput]::KEYUP, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 120
      if ($null -ne $old) { try { [System.Windows.Forms.Clipboard]::SetText($old) } catch {} }
      Out-Json @{ ok = $true; length = $TypeText.Length; via = 'clipboard+ctrlV' }
    } catch { Fail 'E_INTERNAL' $_.Exception.Message }
  }

  # ── UI Automation 相关（需要先加载程序集）──
  default {
    try {
      Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
      Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
    } catch { Fail 'E_UNSUPPORTED' '无法加载 UIAutomation（该操作需要 Windows UI Automation）' }

    $AE = [System.Windows.Automation.AutomationElement]
    $TS = [System.Windows.Automation.TreeScope]
    $TrueCond = [System.Windows.Automation.Condition]::TrueCondition

    function Get-Actions($e) {
      $a = New-Object System.Collections.ArrayList
      $o = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { [void]$a.Add('Invoke') } } catch {}
      $o = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { [void]$a.Add('Value') } } catch {}
      $o = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { [void]$a.Add('Text') } } catch {}
      $o = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$o)) { [void]$a.Add('Select') } } catch {}
      $o = $null
      try { if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$o)) { [void]$a.Add('Expand') } } catch {}
      return ($a -join ',')
    }

    function Get-TopWindows {
      $out = New-Object System.Collections.ArrayList
      foreach ($k in $AE::RootElement.FindAll($TS::Children, $TrueCond)) {
        $n = $k.Current.Name
        if ($n -and $n.Trim().Length -gt 0) { [void]$out.Add($k) }
      }
      return $out
    }

    function Find-Win([string]$kw) {
      foreach ($w in Get-TopWindows) { if ($w.Current.Name -like ('*' + $kw + '*')) { return $w } }
      return $null
    }

    function Get-Roots {
      if ($WindowKeyword) {
        $w = Find-Win $WindowKeyword
        if (-not $w) { return $null }
        return @($w)
      }
      # ★ 不给窗口关键词时返回【所有顶层窗口】。
      #   这个行为对"按控件名操作"是【危险的默认值】：我实测时
      #   `find -NameKeyword '文件'`（不带窗口）把 DSH 界面与任务计划程序窗口里的元素
      #   全都匹配了出来 —— 20 个命中全是【别的窗口】的，完全没法用来"在某个程序里找控件"。
      #   所以 find / click / clicontrol / settext 这类命令改为必须限定窗口（见下面 $needsWindow 检查）。
      return @(Get-TopWindows)
    }

    # 按控件名操作时必须限定窗口，否则会跨程序误匹配
    $needsWindow = @('find', 'clicontrol', 'settext', 'click')
    if (($needsWindow -contains $Command) -and (-not $WindowKeyword)) {
      Fail 'E_BAD_REQUEST' ($Command + ' 需要 -WindowKeyword：限定在哪个窗口里找控件。不给窗口会搜遍所有顶层窗口，导致跨程序误匹配（我实测过这个问题）。')
    }

    if ($Command -eq 'dump') {
      if (-not $WindowKeyword) { Fail 'E_BAD_REQUEST' 'dump 需要 -Window' }
      $w = Find-Win $WindowKeyword
      if (-not $w) { Fail 'E_ELEMENT_NOT_FOUND' "找不到窗口: $WindowKeyword" }
      $r = $w.Current.BoundingRectangle
      Write-Output ("window: " + $w.Current.Name + "  " + (SafeInt $r.Width) + "x" + (SafeInt $r.Height))
      $i = 0
      foreach ($e in $w.FindAll($TS::Descendants, $TrueCond)) {
        if ($i -ge $Limit) { break }
        $n = $e.Current.Name
        if ($n -and $n.Trim().Length -gt 0) {
          $rr = $e.Current.BoundingRectangle
          $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
          $label = if ($n.Length -gt 46) { $n.Substring(0, 46) + '…' } else { $n }
          Write-Output ("  #$i [$ct] '$label' @" + (SafeInt $rr.X) + "," + (SafeInt $rr.Y) + " " + (SafeInt $rr.Width) + "x" + (SafeInt $rr.Height) + " {" + (Get-Actions $e) + "}")
          $i++
        }
      }
      Out-Json @{ ok = $true; window = $w.Current.Name; shown = $i; width = (SafeInt $r.Width); height = (SafeInt $r.Height) }
    }

    elseif ($Command -eq 'find') {
      if (-not $NameKeyword) { Fail 'E_BAD_REQUEST' 'find 需要 -Text' }
      $roots = Get-Roots
      if ($null -eq $roots) { Fail 'E_ELEMENT_NOT_FOUND' "找不到窗口: $WindowKeyword" }
      $hits = 0
      foreach ($rt in $roots) {
        foreach ($e in $rt.FindAll($TS::Descendants, $TrueCond)) {
          $n = $e.Current.Name
          if ($n -and $n -like ('*' + $NameKeyword + '*')) {
            $rr = $e.Current.BoundingRectangle
            $ct = $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
            $cx = SafeInt ($rr.X + $rr.Width / 2); $cy = SafeInt ($rr.Y + $rr.Height / 2)
            Write-Output ("★ [$ct] '$n'")
            Write-Output ("    中心坐标(物理): $cx,$cy   可用动作: " + (Get-Actions $e))
            $hits++
            if ($hits -ge 20) { break }
          }
        }
        if ($hits -ge 20) { break }
      }
      Out-Json @{ ok = ($hits -gt 0); hits = $hits }
    }

    elseif ($Command -eq 'click' -or $Command -eq 'clicontrol') {
      if (-not $NameKeyword) { Fail 'E_BAD_REQUEST' 'click 需要 -Text（控件名关键词）' }
      $roots = Get-Roots
      if ($null -eq $roots) { Fail 'E_ELEMENT_NOT_FOUND' "找不到窗口: $WindowKeyword" }
      $target = $null
      foreach ($rt in $roots) {
        foreach ($e in $rt.FindAll($TS::Descendants, $TrueCond)) {
          $n = $e.Current.Name
          if ($n -and $n -like ('*' + $NameKeyword + '*')) { $target = $e; break }
        }
        if ($target) { break }
      }
      if (-not $target) { Fail 'E_ELEMENT_NOT_FOUND' "没找到名字含「$NameKeyword」的控件" }
      Write-Output ("target: " + $target.Current.Name + "  actions=" + (Get-Actions $target))
      $o = $null
      try {
        if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) {
          ([System.Windows.Automation.InvokePattern]$o).Invoke()
          Out-Json @{ ok = $true; via = 'InvokePattern'; name = $target.Current.Name }
          exit 0
        }
      } catch {}
      # 回退：点元素中心（DPI 已声明，坐标系与 UIA 一致）
      $rr = $target.Current.BoundingRectangle
      $cx = SafeInt ($rr.X + $rr.Width / 2); $cy = SafeInt ($rr.Y + $rr.Height / 2)
      [void][DaInput]::SetCursorPos($cx, $cy)
      Start-Sleep -Milliseconds 60
      [DaInput]::mouse_event([DaInput]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
      [DaInput]::mouse_event([DaInput]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
      Out-Json @{ ok = $true; via = 'coordinate-fallback'; x = $cx; y = $cy; name = $target.Current.Name }
    }

    elseif ($Command -eq 'settext') {
      if (-not $NameKeyword) { Fail 'E_BAD_REQUEST' 'settext 需要 -Text（控件名关键词）' }
      if ($null -eq $FillValue) { Fail 'E_BAD_REQUEST' 'settext 需要 -Value' }
      $roots = Get-Roots
      if ($null -eq $roots) { Fail 'E_ELEMENT_NOT_FOUND' "找不到窗口: $WindowKeyword" }
      $target = $null
      foreach ($rt in $roots) {
        foreach ($e in $rt.FindAll($TS::Descendants, $TrueCond)) {
          $n = $e.Current.Name
          if ($n -and $n -like ('*' + $NameKeyword + '*')) {
            if (-not $target) { $target = $e }
            $acts = Get-Actions $e
            if ($acts -like '*Value*') { $target = $e; break }
          }
        }
        if ($target -and ((Get-Actions $target) -like '*Value*')) { break }
      }
      if (-not $target) { Fail 'E_ELEMENT_NOT_FOUND' "没找到名字含「$NameKeyword」的控件" }
      $o = $null
      try {
        if ($target.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) {
          ([System.Windows.Automation.ValuePattern]$o).SetValue($FillValue)
          Out-Json @{ ok = $true; via = 'ValuePattern'; name = $target.Current.Name; length = $FillValue.Length }
          exit 0
        }
      } catch {}
      Fail 'E_UNSUPPORTED' '该控件不支持 ValuePattern'
    }

    else { Fail 'E_BAD_REQUEST' "未实现: $Command" }
  }
}
