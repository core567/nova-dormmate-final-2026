# DormMate Final - 多节点宿舍环境助手

## 运行方式
1. Web 端：在 VS Code 中打开 `web/index.html`，使用 Live Server 运行（必须使用 localhost，否则无法使用摄像头）。
2. 离线分析：在 `analysis` 目录下运行 `python analyze.py`，读取 `dormmate.csv` 并生成报告。
3. 实时 Dashboard：双击打开 `dashboard/index.html`（需先运行 `python server/publisher.py`）。
4. 3D 数字空间：**双击**打开 `3d/index.html`，不要用 Live Server（原因见 M6 章节）。

## 主要功能
- M1: 温湿度输入、状态判断、历史记录
- M2: 导出 CSV、Python 生成趋势图与 HTML 报告
- M3: 调用摄像头拍照、TTS 语音朗读当前状态
- M4: 微信小程序端、统一业务规则
- M5: MQTT 实时通信，三宿舍数据实时推送至网页 Dashboard
- M6: Three.js 3D 数字空间，MQTT 数据实时驱动 3D 场景变化
- 任务 A: 异常优先级判断、开启风扇处置闭环、事件日志与复盘
- 任务 B: 信息呈现分层（仪表盘 / 3D / 语音 / 报告 各司其职）

## M5：MQTT 实时通信与 Dashboard

### 各角色作用

| 角色 | 在项目中的体现 | 作用 |
| --- | --- | --- |
| Broker（消息中转站） | Mosquitto，监听 `1883`(MQTT) 与 `8083`(WebSocket) | 接收 Publisher 的消息，按 Topic 分发给所有订阅者。Publisher 与 Subscriber 互不直接认识，全靠它中转 |
| Topic（主题） | `dormmate/dorm-a/env`、`dormmate/dorm-b/env`、`dormmate/dorm-c/env` | 消息的"频道名"，Broker 靠它决定消息发给谁。`+` 是单层通配符，`#` 是多层通配符 |
| Publisher（发布者） | `server/publisher.py` | 模拟三个宿舍，每 2 秒把温湿度打包成 JSON 发布到对应 Topic |
| Subscriber（订阅者） | `dashboard/index.html` | 订阅 `dormmate/#`，收到消息后更新卡片与趋势图 |
| JSON（消息格式） | `{"nodeId","temperature","humidity","status","time"}` | 消息正文的结构约定，双方按同一字段名解析。`status` 由 Publisher 按规则自动计算，不手写 |

状态规则（温度优先，与 `web/script.js` 完全一致）：
温度 <18 → 偏冷；温度 ≥30 → 偏热；湿度 ≥75 → 偏湿；其余 → 正常。

### 运行步骤

```bash
# 1. Broker：Mosquitto 已注册为 Windows 服务，随系统自动启动，无需手动开启
sc query mosquitto

# 2. Publisher：另开一个终端运行
python server/publisher.py

# 3. Dashboard：浏览器打开 dashboard/index.html（双击或用 Live Server）
```

### Broker 重启验证（需管理员终端）

```bash
net stop mosquitto     # Dashboard 横幅变为"连接已断开（自动重连中）"
net start mosquitto    # 约 2 秒后自动重连，卡片恢复刷新，无需刷新页面
sc query mosquitto     # 查看服务状态
```

### 容错演示

页面订阅 `dormmate/#`（超集），因此错误消息也能收到并被识别，处理后记入页面底部的事件日志：

```bash
# 非法 JSON —— 解析失败，记日志后忽略
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{this is not json"

# Topic 写错（多了一层）—— 不匹配 dormmate/<nodeId>/env，忽略
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env/extra -m "{\"nodeId\":\"dorm-a\"}"

# 未知节点 —— nodeId 不在白名单，忽略
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-x/env -m "{\"nodeId\":\"dorm-x\"}"

# 温湿度不是数值 —— 忽略
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{\"nodeId\":\"dorm-a\",\"temperature\":\"abc\",\"humidity\":60}"

# status 缺失或非法 —— 按统一规则重算后接受
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{\"nodeId\":\"dorm-a\",\"temperature\":25,\"humidity\":40}"
```

