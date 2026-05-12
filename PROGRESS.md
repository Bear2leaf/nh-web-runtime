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

## 当前状态

### 基线测试 (git HEAD, 30次平均)
| 结果 | 占比 | 原因 |
|------|------|------|
| **成功 (descended)** | ~20% | 成功下到Dlvl:2 |
| 死亡 (game-ended) | ~65% | 被怪物杀死/饿死 |
| 卡住 (stuck) | ~15% | 导航循环 |

### 死因分析
- **怪物战斗死亡** (~60%): AI遭遇jackal/newt/grid bug等怪物，战斗中被杀死
- **饥饿死亡** (~5%): 修复#11后基本解决
- **陷阱卡住** (~10%): "Really step into that pit?"循环，陷阱未被记录

### 本次会话尝试但无效的改动
- 调整combat handler优先级（放食物/饥饿之前）→ 反而降低成功率
- flee-first战斗策略（HP<65%就逃）→ 降低成功率
- PET_CHARS重叠检测（fox 'f'）→ 未显著改善

### 当前瓶颈 (优先级排序)
1. **战斗死亡** (~60%) — Level 1怪物伤害高，AI战斗时HP管理不够
2. **找不到楼梯** (~15%) — 探索算法效率不足
3. **陷阱卡住** (~5%) — "Really step"陷阱检测不完善

## 代码文件
- `test/nav-ai.mjs` — 主导航AI (~637行，refactored版本)
- `test/nav-core.mjs` — 核心工具（BFS,地图扫描）
- `test/nav-strategy.mjs` — 状态机处理 (dead code)
- `src/shim-node.js` — Node.js WASM适配器

## 下一步建议
1. 降低战斗优先级：遇到怪物时优先逃跑而非硬拼
2. 改进陷阱检测：将"Really step"后的位置标记为陷阱
3. 提高探索效率：减少在房间内振荡的时间
