/* 工具/跑全部测试.mjs —— 跑完所有 test_*.mjs 并汇总（一条命令看清"现在是不是绿的"）。
 *
 * 为什么要它：套数会继续涨（现在是 5 套：引擎 / 关卡 / 对照 / 状态 / 关卡数据），
 * 一条条敲容易漏，也容易只跑"上次红的那套"。这个入口扫一遍 test_*.mjs，逐套报告，
 * 有红就非零退出 —— 可以直接接进别处的闸门。
 *
 * 用法：
 *   node 工具/跑全部测试.mjs          # 跑全部
 *   node 工具/跑全部测试.mjs 状态      # 只跑名字里含"状态"的（子串匹配）
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const 根 = path.dirname(HERE);
const 筛 = process.argv[2] || "";

const 套 = fs.readdirSync(根)
  .filter((f) => /^test_.*\.mjs$/.test(f))
  .filter((f) => !筛 || f.indexOf(筛) >= 0)
  .sort();

if (!套.length) {
  console.error("[测试] 没有匹配的 test_*.mjs（筛子：" + 筛 + "）");
  process.exit(2);
}

let 总过 = 0, 总败 = 0, 红套 = [];
const 详情 = [];
for (const f of 套) {
  const r = spawnSync(process.execPath, [f], { cwd: 根, encoding: "utf8" });
  const 出 = (r.stdout || "") + (r.stderr || "");
  // 每套自己会打印「结果：N 项通过，M 项失败」
  const m = /结果：(\d+)\s*项通过，(\d+)\s*项失败/.exec(出);
  const 过 = m ? Number(m[1]) : 0;
  const 败 = m ? Number(m[2]) : (r.status === 0 ? 0 : 1);
  总过 += 过;
  总败 += 败;
  if (r.status !== 0 || !m) 红套.push(f);
  详情.push(`  ${r.status === 0 && m ? "✓" : "✗"} ${f.padEnd(22)} ${m ? 过 + " 通过 / " + 败 + " 失败" : "**跑不起来**（退出码 " + r.status + "）"}`);
}

console.log("[测试] " + 套.length + " 套：");
详情.forEach((x) => console.log(x));
console.log("[测试] 合计 " + 总过 + " 项通过，" + 总败 + " 项失败" + (红套.length ? "（红：" + 红套.join("、") + "）" : " —— 全绿"));
if (总败 || 红套.length) {
  // 红的套把它的失败行原样打出来，省得再跑一次
  for (const f of 红套) {
    const r = spawnSync(process.execPath, [f], { cwd: 根, encoding: "utf8" });
    const 行 = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/).filter((l) => /✗|Error|错误/.test(l)).slice(0, 12);
    if (行.length) { console.log("\n[" + f + "]"); 行.forEach((l) => console.log("  " + l.trim())); }
  }
  process.exit(1);
}