其他容错：Publisher 停止超过 10 秒，对应卡片自动标记"数据超时"；Broker 不可用时横幅显示断连状态并每 2 秒自动重连。

### 旁路验证（可选）

```bash
mosquitto_sub -h 127.0.0.1 -t "dormmate/+/env" -v
```

## M6：3D 数字空间（Three.js + MQTT 数据驱动）

### 打开方式（重要）

**双击 `3d/index.html`，用 `file://` 协议打开，不要用 Live Server。**

这不是偏好问题，是硬约束：`file://` 页面加载 ES module 会被 CORS 拦截，
若依赖 Live Server 起 http 服务才能跑，交付后双击打开就会黑屏。
因此本模块全部使用 UMD 构建（`<script src>` + 全局 `THREE`），并内联全部脚本、不拆本地 js 文件。
完整复现过程见 [docs/bug-fix.md](docs/bug-fix.md) 的 Bug 1。

### 完整数据链路

```
server/publisher.py          采集温湿度，按规则算出 status，打包 JSON
        ↓  publish
Mosquitto Broker (1883)      按 Topic 分发
        ↓  WebSocket 8083
mqtt.js（3d/index.html）      订阅 dormmate/#，校验消息合法性
        ↓  提取 status
updateScene(status, data)    状态 → 视觉参数的唯一映射入口
        ↓  逐帧 lerp 缓动
Three.js 宿舍场景             指示灯颜色 / 风扇转速 / 风扇颜色 实时变化
```

一句话：**Publisher 把「温湿度」变成「状态」，3D 页面把「状态」变成「看得见的视觉变化」。**

### 状态 → 3D 视觉映射

| status | 墙面指示灯 | 风扇 | 风扇颜色 |
| --- | --- | --- | --- |
| 正常 | 绿色 | 静止 | 白色 |
| 偏热 | 红色 | **持续旋转**（缓动加减速） | **浅红色** |
| 偏湿 | 蓝色 | 静止 | 白色 |
| 偏冷 | 琥珀色 | 静止 | 白色 |

> 任务只要求正常 / 偏热 / 偏湿三态。偏冷是业务规则里真实存在的第四态（温度 <18），
> 不处理会与「正常」显示成一样，因此补了琥珀色。

### 场景内容

**房间主体**：长方体室内空间——浅木色哑光地板、浅米白哑光墙面（三面实体墙）、
浅灰白天花板，一面是带窗的正面墙（墙体留出真实窗洞）。沿墙脚有一圈**踢脚线**，
后墙右侧有一扇**带门框和把手的门**。

**宿舍标配物件**：

1. **床铺** —— 浅灰床架 + 浅米色床垫 + **枕头 + 被子 + 床头板**，靠房间左侧
2. **书桌 + 椅子** —— 靠窗摆放，胡桃木色桌面 + 白色支架，配简约靠背椅；
   桌上有**台灯**和**三本书**
3. **立式风扇** —— 房间角落，**核心交互对象**：底座 + 立柱 + 电机 + 三片带扭角的扇叶 +
   外圈护罩与细网圈
4. **状态指示灯面板** —— 挂后墙，矩形发光面按状态显示绿 / 红 / 蓝 / 琥珀
5. **窗户** —— 正面墙上，含窗框、中梃、半透明玻璃，两侧有**窗帘与窗帘杆**
6. **装饰画** —— 右墙上一幅带框画作

**渲染方式**：`MeshStandardMaterial` PBR 哑光材质（roughness 0.75–0.98、metalness 0），
**无任何贴图、噪点或波纹**；开启实时阴影（PCFSoft），家具在地板上投下接触阴影。

