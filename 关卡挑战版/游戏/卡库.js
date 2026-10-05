/* 关卡挑战版 · 卡库（关卡表与牌组构建 + ?level 安装钩子 + 卡面渲染与牌库）
 * ---------------------------------------------------------------
 * 一个文件装三件事（少而大，便于打包）：
 *   甲段（原 levels.js）      —— 关卡表 LEVELS + 牌组构建器（只提供数据）
 *   乙段（原 campaign-pre.js）—— 读 ?level=N，把那一关的牌组与血量装到页面上
 *   丙段                       —— **卡的定义**（37 张，从上游 deck.js 机械抽出）
 *   丁段                       —— **卡面渲染 + 牌库**（替掉 deck.js 的 DOM 工厂）
 *
 * 本文件的位置：排在 外壳.js 之后、index.js 之前。
 *   乙段必须在 index.js 解析到末尾 startGame() 之前动手，否则牌组换不掉。
 *   （以前还有一条"甲段要赶在别人覆盖 freshDeck 之前抓一份上游的"—— 数据换成我们自己的之后，
 *     这条约束消失了，见甲段的说明。）
 *
 * 甲段：关卡表与牌组构建
 * ---------------------------------------------------------------
 * 它只提供两样东西：
 *   1. 关卡表 LEVELS —— 每关：对手名 / 对手牌组 / 双方血量 / AI 档位 / 玩家用哪套牌组
 *   2. 牌组构建器 —— 把关卡表变成上游 startGame() 认得的那个数组
 *
 * 上游 startGame() 的切分方式是硬编码的下标：
 *     playerDeck   = cards.slice(0, 30)
 *     computerDeck = cards.slice(31, 60)        ← 注意下标 30 被跳过
 * 所以甲段的 deckArray() 必须严格按 [30 张玩家牌] + [1 张占位] + [29 张对手牌] + [召唤物] 排列。
 * 下标 30 那一格是上游的既有 quirk，不是我们加的，改它等于改上游行为。
 *
 * 卡库不重抄一遍：丙段那张表就是我们的卡库（37 张），下面按卡名索引。
 */
