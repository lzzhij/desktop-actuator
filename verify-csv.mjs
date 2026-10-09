#!/usr/bin/env node
/**
 * verify-csv.mjs —— 独立验证案例导出的 CSV（用 Node 解析，不经过 PowerShell）
 *
 * 为什么需要：我用 PowerShell 的 ConvertFrom-Csv 抽查时，看到"路径"列的反斜杠不见了。
 * 但我随后实测证明 PowerShell 里 '\' 拼接是正确的（A\B）。
 * ⇒ 所以要么是 CSV 本身有问题，要么是 PowerShell 解析时吃掉了反斜杠。
 *   不能再靠"看起来对不对"下结论，必须换一个独立解析器核对。
 *
 * 用法：node verify-csv.mjs <csv文件>
 */
import fs from 'node:fs';

const f = process.argv[2];
if (!f) { console.error('用法: node verify-csv.mjs <csv文件>'); process.exit(2); }

const buf = fs.readFileSync(f);
console.log('');
console.log('  ── 字节层 ──');
const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
console.log('    文件大小: ' + buf.length + ' 字节');
console.log('    前 3 字节: ' + Array.from(buf.subarray(0, 3)).map((x) => x.toString(16).padStart(2, '0')).join(' ') + '  ⇒ BOM: ' + bom);
const backslashCount = buf.filter((b) => b === 0x5C).length;
console.log('    反斜杠(0x5C)出现次数: ' + backslashCount);

const text = buf.toString('utf8').replace(/^\uFEFF/, '');
const lines = text.split(/\r?\n/).filter((l) => l !== '');
console.log('    行数: ' + lines.length + '（含表头）');

/* ── 一个不依赖任何库的 CSV 解析（处理双引号转义）── */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

const header = parseCsvLine(lines[0]);
console.log('');
console.log('  ── 结构 ──');
console.log('    列数: ' + header.length);
console.log('    列名: ' + header.join(' | '));

const rows = lines.slice(1).map(parseCsvLine);
console.log('    数据行: ' + rows.length);

/* ── 字段完整性 ── */
const idx = (name) => header.indexOf(name);
const iPath = idx('路径'), iName = idx('名称'), iFolder = idx('文件夹'), iState = idx('状态');

console.log('');
console.log('  ── 字段检查 ──');
let problems = 0;
for (const [label, i] of [['路径', iPath], ['名称', iName], ['状态', iState]]) {
  const missing = rows.filter((r) => !r[i] || r[i].trim() === '').length;
  const ok = missing === 0;
  if (!ok) problems++;
  console.log('    ' + (ok ? '\u2713' : '\u2717') + ' 每行都有' + label + '  (缺 ' + missing + ')');
}

/* ── 关键：路径里的反斜杠到底在不在 ── */
console.log('');
console.log('  ── 反斜杠检查（这次争议的核心）──');
const withBslash = rows.filter((r) => r[iPath] && r[iPath].includes('\\')).length;
const nested = rows.filter((r) => r[iPath] && r[iPath].split('\\').filter(Boolean).length > 1).length;
console.log('    路径含反斜杠的行: ' + withBslash + ' / ' + rows.length);
console.log('    路径有多级（说明分隔符生效）的行: ' + nested);
const sample = rows.find((r) => r[iPath] && r[iPath].split('\\').filter(Boolean).length > 1);
console.log('    多级路径样例: ' + (sample ? JSON.stringify(sample[iPath]) : '(无)'));

/* ── 一致性：路径应以名称结尾 ── */
console.log('');
console.log('  ── 一致性 ──');
const badEnd = rows.filter((r) => r[iPath] && r[iName] && !r[iPath].endsWith(r[iName])).length;
console.log('    ' + (badEnd === 0 ? '\u2713' : '\u2717') + ' 路径都以任务名结尾  (异常 ' + badEnd + ')');
if (badEnd) problems++;

const dupPaths = rows.length - new Set(rows.map((r) => r[iPath])).size;
console.log('    ' + (dupPaths === 0 ? '\u2713' : '!') + ' 路径唯一  (重复 ' + dupPaths + ')');

/* ── 按文件夹聚合，验证层级是否合理 ── */
const folders = new Map();
for (const r of rows) folders.set(r[iFolder] || '(根)', (folders.get(r[iFolder] || '(根)') || 0) + 1);
console.log('    文件夹数: ' + folders.size + '（根目录 ' + (folders.get('(根)') || 0) + ' 个任务）');

console.log('');
console.log('  ' + (problems === 0 ? '\u2713 CSV 通过全部检查' : '\u2717 CSV 有 ' + problems + ' 类问题'));
console.log('');
process.exit(problems === 0 ? 0 : 1);