**灯光**：半球光铺底 + 主方向光（模拟窗外日光，负责投影）+ 反向补光 + 室内暖光吸顶灯。
环境光刻意压低，靠方向光制造明暗对比与阴影，避免物体"发平"。
另用 ACES 色调映射让高光平滑滚降。

**环境**：深色干净背景 + 浅灰网格参考平面，远景带雾化淡出。

### 鼠标交互

- **拖拽**旋转视角、**滚轮**缩放
- 默认缓慢**自动旋转**
- **拖动时自动旋转暂停，松开后恢复**——由 OrbitControls 原生 `autoRotate` 提供：
  拖拽期间控制器处于 ROTATE 状态，自动旋转自动跳过
- 拖拽停止后带阻尼惯性，约 3–4 秒自然减速到完全静止（实测相邻帧差异降到 0.00%）

### 运行

```bash
# 1. Broker 已作为 Windows 服务常驻运行
# 2. 启动 Publisher
python server/publisher.py

# 3. 双击打开 3d/index.html
```

页面底部可切换 dorm-a / b / c，**只有当前选中宿舍的数据会驱动 3D 场景**，切换时立即回放该节点最新数据。

### 连接按钮说明

网页与 MQTTX 是两套**完全独立**的 MQTT 客户端，各自连接、互不影响：
关闭 MQTTX 不会断开网页，网页断开也不会影响 MQTTX。

因此网页断开必须点页面自带的「断开连接」按钮（内部调用 `client.end(true)` 停止自动重连）。
直接拔网线或关 Broker 属于"异常断开"，页面会每 2 秒自动重连——这两种断开是刻意区分的。

### 自主改进

在任务要求之外增加三项：

1. **HUD 实时数据面板**：左上角显示当前宿舍的节点、温湿度、状态、数据时间与**实时风扇转速**，
   可直接观察缓动过程——状态刚切换时转速是渐变的，而非瞬间跳变
2. **补全偏冷的视觉表现**：任务只列了三种状态，但 MQTT 数据里真实存在「偏冷」，
   若不处理会和「正常」显示成同一个样子，因此补了琥珀色指示灯
3. **指示灯改用不受光照影响的材质**：指示灯是发光体，用受光材质会因自发光与漫反射叠加而过曝泛白，
   蓝、琥珀这类颜色直接分辨不出（实测蓝色像素数为 0）。改用 Basic 材质后颜色才准确。
   完整排查过程见 [docs/bug-fix.md](docs/bug-fix.md) 的 Bug 4

此外所有视觉属性都走缓动过渡（`lerp`），避免状态切换时的生硬突变。

## 任务 A：异常优先级判断与处置闭环

在 M5/M6 基础上叠加。**温湿度判定规则完全未改动**
（温度 <18 偏冷 / ≥30 偏热 / 湿度 ≥75 偏湿 / 温度优先，正常兜底），
`web/script.js`、`dashboard/index.html`、`server/publisher.py`、`analysis/analyze.py` 四处实现保持一致。

### A1：宿舍优先级判断

系统自动输出「当前最需要关注的宿舍」，规则：

1. **先比异常持续时间**，时间更长的优先
2. **持续时间相同**时，**异常次数多的优先**

每个宿舍维护一条「异常段」：出现异常即开始计时；中途异常类型变化（如偏热→偏湿）
**不重置计时**（视为连续异常），直到收到正常数据才结束该段。
Dashboard 顶部面板实时显示榜首宿舍与判断理由（持续时间、异常次数、当前处置状态）；
三个宿舍都正常时显示「当前无异常宿舍」。

### A2：开启风扇

每张卡片带【开启风扇】按钮（仅「仍需关注」状态可点击）。点击后：

1. Dashboard 发布命令到 `dormmate/<nodeId>/fan`
2. 页面弹出「处理中，风扇已开启」，并记录本次操作时间
3. Publisher 收到命令后模拟风扇降温，数值向舒适区漂移
4. 3D 页面收到命令后强制风扇运转 30 秒（**不改风扇颜色**，颜色仍由宿舍状态决定）

