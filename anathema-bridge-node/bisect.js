'use strict';

// Thin client for the BisectHosting Starbase API.
// The key is account-wide, so keep it in config.json and never log it.

const DEFAULT_BASE_URL = 'https://games.bisecthosting.com';

class BisectError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BisectError';
    this.status = status;
  }
}

class BisectApi {
  constructor({ apiKey, serverId, baseUrl = DEFAULT_BASE_URL, timeoutMs = 15000 }) {
    this.apiKey = apiKey || '';
    this.serverId = serverId || '';
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.apiKey && this.serverId);
  }

  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        throw new BisectError(`${method} ${path} failed with HTTP ${response.status}`, response.status);
      }

      return text ? JSON.parse(text) : null;
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new BisectError(`${method} ${path} timed out after ${this.timeoutMs}ms`, 0);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  serverPath(suffix) {
    return `/api/client/servers/${encodeURIComponent(this.serverId)}${suffix}`;
  }

  async info() {
    const response = await this.request('GET', this.serverPath(''));
    return response?.attributes ?? null;
  }

  async resources() {
    const response = await this.request('GET', this.serverPath('/resources'));
    return response?.attributes ?? null;
  }

  async consoleTail(tail = 200) {
    const response = await this.request('GET', this.serverPath(`/console?tail=${tail}`));
    return Array.isArray(response?.data) ? response.data : [];
  }

  async power(signal) {
    return this.request('POST', this.serverPath('/power'), { signal });
  }

  async command(command) {
    return this.request('POST', this.serverPath('/command'), { command });
  }

  async onlinePlayers() {
    const response = await this.request('GET', this.serverPath('/player/online'));
    return Array.isArray(response?.data) ? response.data : [];
  }
}

module.exports = { BisectApi, BisectError };
