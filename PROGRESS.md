# NetHack Navigation AI — Progress Report (2026/05/12)

## 参考
`./NetHack`为当前游戏底层引擎，在识别到无法正常处理的逻辑时，可以参考源码进行理解并实现解决方案

## 目标
让AI从Dlvl:1成功下到Dlvl:2。

## 已修复的问题

### 1. 逃离阈值bug
HP=4/10时，`hpRatio=0.4 < 0.4`为false → 改为`< 0.5`

### 2. 巨石阻挡
走廊中的巨石`'`被当作可通行 → 排除

### 3. 走廊中看不见的墙
看不见的格子`' '`被当作可通行 → 排除

### 4. 宠物狗识别
'd'不在PET_CHARS中 → 加入PET_CHARS + hadPetBlock检测

### 5. 房间奖励不足
房间奖励从3提高到10

### 6. 方向卡住恢复
添加`lastSentDir`/`sentDirCount`追踪

### 7. 墙壁搜索触发条件
移除`!hasVisibleCorridors`阻塞条件

### 8. 锁门踢门循环
wall-follow路径遇到已试过的门→跳过目标而非再次踢；腿受伤后不再踢门

### 9. 走廊振荡宠物阻挡
尝试与宠物交换位置；添加oscillation handler冷却期(5 ticks)

### 10. 吃食物 (shim-node.js)
`shim_yn_function`中`defaultChar=0`时发送NUL字符 → 添加无效字符保护
`swap places`提示自动回答`y`

### 11. 游戏结束检测 (2026/05/12)
`main()`返回后game loop结束，nav-ai检测不到 → 在loop()中添加`isGameDone()`检查

### 12. 饥饿时"."提示 (2026/05/12)
`handleHpHunger`发送`.`触发"Are you waiting to get hit?" → 在step()顶部添加隐藏怪物检测

### 13. BFS将已开门当作墙壁 (2026/05/12)
**根本原因**：BFS的`isBfsWalkable()`对`'-'`和`'|'`返回false，导致AI打开门后无法用BFS路径穿过。

**修复**：在`nav-core.mjs`的`bfs()`和`bfsAvoiding()`中添加可选参数`openDoors: Set`，BFS将其视为可通行。同时`nav-door.mjs`在成功开门/踢门后将该坐标加入`openedDoors`集合。

**涉及文件**：
- `nav-core.mjs`: `bfs()`、`bfsAvoiding()`新增`openDoors`参数
- `nav-ai.mjs`: navCtx增加`openedDoors: new Set()`字段
- `nav-door.mjs`: 开门/踢门时标记位置到`openedDoors`
- `nav-corridor.mjs`: 所有`bfs()`调用添加`navCtx.openedDoors`
- `nav-level-explore.mjs`: 所有`bfsAvoiding()`调用添加`navCtx.openedDoors`
- `nav-stairs.mjs`: 所有`bfs()`调用添加`navCtx.openedDoors`
- `nav-wall-search.mjs`: 所有`bfs()`调用添加`navCtx.openedDoors`

### 14. corridorFailCount无法累积到阈值 (2026/05/12)
走廊handler每次运行都将`corridorFailCount`重置为0，导致无法触发force-forward逻辑。

**修复**：改为仅当`corridorFailCount === 0`时才重置`enclosedTick`，使失败计数能正常累积。`corridorFailCount >= 5`时走廊handler会强制向前冲而非折返。

### 15. 走廊handler干扰墙壁搜索 (2026/05/12)
走廊handler和墙壁搜索相互触发，形成振荡死循环：wall-search → 放弃 → corridor → enclosed → wall-search。

**修复**：在走廊handler两个分支添加`!wallSearchPhase`守卫，使走廊handler在墙壁搜索期间静默退出。同时墙壁搜索放弃时设置`wallSearchSuppressUntilTick = tickCount + 300`冷却期，防止立即重新触发。

### 16. 墙壁搜索饥饿退出条件过晚 (2026/05/12)
墙壁搜索仅在'Weak'/'Fainting'时退出，此时已太晚无法恢复。AI在wall search阶段饥饿死亡。

**修复**：在'Hungry'状态即退出墙壁搜索，并设置2000 tick冷却期防止立即重新进入。同时将放弃搜索后的冷却期从300提升至2000 tick。

**涉及文件**：
- `nav-wall-search.mjs`: 饥饿退出条件扩展到'Hungry'，冷却期300→2000

