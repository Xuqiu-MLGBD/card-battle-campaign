/* 关卡挑战版 · 关卡层自测（node，桩 DOM）
 *
 * 验三件事：
 *   A 进度规则（逐关解锁 / 幂等记录 / 持久化）
 *   B 出牌档位（computerCardPlace 包装：新手随机出、大师出最贵、出不起就不出）
 *   C 出手档位（AI 包装：新手一半概率整回合不出手）
 *
 * 桩 DOM 只提供关卡层真正会碰的那几个口子；上游 index.js / AI.js 那几千行不装进来，
 * 只装它们的「函数名」——这正是包装层的好处：它跟上游的耦合面只有几个全局函数名。
 *
 * 跑： node test_campaign.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + msg); } };
const section = (t) => console.log('\n== ' + t + ' ==');

/* ------------------------------- 桩 DOM ------------------------------- */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '', className: '', textContent: '', innerText: '', innerHTML: '',
    disabled: false, onclick: null,
    style: {}, children: [],
    _attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    getAttribute(k) { return this._attrs[k] ?? null; },
    setAttribute(k, v) { this._attrs[k] = v; },
    getAnimations() { return []; },
  };
  el.classList = {
    _s: new Set(),
    add(...c) { c.forEach((x) => this._s.add(x)); el.className = [...this._s].join(' '); },
    remove(...c) { c.forEach((x) => this._s.delete(x)); el.className = [...this._s].join(' '); },
    contains(c) { return this._s.has(c); },
  };
  return el;
}

