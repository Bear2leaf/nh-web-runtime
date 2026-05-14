# NetHack Navigation AI — Progress Report (2026/05/14)

## 参考
`./NetHack`为当前游戏底层引擎，在识别到无法正常处理的逻辑时，可以参考源码进行理解并实现解决方案

## 目标
让AI从Dlvl:1成功下到Dlvl:2。

## 当前性能

**最新 30-trial 批次**: 10% 成功 / 57% 死亡 / 27% 卡住 / 3% max-ticks / 3% 其他  
**最新 20-trial 批次**: 20% 成功 / 45% 死亡 / 30% 卡住 / 5% 其他

| 批次 | 成功 | 死亡 | 卡住 | 备注 |
|------|------|------|------|------|
| 纯基线 50次 | 14% (7/50) | 62% (31/50) | 24% (12/50) | git checkout 原始状态 |
| 100次基线 | 9% (9/100) | 62% (62/100) | 29% (29/100) | 早期基线 |
| 100次旧最佳 | 12% (12/100) | 65% (65/100) | 23% (23/100) | kiting+陷阱标记+宠物节流 |
| 100次当前 (commit 301a2fd) | 12% (12/100) | 31% (31/100) | 55% (55/100) | 死亡检测修复后 |
| **20次最新** | **20% (4/20)** | **45% (9/20)** | **30% (6/20)** | **PET_CHARS修复+隐藏怪物修复** |
| **30次最新** | **10% (3/30)** | **57% (17/30)** | **27% (8/30)** | **同上，更大样本** |

> **关键转变**: 修复 PET_CHARS 和隐藏怪物 stale-message bug 后，**卡住率从 55% 骤降至 ~27%**，但 **死亡率从 31% 上升至 ~45-57%**。AI 不再被宠物/陷阱/隐藏怪物困住，而是死于低级怪物围攻。瓶颈已从"卡住"转为"战斗死亡"。
> 当前架构: 并行运行 `node test/node-runner.js [max_tries] [concurrency]`，100次约 60-70s

## 已修复的问题

### 架构/基础设施

#### 37. Makefile 恢复所有补丁文件 (2026/05/14)
`make` 后 NetHack 子模块保持干净。`PATCHED_FILES` 变量列出所有 7 个被修改的文件，build 和 clean 目标统一使用 `git checkout $(PATCHED_FILES)` 恢复。

#### 38. 死亡检测 — HP=0 bug (2026/05/14)
`nav-env-node.js` 中 `getHp()` 使用 `parseInt(hp) || 999` → HP=0 时 `0 || 999` 返回 **999**，导致死亡永远检测不到。
**修复**: `parseInt(hp)` 后用 `Number.isFinite(v) ? v : 999` 判断，HP=0 正确报告为 0。

#### 39. 死亡检测 — WASM 重启状态污染 (2026/05/14)
`node-runner.js` 使用预编译 `WebAssembly.Module` 复用，同一实例重启游戏时 Asyncify 状态残留 → `main()` 进入后崩溃。AI将崩溃误判为"卡住"。
**修复**: 每次 trial 创建全新 WASM 模块实例（~30ms）。Worker 进程每 trial 结束后 `process.exit(0)`，下一个 trial 由 scheduler 重新 fork。

#### 40. 死亡检测 — gameCounter fallback (2026/05/14)
NetHack `done()` 在 Emscripten 上跳过 `exit_nhwindows()` → `shimState.done` 永远为 false。AI无法通过 `done` 检测死亡。
**修复**: `node-runner.js` 轮询 `shim_get_game_counter()`（C 函数），游戏重启时计数器递增 → 触发 `onDone('died')`。`NHNodeEnv` 添加 `getGameCounter()` 方法供 nav-ai 使用。

#### 41. 锁文件名无限增长 (2026/05/14)
`nhmain()` 循环中 `getlock()` 因 `gl.locknum != 0` 只改第一个字符，导致文件名每轮增长 `_0`。`savestateinlock()` + `regularize()` + `set_levelfile_name()` 追加更多后缀，最终崩溃。
**修复**: `libnhmain.c` 重启前设置 `gl.locknum = 0`，强制 `getlock()` 重建完整文件名。

### AI 行为修复

#### 42. 门锁定循环 (2026/05/14)
`MAX_OPEN_ATTEMPTS` 为 3 时，锁门会触发 3 次 "This door is locked" 后才踢门。3 次尝试 × 多扇门 = 大量 ticks 浪费在无用循环上。
**修复**: `MAX_OPEN_ATTEMPTS` 3→1。添加 `_totalDoorTicks` 硬上限（>30 ticks 时放弃所有剩余门）。