### 17. 战斗逃跑阈值过高 (2026/05/12)
逃跑阈值从50%提高到70%后，AI过早逃跑被怪物追杀。测试显示65%和70%都会降低成功率。

**修复**：恢复50%逃跑阈值。Level 1怪物战斗逃跑反而延长战斗、增加死亡风险。

**涉及文件**：
- `nav-combat.mjs`: `lowHp`阈值从`hpRatio < 0.7`恢复为`hpRatio < 0.5`

### 18. SATIATED状态噎死 (2026/05/12)
参考NetHack源码`eat.c`发现：噎死由`canchoke`锁定，当开始进食时状态为`SATIATED`就会触发。AI在满状态吃了Lembas Wafer后噎死（"A little goes a long way" → choke）。

**修复**：在`nav-hp-hunger.mjs`中添加SATIATED保护，不在该状态进食。

**涉及文件**：
- `nav-hp-hunger.mjs`: 添加`if (hungerTrimmed === 'Satiated') return false;`

### 19. 陷阱检测关键字错误 (2026/05/12)
陷阱消息"Really step into that pit?"包含"Really step"但不包含"trap"。原代码用`m.includes('trap')`检测失败。

**修复**：移除`trap`关键字检查，仅用`Really step`检测。

**涉及文件**：
- `nav-stuck.mjs`: 陷阱检测条件修复
- `nav-state-update.mjs`: 同上

### 20. Door handler缺少wallSearchPhase守卫 (2026/05/12)
墙壁搜索期间，门处理应该静默退出（与corridor handler一致）。原代码缺少守卫，导致开门干扰周长行走。

**修复**：在`handleDoors`顶部添加`if (wallSearchPhase) return false;`

**涉及文件**：
- `nav-door.mjs`: 添加wallSearchPhase守卫

### 21. 饥饿临界时强制探索 (2026/05/12)
当处于Weak/Fainting状态且无楼梯/食物可见时，AI仍然被wall search阻塞。应该强制退出wall search并探索，而不是在房间里饿死。

**修复**：在`nav-level-explore.mjs`中添加饥饿临界覆盖，忽略wallSearchPhase继续探索。

**涉及文件**：
- `nav-level-explore.mjs`: 添加isCriticalHunger覆盖逻辑

## 当前状态

### 50次测试结果 (commit 97c06a4, 2026/05/13)
| 结果 | 次数 | 百分比 |
|------|------|--------|
| **成功 (descended)** | 3/50 | 6% |
| 死亡 (game-ended) | 30/50 | 60% |
| 卡住 (stuck) | 17/50 | 34% |

注：成功率有高随机性（5-25%），取决于测试批次

### 关键改进
- 战斗逻辑简化：正面迎敌，不逃跑
- Invisible monster处理："It bites!"时force-fight
- 楼梯可见时不触发wall search

### 当前瓶颈
1. 卡住/stuck问题 - wall search路径无效 (34%)
2. 战斗死亡 - 怪物攻击 (60%)
3. 探索效率 - 需要更快找到楼梯

### 本次会话基于NetHack源码的优化
1. **楼梯永远可见** — 位于房间内，不需搜索。AI应优先进入房间
2. **饥饿营养系统** — 起始900点，每回合-1，约750回合后饿，900后虚弱
3. **SATIATED不吃东西** — 防止噎死（NetHack eat.c: canchoke锁定机制）
4. **陷阱检测修复** — "Really step"消息不含"trap"关键字

### 当前瓶颈 (优先级排序)
1. **探索效率** — 找不到楼梯，在房间内loop直到饿死
2. **战斗死亡** — Level 1怪物伤害高，AI战斗时HP管理不够
3. **饥饿管理** — 无食物时应该积极传送/探索而非等待饿死

## 代码文件
- `test/nav-ai.mjs` — 主导航AI (~500行，refactored版本)
- `test/nav-core.mjs` — 核心工具（BFS,地图扫描）
- `test/nav-strategy.mjs` — 状态机处理 (dead code)
- `src/shim-node.js` — Node.js WASM适配器
- `test/nav-*.mjs` — 各功能handler模块（门、走廊、楼梯、探索、墙壁搜索等）

## 下一步建议
1. **改进探索算法**：房间→门→走廊→新房间。楼梯永远在房间内
2. **饥饿无食物时的策略**：传送或积极搜索新区域，而非在房间内等待饿死
3. **战斗优化**：逃跑后不要被怪物追上，利用地形（穿门、下楼梯）
4. **研究NetHack楼梯生成**：参考`mklev.c`，楼梯在房间内随机放置，无最小距离限制
