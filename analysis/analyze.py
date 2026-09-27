print("我的Python脚本运行了！")
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

# 5. 自动生成 report.html (不用手工修改，每次运行自动覆盖生成)
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
</body>
</html>
"""

# 写入 HTML 文件
with open('report.html', 'w', encoding='utf-8') as f:
    f.write(html_content)
print("报告已生成: report.html")