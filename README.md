# DormMate Final - 多节点宿舍环境助手

## 运行方式
1. Web 端：在 VS Code 中打开 `web/index.html`，使用 Live Server 运行（必须使用 localhost，否则无法使用摄像头）。
2. 离线分析：在 `analysis` 目录下运行 `python analyze.py`，读取 `dormmate.csv` 并生成报告。

## 主要功能
- M1: 温湿度输入、状态判断、历史记录
- M2: 导出 CSV、Python 生成趋势图与 HTML 报告
- M3: 调用摄像头拍照、TTS 语音朗读当前状态

## 已知限制
- 语音识别（ASR）在部分浏览器兼容性较差，目前主要依赖 TTS 朗读功能。
- 历史记录暂未做数据库持久化，刷新页面会清空。