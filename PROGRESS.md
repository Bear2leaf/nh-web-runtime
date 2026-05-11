# NetHack Navigation AI — Progress Report (2026/05/11)

## 参考
./NetHack为当前游戏底层引擎，在识别到无法正常处理的逻辑时，可以参考源码进行理解并实现解决方案

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

## 当前状态

### 最新测试 (10次, 修复#8-10之后)
| 结果 | 次数 | 原因 |
|------|------|------|
| **成功 (descended)** | 1/10 | 成功下到Dlvl:2 |
| 死亡 (game-ended) | 6/10 | 被怪物杀死 |
| 超时 (max-ticks) | 3/10 | 找不到楼梯 |

### 死因分析
- **狐狸(jackal/fox)**: 4/6 — AI战斗但HP管理不够，即使50% HP也继续战斗
- **陷入僵局**: 2/6 — 无路可走时被围攻
- **饥饿(Fainted)**: 之前是主要死因，修复#10后已大幅改善

### 当前瓶颈 (优先级排序)
1. **战斗死亡** (60%) — AI在HP >= 50%时主动攻击狐狸/豺狼，但2-3回合内被打死。需提高逃离阈值或添加回合数限制
2. **找不到楼梯** (30%) — AI在20000 tick内无法发现下楼梯。需要更快的探索策略
3. **宠物挡路振荡** (10%) — 交换位置已实现但仍不够可靠

## 代码文件
- `test/nav-ai.mjs` — 主导航AI (~1250行)
- `test/nav-core.mjs` — 核心工具（BFS,地图扫描）
- `test/nav-strategy.mjs` — 状态机处理 (dead code — 未被nav-ai.mjs调用)
- `src/shim-node.js` — Node.js WASM适配器
