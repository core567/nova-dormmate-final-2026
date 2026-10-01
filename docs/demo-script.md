# DormMate 比赛演示链路（5–8 分钟）

面向演示者：按时间轴照着操作即可。每段给出**做什么 / 说什么 / 应该看到什么 / 出问题怎么办**。

---

## 演示前检查（提前 5 分钟做，不计入演示时间）

| # | 检查项 | 命令 / 操作 | 通过标准 |
| --- | --- | --- | --- |
| 1 | Broker 在跑 | `net start \| findstr -i mosquitto` | 服务已启动（随系统自启） |
| 2 | **只跑一个 Publisher** | 任务管理器搜 `publisher.py`，只允许一个进程 | 多于一个会互相顶下线，数据会断断续续 |
| 3 | Publisher 正常 | `python server/publisher.py` | 每 2 秒刷出三行 `[发布] dormmate/dorm-x/env` |
| 4 | 历史文件在长 | 查看 `server/node_readings_history.csv` 行数 | 每次刷新行数都在增加 |
| 5 | 浏览器标签页 | 打开 `dashboard/index.html`、`3d/index.html`、`web/index.html` | 三个页面顶部都显示「已连接 Broker」 |
| 6 | E2 页面 | `python -m http.server 8000` → `http://localhost:8000/e2/index.html` | 必须用 localhost，否则摄像头/麦克风会被拒 |
| 7 | 小程序 | 微信开发者工具打开 `miniapp/` | 顶部显示「已连接 Broker」 |
| 8 | 报告已生成 | `python analysis/analyze.py` | 输出 `报告已生成: .../analysis/report.html` |
| 9 | 断网也能用 | 拔网线/关 WiFi | 四个网页仍能打开（依赖已本地化到 `libs/`） |

> 标签页建议顺序：`dashboard` → `3d` → `e2` → 小程序 → `report.html`，正好按演示顺序排列。

**场景注入的固定命令**（每台机器路径相同）：

```bash
D:\Mosquitto\mosquitto_pub.exe -h 127.0.0.1 -t dormmate/dorm-a/sim -m "{\"nodeId\":\"dorm-a\",\"temperature\":33,\"humidity\":45}"
```

把 `dorm-a` / `33` 换成别的节点或数值即可复用。

---

## 时间轴

### 0:00–0:40　开场：这是什么

**做什么**：停在 Dashboard。

**说什么**：「DormMate 是一个多节点宿舍环境助手。三个宿舍节点通过 MQTT 上报温湿度，
四个前端——Web Dashboard、3D 数字空间、现场助手、微信小程序——订阅的是**同一条消息、同一份 JSON**，
所以同一时刻各端看到的数字必然一致。状态判定统一由后端 Publisher 计算，前端不各自算一遍。」

**应该看到**：顶部状态条四项——MQTT 链路「已连接」、当前重点宿舍、环境健康指数、数据质量「3 / 3 节点在线」。

---

### 0:40–1:40　实时链路与四端同源

**做什么**：依次切到 Dashboard → 3D → 小程序，指出同一个宿舍的温湿度数字一致。

**说什么**：「三个宿舍每 2 秒上报一次。注意 dashboard 的宿舍 B 卡片是 22.5℃，
切到 3D 页面，同一个宿舍也是 22.5℃；再到小程序，还是 22.5℃。
这不是巧合，是四端订阅同一个 Topic 的结果。」

**应该看到**：三个页面同一 nodeId 的温度、湿度、状态、时间完全一致。

**出问题怎么办**：若某端没数据，看该页 banner 是否「已连接」；没连上就刷新一次页面。

---

### 1:40–3:00　异常处置闭环（本演示的重点）

**做什么**：
1. 切回 Dashboard
2. 在另一个终端注入场景：`... -t dormmate/dorm-a/sim -m "{\"nodeId\":\"dorm-a\",\"temperature\":33,\"humidity\":45}"`
3. 指着卡片说「状态变为偏热，事件进入待处理」
4. 点宿舍 A 卡片上的【开启风扇】
5. 盯着卡片，等它自己变成「已恢复」

