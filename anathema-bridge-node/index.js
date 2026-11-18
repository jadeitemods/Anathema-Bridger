const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const { WebSocketServer, WebSocket } = require('ws');
const { createValourIngress } = require('./valourIngress');
const { BisectApi } = require('./bisect');
const { createMonitor } = require('./monitor');
const { createControl } = require('./control');
const slash = require('./slash');

// ---------- Shared configuration ----------
// One file, ../config.json, drives the bridge, the Valour adapter and the Fabric mod.
// Nothing secret lives in this file's defaults: every credential comes from there.
const CONFIG_PATH = process.env.ANATHEMA_CONFIG || path.join(__dirname, '..', 'config.json');

function failStartup(message) {
  console.error(`[Config] ${message}`);
  process.exit(1);
}

function readConfigFile() {
  if (!fs.existsSync(CONFIG_PATH)) {
    failStartup(`missing ${CONFIG_PATH}. Copy config.example.json to config.json and fill it in.`);
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    failStartup(`${CONFIG_PATH} is not valid JSON: ${error.message}`);
  }
}

function loadConfig() {
  const raw = readConfigFile();

  const required = (key, value) => {
    if (value === undefined || value === null || String(value).trim() === '') {
      failStartup(`required setting "${key}" is missing or empty in ${CONFIG_PATH}`);
    }
    return value;
  };

  // A typo like "pollSeconds": "60s" becomes NaN; without this, setInterval(NaN) would
  // spin the panel API as fast as the machine allows.
  const number = (key, value, fallback, { min = 1, max = 65535 } = {}) => {
    if (value === undefined || value === null || value === '') return fallback;

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
      failStartup(`"${key}" must be a number between ${min} and ${max}, got ${JSON.stringify(value)}`);
    }

    return parsed;
  };

  const discord = raw.discord || {};
  const valour = raw.valour || {};
  const bridge = raw.bridge || {};
  const minecraft = raw.minecraft || {};

  return {
    configPath: CONFIG_PATH,
    discordBotToken: required('discord.botToken', discord.botToken),
    discordChannelId: required('discord.targetChannelId', discord.targetChannelId),
    discordBotId: discord.botId || '',

    valourBotId: valour.botId || '',
    valourChannelId: required('valour.targetChannelId', valour.targetChannelId),
    valourApiBase: valour.apiBase || 'https://api.valour.gg',

    minecraftAddress: minecraft.serverAddress || '',

    hostedserver: {
      apiKey: (raw.hostedserver || {}).apiKey || '',
      serverId: (raw.hostedserver || {}).serverId || '',
    },
    consolealerts: {
      discordChannelId: (raw.consolealerts || {}).discordChannelId || '',
      valourChannelId: (raw.consolealerts || {}).valourChannelId || '',
      pollSeconds: number('consolealerts.pollSeconds', (raw.consolealerts || {}).pollSeconds, 60, {
        min: 10,
        max: 3600,
      }),
    },
    control: {
      allowedUserIds: ((raw.control || {}).allowedUserIds || []).map(String),
      valourUserIds: ((raw.control || {}).valourUserIds || []).map(String),
    },

    bridgeSecret: required('bridge.secret', bridge.secret),
    artifactToken: bridge.artifactToken || '',
    websocketPort: number('bridge.websocketPort', bridge.websocketPort, 3000),
    websocketPath: bridge.websocketPath || '/minecraft',
    valourIngressPort: number('bridge.valourIngressPort', bridge.valourIngressPort, 3001),
    valourSendPort: number('bridge.valourSendPort', bridge.valourSendPort, 3002),
    ignoreCommandPrefixes: String(bridge.ignoreCommandPrefixes || '/,!,.,')
      .split(',')
      .map(prefix => prefix.trim())
      .filter(Boolean),
  };
}

const config = loadConfig();

/** Logs whether the Minecraft server is reachable. Informational only: the mod dials us. */
function probeMinecraftServer() {
  if (!config.minecraftAddress) return;

  const separator = config.minecraftAddress.lastIndexOf(':');
  if (separator < 1) {
    console.log(`[Minecraft] serverAddress "${config.minecraftAddress}" is not host:port; skipping probe.`);
    return;
  }

  const host = config.minecraftAddress.slice(0, separator);
  const port = Number(config.minecraftAddress.slice(separator + 1));

  const socket = net.connect({ host, port });
  socket.setTimeout(3000);

  socket.once('connect', () => {
    console.log(`[Minecraft] Server reachable at ${host}:${port}`);
    socket.destroy();
  });
  socket.once('timeout', () => {
    console.log(`[Minecraft] No response from ${host}:${port} within 3s.`);
    socket.destroy();
  });
  socket.once('error', error => {
    console.log(`[Minecraft] Server not reachable at ${host}:${port} (${error.code || error.message})`);
  });
}


