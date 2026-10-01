/**
 * 轻量 MQTT over WebSocket 客户端（任务 D）
 *
 * 为什么不直接用现成的 mqtt.js：
 *   本项目的小程序工程没有 package.json / node_modules，走 npm + "构建 npm" 会引入
 *   额外构建步骤；微信小程序也没有浏览器/Node 的全局 WebSocket 对象，需要 wx.connectSocket。
 *   这里只实现本项目用得到的报文（CONNECT / SUBSCRIBE / PUBLISH / PING / DISCONNECT，
 *   收发都是 QoS 0），代码不含任何微信 SDK 特有依赖，socket 层通过环境自动适配，
 *   因此同一份代码既能在小程序里跑，也能在 Node 里用内置 WebSocket 做验证。
 *
 * 用法：
 *   const mqtt = require('../../utils/mqtt.js');
 *   const client = mqtt.connect('ws://127.0.0.1:8083/mqtt', { clientId: 'dormmate-miniapp' });
 *   client.on('connect', () => client.subscribe('dormmate/#'));
 *   client.on('message', (topic, payload) => { ... });
 *   client.publish('dormmate/dorm-a/fan', JSON.stringify({...}));
 */
'use strict';

/* ============================================================
   一、字节工具（手写 UTF-8，避免依赖 TextEncoder，小程序基础库不保证有）
   ============================================================ */