**说什么**：「现在人为把宿舍 A 变成 33℃，状态判定为偏热，事件进入 **OPEN（待处理）**。
我点【开启风扇】——注意，点按钮**不会**判定恢复，它只把状态推到 **HANDLING（处理中）**。
命令经 MQTT 下发到 Publisher，Publisher 开始模拟降温。
接下来每条新数据都被记进验证数据——看时间轴上的『温度变化』，
必须等真实收到『正常』数据，事件才会转 **RECOVERED（已恢复）**并归档。」

**应该看到**：
- 卡片徽标 `偏热`（红）→ `处理中`（蓝）→ `已恢复`（绿）
- 下方「异常时间轴」逐步长出：异常发生 → 开启风扇 → 温度变化 ×N → 等待恢复 → 已恢复
- 温度从 33℃ 一路降到 22℃ 附近，约 10 秒

**出问题怎么办**：
- 点了没反应 → 顶部 banner 是否「已连接」；若已断开，按钮会明确提示「MQTT 未连接，风扇命令未发出」，状态不会变——这本身也是可讲的容错点
- Publisher 没降温 → 确认只有一个 Publisher 进程

---

### 3:00–4:00　跨端联动（小程序 → Web / 3D）

**做什么**：
1. 切到微信小程序
2. 点某个宿舍卡片右上角的【设为重点】
3. 立刻切到 Dashboard —— tab 已经跳过去了
4. 再切到 3D —— 场景里的高亮光圈、镜头、浮空标签都跟着切了

**说什么**：「在小程序里把宿舍 C 设为重点，会广播一条 `dormmate/focus` 消息。
Dashboard 自动切到该宿舍的标签页，3D 页面同步选中该宿舍——高亮光圈换成该宿舍的标识色，
镜头平滑聚焦，浮空标签也跟着更新。这是跨端联动，不是三个页面各自操作。」

**应该看到**：Dashboard tab 高亮跳到目标宿舍；3D 的 `NODE · 节点` 行变成目标宿舍，光圈变色。

**出问题怎么办**：小程序点按钮若提示「MQTT 未连接，未能广播」，检查小程序是否连上 Broker。

---

### 4:00–4:45　3D 数字孪生

**做什么**：停在 3D 页面，鼠标拖动旋转、滚轮缩放。

**说什么**：「3D 页面是纯数据驱动的数字孪生。左上角 HUD 六项——
NODE、TEMP、HUMID、STATUS、FAN、MQTT——全部来自 MQTT。
房间里的空气流动粒子速度**跟着风扇转速走**，风扇转得快，气流也快。
给宿舍 A 开风扇，再切到宿舍 B，B 的风扇不会跟着转——每个宿舍的状态是严格隔离的。
所有依赖已经本地化到 `libs/`，拔掉网线这个页面照样打开。」

**应该看到**：HUD 实时刷新；气流粒子在动；状态灯按 OPEN 橙 / HANDLING 蓝 / RECOVERED 绿变化。

---

### 4:45–5:30　E2 现场助手

**做什么**：切到 E2 页面。
1. 点【开始语音指令】，说「**切换到宿舍B**」
2. 说「**朗读状态**」——页面朗读当前宿舍温湿度
3. 点【拍照并保存快照】

**说什么**：「现场助手把语音、当前宿舍、实时温湿度、快照放在一屏。
语音状态有完整状态机——正在聆听、识别失败、未听清、无权限都会明确显示，
识别置信度偏低时会先弹确认框再执行。
语音指令和按钮调用的是**同一套业务函数**，所以识别服务不可用时，点按钮能完成完全一样的操作。」

**翻车预案**：如果麦克风没授权或识别服务不可用，**直接点按钮**，说一句
「语音识别依赖浏览器在线服务，所以这里我用等价的按钮演示，两者走的是同一个函数」——
然后把三个按钮点完。这一条本身就是可讲的容错设计。

**应该看到**：卡片宿舍切换；状态徽标为 `偏湿` 时是**蓝色**（设计口径：偏湿蓝、偏冷琥珀）；快照列表新增一条含 nodeId / 时间 / 描述的记录。

---

### 5:30–6:15　数据链路与离线分析

**做什么**：切到 `report.html`。

**说什么**：「这就是全场的数据落盘。Publisher 每发一条数据就追加一行到
`server/node_readings_history.csv`；`analyze.py` 从这一个文件出发，
生成基础统计、趋势图、今日摘要，以及 IsolationForest 的异常分析。
ML 和固定阈值规则是**并排对照**的——报告里不判定谁对谁错，只解释分歧原因：
固定规则看单点是否越界，孤立森林看温湿度组合是否偏离历史习惯。」

