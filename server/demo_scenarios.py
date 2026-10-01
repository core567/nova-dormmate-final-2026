"""任务 D2：三组不同三节点测试场景

依次播放 3 组场景，用来验证「当前优先关注」会随输入数据自动变化，
而不是写死某个宿舍：

  组 1  dorm-a 先异常、dorm-b 后异常、dorm-c 正常  → 优先 dorm-a（持续最长）
  组 2  dorm-c 先有一段已完成异常，随后三宿舍同时进入异常
        → 持续时间并列 → 优先 dorm-c（异常次数更多）
  组 3  只有 dorm-b 偏湿                              → 优先 dorm-b

每组结束时脚本会用与前端**完全相同**的规则在本地再算一遍，
打印出预期的优先宿舍与理由，方便和 Dashboard / 小程序的显示对照。

用法：
    python server/demo_scenarios.py              # 正常速度，组间等待 20 秒
    python server/demo_scenarios.py --wait 30    # 组间等待 30 秒
    python server/demo_scenarios.py --quiet      # 不等待，快速跑完（供自动测试）
"""

import argparse
import json
import time
from datetime import datetime

import paho.mqtt.client as mqtt

BROKER_HOST = "127.0.0.1"
BROKER_PORT = 1883
NODES = ["dorm-a", "dorm-b", "dorm-c"]
NODE_LABELS = {"dorm-a": "宿舍 A", "dorm-b": "宿舍 B", "dorm-c": "宿舍 C"}

NORMAL = (22.0, 55.0)
HOT = (33.0, 45.0)
WET = (24.0, 82.0)


def calc_status(temperature, humidity):
    """与 web / dashboard / 3d / publisher / analyze 保持一致的固定规则。"""
    if temperature < 18:
        return "偏冷"
    if temperature >= 30:
        return "偏热"
    if humidity >= 75:
        return "偏湿"
    return "正常"


def fmt_duration(seconds):
    minutes, secs = divmod(int(seconds), 60)
    return f"{minutes:02d}:{secs:02d}"


class ScenarioPlayer:
    """一边发布数据，一边用同样的规则在本地维护一份状态，用于输出预期结果。"""

    def __init__(self, client):
        self.client = client
        self.anomaly_count = {node: 0 for node in NODES}
        self.episode_start = {node: None for node in NODES}

    def set_node(self, node, values):
        temperature, humidity = values
        status = calc_status(temperature, humidity)
        stamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # sim：设定 Publisher 的模拟值（Publisher 在运行时生效）
        self.client.publish(f"dormmate/{node}/sim", json.dumps(
            {"nodeId": node, "temperature": temperature, "humidity": humidity},
            ensure_ascii=False))
        # env：直接发布一条环境数据（Publisher 未运行时也能演示）
        self.client.publish(f"dormmate/{node}/env", json.dumps(
            {"nodeId": node, "temperature": temperature, "humidity": humidity,
             "status": status, "time": stamp}, ensure_ascii=False))

        if status == "正常":
            self.episode_start[node] = None
        elif self.episode_start[node] is None:
            self.episode_start[node] = time.time()
            self.anomaly_count[node] += 1

        return status

    def local_rank(self):
        now = time.time()
        items = []
        for node in NODES:
            if self.episode_start[node] is None:
                continue
            items.append({
                "node": node,
                # 与前端一致：按秒取整后再比较
                "duration": int(now - self.episode_start[node]),
                "count": self.anomaly_count[node],
            })
        items.sort(key=lambda x: (-x["duration"], -x["count"]))
        return items

    def report(self, title):
        items = self.local_rank()
        print(f"\n  ── {title} ──")
        if not items:
            print("    脚本预期：当前无异常宿舍")
            return

        top = items[0]
        tied = sum(1 for it in items if it["duration"] == top["duration"]) > 1
        print(f"    脚本预期：【当前优先关注：{NODE_LABELS[top['node']]}"
              f"（{top['node']}）】")
        print("    判断理由：异常持续 " + fmt_duration(top["duration"]) +
              ("（并列最长）" if tied else "（最长）") +
              f"，异常 {top['count']} 次" +
              ("（时长并列，取次数多者）" if tied else ""))
        for it in items:
            print(f"      · {NODE_LABELS[it['node']]}: 持续 "
                  f"{fmt_duration(it['duration'])}, 异常 {it['count']} 次")


def main():
    parser = argparse.ArgumentParser(description="DormMate 三组测试场景演示")
    parser.add_argument("--wait", type=float, default=20,
                        help="组间等待秒数，便于观察页面变化（默认 20）")
    parser.add_argument("--quiet", action="store_true",
                        help="不等待，快速跑完（供自动测试使用）")
    args = parser.parse_args()

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="dorm-scenarios")
    client.connect(BROKER_HOST, BROKER_PORT)
    client.loop_start()

    player = ScenarioPlayer(client)

    def pause(seconds):
        if not args.quiet:
            time.sleep(seconds)

    try:
        print("=" * 64)
        print("DormMate 三组场景演示 —— 观察页面上的「当前优先关注」如何变化")
        print("=" * 64)

        # ---------- 组 1 ----------
        print("\n[组 1] dorm-a 先进入异常，dorm-b 稍后进入异常")
        for node in NODES:
            player.set_node(node, NORMAL)
        time.sleep(2)
        player.set_node("dorm-a", HOT)          # 先异常
        time.sleep(6)
        player.set_node("dorm-b", WET)          # 后异常
        time.sleep(3)
        player.report("组 1 结果（预期：dorm-a，因为持续更久）")
        pause(args.wait)

        # ---------- 组 2 ----------
        print("\n[组 2] 先让 dorm-c 积累一次已完成异常，之后三宿舍同时进入异常")
        for node in NODES:
            player.set_node(node, NORMAL)
        pause(4)

        # 让 dorm-c 的异常次数确定性地多于另外两个宿舍。
        # 次数是跨组累积的（组 1 已给 dorm-a / dorm-b 各加了 1 次），
        # 所以这里按当前值动态补齐，不写死具体次数。
        rivals = max(player.anomaly_count["dorm-a"], player.anomaly_count["dorm-b"])
        while player.anomaly_count["dorm-c"] <= rivals:
            player.set_node("dorm-c", HOT)
            time.sleep(3)
            player.set_node("dorm-c", NORMAL)
            pause(4)
        print(f"  （dorm-c 已累计 {player.anomaly_count['dorm-c']} 次异常，"
              f"dorm-a / dorm-b 各 {rivals} 次）")

        for node in NODES:                      # 同秒进入异常 → 持续时间并列
            player.set_node(node, HOT)
        time.sleep(4)
        player.report("组 2 结果（预期：dorm-c，因为时长并列时次数更多）")
        pause(args.wait)

        # ---------- 组 3 ----------
        print("\n[组 3] 只有 dorm-b 处于偏湿")
        for node in NODES:
            player.set_node(node, NORMAL)
        pause(4)

        player.set_node("dorm-b", WET)
        time.sleep(4)
        player.report("组 3 结果（预期：dorm-b，唯一异常宿舍）")

        print("\n演示结束。三组场景的优先宿舍分别是：")
        print("    组 1 → dorm-a（持续最长）")
        print("    组 2 → dorm-c（时长并列，次数更多）")
        print("    组 3 → dorm-b（唯一异常）")
        print("说明：优先目标由数据决定，脚本里没有写死任何一个宿舍。")

    except KeyboardInterrupt:
        print("\n已中断")
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()
