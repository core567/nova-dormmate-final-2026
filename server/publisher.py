"""M5 Publisher：模拟 dorm-a / dorm-b / dorm-c 三个宿舍节点，周期性向 Mosquitto 发布温湿度 JSON。

发布 Topic: dormmate/<nodeId>/env
发布 Payload: {"nodeId","temperature","humidity","status","time"}
status 由温湿度按统一规则自动计算，不手写。

任务 A 新增（只增不改）：订阅控制 Topic dormmate/<nodeId>/fan，
收到开启命令后该节点模拟"风扇降温"，数值向舒适区漂移直到状态恢复为正常，
使"异常 → 开启风扇 → 数据回归正常 → 已恢复"形成真实闭环。
"""

import csv
import json
import os
import random
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883
PUBLISH_INTERVAL = 2
TOPIC_TEMPLATE = "dormmate/{}/env"

# 历史数据落盘：每次发布都追加一行，供 analysis/analyze.py 统一读取。
# 路径以本文件为基准，保证从任何工作目录启动都写到同一个文件。
HISTORY_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "node_readings_history.csv"
)
HISTORY_FIELDS = ("time", "node", "temperature", "humidity", "status")

# 统一消息协议版本，与 shared/protocol.js 的 SCHEMA_VERSION 保持一致
SCHEMA_VERSION = 2

# Broker 连接重试参数
CONNECT_WAIT_SECONDS = 30.0    # 启动时等待 Broker 的上限
RECONNECT_MIN_DELAY = 1        # 断线后最小重连间隔
RECONNECT_MAX_DELAY = 10       # 断线后最大重连间隔
# Dashboard 下发的控制命令（本 Publisher 只订阅，不发布）
CONTROL_TOPIC_SUBS = ("dormmate/+/fan", "dormmate/+/sim")
NODES = ("dorm-a", "dorm-b", "dorm-c")

# 随机游走边界：温度跨越 18 和 30，湿度跨越 75，保证状态会发生变化。
# 温度上限取 37：偏热阈值是 30，只有留出足够幅度，"开启风扇 → 持续降温 → 恢复"
# 的闭环才有可观察的过程，否则一步降温就恢复正常，看不到"处理中"阶段。
TEMP_RANGE = (15.0, 37.0)
HUMID_RANGE = (50.0, 85.0)
STEP = 0.8

# 风扇降温：向舒适区漂移的目标值、每步最大变化量与步数约束
COMFORT_TEMP = 22.0
COMFORT_HUMID = 60.0
COOL_STEP = 2.0
MIN_COOL_STEPS = 3      # 至少运转几步：即使当前是正常态，点按钮也能看到风扇转动
MAX_COOL_STEPS = 14     # 上限，避免极端值下无限降温
COMFORT_TEMP_BAND = 5.0    # 降温到距舒适温度这么多度以内即视为到位
COMFORT_HUMID_BAND = 8.0


def calc_status(temperature, humidity):
    """状态判断规则，温度优先（与 web/script.js 的 calculateStatus 保持一致）。"""
    if temperature < 18:
        return "偏冷"
    if temperature >= 30:
        return "偏热"
    if humidity >= 75:
        return "偏湿"
    return "正常"


def clamp(value, low, high):
    return max(low, min(high, value))


def append_history(payload):
    """把一次发布的数据追加到历史 CSV。

    文件不存在或为空时先写表头；新建文件用 utf-8-sig（带 BOM，Excel 打开不乱码），
    已存在的文件用 utf-8 追加（utf-8-sig 每次打开都会插一个 BOM，会把文件中间搞脏）。

    任何写入异常都只记日志，绝不能中断 MQTT 主循环——历史文件是旁路产物，
    它的失败不该让实时数据停更。
    """
    try:
        is_new = not os.path.exists(HISTORY_PATH) or os.path.getsize(HISTORY_PATH) == 0
        with open(
            HISTORY_PATH,
            "a",
            encoding="utf-8-sig" if is_new else "utf-8",
            newline="",
        ) as file:
            writer = csv.DictWriter(file, fieldnames=HISTORY_FIELDS)
            if is_new:
                writer.writeheader()
            writer.writerow(
                {
                    "time": payload["time"],
                    "node": payload["nodeId"],
                    "temperature": payload["temperature"],
                    "humidity": payload["humidity"],
                    "status": payload["status"],
                }
            )
    except OSError as exc:
        print(f"[历史] 写入 {os.path.basename(HISTORY_PATH)} 失败，已跳过本条记录：{exc}")


