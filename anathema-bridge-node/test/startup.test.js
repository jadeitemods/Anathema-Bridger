const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

test('bridges Discord and Minecraft without loading Valour when disabled', async t => {
  const originalLoad = Module._load;
  const indexPath = path.resolve(__dirname, '..', 'index.js');
  const originalEnv = {
    VALOUR_ENABLED: process.env.VALOUR_ENABLED,
    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN,
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
  };
  const events = [];
  const discordMessages = [];
  const minecraftMessages = [];
  let discordClient;
  let webSocketServer;

  class FakeClient {
    constructor() {
      discordClient = this;
      this.handlers = new Map();
      this.channels = {
        fetch: async id => ({
          id,
          send: async content => discordMessages.push({ id, content }),
        }),
      };
    }
    once(event, handler) { this.handlers.set(event, handler); return this; }
    on(event, handler) { this.handlers.set(event, handler); return this; }
    login(token) { events.push(token ? 'discord.login' : 'discord.login.missing-token'); return Promise.resolve(); }
  }

  class FakeWebSocketServer {
    constructor(options) {
      this.options = options;
      this.clients = new Set();
      this.handlers = new Map();
      webSocketServer = this;
      events.push('websocket.server');
    }
    on(event, handler) { this.handlers.set(event, handler); return this; }
  }

  process.env.VALOUR_ENABLED = 'false';
  process.env.DISCORD_BOT_TOKEN = 'test-token';
  process.env.DISCORD_CHANNEL_ID = 'test-channel';
  delete require.cache[indexPath];
  Module._load = function(request, parent, isMain) {
    if (request === 'dotenv') return { config() {} };
    if (request === 'discord.js') return {
      Client: FakeClient,
      GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4 },
      Events: { ClientReady: 'ready', MessageCreate: 'messageCreate' },
      Partials: { Channel: 1 },
    };
    if (request === 'ws') return { WebSocketServer: FakeWebSocketServer, WebSocket: { OPEN: 1 } };
    if (request === './valourBridge') throw new Error('Valour module should not load when disabled');
    return originalLoad.call(this, request, parent, isMain);
  };

  t.after(() => {
    Module._load = originalLoad;
    delete require.cache[indexPath];
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  require(indexPath);
  assert.ok(events.includes('websocket.server'));
  assert.ok(events.includes('discord.login'));

  const minecraftSocket = {
    readyState: 1,
    on() {},
    send(payload) { minecraftMessages.push(JSON.parse(payload)); },
  };
  webSocketServer.clients.add(minecraftSocket);
  discordClient.handlers.get('messageCreate')({
    channel: { id: 'test-channel' },
    author: { id: 'human-user', username: 'Jamie', bot: false },
    member: { displayName: 'Jamie' },
    content: 'from Discord',
  });
  assert.deepEqual(minecraftMessages, [{
    type: 'chat', source: 'Discord', username: 'Jamie', message: 'from Discord',
  }]);

  const incomingSocket = { handlers: new Map(), on(event, handler) { this.handlers.set(event, handler); } };
  webSocketServer.handlers.get('connection')(incomingSocket, {
    url: '/minecraft',
    headers: { host: 'localhost' },
  });
  incomingSocket.handlers.get('message')(Buffer.from(JSON.stringify({
    type: 'chat', username: 'Alex', message: 'from Minecraft',
  })));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(discordMessages, [{
    id: 'test-channel', content: '**[Minecraft]** Alex: from Minecraft',
  }]);
});
