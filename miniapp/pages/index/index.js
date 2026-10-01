/**
 * 任务 D：小程序实时看板
 *
 * - 通过 utils/mqtt.js 直连本地 Mosquitto 的 WebSocket 端口，订阅 dormmate/#
 * - 三个宿舍的数据按 nodeId 严格隔离，互不串号
 * - 事件状态：OPEN(待处理) → HANDLING(处理中) → RECOVERED(已恢复)
 *   点击【开启风扇】只进入 HANDLING，恢复必须由后续 MQTT 新数据判定
 * - 页面底部折叠区保留 M4 的手动环境分析功能
 */
const mqtt = require('../../utils/mqtt.js');

const NODES = ['dorm-a', 'dorm-b', 'dorm-c'];
const NODE_LABEL = { 'dorm-a': '宿舍 A', 'dorm-b': '宿舍 B', 'dorm-c': '宿舍 C' };
const TOPIC_RE = /^dormmate\/([^/]+)\/env$/;
const VALID_STATUS = ['正常', '偏冷', '偏热', '偏湿'];
const BROKER_WS = 'ws://127.0.0.1:8083/mqtt';

const PHASE_LABEL = { normal: '正常', open: '待处理', handling: '处理中', recovered: '已恢复' };
const PHASE_CLASS = {
  normal: 'ph-normal', open: 'ph-open',
  handling: 'ph-handling', recovered: 'ph-recovered'
};
const STATUS_CLASS = {
  '正常': 'st-normal', '偏冷': 'st-cold', '偏热': 'st-hot', '偏湿': 'st-wet'
};
const OFFLINE_MS = 10000;   // 任务 D4：超过该时长未收到数据即判定节点离线

/** 固定阈值规则：与 web / dashboard / 3d / publisher / analyze 保持一致 */
function calcStatus(temperature, humidity) {
  if (temperature < 18) return '偏冷';
  if (temperature >= 30) return '偏热';
  if (humidity >= 75) return '偏湿';
  return '正常';
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function fmtDuration(ms) {
  var total = Math.floor(ms / 1000);
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60);
}

