/* 关卡挑战版 · 文案映射层（游戏/文案.js —— 架构改进 A：拒绝结构化）
 * ==========================================================================
 * 照那份流程图的这一条：
 *
 *      StateReducer 验证失败 → RuleError{ code, context } → **UI 文案映射层**
 *        → 本地化文案 → 玩家看到的提示          （日志只记 code + context）
 *
 * 为什么要单独一层：在此之前，**"拒绝"是散落在各处的裸中文字符串** ——
 * 引擎里 28 处 `否('场地已满（上限 5）')`、界面里 `闪提示('这一格已经有随从了…')`，
 * 谁想改口径就得满仓库找；而且**日志/回放/本地化都拿不到稳定的东西**（字符串会变）。
 * 现在统一成：**码（机器）+ 模板（人）**，模板只在这一个文件里维护。
 *
 * 两条硬规矩（都有机器检查）：
 *   ① 引擎/界面里**不许再拼给玩家看的中文** —— 一律走 `提示码(码, 上下文)`（自检 ㉛ 抽样验"拒绝带码"）；
 *   ② 模板里的占位符写成 `{名字}`，取值一律 `String(上下文[名字])`，缺失就退化成一个占位说明
 *      （宁可显示「?」也不要 NaN/undefined 露给玩家）。
 */
(function (W) {
  'use strict';
  if (W.HS_TEXT) return;

  /* 码 → 中文模板。**这一层是"玩家看到的话"的唯一出处**；码本身在 引擎.js 的码表里生成。 */
  var 表 = {
    BAD_COMMAND: '这个操作不成立',
    MATCH_OVER: '这一局已经结束了',
    NO_PENDING_CHOICE: '现在没有要选的东西',
    NOT_YOUR_CHOICE: '现在不该你来选',
    TARGET_NOT_ALLOWED: '这个目标不能选',
    CHOICE_PENDING: '先把手上的选择做完',
    NOT_YOUR_PRIORITY: '现在不是你行动',
    ONCE_PER_TURN: '行动限本回合：现在是 {主动方} 的回合',
    WRONG_PHASE: '这个阶段不能行动',
    CARD_NOT_IN_HAND: '这张牌不在手上',
    BOARD_FULL: '这一格已经有随从了{后缀}',
    BOARD_FULL_DEPLOY: '{方}战场已满',
    INSUFFICIENT_MANA: '法力不够：{卡} 要 {需} 点，你只有 {有} 点',
    BAD_SLOT: '那一格不能放',
    ATTACKER_GONE: '攻击的单位已经不在场了',
    NOT_YOUR_MINION: '那不是你的随从',
    MINION_CANT_ATTACK: '这个随从这回合不能攻击（刚上场，或者已经打过了）',
    FROZEN: '被冻结的随从不能攻击',
    ZERO_ATTACK: '攻击力为 0，打不出伤害',
    NO_TARGET: '先选一个目标',
    TARGET_GONE: '目标已经不在场了',
    CANT_HIT_OWN: '不能打自己的随从',
    CANT_HIT_OWN_HERO: '不能打自己的英雄',
    BAD_TARGET_KIND: '这种目标还不认识',
    TAUNT_FIRST: '对面有嘲讽随从，必须先打它',
    HERO_POWER_USED: '这个回合已经用过英雄技能了',
    UNKNOWN_COMMAND: '这个操作还不认识',
    UNKNOWN: '这个操作不成立（{原因}）',
    /* 全链路检错那几种（游戏/检错.js）里"要露给玩家看"的几个。
       其余（决策响应畸形 / 展示残留 / 动画写状态…）是**记录级**的：只在诊断报告里出现，
       不该刷到玩家脸上 —— 那是"用户行为噪声"，不是他的错。 */
    META_INCOMPLETE: '这张「{卡}」认不出来，先别出它',
    UI_INVALID_INPUT: '这个操作没落在能操作的地方',
    DECISION_INVALID: '这个选项不合法',
    SKELETON_INCOMPLETE: '牌桌没装配完整（{缺}），请重新打开卡片',
    MODULE_MISSING: '有模块没装上（{缺}）'
  };

  /* 取中文：模板里的 {名字} 用上下文替换；缺失的占位符退化成「?」而不是 undefined */
  function 取(码, 上下文) {
    var t = 表[码] || 表.UNKNOWN;
    var s = String(t).replace(/\{([^}]+)\}/g, function (_, 名) {
      var v = 上下文 ? 上下文[名] : undefined;
      return (v === undefined || v === null || v === '') ? '?' : String(v);
    });
    if (码 && !表[码] && 上下文 && 上下文.原因) s = String(t).replace('{原因}', String(上下文.原因));
    return s;
  }

  /* 有没有这个码（自检用：码表与文案表必须对齐，缺一条就是回归） */
  function 有(码) { return Object.prototype.hasOwnProperty.call(表, 码); }
  function 全部码() { return Object.keys(表); }
  function 表内容() { return 表; }

  W.HS_TEXT = { 版本: 1, 取: 取, 有: 有, 全部码: 全部码, 表: 表内容 };
})(typeof window !== 'undefined' ? window : globalThis);
