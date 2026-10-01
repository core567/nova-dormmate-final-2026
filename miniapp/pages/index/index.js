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
// 统一消息协议与数据校验（与 shared/protocol.js 逐字节相同的副本）
const P = require('../../utils/protocol.js');

const NODES = P.NODES;
const NODE_LABEL = { 'dorm-a': '宿舍 A', 'dorm-b': '宿舍 B', 'dorm-c': '宿舍 C' };
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

/** 固定阈值规则统一来自 utils/protocol.js（全项目唯一实现）。
 *  任务 E3：status 由后端 Publisher 统一计算，小程序正常路径直接使用后端值；
 *  此处仅在字段缺失/非法时兜底（保留 D 模块的容错验收）。 */
const calcStatus = P.calcStatus;

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
    hero: {
      id: '—', label: '等待数据', temperature: '--', humidity: '--',
      status: '等待数据', statusClass: '', phaseLabel: '正常', phaseClass: 'ph-normal',
      duration: '—', offline: false, isFocus: false, canFan: false,
      hasAnomaly: false, reason: '正在连接并等待数据…'
    },
    nodes: [],
    recentEvents: [],
    focusNode: '',          // 任务 E3：被设为重点的宿舍，会广播给 Web / 3D
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
        lastSeq: null,          // 最近一次收到的 seq，用于丢弃旧消息
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

  /** P1：统一消息路由 —— 校验规则全部来自 utils/protocol.js。
   *  合法的 fan / sim / focus 不再被当成"非法 env Topic"。 */
  _onMessage(topic, payload) {
    const cls = P.classifyTopic(topic);

    if (cls.kind === P.KIND.UNKNOWN) {
      console.warn('未知 Topic，已忽略', topic, cls.reason);
      return;
    }
    if (cls.kind !== P.KIND.ENV) {
      // 控制消息本页不消费（fan 由自己发出、focus 由自己发出、sim 由 Publisher 消费）
      console.info('控制消息（' + cls.kind + '）已按协议接受', topic);
      return;
    }

    const result = P.validateEnvMessage(topic, payload);
    if (!result.ok) {
      console.warn(result.message, topic);
      return;
    }
    const data = result.data;
    const s = this._state[data.nodeId];

    // P1：seq 更小说明是旧消息，直接丢弃，防止覆盖更新的状态
    if (P.isStaleSeq(s.lastSeq, data.seq)) {
      console.warn('旧消息已丢弃', data.nodeId, data.seq, '<', s.lastSeq);
      return;
    }
    if (data.seq !== null) s.lastSeq = data.seq;

    let status = data.status;
    if (!data.statusValid) {
      status = calcStatus(data.temperature, data.humidity);
      console.warn('status 缺失或非法，已按统一规则重算', data.nodeId, status);
    }

    this._onEnv(data.nodeId, data.temperature, data.humidity, status, data.time);
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
        s.phase = 'recovered';      // HANDLING/OPEN → 后续数据正常 → RECOVERED
      } else if (s.anomalyCount === 0) {
        s.phase = 'normal';         // 从未发生过异常，保持「正常」
      }
      // 已经恢复过则停留在「已恢复」，等下一次异常才转 OPEN
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

  /** P0-六：事件序号从本地已存事件里恢复，刷新页面后不从头编号 */
  _nextEventSeq(nodeId) {
    const events = wx.getStorageSync('dorm_events') || [];
    let max = 0;
    events.forEach((r) => {
      const m = /^evt-(.+)-(\d+)$/.exec(String(r.event_id || ''));
      if (m && m[1] === nodeId) {
        const n = parseInt(m[2], 10);
        if (n > max) max = n;
      }
    });
    return max + 1;
  },

  /** 事件归档到本地历史记录 */
  _archive(nodeId, s, recoverTime) {
    const ep = s.episode;
    const events = wx.getStorageSync('dorm_events') || [];
    events.push({
      event_id: 'evt-' + nodeId + '-' + pad(this._nextEventSeq(nodeId)),
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
        // 第四轮：异常持续时间单独成字段，供 hero 大字号展示
        duration: s.episode ? fmtDuration(Date.now() - s.episode.startTs) : '—',
        episodeText: episodeText,
        offline: offline,
        isFocus: this.data.focusNode === id,   // 任务 E3：重点宿舍标记
        canFan: s.phase === 'open'
      };
    });

    this.setData({
      nodes: nodes,
      priorityText: priorityText,
      priorityReason: priorityReason,
      hero: this._buildHero(nodes, ranked, priorityReason)
    });
  },

  /**
   * 当前重点宿舍卡片：优先展示手动设为重点的宿舍；
   * 没设重点时退回到优先关注的异常宿舍；都没有则展示第一个宿舍。
   */
  _buildHero(nodes, ranked, priorityReason) {
    const focusId = this.data.focusNode;
    let id = null;
    if (focusId && NODES.indexOf(focusId) !== -1) {
      id = focusId;
    } else if (ranked.length) {
      id = ranked[0].id;
    } else {
      id = NODES[0];
    }

    const n = nodes.filter((item) => item.id === id)[0] || nodes[0];
    const s = this._state[id];
    const isFocus = focusId === id;

    let reason;
    if (!n) {
      reason = '等待数据';
    } else if (s.episode) {
      reason = '异常中：' + s.episode.type + '，处置动作需在卡片内完成';
    } else if (isFocus) {
      reason = '已设为重点，切换时会同步广播给 Web Dashboard 与 3D 页面';
    } else {
      reason = priorityReason;
    }

    return {
      id: n ? n.id : '—',
      label: n ? n.label : '暂无数据',
      temperature: n ? n.temperature : '--',
      humidity: n ? n.humidity : '--',
      status: n ? n.status : '等待数据',
      statusClass: n ? n.statusClass : '',
      phaseLabel: n ? n.phaseLabel : '正常',
      phaseClass: n ? n.phaseClass : 'ph-normal',
      duration: n ? n.duration : '—',
      offline: n ? n.offline : false,
      isFocus: isFocus,
      canFan: n ? n.canFan : false,
      hasAnomaly: !!(s && (s.episode || n.offline)),
      reason: reason
    };
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

    // P0-五：未连接 / publish 返回 false 都不能进入 HANDLING，
    // 必须先确认命令真的发出去了，才把状态推到「处理中」。
    if (!this._client || !this._client.isConnected()) {
      wx.showToast({ title: 'MQTT 未连接，命令未发送', icon: 'none' });
      return;
    }

    const sent = this._client.publish('dormmate/' + nodeId + '/fan',
      JSON.stringify({
        schemaVersion: P.SCHEMA_VERSION,
        nodeId: nodeId,
        command: 'on',
        time: nowStamp(),
        seq: P.nextSeq()
      }));

    if (!sent) {
      wx.showToast({ title: '命令发送失败，状态保持待处理', icon: 'none' });
      return;
    }

    s.phase = 'handling';
    s.episode.fanActionTime = nowTime();
    s.verifyData = [];

    wx.showToast({ title: '处理中，风扇已开启', icon: 'none' });
    this._refresh();
  },

  /**
   * 任务 E3：把某个宿舍设为重点，并广播给 Web Dashboard 与 3D 页面。
   * 走 MQTT 的 dormmate/focus 主题，其他端订阅后同步切换选中节点。
   */
  onSetFocus(e) {
    const nodeId = e.currentTarget.dataset.node;
    if (NODES.indexOf(nodeId) === -1) return;

    // P0-五：只有广播真正发出去，才更新本地重点标记并提示成功
    if (!this._client || !this._client.isConnected()) {
      wx.showToast({ title: 'MQTT 未连接，未能广播', icon: 'none' });
      return;
    }

    const sent = this._client.publish('dormmate/focus', JSON.stringify({
      schemaVersion: P.SCHEMA_VERSION,
      nodeId: nodeId,
      source: 'miniapp',
      time: nowStamp(),
      seq: P.nextSeq()
    }));

    if (!sent) {
      wx.showToast({ title: '广播失败，重点未切换', icon: 'none' });
      return;
    }

    this.setData({ focusNode: nodeId });
    wx.showToast({ title: NODE_LABEL[nodeId] + ' 已设为重点', icon: 'none' });

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
