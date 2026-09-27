// 1. 获取页面元素 (文档要求：知道输入在哪里读入)
const analyzeBtn = document.getElementById('analyzeBtn');
const tempInput = document.getElementById('tempInput');
const humidInput = document.getElementById('humidInput');
const statusDisplay = document.getElementById('statusDisplay');
const adviceDisplay = document.getElementById('adviceDisplay');
const historyList = document.getElementById('historyList');

// 用于存放历史记录
let historyData = [];

// 2. 统一规则判断函数 (文档要求：规则在哪里判断)
function calculateStatus(temp, humid) {
    // 规则顺序严格遵循文档第7页：
    if (temp < 18) {
        return { status: "偏冷", advice: "建议开启暖气或添加衣物。" };
    } else if (temp >= 30) {
        return { status: "偏热", advice: "建议开启空调降温。" };
    } else if (humid >= 75) {
        return { status: "偏湿", advice: "建议开启除湿机。" };
    } else {
        return { status: "正常", advice: "环境舒适，适合学习。" };
    }
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
    
    let temp = Number(tempVal);
    let humid = Number(humidVal);
    
    // 校验非数字或异常值
    if (isNaN(temp) || isNaN(humid)) {
        alert("请输入有效的数字！");
        return;
    }
    if (temp < -50 || temp > 100 || humid < 0 || humid > 100) {
        alert("温湿度数值明显异常，请检查输入！");
        return;
    }

    // --- 通过校验，执行规则判断 ---
    let result = calculateStatus(temp, humid);
    
    // --- 更新当前状态 ---
    statusDisplay.innerText = result.status;
    adviceDisplay.innerText = result.advice;

    // --- 加入历史记录 (必须包含时间) ---
    let now = new Date();
    // 格式化为 YYYY-MM-DD HH:mm:ss
    let timeStr = now.toLocaleString('zh-CN', { hour12: false });
    
    let record = `[${timeStr}] 温度: ${temp}℃, 湿度: ${humid}%, 状态: ${result.status}`;
    historyData.push(record);

    // 渲染到页面列表 (只保留最新的5条，避免页面太长)
    historyList.innerHTML = ''; 
    let displayData = historyData.slice(-5); // 取最后5条
    
    displayData.forEach(item => {
        let li = document.createElement('li');
        li.innerText = item;
        historyList.appendChild(li);
    });

    // 清空输入框，方便下一次输入
    tempInput.value = '';
    humidInput.value = '';
});
// 导出 CSV 逻辑
const exportBtn = document.getElementById('exportBtn');
exportBtn.addEventListener('click', function() {
    if (historyData.length === 0) {
        alert("没有历史记录可以导出！");
        return;
    }
    
    // 文档要求：第一行必须是 time,temperature,humidity,status
    let csvContent = "time,temperature,humidity,status\n";
    
    // 解析 historyData 里的每一条记录（我们之前存的是字符串，这里需要拆分重组）
    // 为了避免复杂的字符串解析，建议在 M1 里改写一下 historyData 存为对象。
    // 【最简单做法】：这里我们直接用正则匹配之前的字符串格式
    historyData.forEach(record => {
        // 格式示例：`[2023/10/24 20:31:00] 温度: 31℃, 湿度: 78%, 状态: 偏热`
        let timeMatch = record.match(/\[(.*?)\]/);
        let tempMatch = record.match(/温度: (\d+)/);
        let humidMatch = record.match(/湿度: (\d+)/);
        let statusMatch = record.match(/状态: (.*)/);
        
        if (timeMatch && tempMatch && humidMatch && statusMatch) {
            // 移除时间里的逗号，避免破坏CSV结构
            let timeStr = timeMatch[1].replace(/,/g, '');
            csvContent += `${timeStr},${tempMatch[1]},${humidMatch[1]},${statusMatch[1]}\n`;
        }
    });

    // 触发下载
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' }); // \uFEFF 防止 Excel 打开乱码
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