(function (W) {
  'use strict';

  var SKIP_SLOT = 1;   // 下标 30 的占位张数

  /* 卡库就是**我们自己的表**（丙段）—— 不再去上游 deck.js 拿卡对象。
     这一改顺带消掉一条老约束：以前必须「赶在别人覆盖 freshDeck 之前」抓一份上游的 freshDeck
     （否则无限递归），现在没有这个先后依赖了。 */
  var LIB = null;
  function lib() {
    if (LIB) return LIB;
    LIB = {};
    /* 卡表在丙段（同文件、后一个 IIFE），它把自己的表挂在 W.HS_CARDS 上 —— 这里只做按名索引。
       甲段拿到的就是纯数据（费/攻/血/说明…）；卡面由丁段的工厂负责造。 */
    var 表 = W.HS_CARDS || {};
    for (var 名 in 表) if (Object.prototype.hasOwnProperty.call(表, 名)) LIB[名] = 表[名];
    if (!LIB['Ghoul']) throw new Error('[卡库] 卡表没挂上（W.HS_CARDS 为空）—— 检查加载顺序');
    return LIB;
  }

  /* 把表里的一行数据变成**带工厂的卡对象**（丁段提供；上游读 .name/.mana/… 与三个 getXxxHTML） */
  function 成卡(名) {
    return (W.HS_CARD && W.HS_CARD.造卡对象) ? W.HS_CARD.造卡对象(名) : lib()[名];
  }

  // 按卡名列表铺满 n 张（不够就循环，够了就截断）。卡名打错会在这里当场报出来。
  function fill(names, n, what) {
    var L = lib(), pool = [], missing = [];
    for (var i = 0; i < names.length; i++) {
      if (L[names[i]]) pool.push(成卡(names[i]));
      else missing.push(names[i]);
    }
    if (missing.length) {
      throw new Error('[campaign] ' + what + ' 里这些卡名在我们的卡库里不存在：' + missing.join(' / '));
    }
    var out = [];
    for (var k = 0; k < n; k++) out.push(pool[k % pool.length]);
    return out;
  }

  // 玩家牌组：基础组（前两关）与完整组（第三关起）
  // 卡名必须在我们自己的卡表（丙段）里 —— 那张表是 37 张全量，含上游那条死数据
  // Bloodfen Raptor（deck.js 里定义了却从没放进返回数组）—— 它也照收，但牌组里不用它。
  var BASIC_DECK = [
    'Elven Archer', 'Voodoo Doctor', 'Glacial Shard', 'Skeleton',
    'Acidic Swamp Ooze', 'Ghoul', 'Ghoul', 'Devout Adventurer',
    'Lifedrinker', 'Razorfen Hunter', 'Murloc Tidehunter', "Sen'jin Shieldmasta",
    'Saronite Chain Gang', 'Gnomish Inventor', 'Coldwraith', 'Water Elemental'
  ];
  var FULL_DECK = [
    'Elven Archer', 'Voodoo Doctor', 'Acidic Swamp Ooze', 'Ghoul',
    'Devout Adventurer', 'Lifedrinker', 'Razorfen Hunter', 'Murloc Tidehunter',
    "Sen'jin Shieldmasta", 'Saronite Chain Gang', 'Gnomish Inventor', 'Water Elemental',
    'Boulderfist Ogre', 'Archmage', 'Stormwind Champion', 'Maexxna',
    'The Black Knight', 'Bonemare', 'King Krush', 'Ragnaros the Firelord'
  ];

  // 召唤物（战吼/亡语产生的 1/1）——沿用上游的收尾三张
  var TOKENS = ['Whelp', 'Boar', 'Murloc Scout'];

  /* 五关阶梯：同一套对手强度曲线，从「能出牌就行」到「会挑最优曲线」。
     tier：0 新手（出牌随机 + 一半概率不出手） · 1 熟练（上游原样） · 2 大师（出牌挑最贵）
     slots：**每侧几个部署位**（用户 2026-10-03：第一关双方各 1 格、第二关 2 格……第五关 5 格）。
     自由关不走这张表 —— 它的档位（1/3/5）由 URL 的 ?free=N 给，见乙段。 */
  var LEVELS = [
    {
      id: 1, name: '第一关 · 热身赛', opponentLabel: '学徒 · 血牙',
      playerHp: 30, opponentHp: 20, tier: 0, player: 'basic', slots: 1,
      blurb: '对手还在学怎么出牌：它出一张算一张，而且时常站着不动。',
      opponent: ['Ghoul', 'Skeleton', 'Slime', 'Boar', 'Whelp',
                 'Elven Archer', 'Voodoo Doctor', 'Murloc Scout']
    },
    {
      id: 2, name: '第二关 · 排位赛', opponentLabel: '老兵 · 霜牙',
      playerHp: 30, opponentHp: 25, tier: 1, player: 'basic', slots: 2,
      blurb: '对手会按曲线出牌、会挑目标打。血量也厚了一截。',
      opponent: ['Ghoul', 'Skeleton', 'Slime', 'Elven Archer', 'Voodoo Doctor',
                 'Ghoul', 'Acidic Swamp Ooze', 'Razorfen Hunter', 'Murloc Tidehunter']
    },
    {
      id: 3, name: '第三关 · 挑战赛', opponentLabel: '法师 · 冰喉',
      playerHp: 30, opponentHp: 30, tier: 1, player: 'full', slots: 3,
      blurb: '对手换成了冰霜体系：冻不住你，就用身材压你。你这边解锁了完整牌组。',
      opponent: ['Ghoul', 'Skeleton', 'Coldwraith', 'Glacial Shard', 'Water Elemental',
                 'Saronite Chain Gang', 'Trapped Soul', 'Skeletal Knight']
    },
    {
      id: 4, name: '第四关 · 晋级赛', opponentLabel: '死亡骑士 · 骨语',
      playerHp: 30, opponentHp: 35, tier: 2, player: 'full', slots: 4,
      blurb: '对手会挑出费用最高的那张牌打——每一步都在给你上压力。',
      opponent: ['Ghoul', 'Skeleton', 'Coldwraith', 'Glacial Shard', 'Water Elemental',
                 'Saronite Chain Gang', 'Trapped Soul', 'Skeletal Knight',
                 'Sludge Belcher', 'Grim Necromancer', 'Bonemare', 'The Black Knight', 'Maexxna']
    },
    {
      id: 5, name: '第五关 · 冠军赛', opponentLabel: '巫妖王',
      playerHp: 30, opponentHp: 40, tier: 2, player: 'full', slots: 5,
      blurb: '压轴。对手的牌组里就有巫妖王本人，血量 40。这一关没有任何让步。',
      opponent: ['Ghoul', 'Skeleton', 'Coldwraith', 'Glacial Shard', 'Water Elemental',
                 'Saronite Chain Gang', 'Trapped Soul', 'Skeletal Knight', 'Sludge Belcher',
                 'Grim Necromancer', 'Bonemare', 'The Black Knight', 'Maexxna', 'The Lich King']
    }
  ];

  function byId(id) {
    for (var i = 0; i < LEVELS.length; i++) if (LEVELS[i].id === id) return LEVELS[i];
    return null;
  }

  /* 关卡 → 上游 startGame() 认得的那个数组 */
  function deckArray(level) {
    var arr = fill(level.player === 'full' ? FULL_DECK : BASIC_DECK, 30, '玩家牌组');
    for (var s = 0; s < SKIP_SLOT; s++) arr.push(成卡('Whelp'));   // 下标 30 的占位
    arr = arr.concat(fill(level.opponent, 29, '对手牌组[' + level.name + ']'));
    arr = arr.concat(fill(TOKENS, 3, '召唤物'));
    return arr;
  }

  /* 任务表（用户 2026-10-03 定的法力系统：完成正面任务 → 法力水晶上限 +1，触发负面任务 → −1）。
   * **现在是空表**：机制已经接好（`游戏/资源.js` 的 `完成正面任务()/触发负面任务()`），
   * 但"有哪些任务"是玩法设计 —— 等用户给条目再往里填，不替他编规则。
   * 每条的约定（形状先定下来，将来加条目不改代码）：
   *   { 名: '铺场', 说明: '本回合打出两张随从', 面向: '正面' | '负面', 上限: +1 | -1 }
   * 任务区（界面右栏）会照 `名/说明/面向` 渲染；完成时由判定方调
   * `HS_RESOURCE.完成正面任务(名)` / `触发负面任务(名)`，上限变化会进账本。
   * （摆在 卡库.js 是因为这里就是数据层；将来要按关卡给不同任务，就在 LEVELS 每条里加 `任务: [...]`。） */
  W.HS_TASKS = [];

  W.CAMPAIGN_LEVELS = LEVELS;
  W.CAMPAIGN_DATA = {
    byId: byId,
    deckArray: deckArray,
    lib: lib,
    BASIC_DECK: BASIC_DECK,
    FULL_DECK: FULL_DECK
  };
})(typeof window !== 'undefined' ? window : globalThis);