function isCommand(content) {
  if (!content) return false;
  return config.ignoreCommandPrefixes.some(prefix => content.startsWith(prefix));
}

function formatForDiscord(source, username, message) {
  return `**[${source}]** ${username}: ${message}`;
}

function formatForValour(source, username, message) {
  return `**[${source}]** ${username}: ${message}`;
}

// Minecraft chat cannot show a file, so a compact tag stands in for the attachment
// instead of a raw CDN URL.
function attachmentTag(attachment) {
  const mime = String(attachment.contentType || '').toLowerCase();
  const name = String(attachment.name || '').toLowerCase();

  if (mime === 'image/gif' || name.endsWith('.gif')) return '[GIF]';
  if (mime.startsWith('image/')) return '[image]';
  if (mime.startsWith('video/')) return '[video]';
  if (mime.startsWith('audio/')) return '[audio]';
  return '[file]';
}

function describeAttachments(attachments) {
  const list = attachments ? Array.from(attachments.values()) : [];
  if (list.length === 0) return '';
  return list.length === 1 ? attachmentTag(list[0]) : `[${list.length} files]`;
}

// ---------- Valour forwarding ----------
// The Valour channel is E2EE: only the .NET adapter holds the keys, so this bridge
// forwards over the adapter's local send ingress instead of calling Valour's REST API.
const valourSendUrl = `http://127.0.0.1:${config.valourSendPort}/valour/send`;

async function sendToValour(content, channelId) {
  if (!content) return;

  const response = await fetch(valourSendUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Secret': config.bridgeSecret,
    },
    body: JSON.stringify(channelId ? { message: content, channelId } : { message: content }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`adapter returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

async function relayMinecraftToChats(username, message) {
  const line = `<${username}> ${message}`;

  try {
    await sendToValour(line);
  } catch (err) {
    console.error('[Valour] Send from Minecraft failed:', err.message);
  }
}

// ---------- Discord ----------
let discordChannel = null;

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

// ---------- Hosted server controls ----------
const bisect = new BisectApi({
  apiKey: config.hostedserver.apiKey,
  serverId: config.hostedserver.serverId,
});

let control = null;
let monitor = null;
let alertNotify = null;
let slashHandler = null;

if (bisect.configured && config.consolealerts.discordChannelId) {
  control = createControl({
    api: bisect,
    client: discord,
    channelId: config.consolealerts.discordChannelId,
    allowedUserIds: config.control.allowedUserIds,
    valourUserIds: config.control.valourUserIds,
    notifyValour: text =>
      config.consolealerts.valourChannelId
        ? sendToValour(text, config.consolealerts.valourChannelId)
        : Promise.resolve(),
    broadcast: broadcastSystem,
  });

  // Alerts go to both alert channels; Valour is reached through the adapter.
  let valourAlertsMutedUntil = 0;
  let valourAlertFailures = 0;

  alertNotify = async text => {
    await control.notify(text);

    if (!config.consolealerts.valourChannelId) return;

    if (Date.now() < valourAlertsMutedUntil) return;

    try {
      await sendToValour(text, config.consolealerts.valourChannelId);
      valourAlertFailures = 0;
    } catch (error) {
      valourAlertFailures += 1;
      if (valourAlertFailures === 1) {
        console.error('[Alerts] Valour post failed:', error.message);
      }
      if (valourAlertFailures >= 3) {
        valourAlertsMutedUntil = Date.now() + 30 * 60 * 1000;
        console.error('[Alerts] Valour alert channel is unusable; muting for 30 minutes.');
      }
    }
  };

  monitor = createMonitor({
    api: bisect,
    notify: alertNotify,
    pollSeconds: config.consolealerts.pollSeconds,
    onStateChange: text => {
      // Power actions announce their own transitions; do not duplicate them.
      if (control && control.isBusy()) return Promise.resolve();
      return broadcastSystem(text);
    },
    onConsoleSay: async text => {
      // Console announcements reach both chat platforms; Minecraft already has them.
      await sendToDiscord('Minecraft', 'Console', text).catch(err => console.error('[Console] Discord failed:', err.message));
      await sendToValour(formatForValour('Minecraft', 'Console', text)).catch(err => console.error('[Console] Valour failed:', err.message));
    },
  });
} else {
  console.log('[Control] hostedserver.apiKey/serverId or alerts.discordChannelId missing; controls disabled.');
}

discord.once(Events.ClientReady, async client => {
  console.log(`[Discord] Logged in as ${client.user.tag}`);
  try {
    discordChannel = await client.channels.fetch(config.discordChannelId);
    console.log(`[Discord] Using channel ${discordChannel.id}`);
  } catch (e) {
    console.error('[Discord] Could not fetch channel:', e);
  }

  if (monitor) {
    monitor.start();
  }

  if (control && discordChannel?.guild) {
    try {
      await slash.register(discordChannel.guild);
      slashHandler = slash.createHandler({
        control,
        channelId: config.consolealerts.discordChannelId,
        allowedUserIds: config.control.allowedUserIds,
      });
    } catch (error) {
      console.error('[Slash] registration failed:', error.message);
    }
  }

  // Prove the alerts channel is reachable once, rather than discovering it on the first
  // alert or power action.
  if (config.consolealerts.discordChannelId) {
    try {
      const alerts = await client.channels.fetch(config.consolealerts.discordChannelId);
      console.log(`[Alerts] Discord alerts channel reachable: #${alerts.name ?? alerts.id}`);
    } catch (error) {
      console.error(`[Alerts] Discord alerts channel ${config.consolealerts.discordChannelId} unreachable: ${error.message}`);
    }
  }
});

