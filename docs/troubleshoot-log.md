# DormMate 实时链路故障演练记录（任务 D4）

环境：Windows 11 + Mosquitto（本机服务）+ Chrome，用 `file://` 打开 Dashboard。
下文的时间戳与日志原文均来自实际演练，未做加工。

## 演练前置

| 项 | 说明 |
| --- | --- |
| Broker | Mosquitto 服务运行中，监听 `1883`(MQTT) 与 `8083`(WebSocket) |
| Publisher | `python server/publisher.py`，每 2 秒发布三个宿舍的数据 |
| Dashboard | `dashboard/index.html`，订阅 `dormmate/#` |
| 离线判定 | 某节点超过 **10 秒** 未收到数据即判定离线（`STALE_MS = 10000`） |

---

## 主演练：节点离线

### ① 观察页面现象

停止 Publisher 并等待约 10 秒，Dashboard 上三张卡片同时出现 **节点离线** 标签：

```
20:33:45  dorm-a 节点离线：数据中断
20:33:45  dorm-b 节点离线：数据中断
20:33:45  dorm-c 节点离线：数据中断
```

卡片同时变暗（元素 class 变为 `card stale`），"最后更新"时间停止推进。

### ② 定位故障原因

三张卡片**同时**离线，说明问题不在某个传感器，而在**三者的共同链路环节**。
沿链路逐段排查：

| 环节 | 判断方式 | 结论 |
| --- | --- | --- |
| WebSocket 连接 | 顶部横幅仍显示"已连接 Broker" | 网页与 Broker 之间的连接正常 |
| Broker | 服务未停止，端口仍在监听 | 消息中转站正常 |
| **Publisher** | 进程已被终止 | **数据源中断** ← 故障点在此 |

用旁路订阅可以直接确认数据源确实没在发：

```bash
mosquitto_sub -h 127.0.0.1 -t "dormmate/+/env" -v
# 停 Publisher 期间没有任何输出
```

### ③ 修复链路

重新启动数据源即可：

```bash
python server/publisher.py
```

### ④ 验证通信恢复

重启后约 2 秒，三个节点陆续恢复：

```
20:33:51  dorm-a 节点恢复在线
20:33:51  dorm-b 节点恢复在线
20:33:51  dorm-c 节点恢复在线
```

卡片亮度恢复、温度数值开始刷新、**节点离线** 标签消失。

### 持久化验证

刷新 Dashboard 后，链路日志里那 6 条记录（3 条 offline + 3 条 recovered）**依然存在**，
说明日志已写入 `localStorage`（键名 `dormmate_link_log`），不随页面刷新丢失。

导出的 `link_log.csv` 原文：

```csv
time,type,node,detail
2026-10-01 20:33:45,offline,dorm-a,超过 10 秒未收到数据，判定节点离线
2026-10-01 20:33:45,offline,dorm-b,超过 10 秒未收到数据，判定节点离线
2026-10-01 20:33:45,offline,dorm-c,超过 10 秒未收到数据，判定节点离线
2026-10-01 20:33:51,recovered,dorm-a,重新收到数据，节点恢复在线
2026-10-01 20:33:51,recovered,dorm-b,重新收到数据，节点恢复在线
2026-10-01 20:33:51,recovered,dorm-c,重新收到数据，节点恢复在线
```

---

## 附加演练 1：发送错误 JSON

**故障注入**

```bash
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env -m "{this is not valid json"
```

**页面现象**（事件日志原文）

```
20:35:57  非法 JSON，已忽略 | topic=dormmate/dorm-a/env | payload={this is not valid json
```

**定位原因**：载荷不是合法 JSON，`JSON.parse` 抛异常。
**修复**：发送格式正确的 JSON。
**验证**：之后正常数据被接收，dorm-a 数值恢复刷新；页面全程未崩溃。

持久化链路日志：`2026-10-01 20:35:57,fault,dormmate/dorm-a/env,非法 JSON，已忽略：{this is not valid json`

---

## 附加演练 2：Topic 写错（多了一层）

**故障注入**

```bash
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-a/env/extra \
  -m '{"nodeId":"dorm-a","temperature":25,"humidity":60}'
```

**页面现象**

```
20:35:59  Topic 格式不正确，已忽略 | dormmate/dorm-a/env/extra
```

**定位原因**：Topic 多了一层，不匹配 `dormmate/<nodeId>/env` 的校验正则。
**修复**：把 Topic 改回 `dormmate/dorm-a/env`。
**验证**：修正后消息被正常接收。

---

## 附加演练 3：未知节点

**故障注入**

```bash
mosquitto_pub -h 127.0.0.1 -t dormmate/dorm-x/env \
  -m '{"nodeId":"dorm-x","temperature":25,"humidity":60}'
```

**页面现象**

```
20:36:00  未知节点，已忽略 | dormmate/dorm-x/env
```

**定位原因**：`dorm-x` 不在节点白名单 `{dorm-a, dorm-b, dorm-c}` 内。
**修复**：使用正确的节点 ID。
**验证**：正常消息不受影响，三宿舍数据继续刷新。

---

## 小结

| 故障类型 | 检测方式 | 页面表现 | 是否波及其他节点 |
| --- | --- | --- | --- |
| 节点离线 | 超过 10 秒无数据 | 卡片"节点离线"标签 + 变暗 | 不会（各节点独立判定） |
| 错误 JSON | `JSON.parse` 异常 | 记日志并忽略，页面不崩 | 不会 |
| Topic 写错 | 正则不匹配 | 记日志并忽略 | 不会 |
| 未知节点 | 白名单校验 | 记日志并忽略 | 不会 |

四类故障都会写入**持久化链路日志**（`localStorage` + 可导出 `link_log.csv`），
按「观察现象 → 定位原因 → 修复链路 → 验证恢复」的流程可完整复现。

3D 页面与微信小程序使用相同的 **10 秒** 离线判定规则，会同步提示节点离线。
