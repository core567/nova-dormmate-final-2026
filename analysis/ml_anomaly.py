"""任务 C：IsolationForest 孤立森林异常检测

思路：
1. 从历史 CSV 中取出**单个宿舍、状态为正常**的记录作为训练集，
   让模型学习该宿舍"平时的正常环境范围"（温度 + 湿度两个特征）。
2. 对新数据同时运行两套判断：原有固定阈值规则 + 孤立森林。
   孤立森林是无监督算法，这里不做准确率/F1 等指标计算，
   只输出"是否离群"与离群分数，用于和固定规则做对照。

换一份 CSV（--history 参数）即可重新训练，模型不落盘、每次运行现训，
保证"代码可重复运行、更换数据即换训练集"。
"""

import os

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

# ---- 模型与训练配置 ----
TRAIN_NODE = 'dorm-a'
CONTAMINATION = 0.01     # 预期的离群比例；用 'auto' 在样本重复度高时阈值会异常宽松
RANDOM_STATE = 42        # 固定随机种子，保证同样数据每次训练结果一致
FEATURES = ['temperature', 'humidity']
N_ESTIMATORS = 100

NODE_LABELS = {'dorm-a': '宿舍 A', 'dorm-b': '宿舍 B', 'dorm-c': '宿舍 C'}
RULE_THRESHOLDS = {'temp_low': 18, 'temp_high': 30, 'humid_high': 75}


def calc_status(temperature, humidity):
    """固定阈值规则。

    与 web/script.js、dashboard、3d、publisher 中的实现完全一致，
    任务 C 不修改这条规则，只是与 ML 结果并排对照。
    """
    if temperature < 18:
        return '偏冷'
    if temperature >= 30:
        return '偏热'
    if humidity >= 75:
        return '偏湿'
    return '正常'


def load_history(path):
    """读取历史 CSV 并清洗。返回 (DataFrame, 被丢弃的非法行数)。"""
    df = pd.read_csv(path, encoding='utf-8-sig')
    df['temperature'] = pd.to_numeric(df['temperature'], errors='coerce')
    df['humidity'] = pd.to_numeric(df['humidity'], errors='coerce')
    invalid = int(df[['temperature', 'humidity']].isna().any(axis=1).sum())
    df = df.dropna(subset=['temperature', 'humidity']).reset_index(drop=True)
    return df, invalid


def load_test_cases(path):
    """读取保留的对比测试数据；文件不存在时返回空表。"""
    if not os.path.exists(path):
        return None
    df = pd.read_csv(path, encoding='utf-8-sig')
    df['temperature'] = pd.to_numeric(df['temperature'], errors='coerce')
    df['humidity'] = pd.to_numeric(df['humidity'], errors='coerce')
    return df.dropna(subset=['temperature', 'humidity']).reset_index(drop=True)


def train_model(df, node=TRAIN_NODE, exclude_keys=None):
    """用该宿舍"正常"记录训练孤立森林。

    exclude_keys: 需要排除的 (time, node, temperature, humidity) 集合，
                  用于保证新测试数据不参与训练。
    """
    normal = df[(df['node'] == node) & (df['status'] == '正常')].copy()

    if exclude_keys:
        keys = list(zip(normal['time'], normal['node'],
                        normal['temperature'], normal['humidity']))
        normal = normal[[k not in exclude_keys for k in keys]].copy()

    features = normal[FEATURES].to_numpy(dtype=float)
    model = IsolationForest(
        n_estimators=N_ESTIMATORS,
        contamination=CONTAMINATION,
        random_state=RANDOM_STATE,
    )
    model.fit(features)
    return model, normal


def training_stats(normal_df):
    return {
        'count': int(len(normal_df)),
        'unique': int(len(normal_df[FEATURES].drop_duplicates())) if len(normal_df) else 0,
        'temp_min': float(normal_df['temperature'].min()),
        'temp_max': float(normal_df['temperature'].max()),
        'humid_min': float(normal_df['humidity'].min()),
        'humid_max': float(normal_df['humidity'].max()),
        'time_min': str(normal_df['time'].min()),
        'time_max': str(normal_df['time'].max()),
    }


def score_points(model, temperatures, humidities):
    """批量计算离群分数（越小越离群，< 0 即判为离群）。"""
    points = np.column_stack([np.asarray(temperatures, dtype=float),
                              np.asarray(humidities, dtype=float)])
    return model.decision_function(points)


def build_comparison(model, frame):
    """对一批数据同时给出固定规则与 ML 的判断结果。"""
    if frame is None or not len(frame):
        return []

    scores = score_points(model, frame['temperature'], frame['humidity'])
    rows = []
    for (_, row), score in zip(frame.iterrows(), scores):
        t, h = float(row['temperature']), float(row['humidity'])
        rule = calc_status(t, h)
        ml_anomaly = bool(score < 0)
        rows.append({
            'time': str(row.get('time', '')),
            'node': str(row.get('node', TRAIN_NODE)),
            'temperature': t,
            'humidity': h,
            'rule': rule,
            'ml_anomaly': ml_anomaly,
            'ml_score': float(score),
            'agree': (rule == '正常') != ml_anomaly,
        })
    return rows


def _scan(model, df, node):
    sub = df[df['node'] == node].copy()
    if not len(sub):
        return None
    sub['score'] = score_points(model, sub['temperature'], sub['humidity'])
    sub['rule'] = [calc_status(t, h)
                   for t, h in zip(sub['temperature'], sub['humidity'])]
    sub['ml_anomaly'] = sub['score'] < 0
    return sub


