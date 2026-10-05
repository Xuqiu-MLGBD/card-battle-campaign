/* 关卡挑战版 · 权威状态层自测（node，无需浏览器）—— 2026-10-04 新增
 *
 * 为什么单独加这一套：状态层（`游戏/状态.js` 的 求差/应用/提交/对账）是架构改进 B 的核心，
 * 却**从来没有机器测试**。结果一个真缺陷活到了今天：`求差/应用` 是按引擎的形状写的
 * （`场上` 放 id、单位字段进 `单位` 映射），而界面交上来的是**对象数组** ——
 * 于是"把变更重放回旧状态"永远不等于新状态，`ATOMIC_VIOLATION` 在正常对局里乱报，
 * 而报告里只有 `{原因, revision}`，看不出差在哪。
 *
 * 这一套就盯两件事，缺一不可：
 *   ① **自洽**：正常的一局（上台 / 数值变化 / 下场 / 回合推进）提交后**不许有任何问题**，
 *      且 `应用(旧状态, 变更)` 必须逐字段等于新状态（"施工图能还原成品"）；
 *   ② **有牙**：真的对不上时必须报出来，而且上下文里要带**哪条路径**对不上。
 * 只有 ① 会让检查变成摆设；只有 ② 会让正常对局噪声不断 —— 两边都要有。
 *
 * 跑： node test_状态.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ ' + msg); } };
const section = (t) => console.log('\n== ' + t + ' ==');
const 稳 = (x) => JSON.stringify(x);

/* ---------------- 装载（状态层声明不碰 DOM，所以能直接装进 vm） ---------------- */
const ctx = vm.createContext({ console, JSON, Math, Object, Array, String, Number, isFinite, parseInt });
new vm.Script(fs.readFileSync(path.join(HERE, '游戏', '状态.js'), 'utf8'), { filename: '状态.js' }).runInContext(ctx);
const S = ctx.HS_STATE;

section('A 装载');
ok(!!S, 'HS_STATE 已导出');
['空', '求差', '应用', '提交', '对账', '追平', '展示追到', '读', '版本号', '日志', '重置']
  .forEach((k) => ok(typeof S[k] === 'function', `HS_STATE.${k} 是函数`));

/* ---------------- 一个会变的"场面"（模拟界面采集） ---------------- */
function 新场面() {
  return {
    回合: 1, 法力: 1, 法力上限: 1,
    单位: {},
    席位: { player: { 英雄血: 30, 场上: [] }, enemy: { 英雄血: 20, 场上: [] } },
    手牌: ['Alpha', 'Beta', 'Gamma']
  };
}
let 场面 = 新场面();
const 采 = () => JSON.parse(JSON.stringify(场面));
const 上台 = (id, 卡, 攻, 血) => {
  场面.单位[id] = { id, 卡, 攻, 血, 攻耗: 1, 恢复: 1 };
  场面.席位.player.场上.push(id);
};
const 下场 = (id) => {
  const k = 场面.席位.player.场上.indexOf(id);
  if (k >= 0) 场面.席位.player.场上.splice(k, 1);
  delete 场面.单位[id];
};
/** 提交一次并检查：无问题 + 变更能重放成新状态（返回 {r, 旧, 新}） */
function 提交并验(说明, 要求 = {}) {
  const 旧 = S.读();
  const 期 = 采();                                  // 交给状态层的"新状态"（revision 由状态层补）
  const r = S.提交(采, 说明);
  const 问题 = (r.问题 || []).map((x) => (typeof x === 'string' ? x : x.码));
  ok(问题.length === 0, `${说明}：提交后没有任何问题（实际：${问题.join('、') || '无'}）`);
  const 由变更重建 = S.应用(旧, r.变更);
  const 新 = S.读();
  const a = JSON.parse(JSON.stringify(由变更重建)), b = JSON.parse(JSON.stringify(新));
  a.revision = b.revision; a.展示revision = b.展示revision;
  ok(稳(a) === 稳(b), `${说明}：变更重放出来的状态**逐字段等于**新状态`);
  if (要求.变更含) 要求.变更含.forEach((类型) =>
    ok(r.变更.some((c) => c.类型 === 类型), `${说明}：变更里出现了「${类型}」`));
  if (要求.事件含) 要求.事件含.forEach((类型) =>
    ok(r.事件.some((e) => e.类型 === 类型), `${说明}：事件里出现了「${类型}」`));
  return { r, 旧, 新, 期 };
}

section('B 首次提交：整局一把梭（无旧状态）');
{
  const r = S.提交(采, '开局');
  ok(r.revision === 1, '第一版 revision = 1');
  ok((r.问题 || []).length === 0, '首次提交没有问题');
  ok(r.变更.some((c) => c.路径 && c.路径[0] === '整局'), '变更里有「置 整局」');
  ok(r.事件.some((e) => e.类型 === '开局'), '事件里有「开局」');
}

section('C 上场一只随从');
{
  S.重置();
  S.提交(采, '开局');
  上台('playerCardInPlay0', 'Ghoul', 2, 2);
  提交并验('上场', { 变更含: ['压入', '置'], 事件含: ['上场'] });
}

