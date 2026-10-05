/* 全局审计.js —— 摘上游文件之前的那道工序（批次 0 的教训）：
   把"待摘文件定义过的全局量"拿去全项目搜一遍，看还有谁在读它。
   用法：node 工具/全局审计.js fadeOutInMusic checkForLoss fireworks
        默认扫 index.html + index.js + src/scripts/*.js + 游戏/*.js
*/
const fs = require('fs');
const path = require('path');

const 名字 = process.argv.slice(2);
if (!名字.length) { console.log('用法：node 工具/全局审计.js <名字…>'); process.exit(1); }

const ROOT = path.resolve(__dirname, '..');
function 收集(dir, out) {
  let 项;
  try { 项 = fs.readdirSync(dir); } catch (e) { return out; }
  for (const f of 项) {
    const p = path.join(dir, f);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) { if (f !== '备份' && f !== '上游源码' && f !== 'node_modules') 收集(p, out); }
    else if (/\.(js|html|mjs|css|py)$/.test(f)) out.push(p);
  }
  return out;
}
const 文件 = 收集(ROOT, []).filter((p) => !/[\\/](备份|上游源码|src[\\/]scripts[\\/]?(load|fps|snow|time|testing|pack_handler|window_focus)\.js)$/.test(p));

let 总数 = 0;
for (const n of 名字) {
  const 命中 = [];
  for (const p of 文件) {
    const 行 = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    行.forEach((l, i) => { if (l.indexOf(n) >= 0) 命中.push('  ' + path.relative(ROOT, p).replace(/\\/g, '/') + ':' + (i + 1) + ': ' + l.trim().slice(0, 120)); });
  }
  console.log('\n=== ' + n + '（' + 命中.length + ' 处）===');
  console.log(命中.length ? 命中.join('\n') : '  （没有任何引用 —— 可以摘）');
  总数 += 命中.length;
}
console.log('\n合计 ' + 总数 + ' 处引用');
