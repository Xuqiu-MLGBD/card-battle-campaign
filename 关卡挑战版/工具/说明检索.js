/* 说明检索.js —— 在说明/里找一句话（findstr 是 ANSI 的，中文文件名与中文模式都会翻车，
   这个用 node 的 UTF-8 读，稳）。用法：
     node 工具/说明检索.js 部署位            # 默认找 说明/ 目录
     node 工具/说明检索.js 部署位 说明 游戏   # 指定目录（可给多个）
*/
const fs = require('fs');
const path = require('path');

const 模式 = process.argv[2];
const 目录 = process.argv.slice(3);
if (!模式) { console.log('用法：node 工具/说明检索.js <正则> [目录…]'); process.exit(1); }
const 目标 = 目录.length ? 目录 : ['说明'];
const re = new RegExp(模式);

for (const dir of 目标) {
  let 文件;
  try { 文件 = fs.readdirSync(dir); } catch (e) { console.log('（跳过 ' + dir + '：' + e.message + '）'); continue; }
  for (const f of 文件) {
    const p = path.join(dir, f);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (!/\.(md|js|css|html|json|py|mjs)$/.test(f)) continue;
    const 行 = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    行.forEach((l, i) => {
      if (re.test(l)) console.log(p.replace(/\\/g, '/') + ':' + (i + 1) + ': ' + l.trim().slice(0, 160));
    });
  }
}
