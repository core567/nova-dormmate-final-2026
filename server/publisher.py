"""M5 Publisher：模拟 dorm-a / dorm-b / dorm-c 三个宿舍节点，周期性向 Mosquitto 发布温湿度 JSON。

发布 Topic: dormmate/<nodeId>/env
发布 Payload: {"nodeId","temperature","humidity","status","time"}
status 由温湿度按统一规则自动计算，不手写。

任务 A 新增（只增不改）：订阅控制 Topic dormmate/<nodeId>/fan，
收到开启命令后该节点模拟"风扇降温"，数值向舒适区漂移直到状态恢复为正常，
使"异常 → 开启风扇 → 数据回归正常 → 已恢复"形成真实闭环。
"""

import json
import random
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883
PUBLISH_INTERVAL = 2
TOPIC_TEMPLATE = "dormmate/{}/env"
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
        return {
            "nodeId": self.node_id,
            "temperature": self.temperature,
            "humidity": self.humidity,
            "status": calc_status(self.temperature, self.humidity),
            "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
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
    print(f"[Broker] 连接断开（reason_code={reason_code}），mqtt 库将自动重连…")


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
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    print(f"正在连接 Broker {BROKER_HOST}:{BROKER_PORT} …")
    client.connect(BROKER_HOST, BROKER_PORT, keepalive=60)
    client.loop_start()

    try:
        while True:
            for node in nodes:
                node.step()
                payload = node.build_payload()
                topic = TOPIC_TEMPLATE.format(node.node_id)
                # retain=False：Dashboard 才能通过数据停更检测超时
                client.publish(
                    topic,
                    json.dumps(payload, ensure_ascii=False),
                    qos=0,
                    retain=False,
                )
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