discord.on(Events.InteractionCreate, interaction => {
  if (!slashHandler) return;
  slashHandler(interaction).catch(error => console.error('[Slash] handler failed:', error.message));
});

discord.on(Events.MessageCreate, async msg => {  try {
    if (control && (await control.handleMessage(msg))) return;
  } catch (error) {
    console.error('[Control] handler failed:', error.message);
  }

  if (msg.channel.id !== config.discordChannelId) return;
  if (msg.author.bot) return;
  if (discord.user && msg.author.id === discord.user.id) return;
  if (isCommand(msg.content)) return;

  const username = msg.member?.displayName || msg.author.username;
  const content = [msg.content.trim(), describeAttachments(msg.attachments)]
    .filter(Boolean)
    .join(' ');

  if (!content) return;

  console.log(`[Discord ->] ${username}: ${content}`);

  broadcastToMinecraft('Discord', username, content);

  sendToValour(formatForValour('Discord', username, content)).catch(err => {
    console.error('[Valour] Send from Discord failed:', err.message);
  });
});

async function sendToDiscord(source, username, message) {
  if (!discordChannel) {
    discordChannel = await discord.channels.fetch(config.discordChannelId);
  }
  await discordChannel.send(formatForDiscord(source, username, message));
}

/** Plain line with no "[Source] user:" prefix, for system notices. */
async function sendPlainToDiscord(text) {
  if (!discordChannel) {
    discordChannel = await discord.channels.fetch(config.discordChannelId);
  }
  await discordChannel.send(text);
}

/**
 * Announces a server event where players actually are: Discord chat, Valour chat and
 * in-game. The in-game copy goes through `say`, which the monitor then ignores so it
 * is not echoed a second time.
 */
async function broadcastSystem(text) {
  const line = `**[Bridge]** ${text}`;

  await sendPlainToDiscord(line).catch(err => console.error('[Broadcast] Discord failed:', err.message));
  await sendToValour(line).catch(err => console.error('[Broadcast] Valour failed:', err.message));

  if (bisect.configured) {
    await bisect.command(`say [Bridge] ${text}`).catch(error => {
      console.error('[Broadcast] say failed:', error.message);
    });
  }
}

// ---------- Minecraft WebSocket server ----------
// Loopback only: the bridge is a local process, so the mod socket has no business
// being reachable from the LAN. The same port also serves mod jars so the hosted
// server can pull them, gated by an unguessable token.
const ARTIFACT_DIR = path.join(__dirname, '..', 'anathema-bridge-mod', 'build', 'libs');