#### 43. 陷阱循环 — 临时回避 (2026/05/14)
AI 踩陷阱被 shim 自动拒绝后，下回合同一 handler 再次发送相同方向键，形成 "Really step? → n → 再试 → Really step?" 无限循环。
**修复**: `trapAvoidUntil: Map<position, tick>` — 检测到 "Really step" 消息后，标记该坐标为临时回避（5 ticks）。`nav-corridor.mjs` 在方向评分和 BFS fallback 中检查回避标记，跳过该方向。5 ticks 后自动解除，避免永久堵死唯一通路。

#### 44. corridorVisible 数组检测 bug (2026/05/14)
`(navCtx.grid||'').some(row => row.includes('#'))` — `grid` 是二维数组，`row.includes('#')` 在数组上行为正确，但 `||''` 回退时字符串无 `.some()` 方法。实际 `grid` 始终有值故未崩溃，但代码风格风险。
**修复**: 显式双重循环遍历数组，清晰且健壮。

#### 45. nav-modal.mjs 过度标记陷阱 (2026/05/14)
`trapDir < 0` 时 fallback 标记 **所有 8 个相邻可行走格子** 为陷阱。若玩家在走廊中（仅 2 个相邻可走格子），全部标记后 AI 完全无法移动。
**修复**: fallback 不再标记任何格子，仅重置 `lastMoveDir/lastSentDir/sentDirCount`，让 BFS/pathfinding 自行寻找替代路线。

#### 46. PET_CHARS 包含敌对怪物 — 严重战斗漏洞 (2026/05/14)
`PET_CHARS = new Set(['c','d','f','n','q','r','s','t','w','y'])` 将 **sewer rat ('r')、nymph ('n')、spider ('s')、trapper ('t')、wraith ('w')、centaur ('c')、quadruped ('q')、monkey ('y')** 全部视为"宠物"。
- `handleCombat` 跳过这些怪物 → 玩家被 sewer rat 咬死不还手
- `bfsAvoiding` 允许路径穿过它们 → AI 主动走进 jackal 嘴里
- `scanMap` 排除它们 → `hasVisibleAdjMonster` 检测不到威胁
**修复**:
- `PET_CHARS` 收窄为 `['d','f','u']`（仅实际起始宠物类型：狗/猫/马）
- `isWalkable` 恢复 `!PET_CHARS.has(ch)` 例外（随机探索可走进宠物换位置）
- `bfs`/`bfsAvoiding`/`scanMap`/`findNearestMonster` 移除 `!PET_CHARS.has(ch)` — **所有怪物都阻挡路径、都被检测为威胁**
- `handleCombat` 攻击所有怪物，但通过 `navCtx.petPosition`（从 swap 消息追踪）跳过已知宠物位置

#### 47. lastMoveDir 未设置导致陷阱 fallback 毒化地图 (2026/05/14)
15+ 个 handler 发送移动键时未设置 `lastMoveDir`。当陷阱消息出现时，`lastMoveDir === -1`，fallback 标记 **所有 8 个相邻可行走格子** 为陷阱，迅速毒化整张地图。
**修复**: 全面审计所有 handler，确保每次 `sendKey(KEY[di])` 前设置 `navCtx.lastMoveDir = di`。

#### 48. 隐藏怪物 stale-message 循环 (2026/05/14)
`"Are you waiting to get hit?"` 消息在 15-message 缓冲中持久存在。隐藏怪物 handler 每 tick 都看到该消息，持续发送 'F' 攻击，即使怪物已死或玩家已远离。
**修复**: 隐藏怪物 handler 只检查 **最后 5 条消息** (`navCtx.msgs.slice(-5)`)，避免 stale message 触发。同时移除攻击冷却（从 5 tick → 0 tick），遇到隐形怪物时全力输出。

#### 49. 全局宠物 swap 节流移除 (2026/05/14)
先后尝试了 3 种宠物节流方案：
- **Cooldown (25/60 ticks)**: AI 等待时间过长 → 大量 max-ticks（90%  trial 跑满 20000 ticks）
- **Direction-based 计数**: 消息缓冲滑动窗口导致计数不准确 → 节流时灵时不灵
- **Position-based 振荡检测**: 走廊中宠物跟随导致持续触发 → 同样 max-ticks
**结论**: 全局节流在 1-tile 走廊中无解（宠物跟随，等待无效）。
**修复**: 移除全局 `petSwapBlocked` 节流。保留 `nav-corridor.mjs` 本地处理（4 次连续 swap 后放弃走廊导航）和 `nav-boulder-pet.mjs` 的垂直方向绕行。卡住率反而从 55% → 27%。

