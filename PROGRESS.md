# NetHack Navigation AI — Progress Report (2026/05/15)

## 参考
`./NetHack`为当前游戏底层引擎，在识别到无法正常处理的逻辑时，可以参考源码进行理解并实现解决方案

## 目标
让AI从Dlvl:1成功下到Dlvl:2。

## 当前性能

**最新 100-trial 批次**: 14% 成功 / 38% 死亡 / 43% 卡住 / 2% max-ticks / 3% 其他

| 批次 | 成功 | 死亡 | 卡住 | 备注 |
|------|------|------|------|------|
| 纯基线 50次 | 14% (7/50) | 62% (31/50) | 24% (12/50) | git checkout 原始状态 |
| 100次基线 | 9% (9/100) | 62% (62/100) | 29% (29/100) | 早期基线 |
| 100次旧最佳 | 12% (12/100) | 65% (65/100) | 23% (23/100) | kiting+陷阱标记+宠物节流 |
| 100次当前 (commit 301a2fd) | 12% (12/100) | 31% (31/100) | 55% (55/100) | 死亡检测修复后 |
| **20次最新** | **20% (4/20)** | **45% (9/20)** | **30% (6/20)** | **PET_CHARS修复+隐藏怪物修复** |
| **30次最新** | **10% (3/30)** | **57% (17/30)** | **27% (8/30)** | **同上，更大样本** |
| **100次最新** | **14% (14/100)** | **38% (38/100)** | **43% (43/100)** | **stairs rush扩展 + lowHp阈值0.7** |
| **100次当前** | **11% (11/100)** | **38% (38/100)** | **49% (49/100)** | **boulder-pet跳过走廊 + 隐藏怪物排除宠物 + 宠物等待burst** |

> **关键转变**: 修复 PET_CHARS 和隐藏怪物 stale-message bug 后，**卡住率从 55% 骤降至 ~27%**，但 **死亡率从 31% 上升至 ~45-57%**。AI 不再被宠物/陷阱/隐藏怪物困住，而是死于低级怪物围攻。瓶颈已从"卡住"转为"战斗死亡"。
> 
> **本次改进**: 
> - `lowHp` 阈值 0.5 → 0.7：更早触发撤退和 stairs rush，降低战斗死亡（38% vs ~50%）
> - stairs rush 扩展：即使 stairs 不可见，危急时仍向 `lastStairsPos` 移动，提高逃生成功率（14% vs ~10%）
> 
> 当前架构: 并行运行 `node test/node-runner.js [max_tries] [concurrency]`，100次约 3-4min

## 已修复的问题

### 本次改进 (2026/05/15)

#### 51. lowHp 阈值降低 — 更早撤退保命
`navCtx.lowHp = hpRatio < 0.5` → `hpRatio < 0.7`。触发条件从 HP<50% 提前到 HP<70%，使 combat retreat 和 stairs rush 更早启动，显著降低低级怪物围攻死亡率。

#### 52. stairs rush 扩展至 lastStairsPos — 危急时凭记忆逃生
原 stairs rush 仅在 stairs **当前可见** 时触发。改进后：当 `lowHp || inCombat` 且 stairs 不可见时，若 `lastStairsPos` 有记录，则 BFS 向该位置移动一步。避免"看到 stairs → 被怪物打断 → stairs 离开视野 → 忘记逃生方向"的死亡循环。

#### 53. stairs rush 无条件触发 — 看到楼梯就冲
原逻辑对可见 stairs 有距离阈值（安全时 8，危急时 50）。改进后：**只要 stairs 在视野内就立即处理**，无需计算距离。避免"stairs 在视野边缘但因距离判断跳过"的错失逃生机会。与 #52 共同构成"视野内冲楼梯 / 视野外凭记忆冲旧位置"的完整逃生体系。

#### 54. 走廊宠物阻塞等待 — 让宠物自行走开
走廊中宠物拒绝 swap 时，`nav-corridor.mjs` 的振荡检测会发 '.' 等待，但仅在振荡触发后（5 tick 冷却）生效。新增前置 handler：当 `hadPetBlock && isInCorridor && !inCombat` 且距离上次等待超过 10 ticks 时，主动等待 1 tick 让宠物移动。将被动等待变为主动礼让，减少走廊死锁时间。