class NodeSimulator:
    """单个宿舍节点的随机游走模拟。"""

    def __init__(self, node_id):
        self.node_id = node_id
        self.temperature = round(random.uniform(18.0, 29.0), 1)
        self.humidity = round(random.uniform(50.0, 74.0), 1)
        self.cooling = False
        self.cooled_steps = 0

    def request_fan(self):
        """收到 Dashboard 的开启风扇命令。"""
        self.cooling = True
        self.cooled_steps = 0
        print(f"[风扇] {self.node_id} 收到开启命令，开始模拟降温…")

    def apply_scenario(self, command):
        """演示用：把节点数值直接设为指定温湿度，便于可靠地制造异常场景。

        随机游走无法保证某个宿舍恰好处于异常状态，而闭环演示必须从异常开始，
        因此提供这个注入入口。它只改变模拟数值，不参与状态判定。
        """
        if "temperature" in command:
            self.temperature = round(clamp(float(command["temperature"]), *TEMP_RANGE), 1)
        if "humidity" in command:
            self.humidity = round(clamp(float(command["humidity"]), *HUMID_RANGE), 1)
        self.cooling = False
        print(
            f"[场景] {self.node_id} 已注入 {self.temperature}℃ / {self.humidity}%"
            f"（{calc_status(self.temperature, self.humidity)}）"
        )

    def step(self):
        if self.cooling:
            # 风扇降温：数值向舒适区漂移。降到恢复正常且已运转够步数才停，
            # 这样"处理中"阶段能持续收到多组新数据，闭环过程可观察。
            self.temperature = round(
                clamp(
                    self.temperature
                    + clamp(COMFORT_TEMP - self.temperature, -COOL_STEP, COOL_STEP),
                    *TEMP_RANGE,
                ),
                1,
            )
            self.humidity = round(
                clamp(
                    self.humidity
                    + clamp(COMFORT_HUMID - self.humidity, -COOL_STEP, COOL_STEP),
                    *HUMID_RANGE,
                ),
                1,
            )
            self.cooled_steps += 1

            # 停止条件是"降到接近舒适区"，而不是"刚越过阈值"——
            # 否则停在 29.8℃ 这种压线值上，随机游走一步就又变回偏热，
            # 页面上"已恢复"会立刻被推翻。
            near_comfort = (
                abs(self.temperature - COMFORT_TEMP) <= COMFORT_TEMP_BAND
                and abs(self.humidity - COMFORT_HUMID) <= COMFORT_HUMID_BAND
            )
            if near_comfort and self.cooled_steps >= MIN_COOL_STEPS:
                self.cooling = False
                print(f"[风扇] {self.node_id} 已降到舒适区，风扇停止（共 {self.cooled_steps} 步）")
            elif self.cooled_steps >= MAX_COOL_STEPS:
                self.cooling = False
                print(f"[风扇] {self.node_id} 达到最大降温步数，风扇停止")
            return

        self.temperature = round(
            clamp(self.temperature + random.uniform(-STEP, STEP), *TEMP_RANGE), 1
        )
        self.humidity = round(
            clamp(self.humidity + random.uniform(-STEP, STEP), *HUMID_RANGE), 1
        )

    def build_payload(self):
        now = datetime.now()
        return {
            "schemaVersion": SCHEMA_VERSION,
            "nodeId": self.node_id,
            "temperature": self.temperature,
            "humidity": self.humidity,
            "status": calc_status(self.temperature, self.humidity),
            "time": now.strftime("%Y-%m-%d %H:%M:%S"),
            # seq 用毫秒时间戳：跨进程重启仍单调递增，前端据此丢弃旧消息。
            # 若用从 1 开始的自增计数，Publisher 重启后序号回落，
            # 页面会把所有新消息误判为"过期"而全部丢弃。
            "seq": int(now.timestamp() * 1000),
        }


