print("我的Python脚本运行了！")
import csv
import html
import os
from datetime import datetime

import pandas as pd
import matplotlib.pyplot as plt

# 解决matplotlib中文显示问题
plt.rcParams['font.sans-serif'] = ['SimHei']  # Windows用黑体
plt.rcParams['axes.unicode_minus'] = False

print("正在读取 CSV 数据...")
# 1. 读取 CSV
df = pd.read_csv('dormmate.csv')

# 2. 基础统计
record_count = len(df)
max_temp = df['temperature'].max()
min_temp = df['temperature'].min()

print(f"总记录数: {record_count}")
print(f"最高温度: {max_temp}℃, 最低温度: {min_temp}℃")
print("\n前几行数据:")
print(df.head())

# 3. 重新执行统一规则（文档第8条要求）
def calculate_status(temp, humid):
    if temp < 18:
        return "偏冷"
    elif temp >= 30:
        return "偏热"
    elif humid >= 75:
        return "偏湿"
    else:
        return "正常"

# 重新计算状态，对比是否有差异
df['recalculated_status'] = df.apply(lambda row: calculate_status(row['temperature'], row['humidity']), axis=1)

# 统计各状态数量
status_counts = df['recalculated_status'].value_counts()
print("\n各状态统计:")
print(status_counts)

# 找出需要关注的记录（偏热、偏冷、偏湿）
attention_records = df[df['recalculated_status'] != '正常']
print(f"\n需要关注的记录有 {len(attention_records)} 条。")

# 4. 生成趋势图并保存
plt.figure(figsize=(10, 5))
plt.plot(df.index, df['temperature'], marker='o', label='温度 (℃)', color='red')
plt.plot(df.index, df['humidity'], marker='s', label='湿度 (%)', color='blue')
plt.title('DormMate 环境温湿度趋势图')
plt.xlabel('记录序号')
plt.ylabel('数值')
plt.legend()
plt.grid(True)
plt.savefig('trend.png') # 保存为图片
print("趋势图已保存为 trend.png")

# 5. 任务 B：读取实时历史数据 CSV，自动生成【今日摘要】
#    摘要里的每个数字都来自对 CSV 的统计计算，没有任何写死的句子
NODE_LABELS = {'dorm-a': '宿舍 A', 'dorm-b': '宿舍 B', 'dorm-c': '宿舍 C'}
HISTORY_CSV = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           '..', 'server', 'node_readings_history.csv')


def parse_ts(text):
    try:
        return datetime.strptime(text, '%Y-%m-%d %H:%M:%S')
    except (TypeError, ValueError):
        return None


def fmt_seconds(total):
    total = int(total)
    minutes, seconds = divmod(total, 60)
    return f"{minutes} 分 {seconds} 秒" if minutes else f"{seconds} 秒"


def build_daily_summary(path):
    """把历史 CSV 中今日的数据聚合成一段自动生成的摘要。

    连续异常切分为"段"：同一宿舍连续多条异常算一段，遇到正常数据即结束该段。
    """
    day = datetime.now().strftime('%Y-%m-%d')

    if not os.path.exists(path):
        return f"<p>未找到历史数据文件（{os.path.basename(path)}），无法生成今日摘要。</p>"

    rows = []
    with open(path, encoding='utf-8-sig', newline='') as f:
        for row in csv.DictReader(f):
            if (row.get('time') or '').startswith(day):
                rows.append(row)

    if not rows:
        return f"<p>今日（{day}）暂无环境数据。</p>"

    by_node = {}
    for row in rows:
        by_node.setdefault(row.get('node', 'unknown'), []).append(row)

    type_counts = {}
    node_events = {}
    node_seconds = {}
    normal_rows = 0
    anomaly_rows = 0
    longest = {'duration': -1, 'node': None, 'type': None, 'start': None}

    def close_segment(seg):
        duration = 0
        if seg['start'] and seg['end']:
            duration = (seg['end'] - seg['start']).total_seconds()
        node = seg['node']
        node_events[node] = node_events.get(node, 0) + 1
        node_seconds[node] = node_seconds.get(node, 0) + duration
        if duration > longest['duration']:
            longest.update(seg, duration=duration)

    for node, items in by_node.items():
        seg = None
        for row in items:
            status = row.get('status', '')
            ts = parse_ts(row.get('time'))
            if status == '正常':
                normal_rows += 1
                if seg:
                    close_segment(seg)
                    seg = None
            else:
                anomaly_rows += 1
                type_counts[status] = type_counts.get(status, 0) + 1
                if seg is None:
                    seg = {'node': node, 'type': status, 'start': ts, 'end': ts}
                else:
                    seg['type'] = status
                    seg['end'] = ts
        if seg:
            close_segment(seg)

    sentences = [
        f"今日（{day}）共记录 {len(rows)} 条环境数据，"
        f"其中正常 {normal_rows} 条、异常 {anomaly_rows} 条。"
    ]

    if type_counts:
        ordered = sorted(type_counts.items(), key=lambda kv: -kv[1])
        sentences.append("异常类型分布：" + "、".join(f"{k} {v} 条" for k, v in ordered) + "。")

    total_events = sum(node_events.values())
    if total_events:
        ranked = sorted(node_events.items(), key=lambda kv: -kv[1])
        sentences.append(
            f"全天共出现 {total_events} 段连续异常，涉及 {len(node_events)} 个宿舍；"
            "各宿舍异常段数：" +
            "、".join(f"{NODE_LABELS.get(n, n)} {c} 段" for n, c in ranked) + "。"
        )

    if longest['node']:
        start = longest['start'].strftime('%H:%M:%S') if longest['start'] else '未知时刻'
        sentences.append(
            f"持续最久的一段异常出现在{NODE_LABELS.get(longest['node'], longest['node'])}，"
            f"自 {start} 起的{longest['type']}，持续 {fmt_seconds(longest['duration'])}。"
        )

    if node_seconds:
        top = max(node_seconds, key=node_seconds.get)
        sentences.append(
            f"按异常累计时长排序，今日最需要关注的是{NODE_LABELS.get(top, top)}："
            f"共 {node_events.get(top, 0)} 段异常，累计 {fmt_seconds(node_seconds[top])}。"
        )

    print(f"今日摘要已生成（基于 {len(rows)} 条今日数据）")
    return "<p>" + "</p><p>".join(html.escape(s) for s in sentences) + "</p>"