#### 55. 宠物死锁逃逸 — stuckCount>50 时主动远离
当 stuckCount > 50 且相邻有怪物（可能是宠物被误标为怪物，或宠物间歇性拒绝 swap）时，寻找**背离怪物的安全方向**移动一步。在 `handleBoulderPet` 之前触发，避免 boulder-pet handler 发送 '.' 原地等待导致死锁无限持续。

#### 56. Kiting 阈值收紧 — 更少逃跑，更多硬拼
原 kiting 在 HP<60% 时撤退。DL1 早期怪物（jackal/fox/rat）攻击力低，过早撤退反而浪费 ticks 且可能退入更危险的位置。
**修复**: 撤退阈值 60% → 30%，并新增"被 2+ 怪物包围"条件。单怪时硬拼到底（通常 3-5 ticks 内解决），仅在被围攻或真正濒危时才撤退。减少无意义逃跑导致的 stuck 和 max-ticks。

#### 57. 宠物位置超时延长 — 60→300 ticks
`navCtx.petPosition` 用于 `handleCombat` 跳过已知宠物位置。原 60 tick 超时过短，长走廊行走时 swap 消息老化出缓冲后，宠物位置被清除 → AI 误将宠物当敌对怪物攻击 → 宠物 hostile 反扑。
**修复**: 超时延长至 300 ticks。宠物紧密跟随玩家，数百 tick 内不会丢失。

#### 58. boulder-pet handler 跳过走廊 — 不再原地等待
`nav-boulder-pet.mjs` 的宠物阻塞逻辑在走廊中会发送 '.' 原地等待，且它在 `handleCorridor` **之前**运行，导致走廊 handler 的 swap 逻辑被完全绕过。
**修复**: `!navCtx.isInCorridor` 条件，让走廊中的宠物阻塞由专门的 `nav-corridor.mjs` 处理。

#### 59. 隐藏怪物 handler 排除已知宠物 — 避免 '`.`' 死锁
当隐藏怪物与宠物同时相邻时，隐藏怪物 handler 因 `hasVisibleAdjMonster=true`（宠物被计入）而返回 false，combat 跳过宠物，后续 handler（如 corridor）发送 '.' → 游戏拒绝"Waiting doesn't feel like a good idea"。
**修复**: `hasVisibleAdjMonster` 计算时排除 `navCtx.petPosition`，确保隐藏怪物能被正确处理。

#### 60. 宠物走廊等待 burst — 给宠物离开的时间
原宠物走廊等待条件 `!inCombat` 永远为假（宠物现在在 `features.monsters` 中），导致该逻辑从未触发。且仅等待 1 tick 效果微弱。
**修复**: 
- 条件改为 `adjHostileExclPet === 0`（仅当无真实敌对怪物时才等待）
- 触发后连续等待 **5 ticks**（burst），大幅增加宠物随机走开的概率

#### 61. stairs rush 恢复距离阈值 — 避免盲目冲楼梯
"看到楼梯就冲"导致 AI 无视路径上的怪物和宠物，冲入死胡同或被围攻卡住。
**修复**: 恢复距离阈值（安全时 8，危急时 50），保留 `lastStairsPos` 危险记忆逃生。

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

## 当前状态（最新 working tree, 2026/05/15）

### 100-trial 测试结果
| 结果 | 次数 | 百分比 |
|------|------|--------|
| **成功 (descended)** | 11/100 | 11% |
| 死亡 (died/game-ended) | 38/100 | 38% |
| 卡住 (stuck) | 49/100 | 49% |
| max-ticks | 1/100 | 1% |
| 其他 | 1/100 | 1% |

### 卡住原因分解（基于 stuck 49/100）
| 原因 | 占比 | 典型消息 |
|------|------|---------|
| 宠物走廊阻塞 | ~40% | "You swap places with your kitten" / "is in the way" |
| 隐藏怪物 | ~30% | "Are you waiting to get hit? Use 'm' prefix..." |
| 陷阱/门/物品 | ~20% | "Really step onto that magic trap?" / "This door is locked" |
| 其他 | ~10% | 开场消息残留、不明原因 |