function serveArtifact(req, res) {
  if (!config.artifactToken) return false;

  const prefix = `/artifacts/${config.artifactToken}/`;
  if (!req.url.startsWith(prefix)) return false;

  const requested = path.basename(req.url.slice(prefix.length).split('?')[0]);
  const file = path.join(ARTIFACT_DIR, requested);

  if (!requested.endsWith('.jar') || !fs.existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'application/java-archive',
    'Content-Length': fs.statSync(file).size,
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const httpServer = http.createServer((req, res) => {
  if (serveArtifact(req, res)) return;
  res.writeHead(426, { 'Content-Type': 'text/plain' }).end('Upgrade Required');
});

const wss = new WebSocketServer({
  server: httpServer,
  path: config.websocketPath,
  // Reject during the handshake so an unauthenticated client never gets an open socket.
  // Fail closed: no configured secret means no clients. The secret is taken from a header
  // rather than the query string so it never lands in URLs or access logs.
  verifyClient: (info, done) => {
    const provided = String(info.req.headers['x-bridge-secret'] || '');
    if (!config.bridgeSecret || provided !== config.bridgeSecret) {
      console.warn('[Minecraft] Rejected client: bad secret.');
      done(false, 401, 'Unauthorized');
      return;
    }
    done(true);
  },
});

httpServer.listen(config.websocketPort, '127.0.0.1', () => {
  console.log(`[Bridge] WebSocket listening on ws://127.0.0.1:${config.websocketPort}${config.websocketPath}`);
  if (config.artifactToken) {
    console.log(`[Bridge] Jar downloads enabled under /artifacts/${config.artifactToken.slice(0, 4)}…/`);
  }
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  console.log('[Minecraft] Mod connected.');

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());

      // Commands are audit-only: they go to the alerts channel and nowhere else.
      if (msg.type === 'command') {
        const who = String(msg.username || 'Unknown');
        const command = String(msg.command || '').trim();
        if (!command) return;

        console.log(`[Minecraft command] ${who}: ${command}`);
        if (alertNotify) {
          alertNotify(`**Command** ${who}: \`${command}\``).catch(() => {});
        }
        return;
      }

      if (msg.type !== 'chat') return;

      const username = String(msg.username || 'MinecraftPlayer');
      const content = String(msg.message || '');

      if (isCommand(content)) return;

      console.log(`[Minecraft ->] ${username}: ${content}`);

      sendToValour(formatForValour('Minecraft', username, content)).catch(err => {
        console.error('[Valour] Send from Minecraft failed:', err.message);
      });

      sendToDiscord('Minecraft', username, content).catch(err => {
        console.error('[Discord] Send from Minecraft failed:', err.message);
      });
    } catch (e) {
      console.error('[Minecraft] Error handling mod message:', e);
    }
  });

  ws.on('close', () => {
    console.log('[Minecraft] Mod disconnected.');
  });
});

// Drop half-open mod connections: without this a dead socket looks connected
// indefinitely and chat is silently lost.
const modHeartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      console.warn('[Minecraft] Heartbeat timed out; dropping connection.');
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wss.on('close', () => clearInterval(modHeartbeat));

function broadcastToMinecraft(source, username, message) {
  const payload = JSON.stringify({
    type: 'chat',
    source,
    username,
    message,
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ---------- Local Valour ingress ----------
{
  const valourIngressPort = config.valourIngressPort;
  const valourIngress = createValourIngress({
    secret: config.bridgeSecret,
    onMessage: async ({ username, message }) => {
      if (isCommand(message)) return;
      // Valour -> Minecraft as well as Discord; without this the bridge is only two-way.
      broadcastToMinecraft('Valour', username, message);
      await sendToDiscord('Valour', username, message);
    },
    onCommand: async ({ username, userId, text }) => {
      console.log(`[Valour ingress] command from ${username} (${userId}): ${text}`);
      if (!control) return { handled: false, reason: 'controls disabled' };
      return control.handleValourCommand({ username, userId, text });
    },
  });

  valourIngress.on('error', err => {
    console.error('[Valour ingress] Server error:', err.message);
  });
  valourIngress.listen(valourIngressPort, '127.0.0.1', () => {
    console.log(`[Valour] Local ingress listening on http://127.0.0.1:${valourIngressPort}`);
  });
}

// ---------- Start everything ----------
console.log(`[Config] Loaded ${config.configPath}`);
probeMinecraftServer();

discord.login(config.discordBotToken).catch(err => {
  console.error('[Discord] Login failed:', err);
});;