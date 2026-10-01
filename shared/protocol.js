/**
 * DormMate 统一消息协议与数据校验 —— 单一来源
 *
 * 本文件被四端共用，任何一端都不得再实现自己的校验规则：
 *   - dashboard/index.html     <script src="../shared/protocol.js">
 *   - 3d/index.html            <script src="../shared/protocol.js">
 *   - e2/index.html            <script src="../shared/protocol.js">
 *   - miniapp/utils/protocol.js   ← 与本文件逐字节相同的副本（UMD 兼容 CommonJS）
 *
 * 之所以在 miniapp 下也放一份：微信小程序只能用相对 require，且不能引用
 * miniprogramRoot 之外的路径。两份文件必须保持逐字节一致，
 * 验收脚本会做字节比对，一旦漂移立即报错。
 *
 * 统一消息协议（schemaVersion = 2）：
 *   { schemaVersion, nodeId, temperature, humidity, status, time, seq }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();          // 微信小程序 / Node
  } else {
    root.DormMateProtocol = factory();   // 浏览器 <script>
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SCHEMA_VERSION = 2;

  var NODES = ['dorm-a', 'dorm-b', 'dorm-c'];

  var VALID_STATUS = ['正常', '偏冷', '偏热', '偏湿'];

  /* 物理合理区间：超出即视为不可信数据，统一丢弃。
     区间取得很宽，只挡明显荒谬的值（例如 200℃、湿度 -5%），
     正常演示数据（含场景注入）不会落到区间外。 */
  var TEMP_RANGE = [-20, 60];
  var HUMID_RANGE = [0, 100];

  var KIND = {
    ENV: 'env',
    FAN: 'fan',
    SIM: 'sim',
    FOCUS: 'focus',
    UNKNOWN: 'unknown'
  };

  /* 消息校验失败的原因码，便于调用方分类记日志 */
  var CODE = {
    TOPIC: 'topic',
    UNKNOWN_NODE: 'unknown-node',
    JSON: 'json',
    BAD_NODE_ID: 'bad-nodeid',
    MISMATCH: 'mismatch',
    BAD_VALUES: 'bad-values',
    BAD_COMMAND: 'bad-command'
  };

  var STAMP_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

  function isNode(nodeId) {
    return NODES.indexOf(nodeId) !== -1;
  }

  /** 数字或数字字符串 → 有限数字；否则返回 null */
  function toFiniteNumber(value) {
    if (typeof value === 'number') {
      return isFinite(value) ? value : null;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      var n = Number(value);
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /** 固定阈值规则：温度优先。全项目唯一实现。 */
  function calcStatus(temperature, humidity) {
    if (temperature < 18) return '偏冷';
    if (temperature >= 30) return '偏热';
    if (humidity >= 75) return '偏湿';
    return '正常';
  }

  /**
   * Topic 分类：只有这里认识 Topic 的形状。
   *   dormmate/<nodeId>/env | fan | sim   →  env / fan / sim
   *   dormmate/focus                      →  focus
   *   其他                                 →  unknown（调用方记为 fault）
   */
  function classifyTopic(topic) {
    if (topic === 'dormmate/focus') {
      return { kind: KIND.FOCUS };
    }
    var parts = String(topic).split('/');
    if (parts.length !== 3 || parts[0] !== 'dormmate') {
      return { kind: KIND.UNKNOWN, reason: 'Topic 层级或前缀不匹配' };
    }
    if (parts[2] === KIND.ENV || parts[2] === KIND.FAN || parts[2] === KIND.SIM) {
      return { kind: parts[2], nodeId: parts[1] };
    }
    return { kind: KIND.UNKNOWN, reason: '未知的子主题 ' + parts[2] };
  }

  function parseJsonObject(text) {
    var data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return { ok: false, reason: '不是合法 JSON' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'JSON 顶层不是对象' };
    }
    return { ok: true, data: data };
  }

  /** 温湿度统一校验：必须是有限数字且落在物理合理区间内 */
  function validateReading(temperature, humidity) {
    var t = toFiniteNumber(temperature);
    var h = toFiniteNumber(humidity);
    if (t === null) {
      return { ok: false, reason: 'temperature 不是有限数字' };
    }
    if (h === null) {
      return { ok: false, reason: 'humidity 不是有限数字' };
    }
    if (t < TEMP_RANGE[0] || t > TEMP_RANGE[1]) {
      return {
        ok: false,
        reason: 'temperature ' + t + ' 超出合理区间 [' +
          TEMP_RANGE[0] + ', ' + TEMP_RANGE[1] + ']'
      };
    }
    if (h < HUMID_RANGE[0] || h > HUMID_RANGE[1]) {
      return {
        ok: false,
        reason: 'humidity ' + h + ' 超出合理区间 [' +
          HUMID_RANGE[0] + ', ' + HUMID_RANGE[1] + ']'
      };
    }
    return { ok: true, temperature: t, humidity: h };
  }

  /** 时间戳格式校验，不合法时由调用方用本地时间兜底 */
  function isValidStamp(time) {
    return typeof time === 'string' && STAMP_RE.test(time);
  }

  /**
   * 校验一条 env 消息（Topic + payload 一起看）。
   * 返回 { ok:true, data } 或 { ok:false, code, message }
   *
   * data.statusValid === false 表示 status 缺失或非法，
   * 调用方应按 D 模块的容错要求用 calcStatus 兜底重算。
   */
  function validateEnvMessage(topic, payloadText) {
    var cls = classifyTopic(topic);
    if (cls.kind !== KIND.ENV) {
      return { ok: false, code: CODE.TOPIC, message: '不是 env Topic：' + topic };
    }
    if (!isNode(cls.nodeId)) {
      return {
        ok: false, code: CODE.UNKNOWN_NODE,
        message: '未知节点：' + cls.nodeId
      };
    }

    var parsed = parseJsonObject(payloadText);
    if (!parsed.ok) {
      return { ok: false, code: CODE.JSON, message: parsed.reason };
    }
    var data = parsed.data;

    if (!isNode(data.nodeId)) {
      return {
        ok: false, code: CODE.BAD_NODE_ID,
        message: 'nodeId 非法：' + String(data.nodeId)
      };
    }
    if (data.nodeId !== cls.nodeId) {
      return {
        ok: false, code: CODE.MISMATCH,
        message: 'Topic 与 nodeId 不一致：' + cls.nodeId + ' / ' + data.nodeId
      };
    }

    var reading = validateReading(data.temperature, data.humidity);
    if (!reading.ok) {
      return { ok: false, code: CODE.BAD_VALUES, message: reading.reason };
    }

    var statusValid = VALID_STATUS.indexOf(data.status) !== -1;

    return {
      ok: true,
      data: {
        schemaVersion: toFiniteNumber(data.schemaVersion),
        nodeId: data.nodeId,
        temperature: reading.temperature,
        humidity: reading.humidity,
        status: statusValid ? data.status : null,
        statusValid: statusValid,
        time: isValidStamp(data.time) ? data.time : null,
        seq: toFiniteNumber(data.seq)
      }
    };
  }

  /**
   * 校验一条控制消息（fan / sim / focus）。
   * 返回 { ok:true, data } 或 { ok:false, code, message }
   */
  function validateControlMessage(topic, payloadText) {
    var cls = classifyTopic(topic);
    if (cls.kind === KIND.UNKNOWN) {
      return { ok: false, code: CODE.TOPIC, message: cls.reason };
    }
    if ((cls.kind === KIND.FAN || cls.kind === KIND.SIM) && !isNode(cls.nodeId)) {
      return {
        ok: false, code: CODE.UNKNOWN_NODE,
        message: '未知节点：' + cls.nodeId
      };
    }

    var parsed = parseJsonObject(payloadText);
    if (!parsed.ok) {
      return { ok: false, code: CODE.JSON, message: parsed.reason };
    }
    var data = parsed.data;

    if (cls.kind === KIND.FOCUS) {
      if (!isNode(data.nodeId)) {
        return {
          ok: false, code: CODE.BAD_NODE_ID,
          message: 'focus 的 nodeId 非法：' + String(data.nodeId)
        };
      }
      return { ok: true, kind: cls.kind, data: data };
    }

    if (data.nodeId !== undefined && !isNode(data.nodeId)) {
      return {
        ok: false, code: CODE.BAD_NODE_ID,
        message: 'nodeId 非法：' + String(data.nodeId)
      };
    }
    if (data.nodeId !== undefined && data.nodeId !== cls.nodeId) {
      return {
        ok: false, code: CODE.MISMATCH,
        message: 'Topic 与 nodeId 不一致：' + cls.nodeId + ' / ' + data.nodeId
      };
    }

    if (cls.kind === KIND.FAN) {
      if (data.command !== 'on') {
        return {
          ok: false, code: CODE.BAD_COMMAND,
          message: '未知风扇指令：' + String(data.command)
        };
      }
    }

    if (cls.kind === KIND.SIM) {
      var simReading = validateReading(data.temperature, data.humidity);
      if (!simReading.ok) {
        return { ok: false, code: CODE.BAD_VALUES, message: simReading.reason };
      }
      data.temperature = simReading.temperature;
      data.humidity = simReading.humidity;
    }

    return { ok: true, kind: cls.kind, data: data };
  }

  /**
   * 旧消息判定：seq 比已记录的更小 → 说明这条是过期消息，直接丢弃。
   * 任一侧没有 seq（例如早期版本的消息）时不判定，保持向后兼容。
   */
  function isStaleSeq(lastSeq, seq) {
    if (seq === null || seq === undefined) return false;
    if (lastSeq === null || lastSeq === undefined) return false;
    return seq < lastSeq;
  }

  /** 本端发布消息时用的单调序号（毫秒时间戳，跨进程重启仍然递增） */
  function nextSeq() {
    return Date.now();
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    NODES: NODES,
    VALID_STATUS: VALID_STATUS,
    TEMP_RANGE: TEMP_RANGE,
    HUMID_RANGE: HUMID_RANGE,
    KIND: KIND,
    CODE: CODE,
    isNode: isNode,
    toFiniteNumber: toFiniteNumber,
    calcStatus: calcStatus,
    classifyTopic: classifyTopic,
    parseJsonObject: parseJsonObject,
    validateReading: validateReading,
    isValidStamp: isValidStamp,
    validateEnvMessage: validateEnvMessage,
    validateControlMessage: validateControlMessage,
    isStaleSeq: isStaleSeq,
    nextSeq: nextSeq
  };
}));