function utf8Encode(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(++i);
      var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes) {
  var str = '';
  for (var i = 0; i < bytes.length;) {
    var b = bytes[i++];
    if (b < 0x80) {
      str += String.fromCharCode(b);
    } else if (b < 0xe0) {
      str += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b < 0xf0) {
      str += String.fromCharCode(((b & 0x0f) << 12) |
        ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      var cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) |
               ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      cp -= 0x10000;
      str += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return str;
}

function toUint8(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  if (typeof data === 'string') return utf8Encode(data);
  return new Uint8Array(data);
}

function concat(arrays) {
  var total = 0;
  for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
  var out = new Uint8Array(total);
  var pos = 0;
  for (var j = 0; j < arrays.length; j++) {
    out.set(arrays[j], pos);
    pos += arrays[j].length;
  }
  return out;
}

/** MQTT 剩余长度：每字节 7 位，最高位表示后续还有字节 */
function encodeRemainingLength(len) {
  var bytes = [];
  do {
    var digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    bytes.push(digit);
  } while (len > 0);
  return new Uint8Array(bytes);
}

/** 返回 { value, bytes }；数据不完整时返回 null */
function decodeRemainingLength(buf, offset) {
  var multiplier = 1;
  var value = 0;
  var bytes = 0;
  var pos = offset;
  while (pos < buf.length) {
    var digit = buf[pos++];
    bytes++;
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) return { value: value, bytes: bytes };
    multiplier *= 128;
    if (bytes > 4) return null;
  }
  return null;   // 长度字段还没收全
}

/** MQTT 字符串：2 字节大端长度 + UTF-8 内容 */
function encodeString(str) {
  var body = utf8Encode(str);
  var out = new Uint8Array(body.length + 2);
  out[0] = (body.length >> 8) & 0xff;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function buildPacket(headerByte, payload) {
  return concat([new Uint8Array([headerByte]), encodeRemainingLength(payload.length), payload]);
}

/* ============================================================
   二、socket 适配层：小程序用 wx.connectSocket，Node/浏览器用内置 WebSocket
   ============================================================ */

function createSocket(url) {
  if (typeof wx !== 'undefined' && typeof wx.connectSocket === 'function') {
    var task = wx.connectSocket({ url: url, protocols: ['mqtt'] });
    return {
      isWx: true,
      send: function (bytes) { task.send({ data: bytes.buffer }); },
      close: function () { try { task.close({}); } catch (e) { /* 已关闭 */ } },
      onOpen: function (cb) { task.onOpen(function () { cb(); }); },
      onMessage: function (cb) {
        task.onMessage(function (res) { cb(toUint8(res.data)); });
      },
      onClose: function (cb) { task.onClose(function () { cb(); }); },
      onError: function (cb) { task.onError(function (err) { cb(err); }); }
    };
  }

  if (typeof WebSocket !== 'undefined') {
    var ws = new WebSocket(url, 'mqtt');
    ws.binaryType = 'arraybuffer';
    return {
      isWx: false,
      send: function (bytes) { ws.send(bytes); },
      close: function () { try { ws.close(); } catch (e) { /* 已关闭 */ } },
      onOpen: function (cb) { ws.onopen = function () { cb(); }; },
      onMessage: function (cb) {
        ws.onmessage = function (ev) { cb(toUint8(ev.data)); };
      },
      onClose: function (cb) { ws.onclose = function () { cb(); }; },
      onError: function (cb) { ws.onerror = function (ev) { cb(ev); }; }
    };
  }

  throw new Error('当前环境没有可用的 WebSocket（小程序需 2.6.0+ 基础库）');
}

/* ============================================================
   三、MQTT 客户端
   ============================================================ */

var PACKET = {
  CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4,
  SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14
};

function Client(url, options) {
  options = options || {};
  this.url = url;
  this.clientId = options.clientId ||
    ('dormmate-' + Math.random().toString(16).slice(2, 10));
  this.keepalive = options.keepalive || 60;
  this.reconnectPeriod = options.reconnectPeriod === undefined ? 2000 : options.reconnectPeriod;

  this._handlers = {};
  this._buffer = new Uint8Array(0);
  this._socket = null;
  this._packetId = 0;
  this._subscriptions = [];
  this._pingTimer = null;
  this._reconnectTimer = null;
  this._connected = false;
  this._closedByUser = false;
}

Client.prototype.on = function (event, handler) {
  (this._handlers[event] = this._handlers[event] || []).push(handler);
  return this;
};

Client.prototype._emit = function (event) {
  var args = Array.prototype.slice.call(arguments, 1);
  var list = this._handlers[event] || [];
  for (var i = 0; i < list.length; i++) {
    try {
      list[i].apply(null, args);
    } catch (err) {
      this._emit('error', err);
    }
  }
};

Client.prototype.connect = function () {
  var self = this;
  this._closedByUser = false;
  this._buffer = new Uint8Array(0);

  try {
    this._socket = createSocket(this.url);
  } catch (err) {
    this._emit('error', err);
    this._scheduleReconnect();
    return this;
  }

  this._socket.onOpen(function () {
    self._sendConnect();
  });

  this._socket.onMessage(function (bytes) {
    self._onData(bytes);
  });

  this._socket.onClose(function () {
    self._connected = false;
    self._stopPing();
    self._emit('close');
    if (!self._closedByUser) self._scheduleReconnect();
  });

  this._socket.onError(function (err) {
    // 主动 end() 时底层 WebSocket 也会抛一次 error，这不算异常
    if (self._closedByUser) return;
    self._emit('error', err);
  });

  return this;
};

Client.prototype._sendConnect = function () {
  var variable = concat([
    encodeString('MQTT'),                    // 协议名
    new Uint8Array([0x04]),                  // 协议级别 4 = MQTT 3.1.1
    new Uint8Array([0x02]),                  // 连接标志：clean session
    new Uint8Array([(this.keepalive >> 8) & 0xff, this.keepalive & 0xff])
  ]);
  var payload = concat([encodeString(this.clientId)]);
  this._socket.send(buildPacket(0x10, concat([variable, payload])));
};

Client.prototype.subscribe = function (filter) {
  if (this._subscriptions.indexOf(filter) === -1) {
    this._subscriptions.push(filter);
  }
  if (!this._connected) return this;         // 连上后会统一补订阅

  var packetId = ++this._packetId;
  var payload = concat([
    new Uint8Array([(packetId >> 8) & 0xff, packetId & 0xff]),
    encodeString(filter),
    new Uint8Array([0x00])                     // QoS 0
  ]);
  this._socket.send(buildPacket(0x82, payload));
  return this;
};

Client.prototype.publish = function (topic, message) {
  if (!this._connected) return false;
  var body = (typeof message === 'string') ? utf8Encode(message) : toUint8(message);
  this._socket.send(buildPacket(0x30, concat([encodeString(topic), body])));
  return true;
};

Client.prototype.end = function () {
  this._closedByUser = true;
  this._stopPing();
  if (this._reconnectTimer) {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
  }
  if (this._socket && this._connected) {
    this._socket.send(new Uint8Array([0xe0, 0x00]));   // DISCONNECT
  }
  if (this._socket) this._socket.close();
  this._connected = false;
  return this;
};

Client.prototype.isConnected = function () { return this._connected; };

/* ---------- 收包与解析 ---------- */

Client.prototype._onData = function (bytes) {
  this._buffer = concat([this._buffer, bytes]);
  this._parseBuffer();
};

Client.prototype._parseBuffer = function () {
  while (this._buffer.length >= 2) {
    var header = this._buffer[0];
    var rl = decodeRemainingLength(this._buffer, 1);
    if (!rl) return;                                   // 剩余长度还没收全
    var total = 1 + rl.bytes + rl.value;
    if (this._buffer.length < total) return;           // 报文还没收全

    var fixedHeaderLength = 1 + rl.bytes;
    var packet = this._buffer.subarray(0, total);
    this._buffer = this._buffer.subarray(total);
    this._handlePacket(header, packet, fixedHeaderLength);
  }
};

Client.prototype._handlePacket = function (header, packet, offset) {
  var type = (header >> 4) & 0x0f;

  if (type === PACKET.CONNACK) {
    var code = packet[offset + 1];
    if (code === 0) {
      this._connected = true;
      this._startPing();
      this._emit('connect');
      // 重连后补订阅（mqtt.js 也是这个行为）
      for (var i = 0; i < this._subscriptions.length; i++) {
        this.subscribe(this._subscriptions[i]);
      }
    } else {
      this._emit('error', new Error('CONNACK 返回码 ' + code));
    }
    return;
  }

  if (type === PACKET.PUBLISH) {
    var topicLen = (packet[offset] << 8) | packet[offset + 1];
    var topic = utf8Decode(packet.subarray(offset + 2, offset + 2 + topicLen));
    var pos = offset + 2 + topicLen;
    var qos = (header >> 1) & 0x03;
    if (qos > 0) pos += 2;                             // QoS>0 才有报文标识符
    var payload = packet.subarray(pos);
    this._emit('message', topic, utf8Decode(payload));
    return;
  }

  if (type === PACKET.SUBACK) {
    this._emit('suback', (packet[offset] << 8) | packet[offset + 1]);
    return;
  }

  if (type === PACKET.PINGRESP) {
    this._emit('pong');
  }
};

/* ---------- 心跳与重连 ---------- */

Client.prototype._startPing = function () {
  var self = this;
  this._stopPing();
  var interval = Math.max(5, Math.floor(this.keepalive / 2)) * 1000;
  this._pingTimer = setInterval(function () {
    if (self._connected && self._socket) {
      self._socket.send(new Uint8Array([0xc0, 0x00]));   // PINGREQ
    }
  }, interval);
};

Client.prototype._stopPing = function () {
  if (this._pingTimer) {
    clearInterval(this._pingTimer);
    this._pingTimer = null;
  }
};

Client.prototype._scheduleReconnect = function () {
  var self = this;
  if (this._closedByUser || this._reconnectTimer) return;
  this._emit('reconnect');
  this._reconnectTimer = setTimeout(function () {
    self._reconnectTimer = null;
    self.connect();
  }, this.reconnectPeriod);
};

/* ============================================================
   四、导出
   ============================================================ */

function connect(url, options) {
  return new Client(url, options).connect();
}

module.exports = {
  connect: connect,
  Client: Client,
  // 供测试使用
  _internal: {
    encodeRemainingLength: encodeRemainingLength,
    decodeRemainingLength: decodeRemainingLength,
    utf8Encode: utf8Encode,
    utf8Decode: utf8Decode,
    createSocket: createSocket
  }
};