### A3：处置状态机（点击按钮不会直接判定恢复）

```
正常 ──异常数据──▶ 仍需关注 ──点击开启风扇──▶ 处理中 ──收到正常数据──▶ 已恢复
                       ▲                                            │
                       └──────────── 再次收到异常数据 ────────────────┘
```

关键点：**点击按钮只把状态推进到「处理中」**，恢复必须由后续 MQTT 新数据判定。
处理中期间卡片会显示「已收到 N 组新数据」，用于演示闭环过程。

### A4：事件日志与复盘

每条异常事件记录 7 个字段，持久化在浏览器 localStorage（刷新不丢）：

| 字段 | 说明 |
| --- | --- |
| 宿舍名称 | dorm-a / dorm-b / dorm-c |
| 异常开始时间 | 该异常段的起点 |
| 异常类型 | 偏热 / 偏冷 / 偏湿 |
| 优先原因 | 该事件被排为榜首时的判断理由，否则为 — |
| 用户操作 | 开启风扇的时间，或「无」 |
| 恢复时间 | 恢复正常的时间，未恢复为 — |
| 最终结果 | 已恢复 / 处理中未恢复 / 仍需关注未处理 |

复盘链路（沿用 M2 的 CSV → report.html 管线）：

```
Dashboard 点击【导出事件日志】→ 下载 events.csv
  → 把 events.csv 放到 analysis/ 目录
  → python analyze.py
  → report.html 中出现「事件复盘」表（原有内容保留）
```

### 新增的 MQTT Topic

| Topic | 方向 | 用途 |
| --- | --- | --- |
| `dormmate/<nodeId>/fan` | Dashboard → Publisher / 3D | 开启风扇命令 |
| `dormmate/<nodeId>/sim` | 外部 → Publisher | 演示用场景注入：直接设定该宿舍的温湿度，便于可靠地制造异常 |

原有的 `dormmate/<nodeId>/env` 数据链路与 3D 页面的消息处理逻辑均未改动，只新增了分支。

### 演示步骤（完整闭环）

```bash
# 1. 启动 Publisher（同时订阅风扇命令与场景注入）
python server/publisher.py

# 2. 双击打开 dashboard/index.html

# 3. 制造异常（另开终端）
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/sim \
  -m "{\"nodeId\":\"dorm-a\",\"temperature\":36,\"humidity\":45}"
#   面板显示「当前最需要关注的宿舍：宿舍 A」，卡片状态变为「仍需关注」

# 4. 点击 dorm-a 卡片的【开启风扇】
#   弹出「处理中，风扇已开启」，状态变为「处理中」，Publisher 开始降温

# 5. 观察闭环
#   卡片持续显示「已收到 N 组新数据」，温度逐步下降，约 10 秒后自动变为「已恢复」

# 6. 导出复盘
#   点击【导出事件日志】→ 把 events.csv 放进 analysis/ → python analyze.py → 查看 report.html
```

同时打开 `3d/index.html` 可看到联动：选中对应宿舍后点击风扇，扇叶立即转动。

## 任务 B：信息呈现分层

温湿度判定规则仍未改动。四个信息入口各司其职，**不复制相同的文字**，所有文案都基于真实数据动态生成。

### 四个入口的分工

| 入口 | 承担的信息 | 不做什么 |
| --- | --- | --- |
| **Web 仪表盘** `dashboard/index.html` | 突出当前重点状态：最需关注的宿舍、当前情况一句话描述、异常宿舍判断依据排名 | 不展示全量历史事件明细 |
| **3D 页面** `3d/index.html` | 只展示空间状态：房间内风扇是否转动、指示灯颜色 | 不做优先级判断、不列事件、不显示历史 |
| **TTS 语音**（Dashboard 内按钮） | 朗读当前提醒：最需关注的宿舍、异常类型、已持续多久 | 不朗读历史统计 |
| **report.html** `analysis/report.html` | 历史复盘：今日摘要 + 完整事件详情 + 异常明细 + 趋势图 | 不反映实时状态 |