function nowStamp() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function nowTime() {
  var d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

Page({
  data: {
    connected: false,
    connText: '正在连接…',
    priorityText: '当前无异常宿舍',
    priorityReason: '三个宿舍环境均正常',
    nodes: [],
    recentEvents: [],
    manualOpen: false,
    // M4 手动分析（字段名加 manual 前缀，避免与实时状态冲突）
    temperature: '',
    humidity: '',
    manualStatus: '等待分析',
    manualAdvice: '-'
  },

  /* ---------------- 生命周期 ---------------- */

  onLoad() {
    this._state = {};
    NODES.forEach((id) => {
      this._state[id] = {
        temperature: null, humidity: null, status: '', lastUpdate: null,
        phase: 'normal', episode: null, anomalyCount: 0, verifyData: []
      };
    });
    this._client = null;
    this._tickTimer = null;
    this._refresh();
    this._loadRecentEvents();
    this._connect();
  },

  onShow() {
    if (!this._client) this._connect();
    // 异常持续时间随钟表增长，每秒重算一次
    if (!this._tickTimer) {
      this._tickTimer = setInterval(() => this._refresh(), 1000);
    }
  },

  onHide() { this._teardown(); },
  onUnload() { this._teardown(); },

  _teardown() {
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
    this._disconnect();
  },

  /* ---------------- MQTT ---------------- */

  _connect() {
    if (this._client) return;
    const self = this;
    this.setData({ connText: '正在连接…' });

    const client = mqtt.connect(BROKER_WS, {
      clientId: 'dormmate-miniapp-' + Math.random().toString(16).slice(2, 8)
    });
    this._client = client;

    client.on('connect', () => {
      self.setData({ connected: true, connText: '已连接 Broker' });
      client.subscribe('dormmate/#');
    });

    client.on('message', (topic, payload) => self._onMessage(topic, payload));

    client.on('close', () => {
      self.setData({ connected: false, connText: '连接已断开（自动重连中）' });
    });

    client.on('error', () => {
      self.setData({ connected: false, connText: '连接错误（自动重连中）' });
    });
  },

  _disconnect() {
    if (this._client) {
      this._client.end();
      this._client = null;
    }
    this.setData({ connected: false, connText: '已断开连接' });
  },

  /** 消息校验：非法数据只提示、不改状态，与 Dashboard 的处理方式一致 */
  _onMessage(topic, payload) {
    let data;
    try {
      data = JSON.parse(payload);
    } catch (err) {
      console.warn('非法 JSON，已忽略', topic);
      return;
    }

    const matched = topic.match(TOPIC_RE);
    if (!matched) {
      console.warn('Topic 格式不正确，已忽略', topic);
      return;
    }

    const topicNode = matched[1];
    if (NODES.indexOf(topicNode) === -1) {
      console.warn('未知节点，已忽略', topic);
      return;
    }
    if (!data || NODES.indexOf(data.nodeId) === -1) {
      console.warn('nodeId 非法，已忽略', topic);
      return;
    }
    if (data.nodeId !== topicNode) {
      console.warn('Topic 与 nodeId 不一致，已忽略', topic);
      return;
    }

    const temp = Number(data.temperature);
    const hum = Number(data.humidity);
    if (!isFinite(temp) || !isFinite(hum)) {
      console.warn('温湿度不是有效数值，已忽略', payload);
      return;
    }

    let status = data.status;
    if (VALID_STATUS.indexOf(status) === -1) {
      status = calcStatus(temp, hum);
    }

    this._onEnv(data.nodeId, temp, hum, status, data.time);
    this._refresh();
  },

  /** 状态机：完全由 MQTT 新数据驱动 */
  _onEnv(nodeId, temperature, humidity, status, timeStr) {
    const s = this._state[nodeId];
    const stamp = (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timeStr || ''))
      ? timeStr : nowStamp();

    s.temperature = temperature;
    s.humidity = humidity;
    s.status = status;
    s.lastUpdate = Date.now();

    if (status === '正常') {
      if (s.episode) {
        this._archive(nodeId, s, stamp);
        s.episode = null;
      }
      s.phase = 'recovered';
      s.verifyData = [];
      return;
    }

    if (!s.episode) {
      s.episode = {
        startTs: Date.now(), startTime: stamp, type: status,
        fanActionTime: null, priorityReason: '—'
      };
      s.anomalyCount += 1;
      s.phase = 'open';
      s.verifyData = [];
    } else {
      s.episode.type = status;
      if (s.phase !== 'handling') s.phase = 'open';
    }

    // 处理中持续记录后续验证数据（D3 要求）
    if (s.phase === 'handling') {
      s.verifyData.push(temperature.toFixed(1) + '℃/' + humidity.toFixed(1) + '% ' + status);
      if (s.verifyData.length > 3) s.verifyData.shift();
    }
  },

  /** 事件归档到本地历史记录 */
  _archive(nodeId, s, recoverTime) {
    const ep = s.episode;
    const events = wx.getStorageSync('dorm_events') || [];
    events.push({
      event_id: 'evt-' + nodeId + '-' + (events.length + 1),
      nodeId: nodeId,
      startTime: ep.startTime,
      type: ep.type,
      priorityReason: ep.priorityReason || '—',
      userAction: ep.fanActionTime ? ('开启风扇 ' + ep.fanActionTime) : '无',
      verifyData: s.verifyData.length ? s.verifyData.join('；') : '—',
      status: 'RECOVERED',
      recoverTime: recoverTime
    });
    wx.setStorageSync('dorm_events', events);
    this._loadRecentEvents();
  },

  _loadRecentEvents() {
    const events = wx.getStorageSync('dorm_events') || [];
    this.setData({ recentEvents: events.slice(-3).reverse() });
  },

  /* ---------------- 优先级与渲染 ---------------- */

  /** 时长优先，时长相同比异常次数 */
  _ranked() {
    const items = [];
    NODES.forEach((id) => {
      const s = this._state[id];
      if (!s.episode) return;
      items.push({
        id: id,
        label: NODE_LABEL[id],
        type: s.episode.type,
        durationSec: Math.floor((Date.now() - s.episode.startTs) / 1000),
        count: s.anomalyCount
      });
    });
    items.sort((a, b) => (b.durationSec !== a.durationSec)
      ? b.durationSec - a.durationSec
      : b.count - a.count);
    return items;
  },

  _refresh() {
    const ranked = this._ranked();

    let priorityText = '当前无异常宿舍';
    let priorityReason = '三个宿舍环境均正常';
    if (ranked.length) {
      const top = ranked[0];
      const tied = ranked.filter((o) => o.durationSec === top.durationSec).length > 1;
      priorityText = '当前优先关注：' + top.label + '（' + top.id + '）';
      priorityReason = '判断理由：异常持续 ' + fmtDuration(top.durationSec * 1000) +
        (tied ? '（并列最长）' : '（最长）') + '，异常 ' + top.count + ' 次' +
        (tied ? '（时长并列，取次数多者）' : '');
      // 回写到事件段，归档时作为"优先理由"
      this._state[top.id].episode.priorityReason = priorityReason;
    }

    const nodes = NODES.map((id) => {
      const s = this._state[id];
      const hasData = s.status !== '';
      let episodeText = '';
      if (s.episode) {
        episodeText = s.episode.type + ' 已持续 ' +
          fmtDuration(Date.now() - s.episode.startTs) +
          ' · 今日第 ' + s.anomalyCount + ' 次';
        if (s.phase === 'handling' && s.verifyData.length) {
          episodeText += ' · 已收到 ' + s.verifyData.length + ' 组验证数据';
        }
      }
      // 任务 D4：节点离线判定（只影响显示，不改变事件状态机）
      const offline = s.lastUpdate !== null && (Date.now() - s.lastUpdate) > OFFLINE_MS;
      return {
        id: id,
        label: NODE_LABEL[id],
        temperature: hasData ? s.temperature.toFixed(1) : '--',
        humidity: hasData ? s.humidity.toFixed(1) : '--',
        status: hasData ? s.status : '等待数据',
        statusClass: STATUS_CLASS[s.status] || '',
        phaseLabel: PHASE_LABEL[s.phase],
        phaseClass: PHASE_CLASS[s.phase],
        episodeText: episodeText,
        offline: offline,
        canFan: s.phase === 'open'
      };
    });

    this.setData({
      nodes: nodes,
      priorityText: priorityText,
      priorityReason: priorityReason
    });
  },

  /* ---------------- 交互 ---------------- */

  /**
   * 开启风扇：只把状态推进到 HANDLING。
   * 硬性约束——此处绝不把事件标记为 RECOVERED，恢复只能由后续 MQTT 数据触发。
   */
  onFan(e) {
    const nodeId = e.currentTarget.dataset.node;
    const s = this._state[nodeId];

    if (!s.episode || s.phase !== 'open') {
      wx.showToast({ title: '当前状态不可开启风扇', icon: 'none' });
      return;
    }

    s.phase = 'handling';
    s.episode.fanActionTime = nowTime();
    s.verifyData = [];

    if (this._client && this._client.isConnected()) {
      this._client.publish('dormmate/' + nodeId + '/fan',
        JSON.stringify({ nodeId: nodeId, command: 'on', time: nowStamp() }));
    } else {
      wx.showToast({ title: 'MQTT 未连接，命令未发送', icon: 'none' });
    }

    wx.showToast({ title: '处理中，风扇已开启', icon: 'none' });
    this._refresh();
  },

  toggleManual() {
    this.setData({ manualOpen: !this.data.manualOpen });
  },

  /* ---------------- M4 手动分析（原逻辑保留）---------------- */

  onTempInput(e) { this.setData({ temperature: e.detail.value }); },
  onHumidInput(e) { this.setData({ humidity: e.detail.value }); },

  analyzeEnvironment() {
    const tempVal = this.data.temperature;
    const humidVal = this.data.humidity;

    if (tempVal === '' || humidVal === '') {
      wx.showToast({ title: '不能为空', icon: 'none' });
      return;
    }

    const temp = Number(tempVal);
    const humid = Number(humidVal);

    if (isNaN(temp) || isNaN(humid)) {
      wx.showToast({ title: '请输入数字', icon: 'none' });
      return;
    }

    let status = '正常';
    let advice = '环境舒适';
    if (temp < 18) {
      status = '偏冷'; advice = '建议开启暖气';
    } else if (temp >= 30) {
      status = '偏热'; advice = '建议开启空调';
    } else if (humid >= 75) {
      status = '偏湿'; advice = '建议开启除湿机';
    }

    this.setData({ manualStatus: status, manualAdvice: advice });
  }
});
