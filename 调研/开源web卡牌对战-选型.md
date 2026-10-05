# 开源 web 卡牌对战 · 选型报告

> 目标（用户 2026-10-02）：找一个**炉石传说 / 万智牌那种卡牌对战**（不是杀戮尖塔那种 Roguelike 爬塔）
> 的开源 web 实现，从中**导出一份「无联机对战」的关卡挑战版本**，放进 MMD 的「开源卡牌案例」。
>
> 本报告只写**核实过的**事实。每条都标了来源（GitHub API 实测 / 仓库文件）。凡是没核实的，写「待核」。

---

## 0. 硬约束（先定筛子，再看候选）

从「要塞进 MMD 角色卡」倒推出来的四条硬约束：

| # | 约束 | 为什么 |
|---|---|---|
| H1 | **玩法必须是炉石/万智牌式** —— 随从互相攻击、费用/法力、英雄血量、回合交替 | 用户明确否掉了杀戮尖塔式（Roguelike 爬塔）。联合派对本体也是 TCG（`main.md` 项目目标） |
| H2 | **必须能完全没有联机** —— 不需要服务端、不需要 websocket | 「无联机对战」是这次的交付条件，不是可选项 |
| H3 | **最好自带 AI 对手** | 关卡挑战的前提是有人跟你打。没有 AI 的话，「无联机」就只剩打空气 |
| H4 | **许可证允许改制与再分发** | 要拿去改、要放进案例库。没有许可证 = 法律上不能碰 |

另有两条**软约束**（决定「能不能塞进卡」，不决定「能不能用」）：

| # | 约束 | 说明 |
|---|---|---|
| S1 | 无构建步骤 / 体积小 | MMD 沙盒把脚本按 **单条 ≤18000 UTF-16** 拆进正则规则（见 `scripts/pack_card.py`）。React/Vite/Angular 那一类要先打包再切，随从卡图音频更是塞不进 |
| S2 | 纯静态（`index.html` 直接开） | 便于本地预览、便于外链/二维码投放（项目已有先例：`怪物猎人装备工坊原型-二维码版/`） |

---

## 1. 候选清单（GitHub API 实测，2026-10-02）

★ 与许可证列取自 `api.github.com/repos/<full_name>`。**许可证为 `None` 的一律淘汰**（H4）。

### 1.1 炉石/万智牌式 —— 真正的候选

| 仓库 | ★ | 许可证 | 语言 | 需要服务端？ | 有 AI？ | 结论 |
|---|---|---|---|---|---|---|
| **`Rymedy/hearthstone-web`** | 36 | **MIT** | JavaScript | **否**（`index.html` + `index.js` + `src/`，无 package.json） | **有**（README 用户手册：「对手会打出一张牌」，回合交替的 bot） | ✅ **选中** |
| `keeshii/ryuu-play` | 114 | MIT | TypeScript | **是**（`@ptcg/server` websocket + Angular 前端） | **有**（`packages/simple-bot`，还跑 bot-vs-bot 排位） | 🥈 备选（最成熟，但要起服务端） |
| `rickypeng99/yugioh_web` | 122 | MIT | JavaScript (React) | **是**（联机走 websocket，另有一个 server 仓库） | 待核 | 🥈 备选（引擎完整，但要两个仓库一起起） |
| `inooid/react-redux-card-game` | 112 | MIT | JavaScript (React/Redux) | **是**（socket.io） | 待核 | ⚠️ 2018 停更，WIP |
| `cuttle-cards/cuttle` | 195 | MIT | JavaScript (Vue/Sails) | **是**（socket.io，双人） | 无 | ❌ 只有双人对战，没 AI |
| `EnginKARATAS/hearthstone-web-version` | 31 | **无许可证** | TypeScript (Vite) | 否 | 有（README：「Against computer mode, a game BOT」） | ❌ 无许可证，不能碰 |
| `webxoss/webxoss-core` | 23 | **无许可证** | JavaScript | 是（socket.io） | 无 | ❌ 无许可证 |
| `tim-tang/hearthstone` | 31 | GPL-3.0 | JavaScript | 是（Node 服务端） | — | ❌ 只有服务端 |

### 1.2 被否掉的（记录理由，避免重复调研）

| 仓库 | ★ | 许可证 | 否掉的理由 |
|---|---|---|---|
| `oskarrough/slaytheweb` | 315 | AGPL-3.0 | **玩法不对**：它是「singleplayer, deck builder, roguelike card crawl」，即杀戮尖塔式爬塔，正是用户排除的那一类 |
| `libnoname/noname`（无名杀） | 5079 | GPL-3.0 | **体量 + 许可**：仓库 **2.6 GB**；README 明确「请勿用于商业用途」；GPL-3.0 传染。最成熟的国产开源 web 卡牌，但拿不动 |
| `eduardonoso/slay-the-spire` | 1 | **无许可证** | 无许可证 + 玩法不对 |
| `obalfour/CryptoPokes` / `0xFableOrg/0xFable` | 28 / 108 | MIT / BSD | 区块链 TCG，不是单机对战 |
| `pakastin/deck-of-cards` | — | 0.1.x LGPL / 0.0.x MIT | 是**卡牌 UI 库**（洗牌/翻牌/扑克），不是对战游戏 |
| `ccgame`、各类记忆翻牌、斗地主、TUI 卡牌 | — | — | 不是炉石/万智牌式 |
| `google/boardgame.io` | — | MIT | 不是**游戏**，是回合制游戏**框架**。但它有一条很有价值的参考：`multiplayer:false` + `Local()`（内存 master）就是官方支持的「无服务器」跑法 + 内置 bot。**若将来要从零搭，这是许可最干净的基座** |