**应该看到**：报告顶部的今日摘要数字（来自 CSV 统计，不是写死的）；趋势图；两套判断的并排对照表。

**可选加分**：在终端跑一句
`python analysis/analyze.py --history analysis/dormmate.csv`
并说「换一个 `--history` 参数，整份报告——统计、趋势图、摘要、ML——全部切换到新数据源」。

---

### 6:15–7:00　容错演练（体现工程质量）

**做什么**：依次发四条「坏消息」，每次发完指一下 Dashboard 的事件日志。

```bash
# 1. 非法 JSON
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{这不是JSON"
# 2. Topic 写错（多一层）
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env/extra -m "{\"nodeId\":\"dorm-a\"}"
# 3. 未知节点
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-x/env -m "{\"nodeId\":\"dorm-x\"}"
# 4. Topic 与 nodeId 不一致
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{\"nodeId\":\"dorm-b\"}"
```

**说什么**：「四种坏消息。页面**一条都没崩**——每一条都被识别、记录进事件日志和持久化的链路日志，
然后被丢弃。刷新页面，链路日志还在。」

**应该看到**：事件日志依次出现「不是合法 JSON」「未知 Topic」「未知节点」「Topic 与 nodeId 不一致」。

**再加一手（可选）**：停掉 Publisher（Ctrl+C），约 10 秒后卡片显示「节点离线」；
重新 `python server/publisher.py`，几秒内自动恢复在线。

---

### 7:00–7:40　收尾

**说什么**：「最后三点工程化的东西：

一，**统一的设计系统**——四端共用一套状态色口径：正常绿、偏热红、偏湿蓝、偏冷琥珀、离线灰红，
不再是各页面自己定颜色。

二，**统一的协议与校验**——`shared/protocol.js` 是唯一一份消息校验与状态规则；
小程序用的是它的逐字节副本，验收脚本会做字节比对防止两边漂移。

三，**离线可用**——所有前端依赖都本地化在 `libs/`，断网状态下四个页面全部正常工作。
刚才的演示全程没有访问过外网。」

**结束**：停在 Dashboard，让评委看到三个宿舍的实时数据仍在滚动。

---

## 出问题时的应急顺序

1. **某端没数据** → 看该页顶部 banner；未连接就刷新页面
2. **数据断断续续 / 命令没反应** → 检查是否有**多个 Publisher 进程**（最常见的坑）
3. **3D 黑屏** → 确认 `libs/` 三个文件都在；页面会显示明确的失败提示而不是黑屏
4. **E2 摄像头/麦克风被拒** → 必须用 `http://localhost:8000/e2/index.html`，不能用 `file://`
5. **注入场景没反应** → 确认 `mosquitto_pub` 用的是 `json` 且 Topic 是 `dormmate/<节点>/sim`
6. **一切都不对** → 重启 Broker 服务（需管理员终端）：`net stop mosquitto && net start mosquitto`，
   然后重启 Publisher、刷新页面

---

## 一页速查

```
Broker      Mosquitto 服务（自启）          127.0.0.1:1883 (MQTT) / :8083 (WebSocket)
Publisher   python server/publisher.py      每 2 秒发布 3 个节点
历史落盘    server/node_readings_history.csv
离线分析    python analysis/analyze.py      → analysis/report.html
Dashboard   dashboard/index.html            双击打开（file://）
3D         3d/index.html                    双击打开（file://）
E2          python -m http.server 8000      → http://localhost:8000/e2/index.html
Web M1      web/index.html                  Live Server
小程序      微信开发者工具打开 miniapp/
前端依赖    libs/（three / OrbitControls / mqtt / chart.js，全部本地）
统一协议    shared/protocol.js
设计系统    shared/design-system.css

注入异常    mosquitto_pub -t dormmate/dorm-a/sim -m "{\"nodeId\":\"dorm-a\",\"temperature\":33,\"humidity\":45}"
开启风扇    Dashboard 卡片上的按钮，或 mosquitto_pub -t dormmate/dorm-a/fan -m "{\"command\":\"on\"}"
设为重点    小程序卡片右上角按钮
```
