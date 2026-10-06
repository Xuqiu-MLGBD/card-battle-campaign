/* 关卡挑战版 · 菜单与键位（游戏/菜单.js —— 去上游，2026-10-05）
 * =====================================================================
 * 为什么要有这个模块：菜单的开关原来散在三处，而且没有一处是"正式打包的模块"——
 *   · `index.html` 末尾内联的 `showGameMenu()`：它**定义在 `</body>` 之后**，
 *     而抽骨架只切 `</head>`…`</body>` → 函数被丢在骨架外。沙盒里 `W.showGameMenu`
 *     是 undefined，我们的「设置」按钮那句 `typeof … === 'function'` 就**静默跳过**
 *     （用户 2026-10-05 报的"设置点不动"就是这个；菜单的 DOM 倒是进来了，
 *      因为 `#gamemenu` 写在 `</head>` 与 `<body>` 之间，会被切进去）；
 *   · ESC 是 `src/scripts/elementsController.js` 里**另一套独立实现**（自己一个 keydown，
 *     直接改 `#gamemenu` 显隐）—— 所以"ESC 能开、按钮不能开"；
 *   · 两边各写一份，行为迟早分叉，而且两处都依赖被宿主改写的 `document.getElementById`。
 *
 * 现在收成**一个入口**：按钮与 ESC 都走 `HS_MENU.切换()`；DOM 只在**根基**里找
 * （舞台根 / body，见 `游戏/查找.js` 的说明），不碰被改写的 document 查找。
 *
 * 键位优先级（故意这样排）：`界面.js` 的 keydown 绑在**捕获**阶段，它在"正在瞄准 /
 * 有待选目标"时会 `preventDefault` 把 ESC 吃掉。本模块绑在**冒泡**阶段，并且
 * `e.defaultPrevented` 为真就直接不接手 —— 于是 ESC 在有事要取消时先取消，
 * 没事时才开合菜单。
 */
