/* 关卡挑战版 · 检错层（游戏/检错.js —— 架构改进：全链路检错）
 * ==========================================================================
 * 照那份全链路检错图：**每一层出错都要落成"层 + 码 + 上下文 + 处理"**，
 * 全部汇进一个**聚合器** → 出一份**诊断报告** → 判断**可恢复？**
 *   可恢复 → 回到安全节点继续
 *   不可恢复 → 暂停游戏并提示用户
 *
 * 为什么要有这一层（而不是继续"到处 console.error / 静默"）：
 *   ① 本会话踩的 5 个"点了没反应"级 bug，全都是**错误落在了没人看的地方**：
 *      上游监听器里的异常接不出来、被 stopPropagation 的处理器悄无声息、
 *      面板/指示条/画布把点击吃掉而代码一切正常；
 *   ② A 已经把**规则拒绝**结构化（引擎的码表 → 文案表），但那只覆盖"规则说不"这一种；
 *      还有**输入不合法 / 元信息不全 / 决策请求畸形 / 提交不自洽 / 展示超前 / 日志不全** 这些种类；
 *   ③ 有了聚合器，就能给出"这一局到底哪里不对劲"的**一份东西** —— 而不是让用户截图 + 我们猜。
 *
 * 层的名字直接用那张图的编号与说法（可对照 debug）：
 *   0 输入层 · 1 意图层 · 2 规则核心 · 3 决策层 · 4 提交层 · 5 事件层 · 6 展示层 · 7 日志与回放 · 8 适配/宿主
 *
 * 严重度（决定"恢复"策略）：
 *   '致命' —— 规则真相可能已经错了：**暂停游戏并提示用户**（我们已有的 #hs-losebar 复用为"暂停条"）
 *   '严重' —— 可修：**回到安全节点**（清临时图层 / 放弃待选 / 追平展示 / 解锁管线，再继续）
 *   '提示' —— 只记录（例如玩家点了非法目标这类"用户行为噪声"，不该刷屏打扰他）
 */
