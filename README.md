# desktop-actuator

**给 AI Agent 调用的 Windows 桌面执行器。** 一个文件、零依赖、JSON in → JSON out。

```
请求：{ "op": "click", "x": 100, "y": 200 }
响应：{ "ok": true, "op": "click", "elapsedMs": 12, "result": { ... } }
```

**一句话**：让 Agent 能"看见"屏幕、按**控件名**点按钮、输入中文、枚举窗口 ——
而且每一步都有**结构化的成功/失败结果**，不是靠猜屏幕。

**为什么不用现成的**：

| 现成方案 | 为什么这里不适用 |
|---|---|
| AutoHotkey / Pulover's | 是**给人写脚本**用的，不是给程序调用的；没有 JSON 契约与错误码 |
| Selenium / Playwright | 只管浏览器，**管不到 Windows 桌面应用** |
| UI.Vision（$299/年） | 是**给人的 GUI**，要装扩展与运行时；没有"给 Agent 调用"的接口 |
| 商业 RPA（UiPath 等） | 重、贵、要装一堆东西，不适合嵌进别人的 Agent 循环 |

## 30 秒上手

```bash
node desktop-actuator.mjs describe                      # 看它能做什么
node desktop-actuator.mjs call --json '{"op":"where"}'   # 单次调用
echo '{"op":"where"}' | node desktop-actuator.mjs serve  # 常驻模式（推荐）
```

**Windows 注意**：命令行传 JSON 容易被 shell 吞引号。**推荐 `serve` 模式**（从 stdin 读）。
**要求**：Windows + Node.js。**不需要**装任何依赖、不需要管理员权限、不需要运行时。

## 实测能力（有自动化测试覆盖，不是"看起来能用"）

```
$ node test-input-safe.mjs
  ✓ 组合键 CTRL+A / CTRL+C / CTRL+S / CTRL+V 全部可用
  ✓ 剪贴板内容与输入的完全一致（逐字）
  ✓ 文件已落盘
  ✓ 落盘内容与输入的完全一致（逐字）
  20 通过 · 0 失败
```

即：**输入中文 → 组合键保存 → 对话框里粘贴路径 → 回车 → 文件内容逐字正确**，
这条完整链路是**真的跑通过的**。

---

## 为什么做这个东西（以及它不做什么）

调研过这个市场的付费情况后，结论是三条：

1. **不做宏录制器 GUI** —— 那个位置已经被免费品打穿了
   （AutoHotkey、Pulover's Macro Creator 都免费）。
2. **做「给 Agent 调用的确定性执行器」** —— 这个位置**没有强势占位者**。
   现有的桌面自动化产品全是**给人用的** GUI 或脚本语言；包成 JSON 契约之后，
   可以被任意 Agent 循环调用。最接近的商业产品 Browserbase 只覆盖浏览器，
   **Windows 桌面这一侧是空的**。
3. **形态排序：库/CLI 优先** —— 付费方（QA/测试团队、小团队 IT 运维、Agent 开发者）
   消费的都是程序化接口，不是 GUI。

**所以本工具：**
- ✅ 零依赖（不需要安装器、不需要运行时，一个 `.mjs` + 一个 `.ps1`）
- ✅ 可审计（全部逻辑可见，企业可以锁版本 —— 这是企业买家买商业方案时的核心理由）
- ✅ 统一的 JSON 契约 + **结构化错误码**（Agent 靠码分支，不靠解析文案）
- ✅ `describe` 自述能力（Agent 可以自己发现有哪些操作）
- ❌ **不做图像匹配 / OCR**（这是与商业产品的真实差距，见下方"诚实边界"）
- ❌ **不做 GUI**

---

## 快速开始

```bash
# 1. 看它能做什么（Agent 用这个自我发现）
node desktop-actuator.mjs describe

# 2. 单次调用
node desktop-actuator.mjs call --json '{"op":"where"}'

# 3. 常驻模式（逐行读 JSON 请求，适合被别的进程当执行器）
echo '{"op":"where"}' | node desktop-actuator.mjs serve
```

**Windows 用户注意**：命令行里传 JSON 容易被 shell 吞引号。
**推荐用 `serve` 模式**（从 stdin 读），或者把 JSON 写进文件再重定向。

---

## 操作清单