/* 关卡挑战版 · 前置钩子（卡库.js 的乙段；必须在 index.js **之前**加载）
 * ---------------------------------------------------------------
 * 上游 index.js 在解析到末尾时会立刻 `startGame()` 发牌。所以要换牌组，只能赶在它之前动手。
 * 本段做的事，全部是「读 URL → 定本局的形状与牌组 → 写几个 DOM 文本」：
 *   0. **先定 `HS_SLOTS`（每侧几个部署位）**：挑战关按关卡表的 `slots`（第一关 1 格 → 第五关 5 格），
 *      自由关按 `?free=1|3|5`，都没有就是默认 5。界面（SLOT_COUNT）与引擎（状态.场上上限）都读它
 *      —— 它是"本局的形状"，必须只有一个来源。
 *   1. URL 带 ?level=N 时，把「这一关的牌组」寄存到 HS_LEVEL_DECK 上 ——
 *      index.js 里 `new Deck()` 的默认参数是 `freshDeck()`，按标识符解析成 window.freshDeck；
 *      而 freshDeck 的总闸在丁段，它会优先取 HS_LEVEL_DECK（见丁段那段说明）。
 *   2. 提前把双方血量写进 DOM：index.js 的 startGame() 会读 `.opposingHeroHealth`
 *      来嗅探「是不是教程」（==10 就当教程）。写在这里它读到的就是我们关卡的值。
 *      自由关（?free=N）走不了关卡表，但也得把血量写成 30:30，理由同上 —— 否则会掉进教程分支。
 *   3. 顺手改对手名。
 *
 * 为什么是「重载页面」而不是「原地重开一局」：原地重开要清理上游一堆全局
 * （manaCapacity / oldNumOfChild / 已绑的 mousedown 监听 / 场上残留节点），
 * 而这些都是脚本作用域里的可变状态，清不干净就会串局。整页重载最稳，代价只是重载一次。
 */
(function (W) {
  'use strict';

  /* ★★ 这一段原来是"脚本加载那一刻读 URL → 把这一局摆好"，一次性、不可重入。
     2026-10-03 为了**进 MMD 沙盒**（见 `游戏/沙盒.js`）改成**可重复调用**：
     沙盒里换关必须在**页内**做（`location.href = '?level=N'` 会导航掉平台页 ✗），
     所以"按关卡把牌组/血量/格数摆好"这件事必须能随时再执行一遍。
     独立网页那条路一个字没变：加载时读 URL，命中就调一次同一个函数。 */
  function 应用关卡配置(关卡号, 自由档) {
    var 关卡 = (关卡号 && W.CAMPAIGN_DATA) ? W.CAMPAIGN_DATA.byId(Number(关卡号)) : null;
    var 档 = Number(自由档) || 0;
    if ([1, 3, 5].indexOf(档) < 0) 档 = 0;              // 自由关只认 1/3/5 三档

    /* 部署位数：**先定这一条**（它决定本局的形状，界面与引擎都要读）。
       挑战关：关卡表的 slots（第一关双方各 1 格 → 第五关 5 格）；自由关：档位；都没有：5。 */
    W.HS_SLOTS = 关卡 ? (关卡.slots || 关卡.id) : (档 || 5);

    var 写 = function (sel, text) {
      var el = (W.document && W.document.querySelector) ? W.document.querySelector(sel) : null;
      /* ★ 用 **textContent** 而不是 innerText（2026-10-04，实机"没有血量数字"）：
         `innerText` 是**渲染相关**的属性 —— 对"还没被布局/隐藏"的元素，写进去未必留得住、
         读出来还会是空串。而上游 `startGame()` 恰恰要用 `innerText` 读对手血量来嗅探教程
         （读到空串只影响嗅探 ✓ 但**元素不存在时它直接抛错**，后面整段发牌就不执行了 ——
         实机"没有手牌"很可能就是这个）。这里至少保证"元素在、且文本写得进去"。 */
      if (!el) return false;
      el.textContent = String(text);
      el.innerText = String(text);          // 兼容上游既读 innerText 的那些地方
      el.style.visibility = 'visible';
      el.style.opacity = '1';
      return true;
    };

    if (!关卡) {
      /* 自由关：不走关卡表。但"血量不能是 10"这件事照样得办 ——
         index.js 的 startGame() 拿 `.opposingHeroHealth` 嗅探教程（==10 就当教程）。 */
      W.CAMPAIGN = null;
      W.HS_LEVEL_DECK = undefined;                       // 丁段的总闸据此退回自由卡池
      W.HS_FREE = null;
      if (档) {
        W.HS_FREE = { slots: 档, hpWritten: 写('.playerHeroHealth', 30) && 写('.opposingHeroHealth', 30) };
        写('#opponentlabel', '自由对练 · ' + 档 + ' 格');
      }
      return { 关卡: null, 自由档: 档, slots: W.HS_SLOTS };
    }

    W.CAMPAIGN = { id: 关卡.id, level: 关卡, tier: 关卡.tier };
    W.HS_FREE = null;
    /* ① 换牌组：只登记"这一关的牌组来源"，不直接写 freshDeck ——
       freshDeck 的**唯一写入点**是丁段的总闸，它会优先取 HS_LEVEL_DECK（见丁段那段说明）。 */
    W.HS_LEVEL_DECK = function () { return W.CAMPAIGN_DATA.deckArray(关卡); };
    // ② 双方血量 + 对手名（独立网页里脚本在 body 末尾，这些节点已经解析完；
    //    沙盒里由适配层保证骨架先注入再调这里）
    var okP = 写('.playerHeroHealth', 关卡.playerHp);
    var okO = 写('.opposingHeroHealth', 关卡.opponentHp);
    写('#opponentlabel', 关卡.opponentLabel);
    W.CAMPAIGN.pre = { hpWritten: okP && okO };
    return { 关卡: 关卡, 自由档: 0, slots: W.HS_SLOTS };
  }
  W.HS_APPLY_LEVEL = 应用关卡配置;

  /* 脚本加载那一刻：URL 带了 ?level= / ?free= 就应用一次（独立网页的老路）。
     沙盒里 `location.search` 是平台的，两条都命中不了 → 这里只把 HS_SLOTS 定成默认 5，
     真正的应用由用户在「开始游戏」里选完之后调 `HS_APPLY_LEVEL`。 */
  var q = (W.location && W.location.search) ? W.location.search : '';
  var m = /[?&]level=(\d+)/.exec(q);
  var f = /[?&]free=(\d+)/.exec(q);
  应用关卡配置(m ? Number(m[1]) : 0, f ? Number(f[1]) : 0);
})(typeof window !== 'undefined' ? window : globalThis);