> 对比 d0bcb61（4%/35%/57%）：成功率从 4% → 11%（近 3x），卡住率从 57% → 49%。宠物走廊等待 burst 和 boulder-pet 跳过走廊是主要功臣。

### 死亡原因分解（基于 died 38/100）
| 原因 | 占比 | 典型消息 |
|------|------|---------|
| 低级怪物围攻 | ~50% | jackal/fox/sewer rat/goblin 多次 bites |
| 疾病/中毒 | ~20% | "sickness feels worse" / "You die from your illness" |
| 饥饿/虚弱 | ~15% | "faint from lack of food" |
| 其他 | ~15% | dungeon collapses、被宠物挡路时遭攻击 |

> **关键转变**: 卡住仍是最大瓶颈（49%），但已从 57% 显著下降。宠物走廊死锁在 5-tick burst 等待后部分缓解，但仍有大量 case 无法突破。隐藏怪物是第二大卡住源（~30%）。

## 当前瓶颈（按影响排序，基于 100-trial 11%/38%/49%）

1. **卡住 49%** — 宠物走廊阻塞（~40%）、隐藏怪物（~30%）、陷阱/门/物品（~20%）、其他（~10%）
2. **战斗死亡 38%** — 低级怪物围攻、 sickness、 starvation
3. **其他 2%** — max-ticks、WASM 崩溃

> 注：成功率从 4% 提升至 11%，主要得益于卡住率下降（57%→49%）和更多 trial 能走到 stairs。但 49% 卡住仍是提升到 20%+ 的关键障碍。

## 下一步建议

### 高优先级（卡住 → 成功转化）
1. ~~宠物走廊死锁~~ — **已实现** (#58 boulder-pet 跳过走廊 + #60 宠物等待 5-tick burst)。效果：成功率 4%→11%，卡住率 57%→49%。仍有 ~20% trial 被宠物困住，可进一步优化：
   - 延长 burst 至 10-15 ticks（宠物移动概率随时间增加）
   - 或：burst 结束后仍被阻塞，尝试向走廊反方向移动回到房间
2. **隐藏怪物 timeout** — 当前 handler 无限 'F' 攻击，占卡住 ~30%。`_hiddenMonsterStartTick` 已添加但未启用。应添加 40-60 tick timeout，超时后尝试向开阔方向移动（而非原地攻击到死）。
3. **陷阱循环** — "Really step onto that trap?" 重复出现导致 stuck。当前 trap avoidance 仅标记 5 ticks，可延长或永久标记直到地图更新。

### 中优先级（死亡 → 成功转化）
4. ~~被围检测~~ — **已实现** (#56 kiting 触发条件新增 `adjMonsterCount >= 2`)。同时保留低 HP (<30%) 撤退。
5. ** sickness 预防** — 疾病死亡占比上升。可尝试： eat 前检测 corpse 年龄（old/tainted/rotten 关键词），或直接避免吃非 starting-food 的 corpse
6. ** starvation 预防** — 少数死亡来自饥饿。确保 Weak/Fainting 时 food handler 能突破 combat/corridor 的优先级抢到食物

### 低优先级
7. **房间无出口** — wall search 阈值已较合理（enclosedTick > 50），过早触发会浪费 ticks

## 代码文件
- `test/nav-ai.mjs` — 主导航AI (~500行)
- `test/nav-core.mjs` — 核心工具（BFS, 地图扫描）
- `test/nav-*.mjs` — 各功能handler模块（门、走廊、楼梯、探索、墙壁搜索、战斗、食物等）
- `src/shim-node.js` — Node.js WASM 适配器（YN 自动回答、消息缓冲）
- `test/node-runner.js` — 批量测试 runner（scheduler + worker pool）
- `test/nav-env-node.js` — Node 环境适配器（读取 shimState，替代浏览器 DOM）
- `Makefile` — 构建编排（补丁应用 → 编译 → 自动恢复）