### B1：当前情况

Dashboard 的「当前情况」栏随数据刷新，一句话说清正在发生什么，例如：

> 当前有 2 个宿舍处于异常：宿舍 A 偏热（33.0℃），已持续 00:04，今日第 1 次，当前仍需关注；宿舍 B 偏湿（82.0%），已持续 00:01，今日第 1 次，当前仍需关注。　宿舍 C 正常。

三个宿舍都正常时显示「三个宿舍环境均正常，无需关注」，并附各宿舍当前数值。

### B2：优先宿舍的判断依据

「判断依据」排名列表列出全部异常宿舍，按优先级排序
（**先比异常持续时间，时长相同比异常次数**），每行显示排名、宿舍、异常类型、**异常持续时长**、**异常次数**。

- 第 1 名高亮，并标注完整判断依据
- 数据变化时（新增异常、异常恢复、时长增长）列表**自动重排**，无需刷新页面

### B3：今日摘要（代码从 CSV 自动生成）

`analysis/analyze.py` 会读取 `server/node_readings_history.csv`（实时历史数据），
按当天日期过滤后自动统计生成，例如：

> 今日（2026-10-01）共记录 8150 条环境数据，其中正常 5594 条、异常 2556 条。
> 异常类型分布：偏热 1247 条、偏湿 1237 条、偏冷 72 条。
> 全天共出现 263 段连续异常，涉及 3 个宿舍；各宿舍异常段数：宿舍 C 118 段、宿舍 B 116 段、宿舍 A 29 段。
> 持续最久的一段异常出现在宿舍 B，自 12:34:48 起的偏热，持续 8 分 19 秒。
> 按异常累计时长排序，今日最需要关注的是宿舍 B：共 116 段异常，累计 40 分 1 秒。

**其中每个数字都是脚本对 CSV 的实时统计结果，没有任何写死的文本**——
连续异常按「同一宿舍连续多条异常算一段、遇到正常数据即结束」切分。

### TTS 语音提醒

Dashboard「当前情况」栏右上角的【播放语音提醒】按钮，朗读内容同样由实时数据拼装：

> 当前最需要关注的宿舍是宿舍 A：偏热，已持续 9 秒，这是今日第 1 次异常。宿舍 B 偏湿，已持续 5 秒。宿舍 C 正常。

三个宿舍都正常时朗读「三个宿舍环境均正常，无需关注。」

### 演示步骤

```bash
# 1. 启动 Publisher
python server/publisher.py

# 2. 双击打开 dashboard/index.html
#    「当前情况」与「判断依据」排名随数据实时更新；点【播放语音提醒】听当前提醒

# 3. 制造异常（另开终端）
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/sim \
  -m "{\"nodeId\":\"dorm-a\",\"temperature\":36,\"humidity\":45}"
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-b/sim \
  -m "{\"nodeId\":\"dorm-b\",\"temperature\":24,\"humidity\":85}"

# 4. 生成今日摘要
cd analysis && python analyze.py
#    report.html 顶部出现【今日摘要】，数字取自 server/node_readings_history.csv
```

## 已知限制
- 语音识别（ASR）在部分浏览器兼容性较差，目前主要依赖 TTS 朗读功能。
- 历史记录暂未做数据库持久化，刷新页面会清空。
- M5 的趋势图数据保存在浏览器内存中，刷新后重新累积（最多保留最近 60 个采样点）。
- M6 的 3D 页面依赖 unpkg CDN 加载 three.js 与 mqtt.js，首次打开需联网；
  若 CDN 不可用，页面会显示明确的失败提示而非黑屏。