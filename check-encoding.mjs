#!/usr/bin/env node
/**
 * check-encoding.mjs —— 交付物编码守卫
 *
 * 为什么需要它（这是我在第 34 轮真实踩到的）：
 *   我用脚本给 desktop-actuator.ps1 补 BOM 时，用了
 *   `new UTF8Encoding($true)`（要 BOM）—— 但在此之前有一次编辑用了
 *   `WriteAllText(..., UTF8Encoding($false))`，把 BOM 去掉了。
 *   之后 PowerShell 5.1 按 GBK 读该文件 ⇒ 中文全变乱码 ⇒ 脚本语法错、直接不可用。
 *
 *   症状很迷惑：Node 侧报 "E_PS_FAILED 按键失败"，而真正的原因是文件编码。
 *   所以我需要一条【每次改完都跑】的守卫，而不是靠我记着。
 *
 * 检查项：
 *   · .ps1 / .cmd / .bat  → 必须有 UTF-8 BOM（否则 PowerShell 5.1 / cmd 会按 ANSI 读）
 *   · .cmd / .bat         → 另外必须【全 ASCII】（cmd.exe 按 GBK 读，中文会被当命令执行）
 *   · .mjs/.js/.json/.md  → 不应有 BOM（Node 与多数工具无所谓，但保持一致更省事）
 *   · 所有文本文件        → 不应含 U+FFFD（替换字符），那是"编码已经坏掉"的铁证
 *
 * 用法：node check-encoding.mjs <目录或文件>...
 */
import fs from 'node:fs';
import path from 'node:path';

const targets = process.argv.slice(2);
if (!targets.length) { console.error('用法: node check-encoding.mjs <目录或文件>...'); process.exit(2); }

const BOM = [0xEF, 0xBB, 0xBF];
const hasBom = (b) => b.length >= 3 && b[0] === BOM[0] && b[1] === BOM[1] && b[2] === BOM[2];

const NEEDS_BOM = new Set(['.ps1']);
const NEEDS_ASCII = new Set(['.cmd', '.bat']);
const NO_BOM = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml', '.csv']);
const TEXT_EXT = new Set([...NEEDS_BOM, ...NEEDS_ASCII, ...NO_BOM]);

const files = [];
function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(path.join(p, e.name));
    }
  } else {
    files.push(p);
  }
}
for (const t of targets) { try { walk(t); } catch (e) { console.error('  跳过 ' + t + ': ' + e.message); } }

let bad = 0, checked = 0;
const problems = [];

for (const f of files) {
  const ext = path.extname(f).toLowerCase();
  if (!TEXT_EXT.has(ext)) continue;
  checked++;
  const b = fs.readFileSync(f);
  const rel = path.relative(process.cwd(), f);

  if (NEEDS_BOM.has(ext) && !hasBom(b)) {
    problems.push({ f: rel, why: '缺 UTF-8 BOM（PowerShell 5.1 会按 GBK 读 ⇒ 中文乱码 ⇒ 语法错）', fix: 'add-bom' });
  }
  if (NO_BOM.has(ext) && hasBom(b)) {
    problems.push({ f: rel, why: '有多余的 BOM（这类文件不需要）', fix: 'strip-bom' });
  }
  if (NEEDS_ASCII.has(ext)) {
    const nonAscii = b.findIndex((x) => x > 0x7F);
    if (nonAscii >= 0) {
      problems.push({ f: rel, why: '含非 ASCII 字节（cmd.exe 按 GBK 读，中文会被当命令执行）', fix: 'ascii-only' });
    }
  }
  // U+FFFD 检查（只对文本类）
  const txt = b.toString('utf8');
  if (txt.includes('\uFFFD')) {
    problems.push({ f: rel, why: '含替换字符 U+FFFD —— 编码已经坏了', fix: 'reencode' });
  }
}

console.log('');
console.log('  编码守卫：检查了 ' + checked + ' 个文本文件');
console.log('');
if (!problems.length) {
  console.log('  \u2713 全部通过（.ps1 有 BOM；.cmd/.bat 全 ASCII；无 U+FFFD）');
  console.log('');
  process.exit(0);
}
console.log('  \u2717 发现 ' + problems.length + ' 个问题：');
for (const p of problems) console.log('    · ' + p.f + ' —— ' + p.why + '  [' + p.fix + ']');
console.log('');
console.log('  修复提示：');
console.log('    add-bom   : fs.writeFileSync(f, fs.readFileSync(f,"utf8"), { encoding:"utf8" }) 后补 EF BB BF');
console.log('    或用 PowerShell: [IO.File]::WriteAllText($f, $t, (New-Object Text.UTF8Encoding($true)))');
console.log('');
process.exit(1);