(function (W) {
  'use strict';
  if (W.HS_CHECK) return;

  var 上限 = 200;                       // 报告里最多留多少条（防内存涨）
  var 记录 = [];
  var 计数 = {};
  var 恢复器 = {};                      // 码 → function()：怎么回到安全节点
  var 暂停钩子 = null;                  // 致命错误的"暂停游戏并提示"

  function 层名(层) {
    var 表 = ['输入层', '意图层', '规则核心', '决策层', '提交层', '事件层', '展示层', '日志与回放', '适配/宿主'];
    return (typeof 层 === 'number' && 表[层]) ? 表[层] : String(层);
  }

  /* 报一条问题。**所有层都只调这一个入口** —— 这样"哪里出过什么事"永远只有一份账。 */
  function 报(层, 码, 上下文, 严重) {
    var 条 = {
      时: 时间戳(),
      层: 层名(层),
      码: String(码 || 'UNKNOWN'),
      严重: 严重 || '提示',
      上下文: 上下文 || null,
    };
    记录.push(条);
    if (记录.length > 上限) 记录.shift();
    计数[条.码] = (计数[条.码] || 0) + 1;
    /* 可恢复 → 立刻回到安全节点；不可恢复 → 交给暂停钩子（由界面注册） */
    if (条.严重 === '严重' && 恢复器[条.码]) { try { 恢复器[条.码](条); } catch (e) {} }
    if (条.严重 === '致命' && typeof 暂停钩子 === 'function') { try { 暂停钩子(条); } catch (e) {} }
    try {
      if (W.console && W.console.warn) W.console.warn('[检错] ' + 条.严重 + ' · ' + 层名(层) + ' · ' + 条.码, 上下文 || '');
    } catch (e) {}
    return 条;
  }

  function 时间戳() { try { return Date.now(); } catch (e) { return 0; } }

  /* 注册"这个码怎么回到安全节点"（界面在 boot 时登记：清临时图层 / 放弃待选 / 解锁管线…） */
  function 登记恢复(码, fn) { if (typeof fn === 'function') 恢复器[码] = fn; }
  function 登记暂停(fn) { 暂停钩子 = fn; }

  function 聚合() {
    return {
      总数: 记录.length,
      计数: JSON.parse(JSON.stringify(计数)),
      最近: 记录.slice(-20),
      有致命: 记录.some(function (x) { return x.严重 === '致命'; }),
    };
  }
  function 清空() { 记录 = []; 计数 = {}; }

  /* ------------------------------------------------- 资源与样式：两个"从来没人查过"的体检
     （都是纯读；取不到证据时**一律不报**，宁可漏报也不要误报把玩家吓到） */

  /* 页面引用的**本地** link/script，有没有加载失败。
     怎么判"失败"（三档证据，从强到弱）：
       ① `performance` 里那条资源记录的 `responseStatus` ≥ 400（新 Chrome 有）；
       ② 样式表：`document.styleSheets` 里虽然排在，但 `cssRules.length === 0`
          （404 返回 HTML 时浏览器就是这样：建一张空表，静默失败）；
       ③ 记录在案但 transferSize/decodedBodySize 都是 0（老浏览器的近似判据）。
     外链（CDN 字体图标）不查：离线环境下它必然失败，与"我们打包缺件"是两回事。 */
  function 资源缺口(d) {
    var 缺 = [];
    try {
      var 本地 = /^(?:[a-z]+:)?\/\//i;
      var 表 = {};                                  // url(去查询串) → 资源记录
      try {
        (W.performance && W.performance.getEntriesByType ? W.performance.getEntriesByType('resource') : [])
          .forEach(function (e) {
            var u = String(e.name || '').split('#')[0].split('?')[0];
            表[u] = e;
            表[u.replace(/^.*?\/([^/]*)$/, '$1')] = e;   // 也允许按文件名命中
          });
      } catch (e) { /* 没有 performance：退化成"只看样式表空表"这一档 */ }

      var 查一个 = function (标签, 地址) {
        if (!地址 || 本地.test(地址) || /^data:/i.test(地址)) return;
        var 净 = String(地址).split('#')[0].split('?')[0];
        var 记 = 表[净] || 表[净.replace(/^.*?\/([^/]*)$/, '$1')];
        var 坏 = false, 因 = '';
        if (记) {
          if (typeof 记.responseStatus === 'number' && 记.responseStatus >= 400) { 坏 = true; 因 = 'HTTP ' + 记.responseStatus; }
          else if (记.transferSize === 0 && 记.decodedBodySize === 0 && 记.duration === 0) { 坏 = true; 因 = '没有传输到任何字节'; }
        }
        if (!坏 && 标签 === 'link') {                // 样式表：空表 = 静默失败
          var 空 = 空样式表(d, 净);
          if (空) { 坏 = true; 因 = '样式表存在但规则为空（多半是 404 回来的 HTML）'; }
        }
        if (坏) 缺.push({ 谁: 标签, 址: 净, 因: 因 });
      };

      var 链 = d.querySelectorAll ? d.querySelectorAll('link[rel~="stylesheet"][href]') : [];
      for (var i = 0; i < 链.length; i++) 查一个('link', 链[i].getAttribute('href'));
      var 脚 = d.querySelectorAll ? d.querySelectorAll('script[src]') : [];
      for (var j = 0; j < 脚.length; j++) 查一个('script', 脚[j].getAttribute('src'));
    } catch (e) { /* 读 DOM 出错不该拖垮体检本身 */ }
    return 缺;
  }

  function 空样式表(d, 净) {
    try {
      var 尾 = 净.replace(/^.*?\/([^/]*)$/, '$1');
      var 表集 = d.styleSheets || [];
      for (var i = 0; i < 表集.length; i++) {
        var s = 表集[i];
        var h = String((s && s.href) || '').split('#')[0].split('?')[0];
        if (!h) continue;
        if (!(h === 净 || 尾 === 净 || h.slice(-净.length) === 净)) continue;
        try {
          if (s.cssRules && s.cssRules.length === 0) return true;   // 命中了这张表，但它一条规则都没有
          return false;                                             // 命中了且有规则 → 正常
        } catch (e) { return false; }                               // 跨域读 cssRules 会抛 → 不是我们的情况，放过
      }
      /* 页面上根本找不到这张表：可能是 link 没生效，也可能被宿主重写了地址（沙盒就会），
         证据不足 → 不算失败，交给上面两档去判。 */
      return false;
    } catch (e) { return false; }
  }

  /* 样式生效了吗。
     ⚠ 第一版这里拿"body 计算底色必须是纯黑"当判据（因为上游 styles.css 写了
       `body{background-color:black}`）—— 结果**误报**：我们自己的 样式.css 把 body 改成了深蓝，
       合理覆盖上游那一句。教训：**不要用"计算结果"去证明"某张表加载了"**，层叠本来就会改结果。
     现在的判据都是"加载事实"或"只有我们那张表才会有的效果"：
       ① 外链了 styles.css 时：它必须出现在 document.styleSheets 里且**规则非空**
          （404 回来的 HTML 会被浏览器建成一张空表 —— 这正是缺件时的长相）；
       ② 我们自己 样式.css 里 `#fireworkCanvas{display:none!important}` 真的落到了元素上
          （上游那份 CSS 不管这块画布，所以这个"none"只可能来自我们）；
       ③ 整页容器没有成排外露（裸 HTML 的典型长相：样式没生效时它们会同时显示）。 */
  function 样式生效(d) {
    var 出 = { 上游底: true, 查了上游: false, 上游表: true, 我们画布: true, 外露: 0, 底: '', 该藏的: [] };
    try {
      var g = W.getComputedStyle;
      var 有上游表 = !!(d.querySelector && d.querySelector('link[rel~="stylesheet"][href*="styles.css"]'));
      出.查了上游 = 有上游表;
      if (有上游表) 出.上游表 = 样式表有规则(d, 'styles.css');
      出.上游底 = 出.上游表;                      // 兼容旧字段名（自检与报告在用）
      if (typeof g === 'function' && d.body) {
        try { 出.底 = g(d.body).backgroundColor || ''; } catch (e) {}   // 只作诊断信息，不参与判定
      }
      /* 我们 样式.css: #fireworkCanvas / #snowCanvas { display:none !important }。
         元素不存在就不算失败（有些宿主根本不会建它）。 */
      var 画布 = d.getElementById && (d.getElementById('fireworkCanvas') || d.getElementById('snowCanvas'));
      if (画布 && typeof g === 'function') {
        var dp = '';
        try { dp = g(画布).display || ''; } catch (e) {}
        出.我们画布 = (dp === 'none');
      }
      /* 样式没生效的典型长相：几个"整页容器"同时外露（正常时最多只有一个，且不该是菜单类）。 */
      ['optionsmenu', 'tutorialmenu', 'shopmenu', 'victory', 'howtoplay'].forEach(function (id) {
        var e = d.getElementById && d.getElementById(id);
        if (!e || typeof g !== 'function') return;
        var dp = '';
        try { dp = g(e).display || ''; } catch (err) {}
        if (dp && dp !== 'none') 出.该藏的.push(id);
      });
      出.外露 = 出.该藏的.length;
    } catch (e) { /* 出错就当通过：体检不该自己制造噪声 */ }
    return 出;
  }

  /* 这张样式表在页面里加载成功了吗（存在 + 规则非空）。读不到 cssRules 就当作已加载，不误报。 */
  function 样式表有规则(d, 尾名) {
    try {
      var 集 = (d.styleSheets || []);
      for (var i = 0; i < 集.length; i++) {
        var h = String((集[i] && 集[i].href) || '').split('#')[0].split('?')[0];
        if (!h || h.slice(-尾名.length) !== 尾名) continue;
        try { return !!(集[i].cssRules && 集[i].cssRules.length > 0); } catch (e) { return true; }
      }
      return false;                                  // 页面上根本没有这张表
    } catch (e) { return true; }
  }

  /* ---------------------------------------------------------------- 运行期不变量
     这张清单是"我们这一周真踩过的坑"逐条变成断言 —— 每一类 bug 都对应上面一个错误码。
     它**只读** DOM 与全局状态（不修任何东西），所以可以随时跑（自检、导出本局信息、出牌前后）。 */
  function 跑不变量() {
    var d = W.document;
    if (!d || !d.getElementById) return [];
    var 问 = [];
    function 查(层, 码, 坏, 上下文) { if (坏) 问.push({ 层: 层名(层), 码: 码, 上下文: 上下文 || null, 严重: '严重' }); }

    /* 6 展示层：临时图层不许在"空闲态"挂着（蒙版 / 箭头 / 预览 / 提示条）
       ← 真案例：用户"我的回合为什么会有遮罩" */
    var 拖拽中 = (W.HS_INTERACT && W.HS_INTERACT.state) ? (W.HS_INTERACT.state().state === 'aiming') : false;
    var 待选 = (W.HS_INTERACT && W.HS_INTERACT._待选) ? W.HS_INTERACT._待选() : null;
    var 该亮 = 拖拽中 || !!待选;
    ['hs-mask', 'hs-arrow', 'hs-preview'].forEach(function (id) {
      var e = d.getElementById(id);
      if (!e) return;
      var on = e.classList && e.classList.contains('on');
      查(6, 'PRESENTATION_LEFTOVER', on && !该亮, { 元素: id });
    });

    /* 6 展示层：模态面板开着时，战场不该同时"在局里"（← 真案例："实际无手牌"其实是被开始面板盖住） */
    var 模态 = ['hs-mainmenu', 'hs-codex', 'hs-start', 'campaign-overlay'].filter(function (id) {
      var e = d.getElementById(id);
      return e && e.classList && e.classList.contains('on') || (e && e.style && e.style.display && e.style.display !== 'none' && id === 'hs-mainmenu');
    });
    var 在局里 = (function () {
      var c = d.getElementById('contents');
      return !!c && getComputedStyle(c).visibility !== 'hidden';
    })();
    查(6, 'UI_MODAL_OVER_GAME', 在局里 && 模态.length > 0, { 模态: 模态 });

    /* 6 展示层：锁与队列必须一致（← 真案例："卡死了"= 锁没释放） */
    if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked && W.HS_PIPELINE.queueLength) {
      var 锁 = W.HS_PIPELINE.isLocked(), 队 = W.HS_PIPELINE.queueLength();
      查(6, 'ANIM_LOCK_STUCK', 锁 && 队 === 0 && !拖拽中, { 锁: W.HS_PIPELINE.reason ? String(W.HS_PIPELINE.reason()) : null });
    }

    /* 6 展示层：法力条颗数 = 本局部署位上限（← 真案例：负面任务降上限后水晶没裁） */
    if (W.HS_RESOURCE && W.HS_RESOURCE.上限) {
      var 颗 = d.getElementsByClassName('manabox').length;
      var 上 = W.HS_RESOURCE.上限();
      查(6, 'UI_CAP_MISMATCH', 颗 !== 上, { 水晶: 颗, 上限: 上 });
    }

    /* 2 规则核心：影子引擎的"结局"必须自洽（← 真案例：尸体留在场上 / 血量超上限）
       ⚠ `引擎.新建()` 返回的是**一个包** `{状态, 事件, 变更, 待选择}`，不是状态本身 ——
         第一版直接把它当状态传给 `检查()`，于是报 `Cannot read properties of undefined (reading 'p0')`
         （`状态.players` 不存在）。**是检错器自己先被抓了一次**，这就是它该有的样子。 */
    if (W.HS_ENGINE && W.HS_ENGINE.新建 && W.HS_ENGINE.检查) {
      try {
        var 包 = W.HS_ENGINE.新建({ 种子: 1, 牌组: { p0: [], p1: [] }, 卡表: W.HS_CARDS || {} });
        var 态 = 包 && 包.状态;
        if (!态 || !态.players) 查(2, 'ENGINE_INVARIANT', true, { 原因: '新建没返回状态（接口变了？）' });
        else {
          var 问题 = W.HS_ENGINE.检查(态) || [];
          查(2, 'ENGINE_INVARIANT', 问题.length > 0, { 问题: 问题.slice(0, 3) });
        }
      } catch (e) { 查(2, 'ENGINE_INVARIANT', true, { 抛错: String(e && e.message) }); }
    }

    /* 5 事件层 / 7 日志：事件与变更必须互为因果（引擎自带的校验） */
    if (W.HS_EVENT && W.HS_EVENT.校验事件) {
      try {
        var r = W.HS_EVENT.校验事件([]);
        查(5, 'EVENT_STATE_MISMATCH', Array.isArray(r) && r.length > 0, { 问题: (r || []).slice(0, 3) });
      } catch (e) { /* 空日志校验抛错 = 接口不对，记一条 */ 查(7, 'LOG_INCOMPLETE', true, { 抛错: String(e && e.message) }); }
    }

    /* 4 提交层 / 6 展示层：**权威状态与 DOM 必须一致**（改进 B 的核心不变量）。
       "两套真相"就是这样现形的：权威说 3 血、DOM 写成 1 血 —— 不管是谁偷改的 DOM，
       都会被这一幕抓住。`HS_UI_取值` 是界面注册的取值器（检错层自己不碰 DOM）。 */
    if (W.HS_STATE && typeof W.HS_STATE.对账 === 'function' && typeof W.HS_UI_取值 === 'function') {
      /* ★ 只在**管线空闲**时判"两套真相"。演出/敌方回合进行中，DOM 本来就领先或落后于权威
         （提交点是按事件定的），此时报 UI_WRONG_SOURCE 是噪声不是问题 —— 实测在实机开局那几秒
         误报过，屏幕上那条错误条跟着喊，反而掩盖了真正的问题（返回条被盖住）。 */
      var 管线闲 = true;
      try {
        if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked && W.HS_PIPELINE.queueLength) {
          管线闲 = !W.HS_PIPELINE.isLocked() && W.HS_PIPELINE.queueLength() === 0;
        }
      } catch (e) {}
      try {
        var 差 = 管线闲 ? (W.HS_STATE.对账(W.HS_UI_取值) || []) : [];
        if (差.length) 查(6, 'UI_WRONG_SOURCE', { 差异: 差.slice(0, 3) });
      } catch (e) { 查(4, 'ATOMIC_VIOLATION', { 抛错: String(e && e.message) }); }
    }

    /* 6 展示层：**空闲却仍落后于权威**（改进 E 的不变量）。
       正常情况：演出播着的时候展示是落后的（这是设计 ✓）；演出播完（无锁无队列）就该追平。
       所以"空闲 + 落后"= 要么有人忘了标追平、要么演出没跑完就断了 —— 两种都是真问题。
       （与流程图里 `PRESENTATION_AHEAD` 对称的一侧：那边防"展示超前"，这边防"追不上"。） */
    if (W.HS_STATE && typeof W.HS_STATE.版本号 === 'function') {
      try {
        var v = W.HS_STATE.版本号();
        var 闲 = true;
        if (W.HS_PIPELINE && W.HS_PIPELINE.isLocked && W.HS_PIPELINE.queueLength) {
          闲 = !W.HS_PIPELINE.isLocked() && W.HS_PIPELINE.queueLength() === 0;
        }
        查(6, 'PRESENTATION_LAG_STUCK', !!(v && 闲 && v.展示revision < v.revision),
           v ? { 展示: v.展示revision, 权威: v.revision } : null);
      } catch (e) {}
    }

    /* 8 适配/宿主：**页面引用的本地文件是否真的存在并加载成功**。
       ← 真案例（2026-10-04）：展示包用白名单拷贝，把 styles.css / index.js / src/scripts/*.js
         搬进了子目录，而 index.html 引用的是根路径 → 打开包是"裸 HTML"：上游靠样式表藏起来的
         Victory / Sound / Options / Show FPS 全部外露，点击还被 fireworkCanvas 吃掉。
         当时页面自检 35 项全绿 —— 因为它只查运行时状态，**从来没有人查过"资源在不在"**。
       （静态版是 工具/引用体检.js：不跑浏览器，直接解析 index.html 的引用；这里是运行期版。） */
    var 缺资源 = 资源缺口(d);
    查(8, 'ASSET_MISSING', 缺资源.length > 0, { 缺: 缺资源 });

    /* 8 适配/宿主：样式**是不是真的落到元素上了**（"文件在"不等于"生效"）。
       两个探针都是逐字事实，不依赖我们的命名：
         · 第三方 styles.css 的 `body{background-color:black}`（该文件逐字未改）—— 少了它就是透明；
         · 我们自己 样式.css 把 `#fireworkCanvas` 藏住 —— 这正是上次"点击被画布吃掉"的坑；
       再补一条"页面容器外露"的计数：样式没生效时，几个本该隐藏的整页容器会**同时**暴露。 */
    var 样式 = 样式生效(d);
    查(8, 'STYLE_NOT_APPLIED', !样式.上游底 || !样式.我们画布 || 样式.外露 >= 2, 样式);

    /* 8 适配/宿主：沙盒里必须"骨架齐、血量元素在、脚本到齐"（← 真案例：实机没有手牌/没有血量数字）
       ⚠ 这里的查找**必须走根部作用域**（`HS_UI_找`，见 游戏/查找.js）：`document.getElementById`
         是被平台改写过的方法，在真机上会拿不到舞台里的元素 —— 拿它当判据就会误报
         "SKELETON_INCOMPLETE"（2026-10-05 实机就误报过，屏幕上的错误条跟着喊狼来了）。 */
    if (W.HS_SANDBOX && typeof W.HS_SANDBOX.有SDK === 'function' && W.HS_SANDBOX.有SDK()) {
      var 找 = (W.HS_UI_找 && typeof W.HS_UI_找 === 'function') ? W.HS_UI_找 : function (sel) { return d.querySelector(sel); };
      var 缺 = [];
      ['contents', 'game', 'cards', 'playerhero', 'opposinghero'].forEach(function (id) { if (!找('#' + id)) 缺.push(id); });
      查(8, 'SKELETON_INCOMPLETE', 缺.length > 0, { 缺: 缺 });
      var 少 = [];
      ['.playerHeroHealth', '.opposingHeroHealth'].forEach(function (s) { if (!找(s)) 少.push(s); });
      查(8, 'UI_WRONG_SOURCE', 少.length > 0, { 缺: 少 });
      var 没到 = ['HS_SANDBOX', 'HS_CARDS', 'HS_ENGINE', 'HS_RESOURCE', 'HS_DECIDE', 'HS_TEXT', 'HS_INTERACT']
        .filter(function (k) { return typeof W[k] === 'undefined'; });
      查(8, 'MODULE_MISSING', 没到.length > 0, { 缺: 没到 });
    }
    return 问;
  }

  /* 跑一遍不变量：**报告但不打扰玩家**（提示级）。
     两种恢复策略，区别在"这个动作安不安全"：
       · **安全恢复清单**里的码：查出来就**立刻**回到安全节点（撤临时图层 / 关面板 / 重画水晶
         —— 这些动作是无害的，晚了反而是 bug 拖更久）；
       · 其余（可能要丢演出位置、跳帧的，例如"锁卡住"）：**连续两次**同一个码才升级为"严重"并恢复。
     分级的原因：前者纯显示、修了没有任何副作用；后者会"跳过演出"，不该因为一次瞬时抖动就跳。 */
  var 安全恢复 = ['PRESENTATION_LEFTOVER', 'UI_MODAL_OVER_GAME', 'UI_CAP_MISMATCH', 'UI_WRONG_SOURCE'];
  /* 这两类是**环境坏了**（资源没到 / 样式没生效），不是瞬时抖动：不必等第二次，第一次就该是"严重"。
     它们没有自动恢复动作（恢复器里没登记就是空操作），只求**别被当成提示级淹没**。 */
  var 立刻严重 = ['ASSET_MISSING', 'STYLE_NOT_APPLIED'];
  function 体检() {
    var 问 = 跑不变量();
    var 升级 = [];
    问.forEach(function (x) {
      var 已知 = 计数[x.码] || 0;
      var 立刻 = 安全恢复.indexOf(x.码) >= 0;
      var 严重 = (立刻 || 立刻严重.indexOf(x.码) >= 0) ? '严重' : (已知 >= 1 ? '严重' : '提示');
      报(x.层, x.码, x.上下文, 严重);
      if (严重 === '严重' && !立刻) 升级.push(x.码);
    });
    return { 问: 问, 升级: 升级 };
  }

  /* ---------------------------------------------------------------- 诊断报告（给人看的） */
  function 报告() {
    var 聚 = 聚合();
    var 行 = ['=== 全链路检错 · 诊断报告 ===',
              '记录 ' + 聚.总数 + ' 条' + (聚.有致命 ? '（**有致命错误**）' : '')];
    var 码 = Object.keys(聚.计数);
    if (!码.length) 行.push('（没有记录 —— 这一轮没抓到问题）');
    else {
      行.push('按码计数：' + 码.map(function (k) { return k + '×' + 聚.计数[k]; }).join('  '));
      行.push('最近 20 条：');
      聚.最近.forEach(function (x) {
        行.push('  [' + x.严重 + '] ' + x.层 + ' · ' + x.码 + (x.上下文 ? ' ' + JSON.stringify(x.上下文) : ''));
      });
    }
    /* 顺便把"四道闸"里能现跑的那一道（运行期不变量）跑一次，附在报告里 */
    var 问 = 跑不变量();
    行.push('运行期不变量：' + (问.length ? 问.map(function (x) { return x.层 + '/' + x.码; }).join('、') : '全部通过'));
    return 行.join('\n');
  }

  W.HS_CHECK = {
    版本: 1,
    报: 报,
    聚合: 聚合,
    清空: 清空,
    登记恢复: 登记恢复,
    登记暂停: 登记暂停,
    跑不变量: 跑不变量,
    体检: 体检,
    报告: 报告,
    层名: 层名,
    资源缺口: 资源缺口,     /* 界面自检要用：本地 link/script 有没有加载失败 */
    样式生效: 样式生效,     /* 界面自检要用：样式到底有没有落到元素上 */
    /* 码表（这一层的码；规则拒绝的码在 引擎.js，中文文案在 文案.js） */
    码: {
      输入: 'UI_INVALID_INPUT',
      元信息: 'META_INCOMPLETE',
      决策请求: 'DECISION_MALFORMED',
      决策响应: 'DECISION_INVALID',
      提交: 'ATOMIC_VIOLATION',
      版本断层: 'REVISION_GAP',
      事件: 'EVENT_STATE_MISMATCH',
      展示超前: 'PRESENTATION_AHEAD',
      动画写状态: 'ANIM_WRITE_STATE',
      展示残留: 'PRESENTATION_LEFTOVER',
      模态压场: 'UI_MODAL_OVER_GAME',
      锁卡住: 'ANIM_LOCK_STUCK',
      上限不符: 'UI_CAP_MISMATCH',
      渲染源: 'UI_WRONG_SOURCE',
      日志不全: 'LOG_INCOMPLETE',
      骨架不全: 'SKELETON_INCOMPLETE',
      模块缺失: 'MODULE_MISSING',
      缺资源: 'ASSET_MISSING',
      样式没生效: 'STYLE_NOT_APPLIED',
      引擎不变量: 'ENGINE_INVARIANT'
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