daily_summary_html = build_daily_summary(HISTORY_CSV)


# 6. 自动生成 report.html (不用手工修改，每次运行自动覆盖生成)
html_content = f"""
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>DormMate 环境报告</title>
    <style>
        body {{ font-family: Arial, sans-serif; padding: 20px; }}
        .summary {{ background: #f4f4f9; padding: 15px; border-radius: 5px; }}
        .chart {{ margin-top: 20px; text-align: center; }}
        table {{ border-collapse: collapse; width: 100%; margin-top: 20px; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
        th {{ background-color: #4CAF50; color: white; }}
    </style>
</head>
<body>
    <h1>DormMate 环境分析报告</h1>
    <div class="summary">
        <h2>今日摘要</h2>
        {daily_summary_html}
    </div>

    <div class="summary">
        <h2>数据摘要</h2>
        <p>总记录数: {record_count} 条</p>
        <p>最高温度: {max_temp}℃</p>
        <p>最低温度: {min_temp}℃</p>
        <p>需要关注的记录数: {len(attention_records)} 条</p>
        <p><strong>状态分布：</strong> {status_counts.to_dict()}</p>
    </div>

    <div class="chart">
        <h2>温湿度趋势图</h2>
        <img src="trend.png" alt="趋势图" style="max-width: 100%;">
    </div>

    <h2>需要关注的记录明细</h2>
    <table>
        <tr>
            <th>时间</th>
            <th>温度</th>
            <th>湿度</th>
            <th>状态</th>
        </tr>
"""

# 把需要关注的记录加入 HTML 表格
for index, row in attention_records.iterrows():
    html_content += f"""
        <tr>
            <td>{row['time']}</td>
            <td>{row['temperature']}℃</td>
            <td>{row['humidity']}%</td>
            <td style="color: red;">{row['recalculated_status']}</td>
        </tr>
    """

html_content += """
    </table>
"""
# 6. 任务 A：读取 Dashboard 导出的 events.csv，生成"事件复盘"表
#    （沿用现有 CSV → report.html 管线：Dashboard 导出 → 放到本目录 → 重新运行本脚本）
EVENT_COLUMNS = ['宿舍名称', '异常开始时间', '异常类型',
                 '优先原因', '用户操作', '恢复时间', '最终结果']
events_path = 'events.csv'

if os.path.exists(events_path):
    with open(events_path, encoding='utf-8-sig', newline='') as f:
        event_rows = list(csv.DictReader(f))

    rows_html = ''
    for row in event_rows:
        cells = ''.join(
            f'<td>{html.escape(str(row.get(col, "")))}</td>' for col in EVENT_COLUMNS
        )
        rows_html += f'<tr>{cells}</tr>'

    header_html = ''.join(f'<th>{col}</th>' for col in EVENT_COLUMNS)
    html_content += f"""
    <h2>事件复盘（任务 A）</h2>
    <p>共 {len(event_rows)} 条事件记录，来自 Dashboard 导出的 events.csv。</p>
    <table>
        <tr>{header_html}</tr>
        {rows_html}
    </table>
    """
    print(f"已合并 {len(event_rows)} 条事件记录到报告")
else:
    html_content += """
    <h2>事件复盘（任务 A）</h2>
    <p>暂无事件记录：请在 Dashboard 点击「导出事件日志」，
    将 events.csv 放到本目录后重新运行本脚本。</p>
    """
    print("未找到 events.csv，事件复盘表显示为空提示")

html_content += """
</body>
</html>
"""

# 写入 HTML 文件
with open('report.html', 'w', encoding='utf-8') as f:
    f.write(html_content)
print("报告已生成: report.html")