---

## 2. 为什么选 `Rymedy/hearthstone-web`

对照 H1–H4，它是唯一**四条全中**的：

- **H1 炉石式** ✅ 就是炉石克隆：随从、法力水晶（每回合 +1）、英雄血量、随从上场后要等一回合才能攻击、攻击时互相扣血、英雄技能（2 费打 1）。README 的用户手册把这套流程写得很清楚。
- **H2 无联机** ✅ **上游一行联机代码都没有**。它是纯静态页面，没有 `package.json`、没有 socket、没有 fetch 到后端。「无联机对战」不是我们去砍出来的功能，而是它的原生形态——这一条最干净，也最不容易改坏。
- **H3 有 AI** ✅ 自带 bot 对手（对手回合会自动出牌）。
- **H4 许可** ✅ **MIT**，随便改随便再分发，只需要保留版权声明。
- **S1/S2** ✅ 无构建步骤、纯 vanilla JS —— 唯一有希望压进 MMD 卡的一个。

**它差的那一块正好就是这次的任务**：上游只有**一场无尽对局**（打赢就结束，没有关卡概念）。所以「导出关卡挑战版本」= 在它之上**加一层关卡**，而不动它的对战逻辑。这也是最安全的改法（只加不删）。

### 2.1 版本与来源（可复现）

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/Rymedy/hearthstone-web` |
| 抓取方式 | `https://codeload.github.com/Rymedy/hearthstone-web/tar.gz/refs/heads/master` |
| 抓取日期 | 2026-10-02 |
| 上游最后推送 | 2021-08-22 |
| 默认分支 | `master` |
| 许可证 | MIT（见仓库根 `LICENSE`） |
| 在线试玩 | `https://rymedy.github.io/hearthstone-web/` |

---

## 3. 备选方案（若上游不适用）

按「先满足 H1/H4，再谈工程」排序：

1. **`keeshii/ryuu-play`（MIT，宝可梦 TCG）** —— 工程上最成熟：TypeScript monorepo，`@ptcg/common` 是纯逻辑库（客户端/服务端共用）、`@ptcg/sets` 放卡表、`@ptcg/simple-bot` 是现成 bot。**缺点**：它把「游戏状态」放在服务端、靠 websocket 推给 Angular 客户端，所以做「无联机版」= 关掉 server，把 `common` + `sets` + `simple-bot` 直接搬进浏览器跑。工作量大，但架构是支持的。
2. **`rickypeng99/yugioh_web`（MIT，游戏王）** —— 自研 JS 引擎（不用 ygocore/Lua 卡脚本），有卡片自定义接口，另有 Electron 分支说明逻辑与 UI 是分离的。联机同样走 websocket。适合想要「游戏王规则深度」时的备选。
3. **`google/boardgame.io`（MIT，框架）** —— 如果结论是「现成游戏都不合适，要自己搭」，这是最稳的地基：`Game`（状态 + moves + phases）纯函数、`multiplayer:false` 就不是联机游戏、内置 bot。缺点是它只给你骨架，卡牌规则、卡面交互都得自己写。

---

## 4. 交付形态的结论

**上游 → 关卡挑战版的三条改动**（详见 `../关卡挑战版/README.md`）：

1. **关卡表**（新增 `levels.js`）：每关 = 对手名 + 对手牌组 + AI 档位 + 玩家起始血量。
2. **关卡选择 + 进度存档**（新增 `campaign.js`）：主菜单进关卡列表，通关写 `localStorage`，逐关解锁。
3. **对手 AI 分档**（改 `src/scripts/` 里的 bot 决策）：从「能出就出」升级成按关卡档位加权（越靠后的关卡越会优先攻击英雄、越会用英雄技能）。

**明确不做的事**：不引入任何联机代码、不引入任何后端、不加账号。

### 4.1 能不能塞进 MMD 卡（体积实测）

见 `../MMD-适配说明.md`。结论先写在这里：**整包塞不进**（卡图/音效是主要体积），能进的是**无资源精简版**——这也是这个案例对 MMD 的真正价值：它证明「一个炉石式对战 + 关卡挑战」的核心逻辑可以压到 MMD 沙盒的单条 18000 门禁以内。

---

## 5. 一句话结论

> **选 `Rymedy/hearthstone-web`（MIT，纯前端炉石克隆，自带 bot，零联机代码）**，
> 在它之上加一层「关卡 + AI 分档 + 进度存档」，导出**无联机对战的关卡挑战版本**。
> 备选 `keeshii/ryuu-play`（更成熟但要拆服务端）与 `boardgame.io`（MIT 框架，适合从零搭）。