def find_contrast_cases(model, df, node=TRAIN_NODE, limit=5):
    """对比案例：固定规则判"正常"，ML 却判离群。

    这类点每个特征都还在阈值内，但两个特征的**组合**在历史正常数据里很少出现。
    """
    sub = _scan(model, df, node)
    if sub is None:
        return []
    hit = sub[(sub['rule'] == '正常') & sub['ml_anomaly']]
    hit = hit.sort_values('score').head(limit)
    return [{'time': str(r['time']), 'temperature': float(r['temperature']),
             'humidity': float(r['humidity']), 'rule': str(r['rule']),
             'ml_score': float(r['score'])} for _, r in hit.iterrows()]


def find_missed_cases(model, df, node=TRAIN_NODE, limit=5):
    """不理想案例：固定规则判"异常"，ML 却判正常（漏报）。

    通常出现在"刚好越过阈值、但与历史正常数据距离很近"的点上。
    """
    sub = _scan(model, df, node)
    if sub is None:
        return []
    hit = sub[(sub['rule'] != '正常') & (~sub['ml_anomaly'])]
    hit = hit.sort_values('time', ascending=False).head(limit)
    return [{'time': str(r['time']), 'temperature': float(r['temperature']),
             'humidity': float(r['humidity']), 'rule': str(r['rule']),
             'ml_score': float(r['score'])} for _, r in hit.iterrows()]


def explain_missed(case, stats):
    """给出 ML 漏报的原因说明：模板 + 运行时统计出的数字与分数。"""
    t, h, rule = case['temperature'], case['humidity'], case['rule']
    score = case['ml_score']

    if rule == '偏热':
        gap = t - stats['temp_max']
        return (
            f"该点温度 {t:.1f}℃，已高于训练集中正常温度上限 {stats['temp_max']:.1f}℃"
            f"（超出 {gap:.1f}℃），孤立森林却给出 {score:+.3f} 的分数（≥ 0 视为正常）。"
            f"原因有两点：其一，孤立森林的判定阈值取自训练数据自身的离群分位数，"
            f"而这份训练集里本就含有一批贴近边界的样本（温度高至 {stats['temp_max']:.1f}℃、"
            f"湿度高至 {stats['humid_max']:.1f}%），它们比该点更「孤立」，把阈值整体压低了；"
            f"其二，训练数据在 {stats['temp_max']:.1f}℃ 以上没有任何样本，"
            f"模型无法分辨越界之后的程度——例如 33.0℃ 与 34.0℃ 会落在同一个叶子里、"
            f"拿到完全相同的分数。固定规则不看分布，以 "
            f"{RULE_THRESHOLDS['temp_high']}℃ 为绝对界限，越界即判偏热。"
        )

    if rule == '偏冷':
        gap = stats['temp_min'] - t
        return (
            f"该点温度 {t:.1f}℃，低于训练集中正常温度下限 {stats['temp_min']:.1f}℃"
            f"（低了 {gap:.1f}℃），孤立森林给出 {score:+.3f} 的分数，未判离群。"
            f"低温方向同样受限于训练数据的覆盖范围：样本在 "
            f"{stats['temp_min']:.1f}℃ 以下缺失，模型难以衡量越界程度，"
            f"且训练集中贴近边界的样本会拉低判定阈值。固定规则以 "
            f"{RULE_THRESHOLDS['temp_low']}℃ 为绝对界限，越界即判偏冷。"
        )

    if rule == '偏湿':
        gap = h - stats['humid_max']
        return (
            f"该点湿度 {h:.1f}%，高于训练集中正常湿度上限 {stats['humid_max']:.1f}%"
            f"（超出 {gap:.1f}%），孤立森林给出 {score:+.3f} 的分数，未判离群。"
            f"该点的温度 {t:.1f}℃ 处在训练分布内部，"
            f"而湿度只比历史最高值高 {gap:.1f}%，在「温度-湿度」平面上仍紧邻正常样本云，"
            f"需要更多次随机切分才能隔离，因此分数未跌破阈值。"
            f"固定规则以 {RULE_THRESHOLDS['humid_high']}% 为绝对界限，越界即判偏湿。"
        )

    return (f"固定规则判为{rule}，但该点在训练分布内未见明显偏离，"
            f"孤立森林给出 {score:+.3f} 的分数，未判离群。")


def run_analysis(history_path, test_cases_path, node=TRAIN_NODE):
    """完整流程：清洗 → 训练 → 双套判断 → 案例检索。"""
    df, invalid_rows = load_history(history_path)
    test_df = load_test_cases(test_cases_path)

    # 保证测试数据不参与训练
    exclude_keys = set()
    if test_df is not None and len(test_df):
        exclude_keys = set(zip(test_df['time'], test_df['node'],
                               test_df['temperature'], test_df['humidity']))

    model, normal_df = train_model(df, node=node, exclude_keys=exclude_keys)
    stats = training_stats(normal_df)

    # 对照表：保留的测试用例 + 该宿舍最近的实时记录
    compare_df = df[df['node'] == node].tail(3)
    if test_df is not None and len(test_df):
        compare_df = pd.concat([test_df, compare_df], ignore_index=True)

    return {
        'node': node,
        'node_label': NODE_LABELS.get(node, node),
        'stats': stats,
        'invalid_rows': invalid_rows,
        'total_rows': int(len(df)),
        'compare_rows': build_comparison(model, compare_df),
        'contrast_cases': find_contrast_cases(model, df, node),
        'missed_cases': find_missed_cases(model, df, node),
        'config': {
            'contamination': CONTAMINATION,
            'random_state': RANDOM_STATE,
            'n_estimators': N_ESTIMATORS,
        },
    }