section('D 场上单位的数值变化（攻/血/攻耗/恢复）');
{
  场面.单位.playerCardInPlay0.血 = 1;
  场面.单位.playerCardInPlay0.恢复 = 0;
  const { r } = 提交并验('数值变化', { 事件含: ['单位变化'] });
  ok(r.变更.some((c) => c.类型 === '置' && c.路径[0] === '单位' && c.路径[1] === 'playerCardInPlay0'),
     '变更把这只随从的字段「置」到了 单位 映射上');
}

section('E 下场：抽出 id 之外，还必须删掉 单位 里那一份');
{
  下场('playerCardInPlay0');
  const { r } = 提交并验('下场', { 变更含: ['抽出', '删'], 事件含: ['下场'] });
  ok(r.变更.some((c) => c.类型 === '删' && c.路径[0] === '单位'),
     '（修复点）下场时连 单位 映射里那份一起删 —— 只抽 id 会让重放里留下尸体');
}

section('F 英雄血量与回合/法力');
{
  场面.席位.enemy.英雄血 = 14;
  场面.法力 = 3; 场面.法力上限 = 3; 场面.回合 = 2;
  提交并验('英雄掉血 + 回合推进', { 事件含: ['英雄血量变化', '回合变化', '法力变化', '法力上限变化'] });
}

section('G 场上换序：压入/抽出表达不了它，但整置一排能（不许当"不自洽"报出来）');
{
  上台('playerCardInPlay1', 'Boar', 1, 1);
  上台('playerCardInPlay2', 'Whelp', 1, 1);
  S.提交(采, '再上两只');
  const 原序 = 场面.席位.player.场上.slice();
  ok(原序.length >= 2, `换序前场上至少 2 只（实际 ${原序.length}）`);
  const 换序后 = 原序.slice();
  [换序后[0], 换序后[1]] = [换序后[1], 换序后[0]];
  场面.席位.player.场上 = 换序后;
  提交并验('换序', { 变更含: ['置'], 事件含: ['场上重排'] });
  ok(S.读().席位.player.场上.join() === 换序后.join(), '权威状态记下了新顺序');
}

section('H 有牙：变更丢了信息时，提交必须报 ATOMIC_VIOLATION 并指出哪条路径');
{
  /* 触发方式很直白：让采集器交一份"单位 映射里多出一只不在场上的随从"的状态。
     求差只会写"在场上"的家伙，于是重放出来必然少这一只 —— 这正是我们要它抓的东西。 */
  const 旧 = S.读();
  const 坏 = JSON.parse(JSON.stringify(采()));
  坏.单位.幽灵随从 = { id: '幽灵随从', 卡: 'X', 攻: 1, 血: 1, 攻耗: 1, 恢复: 1 };
  const r = S.提交(() => JSON.parse(JSON.stringify(坏)), '混进一只不在场上的单位');
  const 码 = (r.问题 || []).map((x) => (typeof x === 'string' ? x : x.码));
  ok(码.indexOf('ATOMIC_VIOLATION') >= 0, '重放对不上时报 ATOMIC_VIOLATION');
  const 条 = (r.问题 || []).filter((x) => x && x.码 === 'ATOMIC_VIOLATION')[0];
  ok(!!条 && !!(条.上下文 && 条.上下文.差异 && 条.上下文.差异.length),
     '问题里带**差异路径**（不是只有 {原因, revision}）');
  ok(!!条 && 稳(条.上下文.差异).indexOf('幽灵随从') >= 0, '差异路径点名了那只多出来的单位');
  /* 把权威拉回正常（否则后面的断言都在一份脏状态上） */
  S.重置();
  场面 = 新场面();
  上台('playerCardInPlay0', 'Ghoul', 2, 2);
  S.提交(采, '重新开始');
  ok((S.提交(采, '再采一次').问题 || []).length === 0, '重新开始后又回到零噪声');
}

section('I 对账：非提交点的变化必须现形');
{
  const 干净 = S.对账(采);
  ok(干净.length === 0, '提交刚做完时对账是干净的');
  场面.单位.playerCardInPlay0.血 = 9;                 // 模拟"演出/别人偷改了血量"
  const 差 = S.对账(采);
  ok(差.some((x) => String(x.项).indexOf('playerCardInPlay0') === 0), '某只随从的数值被改 → 对账抓到它');
  场面.单位.playerCardInPlay0.血 = 2;                 // 改回来
  ok(S.对账(采).length === 0, '改回来后对账又干净了');
}

section('J 追平与版本号');
{
  const 记 = [];
  const v0 = S.版本号();
  ok(S.追平((权) => 记.push(权)), '追平() 调用了画笔');
  ok(记.length === 1 && 记[0].revision === v0.revision, '画笔拿到的是权威状态本身');
  const v1 = S.版本号();
  ok(v1.展示revision === v1.revision, '追平之后 展示revision = revision（"跳过动画"= 强制同步）');
  S.展示追到(0);
  ok(S.版本号().展示revision === 0, '展示追到(0) 能把展示版本退回去（演出可以滞后）');
  S.展示追到(999);
  ok(S.版本号().展示revision <= S.版本号().revision, '展示版本永远不超过权威版本');
}

section('K 日志：可读、带原因、可回放');
{
  const 日志 = S.日志(5);
  ok(Array.isArray(日志) && 日志.length > 0, '日志非空');
  ok(日志.every((x) => typeof x.revision === 'number' && typeof x.原因 === 'string'), '每条都有 revision 与原因');
  ok(日志.every((x) => Array.isArray(x.变更) && Array.isArray(x.事件)), '每条都带变更与事件（可回放）');
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