def on_connect(client, userdata, flags, reason_code, properties=None):
    if reason_code == 0:
        print(f"[Broker] 已连接 {BROKER_HOST}:{BROKER_PORT}")
        for topic in CONTROL_TOPIC_SUBS:
            client.subscribe(topic)
        print(f"[命令] 已订阅控制 Topic：{'、'.join(CONTROL_TOPIC_SUBS)}")
    else:
        print(f"[Broker] 连接失败，reason_code={reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    # 宁可吵一点：断线必须看得见，不允许 Publisher 无声失败
    print(
        f"[Broker] 连接断开（reason_code={reason_code}），"
        f"{RECONNECT_MIN_DELAY}~{RECONNECT_MAX_DELAY} 秒后自动重连；"
        f"断线期间数据仍会写入历史文件"
    )


def wait_for_broker(client, timeout=CONNECT_WAIT_SECONDS):
    """等待首次连上 Broker。

    用的是 connect_async + loop_start，所以 Broker 没起来也不会抛异常崩掉，
    这里只是为了让启动日志更清楚；超时也不退出，后台会继续重连。
    """
    deadline = time.time() + timeout
    while not client.is_connected() and time.time() < deadline:
        time.sleep(0.5)
    if client.is_connected():
        print(f"[Broker] 已连接 {BROKER_HOST}:{BROKER_PORT}")
        return True
    print(
        f"[Broker] {timeout:.0f} 秒内未连上 {BROKER_HOST}:{BROKER_PORT}，"
        f"已转入后台持续重连（每 {RECONNECT_MIN_DELAY}~{RECONNECT_MAX_DELAY} 秒一次）"
    )
    return False


def publish_env(client, topic, payload):
    """发布一条 env 消息并检查结果。

    返回 True/False。失败一律打印原因——静默丢弃是这次要修掉的问题之一。
    """
    if not client.is_connected():
        print(f"[发布] 跳过 {topic}：Broker 未连接（该组数据已写入本地历史文件）")
        return False

    info = client.publish(
        topic, json.dumps(payload, ensure_ascii=False), qos=0, retain=False
    )
    if info.rc != mqtt.MQTT_ERR_SUCCESS:
        print(f"[发布] 失败 {topic}：rc={info.rc}（{mqtt.error_string(info.rc)}）")
        return False
    return True


def main():
    nodes = [NodeSimulator(node_id) for node_id in NODES]
    nodes_by_id = {node.node_id: node for node in nodes}

    def on_message(client, userdata, msg):
        """处理 Dashboard 下发的控制命令

        dormmate/<nodeId>/fan  {"nodeId":..,"command":"on"}        开启风扇，模拟降温
        dormmate/<nodeId>/sim  {"nodeId":..,"temperature":..,"humidity":..}  演示用场景注入
        """
        parts = msg.topic.split("/")
        if len(parts) != 3 or parts[0] != "dormmate":
            print(f"[命令] Topic 格式不正确，已忽略: {msg.topic}")
            return

        node = nodes_by_id.get(parts[1])
        if node is None:
            print(f"[命令] 未知节点，已忽略: {msg.topic}")
            return

        try:
            command = json.loads(msg.payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            print(f"[命令] 不是合法 JSON，已忽略: {msg.payload!r}")
            return

        action = parts[2]
        try:
            if action == "fan" and command.get("command") == "on":
                node.request_fan()
            elif action == "sim":
                node.apply_scenario(command)
            else:
                print(f"[命令] 未知命令，已忽略: {msg.topic} {command!r}")
        except (TypeError, ValueError) as exc:
            print(f"[命令] 参数非法，已忽略: {command!r}（{exc}）")

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="dorm-simulator",
        protocol=mqtt.MQTTv311,
    )
    # 断线后按 1~10 秒退避重连；Broker 中途重启也能自己恢复
    client.reconnect_delay_set(
        min_delay=RECONNECT_MIN_DELAY, max_delay=RECONNECT_MAX_DELAY
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    print(f"正在连接 Broker {BROKER_HOST}:{BROKER_PORT} …")
    # connect_async + loop_start：Broker 没启动时不会抛异常退出，
    # 而是在后台持续重试，这比 connect() 抛 OSError 直接崩掉更适合演示现场。
    client.connect_async(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()
    wait_for_broker(client)

    print(
        f"[历史] 每条发布都会追加到 {HISTORY_PATH}"
        f"（写入失败只记日志，不影响 MQTT 发布）"
    )

    try:
        while True:
            for node in nodes:
                node.step()
                payload = node.build_payload()
                topic = TOPIC_TEMPLATE.format(node.node_id)
                # retain=False：Dashboard 才能通过数据停更检测超时
                sent = publish_env(client, topic, payload)
                # 无论是否真的发出，每个节点每次生成的数据都要落历史文件：
                # Broker 断线时数据不该丢，历史链路要能独立于 MQTT 存在。
                append_history(payload)
                if sent:
                    print(f"[发布] {topic} -> {json.dumps(payload, ensure_ascii=False)}")
            time.sleep(PUBLISH_INTERVAL)
    except KeyboardInterrupt:
        print("\n收到 Ctrl+C，正在停止发布…")
    finally:
        client.loop_stop()
        client.disconnect()
        print("已断开 Broker，Publisher 退出。")


if __name__ == "__main__":
    main()
