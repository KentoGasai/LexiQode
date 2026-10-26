'use strict';

/**
 * Talking to the core over its documented HTTP API.
 *
 * All sidecar traffic goes through the main process rather than from the
 * window. That keeps the bearer token and the model key out of the renderer
 * entirely, removes any need for the window to be allowed to make network
 * requests, and means a reloaded window reconnects through one place.
 *
 * The event stream is a plain `fetch` body reader rather than an EventSource,
 * because the token has to travel in a header-like way and a half-read response
 * has to be abandonable when the window closes or the core restarts.
 */

class CoreRequestError extends Error {
  constructor(message, { status = 0, path = '' } = {}) {
    super(message);
    this.name = 'CoreRequestError';
    this.status = status;
    this.path = path;
  }
}

/** Split a stream of SSE frames without losing a frame across two chunks. */
function parseFrames(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const split = rest.indexOf('\n\n');
    if (split === -1) break;
    const frame = rest.slice(0, split);
    rest = rest.slice(split + 2);
    let type = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue; // heartbeat
      if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    try {
      events.push({ type, data: JSON.parse(data) });
    } catch {
      // A frame we cannot read is dropped rather than thrown: one bad event
      // must not end the stream that carries every other one.
    }
  }
  return { events, rest };
}

class CoreClient {
  constructor({ baseUrl, token }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.token = token;
    this.controller = null;
  }

  url(path) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request(method, path, body) {
    let response;
    try {
      response = await fetch(this.url(path), {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new CoreRequestError(`the core is not reachable: ${error.message}`, { path });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { error: text.slice(0, 400) };
      }
    }
    if (!response.ok) {
      const message = (payload && (payload.error || payload.message)) || `HTTP ${response.status}`;
      throw new CoreRequestError(message, { status: response.status, path });
    }
    // The core reports a refusal either way: some problems are a status code
    // and some are a 200 carrying `ok: false`. Normalising here means the window
    // only ever has one shape to handle - a thrown Error with a usable message -
    // instead of having to check both.
    if (payload && payload.ok === false) {
      throw new CoreRequestError(payload.error || payload.message || 'the core refused that request', {
        status: response.status,
        path
      });
    }
    return payload;
  }

  get(path) {
    return this.request('GET', path);
  }

  post(path, body) {
    return this.request('POST', path, body ?? {});
  }

  /**
   * Follow `/api/events` until stopped.
   *
   * `onEvent` is called per parsed frame; `onEnd` is called once, with the
   * reason, so the caller can decide whether to reconnect, show an error or
   * leave the panel quiet.
   */
  async stream({ onEvent, onEnd, signal }) {
    this.controller = new AbortController();
    const abort = () => this.controller.abort();
    signal?.addEventListener('abort', abort, { once: true });

    try {
      const response = await fetch(this.url(`/api/events?token=${encodeURIComponent(this.token)}`), {
        headers: { accept: 'text/event-stream' },
        signal: this.controller.signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`event stream refused with HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseFrames(buffer);
        buffer = rest;
        for (const event of events) onEvent(event);
      }
      onEnd?.({ reason: 'closed' });
    } catch (error) {
      const aborted = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      onEnd?.({ reason: aborted ? 'aborted' : 'failed', message: error?.message || String(error) });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.controller = null;
    }
  }

  close() {
    try {
      this.controller?.abort();
    } catch {
      // Nothing to close.
    }
  }
}

module.exports = { CoreClient, CoreRequestError, parseFrames };