/* 关卡挑战版 · 效果表（卡库.js 的丙段；**纯数据，不碰 DOM**）
 * ===============================================================
 * 这是新的**引擎**（游戏/引擎.js）读的那张表：卡名 → { 费, 攻, 血, 关键词, 战吼, 亡语 }。
 *
 * 为什么自己抄一份数值，而不是从上游 deck.js 的卡对象上读：
 *   ① 引擎是**纯逻辑**，不许碰宿主环境；上游的卡对象是 class 实例、还挂着 DOM 方法，
 *      让引擎去吃它等于把宿主拖进规则层；
 *   ② 效果必须变成**数据**才谈得上"加卡不改引擎"（上游 card_effects.js 是"直接改 DOM"的反面教材）；
 *   ③ 数值抄错了要被机器抓住 —— test_levels.mjs 里有一条断言，逐张核对本表与上游 deck.js 的
 *      (攻/血/费) 是否一致。抄错就当场红。
 *
 * 目标口径（效果表里 目标 字段的取值）：
 *   无 / 自身 / 任意 / 任意随从 / 友方随从 / 敌方随从 / 敌方英雄 / 敌方角色
 * 动作：伤害 / 治疗 / 加成 / 召唤 / 抽牌 / 冻结 / 消灭
 *
 * 关键词：嘲讽 神圣护盾 冲锋 剧毒 伤害后冻结
 *   · 剧毒 = 被它伤到的随从直接销毁（Maexxna）
 *   · 伤害后冻结 = 被它伤到的角色冻结（Water Elemental）
 *   这两个都写成**关键词**而不是"触发效果"，是因为它们只需要在伤害原语里读一个字段，
 *   写成触发器反而要绕一圈。真正的触发机制留给亡语（见引擎的 状态检查）。
 *
 * ⚠ 只挑**上游那套卡里真有的 20 张**，不用凭空造卡：这样阶段 2 的双跑对照
 *   才能拿同名的卡逐项比数值与判定。
 */
