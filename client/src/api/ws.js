/**
 * WebSocket 信令封装：连接、心跳、消息回调注册、断线通知。
 * 注意：断线后不自动重连房间（需用户手动重新加入），但 WS 本身会尝试重连以接收全局广播。
 */

const HEARTBEAT_INTERVAL = 30000;

class SignalClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this._callbacks = new Set();
    this._onStatus = null;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._manualClose = false;
  }

  /** 建立连接（幂等） */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;

    this._manualClose = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this._onStatus?.(true);
      this._startHeartbeat();
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      for (const cb of this._callbacks) {
        try {
          cb(msg.type, msg.payload);
        } catch (err) {
          console.error('[ws] 回调错误:', err);
        }
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this._stopHeartbeat();
      this._onStatus?.(false);
      if (!this._manualClose) {
        this._reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  /** 手动关闭（离开房间页时调用，不再自动重连） */
  close() {
    this._manualClose = true;
    clearTimeout(this._reconnectTimer);
    this._stopHeartbeat();
    this._callbacks.clear();
    this._onStatus = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  send(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
      return true;
    }
    return false;
  }

  onMessage(cb) {
    this._callbacks.add(cb);
  }

  offMessage(cb) {
    this._callbacks.delete(cb);
  }

  onStatusChange(cb) {
    this._onStatus = cb;
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      this.send('ping', { t: Date.now() });
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }
}

/** 单例 */
export const signal = new SignalClient();
