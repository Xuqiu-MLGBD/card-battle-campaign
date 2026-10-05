/* 工具/生成卡表基线.mjs —— 把"上游卡表数值"冻成一份数据基线（工具/上游卡表基线.json）。
 *
 * 为什么要这一步（2026-10-04）：
 *   卡表是**我们自己抄的一份数值**（`游戏/卡库.js` 丙段），所以 `test_levels.mjs` 的 G 段要
 *   逐张与上游核对 —— 这是"手抄有没有抄错"唯一的机器保障。可上游那份对照物 `deck.js`
 *   已经**不再随工程分发**（去依赖执行表里已完成的一步），测试于是直接 ENOENT 崩掉。
 *   正确做法不是把对照物请回来，而是把它**变成我们自己的数据**：
 *   一张 name → {费,攻,血} 的表 + 来源文件的 sha256（可审计"这份基线是从哪一版抽的"）。
 *   数值是事实数据，不含表达 —— 于是这份基线可以随工程与展示包一起走，测试从此自包含。
 *
 * 用法：node 工具/生成卡表基线.mjs [上游镜像目录]
 *   默认 ../上游源码/hearthstone-web（开发树里那份 71 MB 镜像；展示包里没有它也没关系，
 *   基线已经生成好了，重算才需要镜像）。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const 工程根 = path.dirname(HERE);
const 镜像 = process.argv[2] || path.join(工程根, "..", "上游源码", "hearthstone-web");
const 源文件 = path.join(镜像, "deck.js");
const 产物 = path.join(HERE, "上游卡表基线.json");

if (!fs.existsSync(源文件)) {
  console.error("[基线] ✗ 找不到对照物：" + 源文件);
  console.error("       只有**重算**基线才需要它；工程里已生成好的 " + path.basename(产物) + " 不受影响。");
  process.exit(1);
}

const 原文 = fs.readFileSync(源文件, "utf8");
const sha = crypto.createHash("sha256").update(原文, "utf8").digest("hex");

/* 装进一个最小上下文：deck.js 只定义数据与几个工厂函数，不会碰 document。
   桩里给 location 是因为卡库.js 会读它 —— 这里不装卡库，但保持与测试同一套桩，少一个坑。 */
const ctx = vm.createContext({ console, Math, JSON, Object, Array, Error, String, Number,
                              location: { search: "", pathname: "/", href: "/" } });
try {
  new vm.Script(原文, { filename: "deck.js" }).runInContext(ctx);
} catch (e) {
  console.error("[基线] ✗ deck.js 装不进来：" + e.message);
  process.exit(1);
}
if (typeof ctx.freshDeck !== "function") {
  console.error("[基线] ✗ deck.js 装上了却没有 freshDeck —— 对照物换版本了？");
  process.exit(1);
}

const 卡 = {};
for (const c of ctx.freshDeck()) {
  if (!c || !c.name) continue;
  卡[c.name] = { 费: c.mana, 攻: c.attack, 血: c.health };
}
/* 上游有一张死数据：deck.js 定义了 Bloodfen Raptor 却从没放进返回数组。
   我们照收它（连数据一起接管），所以这里显式补上 —— 否则 G 段会把它算成"表里有、上游没有"。 */
if (!卡["Bloodfen Raptor"]) 卡["Bloodfen Raptor"] = { 费: 2, 攻: 3, 血: 2, 备注: "上游死数据：进了卡表、没进牌组" };

const 出 = {
  说明: "上游卡表数值基线（name → 费/攻/血）。由 工具/生成卡表基线.mjs 从 deck.js 抽出；" +
        "只含数值事实，不含任何表达。test_levels.mjs 的 G 段用它逐张核对我们的 游戏/卡库.js。",
  来源: "上游源码/hearthstone-web/deck.js（不随包分发）",
  来源sha256: sha,
  张数: Object.keys(卡).length,
  卡,
};
fs.writeFileSync(产物, JSON.stringify(出, null, 2) + "\n", "utf8");
console.log("[基线] ✓ " + 产物);
console.log("[基线]   " + 出.张数 + " 张 · 对照物 sha256 " + sha.slice(0, 16) + "…");