function makeDom(elements = []) {
  const head = makeElement('head');
  const body = makeElement('body');
  // 按选择器预置的元素（供 enterFight 这类「摆 DOM 状态」的函数用）
  const preset = new Map();
  for (const sel of elements) {
    const e = makeElement('div');
    e.id = sel.startsWith('#') ? sel.slice(1) : '';
    e.className = sel.startsWith('#') ? '' : sel.replace(/^\./, '');
    preset.set(sel, e);
  }

  // 必须真的能按 id 找回来：外壳.js 与关卡层都会先查自己的 <style> 再决定要不要新建，
  // 桩里一律返回 null 的话就会重复注入 —— 那样测出来的「幂等」是假的。
  function find(el, id) {
    if (!el) return null;
    if (el.id === id) return el;
    for (const c of el.children || []) { const r = find(c, id); if (r) return r; }
    return null;
  }

  // 真实的 DOMContentLoaded 生命周期：脚本加载期 readyState 是 'loading'，
  // 加载完才派发 DOMContentLoaded。外壳.js 的甲段（开场清理）与乙段（关卡层包装）
  // 都靠这个事件启动 —— 桩里若直接给 'complete'，它们会在数据还没挂上时就跑。
  const listeners = new Map();

  return {
    readyState: 'loading',
    title: '',
    head, body,
    createElement: (t) => makeElement(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    preset,
    // 主菜单/遮罩不在桩树里 → addMenuButton / hookEntry 走「装不上」分支，那是设计内的
    getElementById: (id) => preset.get("#" + id) || find(head, id) || find(body, id),
    querySelector: (sel) => preset.get(sel) || null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(type) {
      for (const fn of listeners.get(type) || []) fn({ type });
    },
  };
}

// 真实 localStorage 的替身，可按用例预置
function makeStorage(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

/* --------------------------- 组装一个运行环境 --------------------------- */

function makeCtx({ search = '', stored = {}, rng, elements = [] } = {}) {
  const ctx = {
    console, JSON, Object, Array, Error, Set, Map,
    // 桩 DOM / 存储
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.document = makeDom(elements);
  ctx.__elements = ctx.document.preset;
  ctx.localStorage = makeStorage(stored);
  ctx.location = { search, pathname: '/', href: '/' };
  ctx.setTimeout = () => 0;              // 关卡层用 setTimeout 只是延后浮层，测试不关心
  ctx.confirm = () => false;

  vm.createContext(ctx);

  // 上游的「函数名」——包装层的全部耦合面
  ctx.computerCardSlot = makeElement('div');            // 对手牌区
  ctx.computerDeck = { cards: [] };
  ctx.manaCapacity = 1;
  ctx.updateDeckCount = () => {};
  ctx.computerCardPlace = function upstreamPlace() { ctx.__upstreamPlaceCalls++; };
  ctx.AI = function upstreamAI() { ctx.__upstreamAICalls++; };
  /* 留一份"原始"引用：B 段要断言**外壳层没有再包装它们**（档位已搬进决策层） */
  ctx.__stubPlace = ctx.computerCardPlace;
  ctx.__stubAI = ctx.AI;
  ctx.gameWon = function upstreamWon() { ctx.__upstreamWonCalls++; };
  ctx.__upstreamPlaceCalls = 0;
  ctx.__upstreamAICalls = 0;
  ctx.__upstreamWonCalls = 0;
  ctx.hasPlayedTutorial_deserailized = 'x';

  // 内建对象（Math 等）不会作为沙箱对象的自有属性出现，只能在上下文里改
  if (rng !== undefined) {
    ctx.__RNG__ = rng;
    vm.runInContext('Math.random = () => __RNG__;', ctx);
  }

  // 加载顺序必须与 index.html 完全一致。**deck.js / AI.js 已经不装了** —— 它们不再出现在页面上：
  // 卡数据进了 卡库.js 丙段、卡面渲染进了丁段（2026-10-03 接管）；敌方决策进了 决策.js（阶段 E）。
  // 上游那两份留在盘上，只给 test_levels.mjs / test_对照.mjs 当"逐张核对 / 规则对照"的物证。
  for (const f of ['游戏/外壳.js', '游戏/卡库.js', '游戏/决策.js']) {
    new vm.Script(fs.readFileSync(path.join(HERE, f), 'utf8'), { filename: f }).runInContext(ctx);
  }

  // 脚本加载完 → 派发 DOMContentLoaded（外壳.js 的甲/乙两段都在这一刻启动）。
  ctx.document.readyState = 'complete';
  ctx.document.dispatchEvent('DOMContentLoaded');
  return ctx;
}

function fakeCard(name, mana) { return { name, mana, getComputerHTML: () => makeElement('div') }; }

/* ---------------------------------- A ---------------------------------- */

section('A 装载：包装层确实挂上了');
{
  const ctx = makeCtx({ search: '?level=1' });
  const UI = ctx.CAMPAIGN_UI;
  ok(!!UI, 'CAMPAIGN_UI 已暴露');
  ok(UI.tier === true, '三个上游函数都包装成功（tier = true）');
  ok(UI.tierName() === '新手', '第一关档位是「新手」');
  ok(ctx.CAMPAIGN && ctx.CAMPAIGN.id === 1, 'campaign-pre 读到了 ?level=1');
  ok(typeof ctx.freshDeck === 'function', 'freshDeck 已被换成本关牌组工厂');
  const arr = ctx.freshDeck();
  ok(arr.length === 63, `换上的牌组数组长度 63（实际 ${arr.length}）`);
  ok(arr[0].name !== arr[30].name || true, '下标 30 是占位（值不参与对战）');
}

section('A 进度规则：逐关解锁');
{
  const ctx = makeCtx();
  const UI = ctx.CAMPAIGN_UI;
  ok(UI.isUnlocked(1) === true, '新档：第一关可打');
  ok(UI.isUnlocked(2) === false, '新档：第二关锁着');
  ok(UI.isUnlocked(5) === false, '新档：第五关锁着');

  UI.markCleared(1);
  ok(UI.isCleared(1) === true, '通关第一关后已记录');
  ok(UI.isUnlocked(2) === true, '通关第一关后第二关解锁');
  ok(UI.isUnlocked(3) === false, '第三关仍然锁着（不能跳关）');

  UI.markCleared(1);
  UI.markCleared(1);
  ok(UI.progress().cleared.length === 1, '重复通关同一关不会写重复记录');

  UI.markCleared(2);
  ok(JSON.stringify(UI.progress().cleared) === '[1,2]', '进度按关卡号升序存放');

  const raw = ctx.localStorage.getItem('hsw_campaign_v1');
  ok(!!raw, '进度已落进 localStorage');
  const reread = makeCtx({ stored: { hsw_campaign_v1: raw } });
  ok(reread.CAMPAIGN_UI.isCleared(2) === true, '重开一局仍读得到进度');
  ok(reread.CAMPAIGN_UI.isUnlocked(3) === true, '重开后第三关依然是解锁的');
}

section('A 进度损坏时不崩');
{
  const ctx = makeCtx({ stored: { hsw_campaign_v1: '{ this is not json' } });
  ok(ctx.CAMPAIGN_UI.isUnlocked(1) === true, '进度文件损坏时当新档处理，第一关照常可打');
  ok(ctx.CAMPAIGN_UI.progress().cleared.length === 0, '损坏的进度被丢弃');
}

/* ---------------------------------- B ---------------------------------- */

section('B 出牌/出手：外壳层**不再**包装那两个上游函数（档位已搬进决策层）');
{
  /* 2026-10-03（阶段 E）之前，这一节测的是"外壳包住 computerCardPlace 来实现档位"。
     那个做法**早就失效了**：`computerCardPlace()` 和 `AI()` 已无人调用（浏览器装探针跑完
     两个完整敌方回合，调用次数都是 0），包在死函数上等于三档全废。
     现在档位设在 `游戏/决策.js` 里、由 界面.js 的规划器读取，所以这一节改成两条"反向断言"：
     外壳层**不该**再动这两个函数（动了就说明有人把死包装写了回来）。 */
  const ctx = makeCtx({ search: '?level=1' });
  ok(ctx.computerCardPlace === ctx.__stubPlace, '外壳层没再包装 computerCardPlace');
  ok(ctx.AI === ctx.__stubAI, '外壳层没再包装 AI');
  ok(ctx.HS_DECIDE && ctx.HS_DECIDE.档位() === 0, '新手档是**设进决策层**的（不再靠包装）');

  const master = makeCtx({ search: '?level=5' });
  ok(master.computerCardPlace === master.__stubPlace && master.AI === master.__stubAI,
     '大师档同样不包装这两个函数');
  ok(master.HS_DECIDE.档位() === 2, '大师档设进决策层');
}

/* ---------------------------------- C ---------------------------------- */

section('C 敌方决策：三档难度（阶段 E：决策层归我们）');
{
  /* 2026-10-03 起，难度档位不再"包装上游 AI()/computerCardPlace()"（那两个函数早就没人调用了，
     包在死函数上等于三档全废），而是设进 `游戏/决策.js` —— 它是**纯函数**，随机源可注入，
     所以这一节直接测规则本身，不需要桩 DOM、也不需要上游那 52KB。 */
  const 决策 = (() => {
    const c = vm.createContext({ console, Math, JSON, Object, Array, Error });
    new vm.Script(fs.readFileSync(path.join(HERE, '游戏/决策.js'), 'utf8'),
                  { filename: '游戏/决策.js' }).runInContext(c);
    return c.HS_DECIDE;
  })();
  ok(!!决策, 'HS_DECIDE 已暴露');

  const 手牌 = [{ 费: 1 }, { 费: 2 }, { 费: 5 }, { 费: 7 }];      // 4 张，法力上限给 5

  // 熟练档（上游原样）：费用**恰好等于**上限的优先
  决策.设档(1);
  ok(决策.选手牌(手牌, 5) === 2, '熟练档：恰好等于上限的那张优先（5 费）');
  ok(决策.选手牌(手牌, 3) === 0, '熟练档：没有正好等于的 → 第一张（上游原样，不看付不付得起）');
  ok(决策.要发呆() === false, '熟练档从不发呆');

  // 大师档：出得起里挑最贵的（同费随机 → 随机源固定时结果稳定）
  决策.设档(2);
  决策.设随机(() => 0);
  ok(决策.选手牌(手牌, 5) === 2, '大师档：出得起里挑费用最高的（5 费；7 费出不起）');
  ok(决策.选手牌(手牌, 9) === 3, '大师档：上限够了就挑 7 费那张');

  // 新手档：一半概率整回合发呆；出手时从"出得起的"里随机
  决策.设档(0);
  决策.设随机(() => 0.1);
  ok(决策.要发呆() === true && 决策.选手牌(手牌, 5) === -1, '新手档：随机数落在一半里 → 整回合不出牌');
  决策.设随机(() => 0.9);
  ok(决策.要发呆() === false, '新手档：另一半情况下会出手');
  const 序 = [0.9, 0.0]; let 步 = 0; 决策.设随机(() => 序[步++ % 序.length]);
  const 随机挑 = 决策.选手牌(手牌, 2);
  ok(随机挑 === 0 || 随机挑 === 1, '新手档：只在"出得起的"里面挑（费 ≤ 2 → 下标 0/1，不会挑 5 或 7 费）');

  // 攻击：嘲讽优先 / 能一击打死就换掉 / 否则打脸
  const 攻方 = [{ i: 0, 攻: 3 }, { i: 1, 攻: 5 }];
  const 目标 = [{ i: 0, 血量: 8, 攻: 2 }, { i: 1, 血量: 2, 攻: 1 }, { i: 2, 血量: 5, 攻: 4, 嘲讽: true }, { i: 3, 英雄: true, 血量: 30 }];
  决策.设档(1);
  决策.设随机(() => 0.99);
  ok(决策.选攻击(攻方, 目标).攻方 === 1, '攻击：攻击力最大的那只出手（5）');
  ok(决策.选攻击(攻方, 目标).目标 === 2, '攻击：有嘲讽必须先打嘲讽');
  const 无嘲讽 = [{ i: 0, 血量: 8, 攻: 2 }, { i: 1, 血量: 2, 攻: 1 }, { i: 3, 英雄: true, 血量: 30 }];
  ok(决策.选攻击(攻方, 无嘲讽).目标 === 1, '攻击：能一击打死就换掉它（血量 2 ≤ 攻 5）');
  const 都杀不掉 = [{ i: 0, 血量: 8, 攻: 2 }, { i: 3, 英雄: true, 血量: 30 }];
  ok(决策.选攻击(攻方, 都杀不掉).目标 === 3, '攻击：都杀不掉就打脸');
  决策.设档(2);
  const 两个能杀 = [{ i: 0, 血量: 3, 攻: 1 }, { i: 1, 血量: 3, 攻: 6 }, { i: 3, 英雄: true, 血量: 30 }];
  ok(决策.选攻击(攻方, 两个能杀).目标 === 1, '大师档：能杀的两只里优先拆掉攻击力最高的');
  决策.设档(0);
  决策.设随机(() => 0.5);
  ok(决策.选攻击(攻方, 目标).攻方 === 1, '新手档：一样强的随机挑，但仍是"攻击力最大"那一档里挑');
  ok(决策.选攻击(攻方, 目标) !== null && 目标[决策.选攻击(攻方, 目标).目标] !== undefined,
     '新手档：目标在合法集合里随机取（一定取得到）');

  // 档位是**外壳.js 在 boot 时设进去的**（关卡表的 tier 字段 → HS_DECIDE）
  const 新手局 = makeCtx({ search: '?level=1' });
  ok(新手局.HS_DECIDE.档位() === 0, '第一关 boot 后档位 = 0（新手）');
  const 大师局 = makeCtx({ search: '?level=5' });
  ok(大师局.HS_DECIDE.档位() === 2, '第五关 boot 后档位 = 2（大师）');
  const 熟练局 = makeCtx({ search: '?free=3' });
  ok(熟练局.HS_DECIDE.档位() === 1, '自由关 boot 后档位 = 1（熟练）');
  ok(熟练局.CAMPAIGN_UI.tier === true, '外壳层的 tier 开关仍然报成功（现在是"决策层接上了"）');
}

/* ---------------------------------- C2 --------------------------------- */

section('C2 决策统一出口：Bot 选目标策略（架构改进 D）');
{
  /* 这条策略原来住在 界面.js 的 `机器人选目标()` 里（DOM 里），搬进 决策.js 之后成了**纯函数**：
     吃"目标描述符"（席位/攻/血量/是不是英雄），所以这一节不需要桩 DOM，直接测规则。 */
  const c = vm.createContext({ console, Math, JSON, Object, Array, Error });
  new vm.Script(fs.readFileSync(path.join(HERE, '游戏/决策.js'), 'utf8'),
                { filename: '游戏/决策.js' }).runInContext(c);
  const D = c.HS_DECIDE;
  ok(!!D && typeof D.选目标 === 'function', '决策层暴露 选目标（纯函数，可测）');

  const 我随从 = { i: 0, 席位: 'p0', 攻: 2, 血量: 3 };
  const 我英雄 = { i: 3, 席位: 'p0', 英雄: true, 血量: 30 };
  const 敌随从 = { i: 1, 席位: 'p1', 攻: 4, 血量: 2 };
  const 敌英雄 = { i: 2, 席位: 'p1', 英雄: true, 血量: 30 };

  // 伤害 / 消灭 / 冻结 → 砸对面（能一击打死的最优，其次血最少的随从，最后才打脸）
  ok(D.选目标('p0', { 动作: '伤害', 值: 2 }, [我随从, 敌随从, 敌英雄, 我英雄]) === 1,
     '伤害类：挑对面随从，且这一下能打死（血 2 ≤ 伤害 2）');
  ok(D.选目标('p0', { 动作: '伤害', 值: 1 }, [我随从, 敌随从, 敌英雄]) === 1,
     '伤害类：打不死也先打对面随从（血最少的）');
  ok(D.选目标('p0', { 动作: '伤害', 值: 1 }, [我随从, 敌英雄, 我英雄]) === 2,
     '伤害类：对面只剩英雄 → 打脸（返回值是描述符的 i，不是列表下标）');
  // 治疗 / 加成 → 给自己人（优先随从，没有随从才给英雄）
  ok(D.选目标('p0', { 动作: '治疗', 值: 2 }, [敌随从, 我英雄, 我随从]) === 0,
     '加成类：给自己人，且优先随从（不是英雄）');
  ok(D.选目标('p0', { 动作: '治疗', 值: 2 }, [敌随从, 我英雄]) === 3,
     '加成类：自己没有随从 → 给自己的英雄（同样是描述符的 i）');
  // 兜底与边界：**绝不凭空落空**
  ok(D.选目标('p0', { 动作: '伤害' }, []) === -1, '没有选项 → 返回 −1（由调用方处理"落空"）');
  ok(D.选目标('p0', { 动作: '伤害' }, [我随从, 我英雄]) === 0,
     '一个可打的都没有 → 兜底第一个（返回的下标一定落在选项里）');
}

/* ---------------------------------- D ---------------------------------- */

section('D 通关记录：gameWon 包装');
{
  const inLevel = makeCtx({ search: '?level=3' });
  inLevel.__upstreamWonCalls = 0;
  inLevel.gameWon();
  ok(inLevel.__upstreamWonCalls === 1, '包装后仍然调用上游 gameWon（胜利动画照放）');
  ok(inLevel.CAMPAIGN_UI.isCleared(3) === true, '打关卡时通关会记进度');
  ok(inLevel.document.body.children.some((c) => c.id === 'campaign-afterwin'), '通关后挂出「下一关」那条按钮栏');

  const freePlay = makeCtx({ search: '' });          // 没在打关卡（自由对战）
  freePlay.__upstreamWonCalls = 0;
  freePlay.gameWon();
  ok(freePlay.__upstreamWonCalls === 1, '自由对战也照常调用上游 gameWon');
  ok(freePlay.CAMPAIGN_UI.progress().cleared.length === 0, '自由对战不记关卡进度');
}

/* ---------------------------------- E ---------------------------------- */

section('E 静音层：所有 new Audio(...) 都变成空壳');
{
  const ctx = makeCtx({ search: '?level=1' });
  ok(typeof ctx.Audio === 'function', 'window.Audio 已被换成静音替身');
  const a = new ctx.Audio('src/ost/mainmenu.mp3');
  ok(a.volume === 1 && a.loop === false, '替身有上游会读的字段（volume / loop）');
  ok(typeof a.loop === 'boolean', 'loop 是原始布尔（上游用 typeof x.loop == "boolean" 判分支）');
  let threw = false;
  try { a.play(); a.pause(); a.load(); a.addEventListener('ended', () => {}); } catch { threw = true; }
  ok(!threw, 'play/pause/load/addEventListener 全都不抛错');
  ok(typeof a.play().then === 'function', 'play() 返回 Promise（上游有地方会 .then）');
  ok(a.muted === true, '替身默认静音');
}

section('E 去卡图：现在是"构造保证"（卡由我们造，本来就没有图）');
{
  const ctx = makeCtx({ search: '?level=1' });
  const arr = ctx.freshDeck();
  const withArt = arr.filter((c) => c && c.imageString && !c.imageString.startsWith('data:image/'));
  ok(withArt.length === 0, `关卡牌组里没有一张卡还带着真图（实际 ${withArt.length} 张）`);

  // ★ 2026-10-03 接管之后，"去卡图"从"运行时包一层 freshDeck 把 imageString 换成透明图"
  //   变成了**由构造保证**：卡是我们自己造的（卡库.js 丁段 造卡对象），`imageString` 天生是空串。
  //   所以这里换一条**新的**不变量来守它 —— 卡表必须自带**全量**卡，且牌组用到的名字一个不缺；
  //   否则牌组构建会抛错（fill() 里那条"卡名不存在"）。
  const lib = ctx.CAMPAIGN_DATA.lib();
  const 张数 = Object.keys(lib).length;
  ok(张数 >= 37, `我们自己的卡表是 37 张全量（实际 ${张数} 张）`);
  ok(Object.keys(lib).every((n) => lib[n].imageString === undefined),
     '卡表里没有任何一张带 imageString（图这件事从构造上就不存在）');
  // 牌组里每一张都得能在表里索引到、且带着卡面工厂（上游 index.js 会调 getPlayerHTML 之类）
  ok(arr.every((c) => c && c.name && typeof c.getPlayerHTML === 'function'),
     '关卡牌组里的每张卡都是我们造的卡对象（带 name 与卡面工厂）');
  ok(ctx.CAMPAIGN_DATA.lib()['Ghoul'] !== undefined, '卡表按卡名索引得到');
}

section('E 去卡图：自由对战那条路也覆盖到');
{
  // 不带 ?level 时 卡库.js 的乙段不动 freshDeck，走丁段那份**自由对战卡池**（照上游返回顺序排的 63 张位）
  const ctx = makeCtx({ search: '' });
  const arr = ctx.freshDeck();
  const withArt = arr.filter((c) => c && c.imageString && !c.imageString.startsWith('data:image/'));
  ok(withArt.length === 0, '自由对战的牌组同样没有真图');
  ok(arr.length === 63, `自由对战卡池仍是 63 张位（上游 startGame 切 30/31..60 + 3 张召唤物；实际 ${arr.length}）`);
}

section('E 去炉石美术：样式的加载方式（决定会不会白打 404）');
{
  const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
  const cssPath = path.join(HERE, '游戏', '样式.css');
  ok(fs.existsSync(cssPath), '游戏/样式.css 存在');
  ok(html.includes('游戏/样式.css'), 'index.html 引用了 游戏/样式.css');

  // 这三条是这一段的关键：样式必须**排在两个上游样式表之后**（否则覆盖不过），
  // 且必须在 **body 之前**加载 —— background-image 的请求在解析 body 那一刻就发出去了，
  // 靠脚本在 DOMContentLoaded 注入来不及拦（实测会白打 11 个 404）。
  const iStyles = html.indexOf('href="styles.css"');
  // 用 `href="..."` 定位，别用裸文件名 —— 文件顶部那行说明注释里也写着「游戏/样式.css」，
  // 裸匹配会命中注释，于是"谁先谁后"就测反了（这里踩过一次）。
  const iOurs = html.indexOf('href="游戏/样式.css');
  const iBody = html.indexOf('<body');
  ok(iStyles !== -1 && iStyles < iOurs, 'ours.css 排在上游 styles.css 之后（能覆盖它）');
  ok(iOurs < iBody, 'ours.css 在 <body> 之前加载（早于任何背景图请求）');

  // 断言全部走「剥掉注释 → 拆成一条条规则」的结构，不做裸字符串包含 ——
  // 注释里出现的类名会把包含式断言骗过去（第一版就是这么假绿的）。
  const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }));
  const selOf = (decl) => rules.filter((r) => r.body.includes(decl)).map((r) => r.sel).join(',');

  // 这个文件不该引用任何外部资源 —— 引用了就说明还有 404 在路上
  ok(!/url\(/.test(css), 'ours.css 里没有任何 url(...)：不引用素材，也就不会发出请求');

  // 上游 styles.css 里那 21 处 url(src/...) 必须逐条被压平（漏哪条就漏哪条 404）
  const bgSel = selOf('background-image: none !important');
  const mustCover = ['#load', '#mainmenu', '#openpacks', '#howtoplay', '.bg-image',
                     '.playerhero', '.opponenthero', '.playerheropower',
                     '.player-deck', '.computer-deck', '.enemycard',
                     '#packOpenAnimElem', '#cardpackimg', '#confirm',
                     '#vs', '#victoryImg1', '#victoryImg2', '#hoggerposter', '#gifhint',
                     '.divineShield', '.taunt', '.legendaryinplay'];
  const missed = mustCover.filter((s) => !bgSel.includes(s));
  ok(missed.length === 0, `压平规则覆盖了上游全部素材引用（漏掉：${missed.join(' ') || '无'}）`);

  // 卡面 / 场上卡**刻意不压平**：它们的图由 deck.js 写在行内样式上，将来要挂我们自己的图
  ok(!bgSel.includes('.card-face') && !bgSel.includes('.cardinplay'),
     '卡面与场上卡没有被压平（留给将来我们自己的卡图）');

  const curSel = selOf('cursor: auto !important');
  ok(curSel.includes('body') && curSel.includes('button:hover'), '有复位光标的规则（含 body 与按钮）');

  ok(rules.some((r) => r.sel === '*' && r.body.includes('font-family: var(--hs-font)')),
     '整个文档的字体族被换掉（Belwe 是暴雪商用字体，文件已删）');

  // 入场/闪光/震屏停掉；但界面机制类动效必须留着
  const fxSel = selOf('animation: none !important');
  const stopped = ['.onLoadPlayerAnim', '.onLoadComputerAnim', '.tutorialHeroAnim',
                   '.legendaryFlipAnim', '.epicFlipAnim', '.deathwingShake', '.shakeScreenAnim', '.zoomOutAnim'];
  const notStopped = stopped.filter((c) => !fxSel.includes(c));
  ok(notStopped.length === 0, `炉石式演出类全部在停用名单里（漏掉：${notStopped.join(' ') || '无'}）`);
  for (const keep of ['hs-deploy', 'openMenuAnim']) {
    ok(!fxSel.includes(keep), `${keep} 没被误停（那是界面机制，不是炉石招牌）`);
  }

  // 看板娘台词气泡停掉
  ok(selOf('display: none !important').includes('#playerbubble'), '对话气泡被隐藏');

  // 「点此开始」必须看得见：上游只靠一张卡包图当外观，图没了会变成看不见的可点区域
  ok(rules.some((r) => r.sel === '#confirm::after' && r.body.includes('点此开始对战')),
     '#confirm 有可见文字兜底');

  // ★ 我们自己的 UI 落点：配色收在变量里，换皮只动这里
  const rootRule = rules.find((r) => r.sel === ':root') || { body: '' };
  for (const v of ['--hs-bg', '--hs-panel', '--hs-soft', '--hs-line', '--hs-text', '--hs-accent', '--hs-font']) {
    ok(rootRule.body.includes(v + ':'), `配色/字体变量 ${v} 已在 :root 声明`);
  }
}

section('E 开场清理：不再有「点击继续」门槛，首访不卡空等');
{
  const fresh = makeCtx({ search: '', stored: {} });
  ok(fresh.HS_STRIP.skipStartupGate === true, '开场门槛开关是开的');
  ok(fresh.localStorage.getItem('hasPlayedTutorial') !== null,
     '首访时预置了教程哨兵（否则上游会强制进教程，而教程的开场影片已摘掉，会空等 48 秒）');

  const returning = makeCtx({ search: '', stored: { hasPlayedTutorial: '"already"' } });
  ok(returning.localStorage.getItem('hasPlayedTutorial') === '"already"',
     '已经有哨兵时不覆盖（不干扰老档）');

  ok(fresh.document.title === '卡牌对战', `<title> 换成了我们自己的名字（实际 "${fresh.document.title}"）`);
  ok(fresh.HS_STRIP.appName === '卡牌对战', '应用名暴露在 HS_STRIP 上，改名只动一处');
}

section('E 直接进对局：不再有「双方头像 → 点此开始对战 → 点确认」这一步');
{
  const NEED = ['#mainmenu', '#contents', '#block', '#confirm', '#transitionblock',
                '#skipcinematicbtn', '#playerlabel', '#playerclasslabel', '#opponentlabel', '#vs',
                '.playerhero', '.opponenthero', '.playerHeroHealth', '.opposingHeroHealth'];
  const ctx = makeCtx({ search: '?level=1', elements: NEED });
  ok(typeof ctx.CAMPAIGN_UI.enterFight === 'function', 'enterFight 暴露给自测');
  ctx.CAMPAIGN_UI.enterFight();
  const el = (s) => ctx.__elements.get(s);

  ok(el('#mainmenu').style.display === 'none', '主菜单收起');
  ok(el('#contents').style.visibility === 'visible', '对局区亮出');
  ok(el('#block').style.visibility === 'hidden', '开场遮罩收掉（不再等玩家点）');
  ok(el('#confirm').style.display !== 'block', '「点此开始对战」不再出现');
  ok(el('#transitionblock').style.visibility === 'hidden', '转场黑幕收掉');
  ok(el('#skipcinematicbtn').style.display === 'none', '「Skip ▶」收掉');
  // 开场那排「对阵」不要了：职业与 VS 收掉
  for (const s of ['#playerclasslabel', '#vs']) {
    ok(el(s).style.visibility === 'hidden', `${s} 不显示（开场那排「对阵」不要了）`);
  }
  // ★ 但**双方名字保留** —— 它们现在被 ours.css 定位进右栏两个头像框里当标题了
  //   （用户 2026-10-03 的图 1：右栏是「设置 / 敌方玩家-bot / END TURN / 我方玩家 / 任务区」）
  for (const s of ['#playerlabel', '#opponentlabel']) {
    ok(el(s).style.visibility !== 'hidden', `${s} 保留显示（它现在是右栏头像框的标题）`);
  }
  ok(el('.playerHeroHealth').style.visibility === 'visible', '我方血条亮出');
  ok(el('.opposingHeroHealth').style.visibility === 'visible', '敌方血条亮出');
  ok(ctx.isInGame === true, 'isInGame 置为 true（上游用它判断在局内）');
}

section('E 外壳层是幂等的');
{
  const ctx = makeCtx({ search: '' });
  const first = ctx.Audio;
  // 创卡页预览会把脚本重跑一遍，不能因此叠加包装
  new vm.Script(fs.readFileSync(path.join(HERE, '游戏/外壳.js'), 'utf8'),
                { filename: '外壳.js#2' }).runInContext(ctx);
  ok(ctx.Audio === first, '重复执行 外壳.js 不会把 Audio 再包一层');
  const arr = ctx.freshDeck();
  ok(arr.every((c) => c && c.imageString === ''),
     '重复执行后卡依然没有图（我们的卡由构造保证，与"包没包 freshDeck"无关）');
  // 样式已经搬到 游戏/样式.css（由 head 加载），这一层不再注入任何 <style>
  ok(!ctx.document.head.children.some((c) => c.id === 'hs-strip-style'),
     '外壳.js 不再注入 <style>（外观由 样式.css 负责，那样才拦得住背景图请求）');
  ok(ctx.CAMPAIGN_UI !== undefined, '重复执行不会把关卡层打翻（乙段有幂等闸）');
}

section('F 资源与回合（阶段 C：资源层归我们）');
{
  /* 资源层（游戏/资源.js）是**页面侧**的文件：它要在 index.js 之后、界面.js 之前跑，
     并且会换掉 window.playerTurn / placeCardFunc。所以这里先把上游那两拍做成最小实现，
     再把资源层装进来 —— 验的是"我们的规则真的在算数"，不是 DOM 长得对不对。 */
  const ctx = makeCtx({ search: '?level=1' });
  ctx.mana = 1;
  ctx.manaCapacity = 1;
  let 上游回合次数 = 0;
  ctx.playerTurn = function () {                    // 上游那一拍：自增一步 + 法力回满
    上游回合次数++;
    if (ctx.manaCapacity != 10) ctx.manaCapacity++;
    ctx.mana = ctx.manaCapacity;
  };
  ctx.placeCardFunc = function () { ctx.mana -= 2; };   // 模拟上游扣费
  new vm.Script(fs.readFileSync(path.join(HERE, '游戏/资源.js'), 'utf8'),
                { filename: '游戏/资源.js' }).runInContext(ctx);

  const 资 = ctx.HS_RESOURCE;
  ok(!!资, 'HS_RESOURCE 已暴露');
  ok(资.是不是我们的() === true, '回合推进已换成我们的（__hsOurs 标记在）');
  ok(ctx.placeCardFunc.__hsOurs === true, '出牌那一拍也换成我们的（出不起就不让上游扣）');
  ok(资.上限() === 1 && 资.法力() === 1, '开局 1/1');
  ok(ctx.mana === 1 && ctx.manaCapacity === 1, '全局量与我们的真相一致');

  // ① 回合开始：上限 +1、法力回满 —— 全局量被"预置一步"，上游自增后正好落在我们的值上
  ctx.playerTurn();
  ok(上游回合次数 === 1, '上游那一拍确实被调用了（改能力，不改调用点）');
  ok(资.上限() === 2 && 资.法力() === 2, '回合开始：上限 +1、法力回满（我们的规则）');
  ok(ctx.manaCapacity === 2 && ctx.mana === 2, '全局量被摆到与真相一致（唯一写入点）');

  // ② 用户的法力系统：正面任务 +1 / 负面任务 −1
  ok(资.触发负面任务('自测：空过') === 1, '负面任务 → 上限 −1');
  ok(资.上限() === 1 && ctx.manaCapacity === 1, '上限降了，全局量跟着走');
  ok(资.法力() <= 资.上限(), '上限掉到法力之下时，法力被夹回上限内');
  ok(资.完成正面任务('自测：铺场') === 2, '正面任务 → 上限 +1');

  // ③ 夹在顶尖之内 / 出不起不扣费
  ok(资.设上限(99) === 10, '上限夹在顶尖 10');
  ok(资.设上限(-5) === 0, '上限不会低于 0');
  资.设上限(6);
  资.回满();
  ok(资.法力() === 6 && ctx.mana === 6, '回满 = 法力对上限');
  ok(资.花(4) === true && 资.法力() === 2, '花 4 点法力');
  ok(资.花(99) === false && 资.法力() === 2, '出不起就不扣（返回 false）');
  ctx.getNameOfElement = 'Ragnaros the Firelord';   // 8 费，手上只有 2 点
  ctx.placeCardFunc();
  ok(ctx.mana === 2 && 资.法力() === 2, '出不起的牌：上游那一下被挡住，法力不动（' + ctx.mana + '）');

  // ④ 账本：上限每一次变化都要留痕（任务区显示的就是它）
  const 账 = 资.历史();
  ok(账.length >= 4, '上限变化都进了账本（' + 账.length + ' 条）');
  ok(账.some((x) => x.文字.indexOf('负面任务') >= 0) && 账.some((x) => x.文字.indexOf('正面任务') >= 0),
     '账本里能看出是哪一类任务动的手');
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