(function (W) {
  'use strict';
  if (W.HS_MENU) return;
  var d = W.document;

  function 根() {
    try {
      if (W.HS_SANDBOX && typeof W.HS_SANDBOX.根 === 'function') {
        var r = W.HS_SANDBOX.根();
        if (r && r.querySelector) return r;
      }
    } catch (e) {}
    return (d && (d.body || d.documentElement)) || null;
  }
  function 找(sel) {
    var r = 根(), el = null;
    try { el = r ? r.querySelector(sel) : null; } catch (e) {}
    if (!el) { try { el = d.querySelector(sel); } catch (e) {} }
    return el;
  }
  function 显(el, 开) { if (el && el.style) el.style.display = 开 ? 'block' : 'none'; }
  function 记(内容, 严重) {
    try { if (W.HS_CHECK && W.HS_CHECK.报) W.HS_CHECK.报(6, 'UI_INVALID_INPUT', 内容, 严重 || '提示'); } catch (e) {}
  }

  function 面板() { return 找('#gamemenu'); }
  function 抽屉() { return 找('#gamemenuContent'); }
  /* 开关用**类**（`hs-open`）而不是行内 display：外观（遮罩、居中、面板）全在
     游戏/样式.css 里声明，这里只管"加/去一个类" —— 这样换皮只改样式表。 */
  function 开着() { var m = 面板(); return !!(m && m.classList && m.classList.contains('hs-open')); }

  /* 开：把上游那两句（display:block + openMenuAnim）照做，动画类过一会儿自己摘掉 */
  function 开() {
    var m = 面板(), c = 抽屉();
    if (!m || !c) { 记({ 菜单: '找不到 #gamemenu / #gamemenuContent，开不了' }); return false; }
    try { m.classList.add('hs-open'); } catch (e) { 显(m, true); 显(c, true); }
    return true;
  }

  /* 关：把抽屉收起来。原来这里要先关"选项"子菜单（上游那套 Sound/FPS 面板）——
     2026-10-05 那套窗体已从 index.html 整块删除（用户：这些无用的显示删去），所以只剩抽屉。 */
  function 关() {
    try { 面板().classList.remove('hs-open'); } catch (e) { 显(面板(), false); 显(抽屉(), false); }
    return true;
  }

  function 切换() { return 开着() ? 关() : 开(); }

  /* ---------------------------------------------------------------- 抽屉里的四个按钮
     上游那份接线（`elementsController.js` 里的 `resumebtn.onclick` / `optionsbtn` / `concedebtn` /
     `quitbtn`）**随文件一起删掉了** —— 删完不接，抽屉就会只剩一颗「Resume」按不动，
     人一旦打开菜单就只能靠 ESC 出来（ESC 是我们的，能用，但这不该是唯一出路）。
     所以这里接上：Resume → 关；Concede → 认输（走 回合.js 的失败序列）再关。
     Options / Quit 我们**没有对应功能**（音量随音频一起去掉、退出到主页面另有入口），
     直接藏起来 —— 留着一颗点了没反应的按钮比没有更糟。 */
  function 装抽屉() {
    var 接 = function (id, fn) {
      var el = 找('#' + id);
      if (!el || el.__hsWired) return false;
      el.__hsWired = true;
      el.addEventListener('click', function (e) { try { e.preventDefault(); } catch (er) {} fn(); });
      return true;
    };
    var 藏 = function (id) { var el = 找('#' + id); if (el) el.style.display = 'none'; };
    接('resumebutton', 关);
    /* 「返回原生界面」：**只在沙盒里有意义**（关掉舞台回到平台聊天页）。独立网页没有 SDK，
       这颗按钮就藏起来 —— 留一颗点了没反应的按钮比没有更糟。 */
    var 有SDK = false;
    try { 有SDK = !!(W.HS_SANDBOX && typeof W.HS_SANDBOX.有SDK === 'function' && W.HS_SANDBOX.有SDK()); } catch (e) {}
    var 返钮 = 找('#backnativebutton');
    if (返钮) 返钮.style.display = 有SDK ? '' : 'none';
    接('backnativebutton', function () {
      关();
      try { if (W.HS_SANDBOX && typeof W.HS_SANDBOX.关闭 === 'function') W.HS_SANDBOX.关闭(); } catch (e) {}
    });
    接('mainmenubutton', function () {
      关();                                            // 先收抽屉，再回主页面
      try {
        if (W.CAMPAIGN_UI && typeof W.CAMPAIGN_UI.回主菜单 === 'function') { W.CAMPAIGN_UI.回主菜单(); return; }
        /* 沙盒/独立网页都走上面那条；真没有就退回"刷新页面"这个最笨但一定有效的办法 */
        W.location.reload();
      } catch (e) {}
    });
    接('concedebutton', function () {
      关();
      try { if (W.HS_TURN && typeof W.HS_TURN.失败 === 'function') W.HS_TURN.失败(); } catch (e) {}
    });
    /* Options / Quit 两颗按钮**已从 index.html 删掉**（我们没有对应功能），
       所以这里不再需要运行时藏它们 —— 留着"藏"的代码会让人以为标记里还有。 */
    return true;
  }

  /* ESC：冒泡阶段接，别人已经用掉的不抢（见文件头"键位优先级"）。
     ⚠ 两个轻量探针（诊断"ESC 没反应"时先看它们，别看现象猜）：
       `W.HS_MENU_按键`   —— 监听到底有没有被调到（不涨 = 事件没到；
                             涨了但状态不对 = 进来时"开着"的判断与看到的界面不一致，见下）。
       `W.HS_MENU_诊断`   —— 最近一次 ESC 的判定快照。
     2026-10-05 用它们抓到过一次真凶：`src/scripts/elementsController.js` 里**另有一套 ESC**
     与我们互相打架（它按"当前显隐"关、我们按"当前显隐"开，净效果是关不掉）——那一段已删。 */
  function onKey(e) {
    W.HS_MENU_按键 = (W.HS_MENU_按键 || 0) + 1;
    var k = e && (e.key || e.keyCode);
    if (!(k === 'Escape' || k === 27)) return;
    var 被吃 = !!e.defaultPrevented;
    var 前 = 开着();
    W.HS_MENU_诊断 = { 被吃: 被吃, 按前开着: 前 };
    if (被吃) return;
    切换();
    W.HS_MENU_诊断.按后开着 = 开着();
  }
  try { if (d && d.addEventListener) d.addEventListener('keydown', onKey, false); } catch (e) {}

  /* 抽屉按钮：载入期先接一次，之后 `查找.js` 自愈把 id 补回来的那几拍再各接一次 */
  装抽屉();
  W.setTimeout(function () { 装抽屉(); }, 600);
  W.setTimeout(function () { 装抽屉(); }, 2000);

  W.HS_MENU = {
    版本: 1,
    开: 开, 关: 关, 切换: 切换, 开着: 开着, 装抽屉: 装抽屉,
    根: 根, 找: 找,
  };
})(typeof window !== 'undefined' ? window : globalThis);