(function (G) {
  'use strict';

  /* ── 卡的定义（37 张，**从上游 deck.js 机械抽出** —— 见 抽上游卡数据.py）───────────
     费/攻/血/稀有/说明逐字段照抄上游；**效果（战吼/亡语/关键词）与体力是我们自己的那一套**。
     上游没实现、我们也没实现的（Alexstrasza 设血、Deathwing 清场、Leeroy 给对方召唤…）
     在 `说明` 里逐条写清「先只留数值」，不假装有。
     ⚠ 数值由 test_levels.mjs 的 G 段逐张与上游核对：抄错一位、或上游改了卡面，那里当场红。 */
  var 卡表 = {
    'Murloc Scout': { 费: 0, 攻: 1, 血: 1, 稀有: 'Common',
      召唤物: true,
      说明: '1/1 鱼人斥候。' 
    },
    'Alexstrasza': { 费: 9, 攻: 8, 血: 8, 稀有: 'Legendary',
      说明: '8/8 传说。（上游战吼是「把某个英雄的血设成 15」—— 我们的效果表还没有「设为血量」，先只留数值）' 
    },
    'Elite Tauren Chieftain': { 费: 5, 攻: 5, 血: 5, 稀有: 'Legendary',
      战吼: [{动作:'抽牌',数量:1,目标:'无'}],
      说明: '战吼：抽一张牌。（上游原文是「双方各抽一张」—— 我们的效果表还没有「给对方抽牌」，先按自己抽一张）' 
    },
    'Deathwing': { 费: 10, 攻: 12, 血: 12, 稀有: 'Legendary',
      说明: '12/12 传说。（上游战吼「消灭其它所有随从并弃手牌」—— 先只留数值）' 
    },
    'Elven Archer': { 费: 1, 攻: 1, 血: 1, 稀有: 'Common',
      战吼: [{动作:'伤害',值:1,目标:'任意'}],
      说明: '战吼：造成 1 点伤害。' 
    },
    'Voodoo Doctor': { 费: 1, 攻: 2, 血: 1, 稀有: 'Common',
      战吼: [{动作:'治疗',值:2,目标:'任意'}],
      说明: '战吼：恢复 2 点生命。' 
    },
    'King Krush': { 费: 9, 攻: 8, 血: 8, 稀有: 'Legendary',
      关键词: {冲锋:true},
      说明: '冲锋（上游的 Charge；这一版真会生效）。' 
    },
    'Ragnaros the Firelord': { 费: 8, 攻: 8, 血: 8, 稀有: 'Legendary',
      说明: '白板 8/8（随机打 8 这一版不做 —— 随机目标要先有「谁随机」的规则）。' 
    },
    'The Lich King': { 费: 8, 攻: 8, 血: 8, 稀有: 'Legendary',
      关键词: {嘲讽:true},
      说明: '嘲讽。' 
    },
    'Acidic Swamp Ooze': { 费: 2, 攻: 3, 血: 2, 稀有: 'Common',
      说明: '身材 3/2（这一版没有武器，所以它是纯身材卡）。' 
    },
    'Bloodfen Raptor': { 费: 2, 攻: 3, 血: 2, 稀有: 'Common',
      说明: '⚠ 上游**死数据**：deck.js 里定义了它，但从来没放进返回的牌组 —— 我们照收数据、照此备注。' 
    },
    'Lifedrinker': { 费: 4, 攻: 3, 血: 3, 稀有: 'Rare',
      战吼: [{动作:'伤害',值:3,目标:'敌方英雄'},{动作:'治疗',值:3,目标:'自身英雄'}],
      说明: '战吼：对敌方英雄造成 3 点伤害，并为自己英雄恢复 3 点。' 
    },
    'Boar': { 费: 1, 攻: 1, 血: 1, 稀有: 'Common',
      召唤物: true,
      说明: '1/1 野猪。' 
    },
    'Razorfen Hunter': { 费: 3, 攻: 2, 血: 3, 稀有: 'Common',
      战吼: [{动作:'召唤',卡:'Boar',数量:1}],
      说明: '战吼：召唤一个 1/1 野猪。' 
    },
    'Murloc Tidehunter': { 费: 2, 攻: 2, 血: 1, 稀有: 'Common',
      战吼: [{动作:'召唤',卡:'Murloc Scout',数量:1}],
      说明: '战吼：召唤一个 1/1 鱼人斥候。' 
    },
    'Leeroy Jenkins': { 费: 4, 攻: 6, 血: 2, 稀有: 'Legendary',
      关键词: {冲锋:true},
      说明: '冲锋。（上游的战吼「给对手召唤两个 1/1 雏龙」需要「替对方召唤」，我们的效果表还没有 —— 先只做冲锋）' 
    },
    'Gnomish Inventor': { 费: 4, 攻: 2, 血: 4, 稀有: 'Common',
      战吼: [{动作:'抽牌',数量:1,目标:'无'}],
      说明: '战吼：抽一张牌。' 
    },
    "Sen'jin Shieldmasta": { 费: 4, 攻: 3, 血: 5, 稀有: 'Common',
      关键词: {嘲讽:true},
      说明: '嘲讽。'
    },
    'Saronite Chain Gang': { 费: 4, 攻: 2, 血: 3, 稀有: 'Rare',
      关键词: {嘲讽:true},
      战吼: [{动作:'召唤',卡:'Saronite Chain Gang',数量:1,目标:'无'}],
      说明: '嘲讽 · 战吼：召唤一个自身的复制。' 
    },
    'Archmage': { 费: 6, 攻: 4, 血: 7, 稀有: 'Common',
      说明: '白板 4/7。' 
    },
    'Boulderfist Ogre': { 费: 6, 攻: 6, 血: 7, 稀有: 'Common',
      说明: '白板 6/7。' 
    },
    'Stormwind Champion': { 费: 7, 攻: 7, 血: 7, 稀有: 'Common',
      战吼: [{动作:'加成',攻:1,血:1,目标:'友方随从'}],
      说明: '战吼：使一个友方随从获得 +1/+1。' 
    },
    'Whelp': { 费: 1, 攻: 1, 血: 1, 稀有: 'Common',
      召唤物: true,
      说明: '1/1 雏龙。' 
    },
    'Devout Adventurer': { 费: 2, 攻: 2, 血: 2, 稀有: 'Common',
      关键词: {神圣护盾:true},
      说明: '神圣护盾。' 
    },
    'Coldwraith': { 费: 3, 攻: 3, 血: 4, 稀有: 'Common',
      说明: '3/4（「有敌人被冻结则抽一张」这一版简化成不触发）。' 
    },
    'Water Elemental': { 费: 4, 攻: 3, 血: 6, 稀有: 'Common',
      关键词: {伤害后冻结:true},
      说明: '被它伤害的角色会被冻结。' 
    },
    'Ghoul': { 费: 2, 攻: 2, 血: 2, 稀有: 'Common',
      说明: '白板 2/2。' 
    },
    'Skeletal Knight': { 费: 1, 攻: 2, 血: 3, 稀有: 'Common',
      说明: '2/3（亡语给的「冰封王座卡」这一版不做）。' 
    },
    'Glacial Shard': { 费: 1, 攻: 2, 血: 1, 稀有: 'Common',
      战吼: [{动作:'冻结',目标:'敌方角色'}],
      说明: '战吼：冻结一个敌方角色。' 
    },
    'Maexxna': { 费: 6, 攻: 2, 血: 8, 稀有: 'Legendary',
      关键词: {剧毒:true},
      说明: '剧毒：被它伤害的随从直接销毁。' 
    },
    'Trapped Soul': { 费: 3, 攻: 2, 血: 6, 稀有: 'Common',
      说明: '白板 2/6。' 
    },
    'Sludge Belcher': { 费: 5, 攻: 3, 血: 5, 稀有: 'Rare',
      关键词: {嘲讽:true},
      亡语: [{动作:'召唤',卡:'Slime',数量:1,目标:'无'}],
      说明: '嘲讽 · 亡语：召唤一个 1/2 带嘲讽的淤泥。' 
    },
    'Grim Necromancer': { 费: 4, 攻: 2, 血: 4, 稀有: 'Common',
      战吼: [{动作:'召唤',卡:'Skeleton',数量:2}],
      说明: '战吼：召唤两个 1/1 骷髅。' 
    },
    'Skeleton': { 费: 1, 攻: 1, 血: 1, 稀有: 'Common',
      召唤物: true,
      说明: '1/1 骷髅。' 
    },
    'Slime': { 费: 1, 攻: 1, 血: 2, 稀有: 'Common',
      关键词: {嘲讽:true},
      召唤物: true,
      说明: '1/2 带嘲讽的淤泥。' 
    },
    'The Black Knight': { 费: 6, 攻: 4, 血: 5, 稀有: 'Legendary',
      战吼: [{动作:'消灭',目标:'敌方嘲讽随从'}],
      说明: '战吼：消灭一个带嘲讽的敌方随从。' 
    },
    'Bonemare': { 费: 7, 攻: 5, 血: 5, 稀有: 'Common',
      战吼: [{动作:'加成',攻:4,血:4,目标:'友方随从'}],
      说明: '战吼：使一个友方随从获得 +4/+4。' 
    },
  };


  /* 给组装/测试用：这张表覆盖了几种"动作"，一眼看得出表达力到哪 */
  var 动作覆盖 = (function () {
    var 集 = {};
    for (var 名 in 卡表) {
      if (!Object.prototype.hasOwnProperty.call(卡表, 名)) continue;
      var d = 卡表[名];
      var 全部 = (d.战吼 || []).concat(d.亡语 || []);
      for (var i = 0; i < 全部.length; i++) 集[全部[i].动作] = (集[全部[i].动作] || 0) + 1;
      for (var k in (d.关键词 || {})) if (d.关键词[k]) 集['关键词:' + k] = (集['关键词:' + k] || 0) + 1;
    }
    return 集;
  })();

  /* 体力分布（给测试与文档用）：攻耗 / 恢复 攒起来分别是哪几档 */
  var 体力分布 = (function () {
    var 攻 = {}, 恢 = {}, 反击的 = [];
    for (var 名3 in 卡表) {
      if (!Object.prototype.hasOwnProperty.call(卡表, 名3)) continue;
      var d3 = 卡表[名3];
      攻[d3.攻耗] = (攻[d3.攻耗] || 0) + 1;
      恢[d3.恢复] = (恢[d3.恢复] || 0) + 1;
      if (d3.关键词 && d3.关键词.反击) 反击的.push(名3);
    }
    return { 攻耗: 攻, 恢复: 恢, 反击的: 反击的 };
  })();

  /* 需要玩家选目标的卡（界面的"待选择"就靠这张表判断要不要弹选目标）
     —— 目标不是'无'也不是'自身'的战吼 */
  var 需要选目标 = (function () {
    var 名单 = [];
    for (var 名 in 卡表) {
      if (!Object.prototype.hasOwnProperty.call(卡表, 名)) continue;
      var 战吼 = 卡表[名].战吼 || [];
      for (var i = 0; i < 战吼.length; i++) {
        if (战吼[i].目标 !== '无' && 战吼[i].目标 !== '自身' && !/^召唤/.test(战吼[i].动作)) { 名单.push(名); break; }
      }
    }
    return 名单;
  })();
  for (var 名 in 卡表) if (Object.prototype.hasOwnProperty.call(卡表, 名)) 卡表[名].名 = 名;

  /* ── 体力：攻耗 / 恢复（用户 2026-10-03 定的新战斗机制）──────────────────────
       攻耗  执行攻击时要**消耗**的生命值（红色 -x，显示在血量上方）
       恢复  本回合**没攻击**、回合结束时可以**恢复**的生命值（绿色 +x，显示在血量下方）
     为什么写成**两列**而不是一个数：用户明确说了「目前先攻守同值，但之后会做成
     攻击耗费量和不攻击恢复量不一样的」—— 所以数据形状现在就要分得开，
     之后只需要改数字，不用动引擎与界面。

     初始值按体量给（费 ≤2 → 1，3~5 → 2，≥6 → 3）；想单独调某张卡，
     直接在那张卡上写 `攻耗`/`恢复` 覆盖即可（下面的赋值只在没写的时候生效）。
     ⚠ 攻耗写成 `0` 是**合法**的，表示"这张卡攻击不费血"。

     一个直接后果要记住：**攻耗 ≥ 1 时，1 血随从一攻击就会死**（用户选了「能打空就死」）。
     这是机制的自然结果，不是 bug；不想让 1 血小兵自杀就给它们 攻耗: 0。 */
  var 体力规则 = function (费) { return 费 <= 2 ? 1 : (费 <= 5 ? 2 : 3); };
  for (var 名2 in 卡表) {
    if (!Object.prototype.hasOwnProperty.call(卡表, 名2)) continue;
    var d2 = 卡表[名2];
    if (d2.攻耗 === undefined) d2.攻耗 = 体力规则(d2.费);
    if (d2.恢复 === undefined) d2.恢复 = d2.攻耗;
  }

  /* ── 反击（用户 2026-10-03 挑的 3 张）────────────────────────────────────
       默认**没有反击**：攻击对方单位时不会再被反伤，只有带「反击」词条的才还手。
       （老路径那边是上游写死的"无条件反击"，所以这一条在 对照清单 里记为"引擎按新规则、老路径待对齐"。） */
  ['Maexxna', 'The Black Knight', 'Sludge Belcher'].forEach(function (n) {
    if (!卡表[n]) return;
    卡表[n].关键词 = 卡表[n].关键词 || {};
    卡表[n].关键词.反击 = true;
  });

  /* 体力分布（给测试与文档用）：攻耗 / 恢复 攒起来分别是哪几档 */
  var 体力分布 = (function () {
    var 攻 = {}, 恢 = {}, 反击的 = [];
    for (var 名3 in 卡表) {
      if (!Object.prototype.hasOwnProperty.call(卡表, 名3)) continue;
      var d3 = 卡表[名3];
      攻[d3.攻耗] = (攻[d3.攻耗] || 0) + 1;
      恢[d3.恢复] = (恢[d3.恢复] || 0) + 1;
      if (d3.关键词 && d3.关键词.反击) 反击的.push(名3);
    }
    return { 攻耗: 攻, 恢复: 恢, 反击的: 反击的 };
  })();

  G.HS_CARDS = 卡表;
  G.HS_CARDS_INFO = { 动作覆盖: 动作覆盖, 需要选目标: 需要选目标, 张数: Object.keys(卡表).length, 体力分布: 体力分布 };

/* 关卡挑战版 · 卡面渲染与牌库（卡库.js 的丁段；**我们自己的**）
 * ===============================================================
 * 上游 deck.js 干两件事：定义卡（数据）、造卡的 DOM（getPlayerHTML / getComputerHTML /
 * getPlayerCardsInHandHTML）。数据已经在丙段归我们了，这一节把 **DOM 工厂也拿回来**。
 *
 * 过渡契约（**只在 index.js 还被上游驱动时有效**，等"回合与资源"也接管了就删掉）：
 *   · 上游按 `children[i]` 读攻/血/费用/文案/名字（例如它给手牌染色读
 *     `hand.children[i].children[0].children[4].style.border`），所以**层级位置保持原样**；
 *   · 但同一批节点上**加了我们自己的类名**（hs-atk / hs-hp / hs-mana / hs-info / hs-name），
 *     我们的代码只认自己的类名 —— 上游那边一接管，旧类名与旧索引一起删；
 *   · 上游 `startGame()` 里写的是 `new Deck(cards)`，所以下面把 `牌库` 挂成 `window.Deck`；
 *   · 上游读卡对象的 `.name/.mana/.attack/.health/.info/.imageString`，所以造出来的卡
 *     **两套名字都给**（我们的是 名/费/攻/血）。
 *
 * 与上游的两处**刻意不同**：
 *   ① 上游在造卡时给"传说卡"挂一堆招牌动效（legendaryFlipAnim / theLichKingShake /
 *      deathwingShake / epicFlipAnim…）—— 那些动效我们的样式早就停用了，所以这里不再复现；
 *   ② 上游把卡图写在 `style.backgroundImage` 上，我们**不再设背景**（去卡图那轮是把
 *      imageString 换成 1×1 透明图）。想给自己的卡挂图，**就在这里加一处** —— 这是唯一入口。
 */
(function (G) {
  'use strict';
  if (G.HS_CARD) return;
  var 表 = G.HS_CARDS || {};
  var 序 = { player: 1, enemy: 1 };

  function 造节点(tag, cls, text) {
    var e = G.document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  /* 场上卡。层级与上游一致：children[0]=攻(>数字) · children[1]=血(>数字) · children[2]=关键词槽 */
  function 造场上卡(名, 侧) {
    var d = 表[名] || { 费: 0, 攻: 1, 血: 1 };
    var el = 造节点('div');
    var 我方 = (侧 === 'player');
    el.id = (我方 ? 'playerCardInPlay' : 'cpuCardInPlay') + 序[我方 ? 'player' : 'enemy']++;
    /* 落位动效：**我们自己的类**（阶段 F：上游 `placeCardAnim` 随 animations.css 出列，
       动画已在 样式.css 里用我们自己的 `@keyframes hs-deploy` 重写）。 */
    el.className = 'cardinplay ' + (我方 ? 'player-cardinplay' : 'computer-cardinplay') + ' hs-deploy';
    /* 攻/血徽章：**框里再放数字**（层级与上游一致：children[0].children[0] 是攻数字、
       children[1].children[0] 是血数字 —— 上游的 AI/结算还在按这两个位置读数） */
    var 攻框 = 造节点('div', 'attackValueBackground hs-atk-wrap');
    攻框.appendChild(造节点('div', 'attackValue hs-atk', d.攻));
    var 血框 = 造节点('div', 'healthValueBackground hs-hp-wrap');
    血框.appendChild(造节点('div', 'healthValue hs-hp', d.血));
    el.appendChild(攻框);
    el.appendChild(血框);
    /* children[2]：上游当初要它是为了放"护盾破裂"的动画节点；现在归我们当**关键词槽**
       （嘲讽/神圣护盾/剧毒/冻结/反击的角标都挂在这里，见 样式.css 的 .hs-kw）。 */
    el.appendChild(造节点('div', 'hs-kw'));
    if (d.关键词 && d.关键词.嘲讽) el.classList.add('hasTaunt');
    if (d.关键词 && d.关键词.神圣护盾) el.classList.add('hasDivineShield');
    /* children[3]：**卡名**。上游的场上卡是靠卡图认人的，卡图一剥，随从就只剩几个数字
       （2026-10-03 实测：打出去的 Skeleton 卡面上没有任何名字）。手牌卡一直有名字、
       场上卡漏了，这里补上。为什么**追加在最后**：上游读的是 children[0]/[1]，
       手牌那条读 children[0].children[5] —— 追加不动任何一个已有下标。 */
    el.appendChild(造节点('div', 'hs-board-name', 名));
    return el;
  }

  /* 手牌卡。层级与上游一致：children[0]=脸 > [攻,血,费,文案,border,名]（第 5 个是名字） */
  function 造手牌卡(名) {
    var d = 表[名] || { 费: 0, 攻: 1, 血: 1 };
    var 卡 = 造节点('div', 'card');
    var 脸 = 造节点('div', 'card-face');
    脸.appendChild(造节点('div', 'cardAttackValue hs-atk', d.攻));
    脸.appendChild(造节点('div', 'cardHealthValue hs-hp', d.血));
    脸.appendChild(造节点('div', 'cardManaValue hs-mana', d.费));
    脸.appendChild(造节点('div', 'cardInfoValue hs-info', d.说明 || ''));
    脸.appendChild(造节点('div', 'card-border hs-border'));      // 上游给它染色表示"出得起/出不起"
    脸.appendChild(造节点('div', 'cardNameValue hs-name', 名));
    卡.appendChild(脸);
    return 卡;
  }

  /* 卡对象：两套名字都给（见文件头的过渡契约） */
  function 造卡对象(名) {
    var d = 表[名] || { 费: 0, 攻: 1, 血: 1, 说明: '' };
    return {
      名: 名, 费: d.费, 攻: d.攻, 血: d.血, 说明: d.说明 || '', 稀有: d.稀有 || 'Common',
      关键词: d.关键词 || {}, 战吼: d.战吼 || [], 亡语: d.亡语 || [], 召唤物: !!d.召唤物,
      // —— 过渡：上游读的那套字段名 ——
      name: 名, mana: d.费, attack: d.攻, health: d.血, info: d.说明 || '', imageString: '',
      getPlayerHTML: function () { return 造场上卡(名, 'player'); },
      getComputerHTML: function () { return 造场上卡(名, 'enemy'); },
      getPlayerCardsInHandHTML: function () { return 造手牌卡(名); }
    };
  }

  /* 自由对战的卡池：**照上游 freshDeck() 的返回顺序**（63 张位，见 抽上游卡数据.py 的输出）。
     关卡牌组不从这里分派 —— 见下面 freshDeck 总闸里 HS_LEVEL_DECK 那一条。 */
  var 自由卡池 = ('Elite Tauren Chieftain,Devout Adventurer,Devout Adventurer,Deathwing,Elven Archer,Elven Archer,'
    + 'Voodoo Doctor,Voodoo Doctor,King Krush,Ragnaros the Firelord,The Lich King,Acidic Swamp Ooze,'
    + 'Acidic Swamp Ooze,Lifedrinker,Lifedrinker,Alexstrasza,Razorfen Hunter,Razorfen Hunter,Murloc Tidehunter,'
    + 'Murloc Tidehunter,Leeroy Jenkins,Gnomish Inventor,Gnomish Inventor,"Sen\'jin Shieldmasta",'
    + '"Sen\'jin Shieldmasta",Saronite Chain Gang,Saronite Chain Gang,Archmage,Boulderfist Ogre,Boulderfist Ogre,'
    + 'Stormwind Champion,Coldwraith,Coldwraith,Water Elemental,Water Elemental,Ghoul,Ghoul,Skeletal Knight,'
    + 'Skeletal Knight,Skeletal Knight,Glacial Shard,Glacial Shard,Saronite Chain Gang,Saronite Chain Gang,'
    + 'Maexxna,Maexxna,Trapped Soul,Trapped Soul,Sludge Belcher,Sludge Belcher,Grim Necromancer,Grim Necromancer,'
    + 'Skeleton,Skeleton,Slime,Slime,The Black Knight,The Black Knight,Bonemare,Bonemare,Whelp,Boar,Murloc Scout')
    .split(',');
  // 名字里有逗号的那两张（"Sen'jin Shieldmasta"）上面的写法会少引号，这里修回来
  for (var i = 0; i < 自由卡池.length; i++) 自由卡池[i] = 自由卡池[i].trim().replace(/^"|"$/g, '');

  /* freshDeck 的**总闸**（本文件里唯一的写入点）：关卡牌组优先，没有关卡就是自由卡池。
     关卡那一条由乙段寄存（HS_LEVEL_DECK），在这里被调用 —— 延迟解析很关键：
     乙段跑在丁段之前，那时自由卡池还没造出来；牌组是 startGame() 时才发的，所以来得及。
     一条硬规矩：别处要换牌组，只许登记 HS_LEVEL_DECK，**不许再写 freshDeck**。 */
  G.freshDeck = function () {
    if (typeof G.HS_LEVEL_DECK === 'function') return G.HS_LEVEL_DECK();
    var out = [];
    for (var i = 0; i < 自由卡池.length; i++) out.push(造卡对象(自由卡池[i]));
    return out;
  };

  /* 牌库（上游 `new Deck(cards)` 的替身；只实现它真用到的那几样） */
  function 牌库(cards) { this.cards = cards || G.freshDeck(); }
  牌库.prototype.shuffle = function () {
    for (var i = this.cards.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = this.cards[i]; this.cards[i] = this.cards[j]; this.cards[j] = t;
    }
  };
  Object.defineProperty(牌库.prototype, 'numberOfCards', { get: function () { return this.cards.length; } });
  G.Deck = 牌库;                 // 过渡：上游 index.js 里写的是 new Deck(...)
  G.HS_CARD = { 造场上卡: 造场上卡, 造手牌卡: 造手牌卡, 造卡对象: 造卡对象, 牌库: 牌库, 卡池: 自由卡池 };
})(typeof globalThis !== 'undefined' ? globalThis : this);

})(typeof globalThis !== 'undefined' ? globalThis : this);
