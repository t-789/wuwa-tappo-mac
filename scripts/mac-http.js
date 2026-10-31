(() => {
  'use strict';
  if (!window || window.__WUWATAPPO_HTTP_ADAPTER__) return;

  // The WKWebView network process can leave a cross-origin XHR with custom headers
  // unsettled forever, which latches the app's one-way request lock (see
  // .work/http-hang-diagnosis.md). This adapter moves the transport into the Rust
  // process, where no preflight exists at all; axios keeps its interceptors, its
  // envelope parsing and its error semantics on top of the bytes handed back here.
  const DEFAULT_TIMEOUT = 15e3;
  const WATCHDOG_GRACE = 5e3;
  const STATUS_TEXT = {
    200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content',
    301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    405: 'Method Not Allowed', 409: 'Conflict', 412: 'Precondition Failed',
    415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
  };
  const viewId = Math.random().toString(36).slice(2);
  let nextId = 0;
  let ready = null;
  let warned = false;

  function nativeCore() {
    const read = () => window.__TAURI__?.core;
    if (read()?.Channel && read()?.invoke) return Promise.resolve(read());
    if (document.readyState !== 'loading') return Promise.reject(new Error('Native HTTP bridge is unavailable'));
    return new Promise((resolve, reject) => document.addEventListener('DOMContentLoaded', () => {
      const core = read();
      if (core?.Channel && core?.invoke) resolve(core);
      else reject(new Error('Native HTTP bridge is unavailable'));
    }, { once: true }));
  }

  // The axios request interceptor prepends baseURL without a separator
  // (this.baseConfig.adapter && (t.url = (this.baseConfig.baseURL || '') + t.url)),
  // so "...kurogames-global.com" + "api/common/activity-config?" arrives as one
  // malformed authority. Relative paths and leading-slash paths (userLogout) must
  // both land on the same origin, and a lone trailing "?" is dropped.
  function resolveUrl(value, baseURL) {
    let url = typeof value === 'string' ? value.trim() : '';
    const base = typeof baseURL === 'string' ? baseURL.trim().replace(/\/+$/, '') : '';
    if (base && url.startsWith(base)) {
      const rest = url.slice(base.length);
      if (!rest.startsWith('/')) url = rest ? base + '/' + rest : base + '/';
    } else if (base && !/^[a-z][a-z0-9+.-]*:/i.test(url)) {
      url = base + '/' + url.replace(/^\/+/, '');
    }
    if (!/^https:\/\/[^/?#\s]+/i.test(url)) throw new Error('Native HTTP bridge only allows absolute https URLs');
    return url.replace(/\?$/, '');
  }

  function queryString(params) {
    if (!params || typeof params !== 'object') return '';
    const pairs = [];
    for (const key of Object.keys(params)) {
      const value = params[key];
      if (value === undefined || value === null) continue;
      const name = encodeURIComponent(key);
      for (const item of Array.isArray(value) ? value : [value]) pairs.push(name + '=' + encodeURIComponent(String(item)));
    }
    return pairs.join('&');
  }

  function headerList(headers) {
    if (!headers) return [];
    const plain = typeof headers.toJSON === 'function' ? headers.toJSON() : headers;
    const list = [];
    for (const key of Object.keys(plain)) {
      const value = plain[key];
      if (value === undefined || value === null || value === false) continue;
      const text = Array.isArray(value) ? value.join(', ') : String(value);
      if (text) list.push([String(key).toLowerCase(), text]);
    }
    return list;
  }

  function bodyOf(data) {
    if (data === undefined || data === null) return null;
    if (typeof data === 'string') return data;
    if (typeof URLSearchParams !== 'undefined' && data instanceof URLSearchParams) return data.toString();
    if (typeof Blob !== 'undefined' && data instanceof Blob) throw new Error('Native HTTP bridge does not support binary request bodies');
    if (typeof ArrayBuffer !== 'undefined' && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) throw new Error('Native HTTP bridge does not support binary request bodies');
    try { return JSON.stringify(data) } catch { return String(data) }
  }

  function decode(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function concatChunks(chunks) {
    const parts = chunks.map(decode);
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length }
    return new TextDecoder().decode(bytes);
  }

  function adapter(config) {
    return new Promise((resolve, reject) => {
      const requestConfig = config || {};
      let url;
      try {
        url = resolveUrl(requestConfig.url, requestConfig.baseURL);
        const query = queryString(requestConfig.params);
        if (query) url += (url.includes('?') ? '&' : '?') + query;
      } catch (error) {
        reject(error);
        return;
      }
      const method = String(requestConfig.method || 'get').toUpperCase();
      let body;
      try { body = bodyOf(requestConfig.data) } catch (error) { reject(error); return }
      const timeout = Number(requestConfig.timeout) > 0 ? Number(requestConfig.timeout) : DEFAULT_TIMEOUT;
      const signal = requestConfig.signal;
      const id = 'http-' + viewId + '-' + (++nextId);
      const handle = Object.freeze({ id, method, url });
      const chunks = [];
      let headers = {};
      let status = 0;
      let channel = null;
      let settled = false;
      let timer = 0;

      function failure(message, code, response) {
        const error = new Error(message);
        error.config = requestConfig;
        error.code = code;
        error.isAxiosError = true;
        error.request = handle;
        if (response) error.response = response;
        return error;
      }

      function cancelError() {
        const error = failure('canceled', 'ERR_CANCELED');
        error.__CANCEL__ = true;
        error.name = 'CanceledError';
        return error;
      }

      function abortNative() {
        const core = ready;
        if (core) core.invoke('native_http_abort', { id }).catch(() => {});
      }

      function finish(settle) {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = 0 }
        if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
        const current = channel;
        channel = null;
        if (current) { try { current.cleanupCallback?.() } catch {} }
        settle();
      }

      function onAbort() {
        if (settled) return;
        abortNative();
        finish(() => reject(cancelError()));
      }

      // Mirrors axios' own settle(): a response is handed to the success interceptor
      // unless validateStatus rejects it, and a rejected status keeps its full
      // response attached so the app's r===401 / r>=500 branches still see status,
      // headers and envelope. A transport failure is never disguised as one of these.
      function accepted(response) {
        if (!response.status) return true;
        const validate = requestConfig.validateStatus;
        return typeof validate === 'function' ? Boolean(validate(response.status)) : response.status >= 200 && response.status < 300;
      }

      function complete() {
        const response = {
          data: concatChunks(chunks),
          status,
          statusText: STATUS_TEXT[status] ?? '',
          headers,
          config: requestConfig,
          request: handle,
        };
        if (accepted(response)) {
          finish(() => resolve(response));
          return;
        }
        const code = status >= 400 && status < 500 ? 'ERR_BAD_REQUEST' : 'ERR_BAD_RESPONSE';
        finish(() => reject(failure('Request failed with status code ' + status, code, response)));
      }

      function receive(event) {
        if (settled || !event) return;
        if (event.type === 'head') {
          status = Number(event.status) || 0;
          headers = {};
          for (const pair of event.headers ?? []) {
            if (Array.isArray(pair) && pair.length === 2) headers[String(pair[0]).toLowerCase()] = String(pair[1]);
          }
        } else if (event.type === 'chunk') {
          chunks.push(String(event.data ?? ''));
        } else if (event.type === 'done') {
          complete();
        } else if (event.type === 'error') {
          const kind = String(event.kind ?? '');
          finish(() => reject(kind === 'timeout'
            ? failure('timeout of ' + timeout + 'ms exceeded', 'ETIMEDOUT')
            : failure(typeof event.message === 'string' && event.message ? event.message : 'Network Error', 'ERR_NETWORK')));
        }
      }

      if (signal?.aborted) {
        reject(cancelError());
        return;
      }
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort);

      timer = setTimeout(() => {
        if (settled) return;
        abortNative();
        finish(() => reject(failure('timeout of ' + timeout + 'ms exceeded', 'ETIMEDOUT')));
      }, timeout + WATCHDOG_GRACE);

      (ready ? Promise.resolve(ready) : nativeCore()).then(core => {
        ready = core;
        if (settled) return;
        channel = new core.Channel(receive);
        return core.invoke('native_http_request', {
          id,
          spec: {
            method,
            url,
            headers: headerList(requestConfig.headers),
            body,
            timeoutMs: timeout,
          },
          events: channel,
        }).catch(error => {
          // The command rejects its allow-lists by name ("HTTP header is not allowed: …"),
          // which is the only way a rejection reason reaches the app log.
          const message = typeof error === 'string' && error ? error : 'Network Error';
          if (!warned) {
            warned = true;
            console.warn('[macOS] Native HTTP bridge rejected the request:', message);
          }
          finish(() => reject(failure(message, 'ERR_NETWORK')));
        });
      }).catch(() => {
        if (!warned) {
          warned = true;
          console.warn('[macOS] Native HTTP bridge is unavailable');
        }
        finish(() => reject(failure('Network Error', 'ERR_NETWORK')));
      });
    });
  }

  Object.defineProperty(window, '__WUWATAPPO_HTTP_ADAPTER__', { value: adapter, writable: false, configurable: false });
})();
