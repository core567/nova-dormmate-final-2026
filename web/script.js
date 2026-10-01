// 统一消息协议与数据校验（单一来源，与 Dashboard / 3D / 小程序同一份规则）
var P = window.DormMateProtocol;

// 1. 获取页面元素 (文档要求：知道输入在哪里读入)
const analyzeBtn = document.getElementById('analyzeBtn');
const tempInput = document.getElementById('tempInput');
const humidInput = document.getElementById('humidInput');
const statusDisplay = document.getElementById('statusDisplay');
const adviceDisplay = document.getElementById('adviceDisplay');
const historyList = document.getElementById('historyList');

// 用于存放历史记录。
// P1-十四：改存对象，不再拼成字符串——字符串要靠正则反解，
// 26.5 会被 /\d+/ 截成 26，小数直接丢掉。
let historyData = [];

// 各状态对应的建议文案（页面文案，不是业务规则；状态本身由共享模块判定）
const ADVICE = {
    '偏冷': '建议开启暖气或添加衣物。',
    '偏热': '建议开启空调降温。',
    '偏湿': '建议开启除湿机。',
    '正常': '环境舒适，适合学习。'
};

// 2. 统一规则判断函数 (文档要求：规则在哪里判断)
//    规则本体来自 shared/protocol.js，本页不再自带一份
function calculateStatus(temp, humid) {
    const status = P.calcStatus(temp, humid);
    return { status: status, advice: ADVICE[status] };
}

function formatStamp(date) {
    const pad = (n) => (n < 10 ? '0' + n : '' + n);
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
        ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

// 3. 点击事件绑定 (文档要求：历史在哪里加入)
analyzeBtn.addEventListener('click', function() {
    let tempVal = tempInput.value.trim();
    let humidVal = humidInput.value.trim();

    // --- 文档第8页要求：防错校验 ---
    // 校验空值
    if (tempVal === '' || humidVal === '') {
        alert("温度和湿度都不能为空！");
        return;
    }

    // 数值校验统一走 shared/protocol.js（有限数字 + 物理合理区间），
    // 与 MQTT 四端是同一个函数，不再各写一套
    const reading = P.validateReading(tempVal, humidVal);
    if (!reading.ok) {
        alert("数值不合法：" + reading.reason + "。请检查输入！");
        return;
    }

    const temperature = reading.temperature;
    const humidity = reading.humidity;

    // --- 通过校验，执行规则判断 ---
    let result = calculateStatus(temperature, humidity);

    // --- 更新当前状态 ---
    statusDisplay.innerText = result.status;
    adviceDisplay.innerText = result.advice;

    // --- 加入历史记录 (必须包含时间) ---
    historyData.push({
        time: formatStamp(new Date()),
        temperature: temperature,
        humidity: humidity,
        status: result.status
    });

    renderHistory();

    // 清空输入框，方便下一次输入
    tempInput.value = '';
    humidInput.value = '';
});

// 渲染历史列表 (只保留最新 5 条，避免页面太长)
function renderHistory() {
    historyList.innerHTML = '';
    historyData.slice(-5).forEach(function(record) {
        const li = document.createElement('li');
        li.innerText = '[' + record.time + '] 温度: ' + record.temperature +
            '℃, 湿度: ' + record.humidity + '%, 状态: ' + record.status;
        historyList.appendChild(li);
    });
}

// 导出 CSV 逻辑
const exportBtn = document.getElementById('exportBtn');
exportBtn.addEventListener('click', function() {
    if (historyData.length === 0) {
        alert("没有历史记录可以导出！");
        return;
    }

    // 文档要求：第一行必须是 time,temperature,humidity,status
    // 直接由对象字段拼行，不经过字符串反解，小数原样保留（26.5 仍是 26.5）
    const lines = ['time,temperature,humidity,status'];
    historyData.forEach(function(record) {
        lines.push([
            String(record.time).replace(/,/g, ''),   // 时间里的逗号会破坏 CSV 结构
            record.temperature,
            record.humidity,
            record.status
        ].join(','));
    });
    const csvContent = lines.join('\n') + '\n';

    // 触发下载
    const blob = new Blob(["﻿" + csvContent], { type: 'text/csv;charset=utf-8;' }); // ﻿ 防止 Excel 打开乱码
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", "dormmate.csv");
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// --- M3 摄像头逻辑 ---
const startCameraBtn = document.getElementById('startCameraBtn');
const snapBtn = document.getElementById('snapBtn');
const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const snapshot = document.getElementById('snapshot');
let stream = null;

startCameraBtn.addEventListener('click', async function() {
    try {
        // 调用摄像头
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        video.style.display = 'block';
        video.play();
        snapBtn.disabled = false;
        startCameraBtn.innerText = "摄像头已开启";
    } catch (err) {
        alert("无法访问摄像头: " + err.message + "。请确保使用 localhost 打开，并允许权限。");
    }
});

snapBtn.addEventListener('click', function() {
    if (!stream) return;
    // 把视频画面画到画布上
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    // 把画布内容变成图片
    const dataURL = canvas.toDataURL('image/png');
    snapshot.src = dataURL;
    snapshot.style.display = 'block';

    // 拍照后关闭摄像头
    stream.getTracks().forEach(track => track.stop());
    video.style.display = 'none';
    snapBtn.disabled = true;
    startCameraBtn.innerText = "重新开启摄像头";
});
// --- M3 TTS 逻辑 ---
const ttsBtn = document.getElementById('ttsBtn');
ttsBtn.addEventListener('click', function() {
    const statusText = document.getElementById('statusDisplay').innerText;
    if (statusText === '等待分析' || statusText === '') {
        alert("请先分析环境数据！");
        return;
    }
    // 合成语音
    const utterance = new SpeechSynthesisUtterance(`当前宿舍环境状态是：${statusText}`);
    utterance.lang = 'zh-CN';
    window.speechSynthesis.speak(utterance);
});