| op | 参数 | 说明 |
|---|---|---|
| `where` | — | 屏幕尺寸、鼠标位置、**DPI 与缩放比**、前台窗口 |
| `windows` | — | 枚举可见窗口（标题 + 位置 + handle） |
| `capture` | `path`, `region?` | 截屏到 PNG；返回路径与字节数 |
| `move` | `x`, `y` | 移动鼠标 |
| `click` | `x`, `y`, `button?` | 按坐标点击（`left` / `right` / `double`） |
| `clicontrol` | `name`, `window?` | **按控件名触发**（优先 InvokePattern，不用坐标） |
| `key` | `name` | 按键。单键 `ENTER`；**组合键 `CTRL+S`** |
| `type` | `text` | 输入文本（走剪贴板，支持中文） |
| `dump` | `window`, `limit?` | 列出窗口内可访问控件（**结构化数组**） |
| `find` | `name`, `window?` | 按名字找控件，返回中心坐标与可用动作 |
| `setText` | `name`, `value`, `window?` | 把文字写入输入框（ValuePattern）。**`value` 允许为空串（清空）** |

## 错误码

| 码 | 含义 |
|---|---|
| `E_BAD_REQUEST` | 请求本身不合法（缺参数、参数类型错、语法错） |
| `E_UNSUPPORTED` | 本平台不支持该操作（例如非 Windows，或控件不支持 ValuePattern） |
| `E_PS_FAILED` | 底层 PowerShell 调用失败 |
| `E_ELEMENT_NOT_FOUND` | 按名字找不到控件 |
| `E_TIMEOUT` | 超时 |
| `E_INTERNAL` | 其他内部错误 |

**注意**：失败响应**永远**也带 `op` 与 `elapsedMs`，便于观测与归因。

---

## ★ 这个工具与常见脚本的真实差别：DPI

**同一个窗口，两套 API 报出的尺寸不一样**（实测数据）：

| 来源 | 报出的尺寸 |
|---|---|
| PowerShell 的 `SystemInformation` | `1707 x 1067` |
| Windows UI Automation | `2560 x 1600` |

**比值正好 1.5 —— 系统 DPI 是 144（150% 缩放）。**

进程若**不声明 DPI 感知**：`SetCursorPos` 收到的是**逻辑坐标**，而屏幕是**物理像素**，
于是"按读到的坐标去点"会偏 1.5 倍 —— 表现是「**点了没反应**」或「点错地方」。

本工具在启动时就声明 **per-monitor DPI 感知**，并把 DPI 与缩放比写进 `where` 的输出里，
**让这件事可观测**，而不是留给使用者去猜。

---

## 测试

```bash
node selftest.mjs          # 55 项：契约 / 只读 op / 截屏 / 坐标 / UIA / 反例 / serve / 编码守卫
node test-input-safe.mjs   # 20 项：写入类操作的安全端到端验证
node check-encoding.mjs ..            # 编码守卫（.ps1 必须有 BOM）—— 可选，见下方说明
```

**两套测试都是 0 失败才退出 0**，可以直接接 CI。

### `test-input-safe.mjs` 的安全设计（这是它存在的唯一理由）

- **只对「本脚本自己启动的记事本」发按键**，绝不对当前前台窗口盲打字
- 测前记录前台窗口，测完把焦点还回去
- 不碰用户文档；临时目录用完即删
- 明确规避 `Ctrl+A` / `Delete` 这类破坏性组合

它用两条独立路径做验证（互相印证）：
- **路 A 剪贴板回环**：`type` → `Ctrl+A` → `Ctrl+C` → 读剪贴板 → 逐字比对
- **路 B 另存为落盘**：`Ctrl+S` → 对话框粘贴路径 → `ENTER` → 读文件 → 逐字比对

---

## 诚实边界（还没做的事）

| 缺口 | 影响 | 现状 |
|---|---|---|
| **无图像匹配 / OCR** | 无法处理自绘界面、游戏、Canvas 应用 | 未做 |
| **无"等待元素出现"** | 调用方需要自己重试 | 未做 |
| **无滚轮 / 拖拽** | 长列表与拖放操作做不了 | 未做 |
| **无窗口相对坐标** | 窗口移动后坐标失效 | 未做 |
| 只支持 Windows | 依赖 user32 / UIAutomation | 平台限制 |
| 未做 MCP / 工具插件封装 | 接入 Agent 需要一层适配 | 计划中 |

**与商业产品的真实差距**：UI.Vision（$299/年）与 Macro Scheduler（$199.99/用户）
有图像匹配、元素等待、错误恢复、以及支持体系。**本工具目前只覆盖"坐标 + UIA"这一层。**

---

## 一个设计决策值得说明：为什么 `clicontrol` 与 `click` 是两个 op

因为它们**语义不同，混用会出危险**：

- `click` 按**屏幕坐标**点 —— 坐标错了就点错地方
- `clicontrol` 按**控件名**触发 —— 找不到就明确失败

我实测时踩过一次：参数传错导致 `clicontrol` 走到了坐标分支，
**静默地去点击了屏幕 (0,0) 并返回 `ok: true`**。
之后把两者拆成独立 op，并给坐标类命令加了"必须显式传坐标"的护栏 ——
**"静默做错事"比直接报错危险得多。**

---

## 许可

MIT（见 `LICENSE`）。