#### 50. 宠物位置追踪 (2026/05/14)
新增 `navCtx.petPosition` 和 `navCtx.petPositionTick`。
- 从 `"swap places with"` 消息推断宠物位置（swap 后宠物在玩家旧位置）
- 从 `"is in the way"` / `"doesn't want to swap"` 消息推断宠物位置（宠物在目标位置）
- 60 ticks 无交互后清除 stale 位置
- `handleCombat` 跳过已知宠物位置，避免误杀宠物导致其 hostile 反扑
- `nav-ai.mjs` 隐藏怪物 handler 的 'F' 攻击也跳过宠物方向

## 当前状态（最新 working tree, 2026/05/14）

### 30-trial 测试结果
| 结果 | 次数 | 百分比 |
|------|------|--------|
| **成功 (descended)** | 3/30 | 10% |
| 死亡 (died/game-ended) | 17/30 | 57% |
| 卡住 (stuck) | 8/30 | 27% |
| max-ticks | 1/30 | 3% |
| 其他 | 1/30 | 3% |

### 卡住原因分解（基于 stuck 8/30）
| 原因 | 占比 | 典型消息 |
|------|------|---------|
| 宠物阻塞 | ~25% | "You swap places with your little dog" / "is in the way" |
| 隐藏怪物 | ~25% | "Are you waiting to get hit?" |
| 开场/房间无出口 | ~25% | "Your hour of destiny has come"、物品 clutter |
| 战斗/被围 | ~25% | 低 HP 时 surrounded by monsters |

> 对比 commit 301a2fd：卡住率从 55% → 27%，宠物振荡和隐藏怪物 stale loop 已基本消除。

### 死亡原因分解（基于 died 17/30）
| 原因 | 占比 | 典型消息 |
|------|------|---------|
| 低级怪物围攻 | ~50% | jackal/fox/sewer rat/goblin 多次 bites |
| 隐形怪物 | ~20% | "It bites!" / "You cannot escape from it!" |
| 饥饿/虚弱 | ~15% | "faint from lack of food" |
| 疾病/中毒/其他 | ~15% | "sickness feels worse"、dungeon collapses |

> **关键转变**: 死亡已成为最大瓶颈。AI 不再被宠物/陷阱困住，而是死于战斗。早期游戏（DL1）HP 仅 10-15，jackal/fox 可在 5-10 ticks 内咬死玩家。

## 当前瓶颈（按影响排序）

1. **战斗死亡 57%** — 低级怪物（jackal, fox, sewer rat, goblin）围攻、隐形怪物无法定位、被围时无有效脱战手段
2. **卡住 27%** — 宠物走廊阻塞（1-tile corridor 无解）、隐藏怪物、无出口房间
3. **其他 16%** — max-ticks、饥饿、疾病、WASM 崩溃

## 下一步建议

### 高优先级（死亡 → 成功转化）
1. **战斗逃跑优化** — kiting 逻辑在 <60% HP 时尝试撤退，但 retreat 方向常被墙/陷阱/其他怪物阻塞。应优先向 stairs/门/开阔房间撤退，而非随机方向
2. **被围检测** — 当 2+ 怪物相邻时，不应硬拼，应立即尝试 teleport 或 rush stairs
3. **隐形怪物** — "Are you waiting to get hit?" 时若 HP < 40%，优先 teleport 而非盲目 'F' 攻击 8 个方向
4. ** stairs rush 扩大** — 低 HP 时即使 stairs 距离 >15 也应 rush（当前 threshold 15）

### 中优先级（卡住 → 成功转化）
5. **宠物走廊死锁** — 1-tile corridor 中宠物跟随是 NetHack 机制问题。可考虑：低 HP 时允许攻击宠物开路；或传送脱离 corridor
6. **房间无出口** — wall search 阈值可进一步降低（当前 enclosedTick > 50）

### 低优先级
7. **饥饿策略** — Weak/Fainting 时 food handler 已存在，但食物可能刷新在怪物堆中，需评估取食风险

## 代码文件
- `test/nav-ai.mjs` — 主导航AI (~500行)
- `test/nav-core.mjs` — 核心工具（BFS, 地图扫描）
- `test/nav-*.mjs` — 各功能handler模块（门、走廊、楼梯、探索、墙壁搜索、战斗、食物等）
- `src/shim-node.js` — Node.js WASM 适配器（YN 自动回答、消息缓冲）
- `test/node-runner.js` — 批量测试 runner（scheduler + worker pool）
- `test/nav-env-node.js` — Node 环境适配器（读取 shimState，替代浏览器 DOM）
- `Makefile` — 构建编排（补丁应用 → 编译 → 自动恢复）
