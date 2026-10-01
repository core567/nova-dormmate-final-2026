"""M5 Publisher：模拟 dorm-a / dorm-b / dorm-c 三个宿舍节点，周期性向 Mosquitto 发布温湿度 JSON。

Topic:   dormmate/<nodeId>/env
Payload: {"nodeId","temperature","humidity","status","time"}
status 由温湿度按统一规则自动计算，不手写。
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
NODES = ("dorm-a", "dorm-b", "dorm-c")

# 随机游走边界：温度跨越 18 和 30，湿度跨越 75，保证状态会发生变化
TEMP_RANGE = (17.0, 31.0)
HUMID_RANGE = (50.0, 85.0)
STEP = 0.8


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

    def step(self):
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
    else:
        print(f"[Broker] 连接失败，reason_code={reason_code}")


def on_disconnect(client, userdata, flags, reason_code, properties=None):
    print(f"[Broker] 连接断开（reason_code={reason_code}），mqtt 库将自动重连…")


def main():
    nodes = [NodeSimulator(node_id) for node_id in NODES]

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        client_id="dorm-simulator",
        protocol=mqtt.MQTTv311,
    )
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

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
