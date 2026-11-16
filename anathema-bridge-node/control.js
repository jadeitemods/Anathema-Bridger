'use strict';

// Whitelisted staff commands, accepted from the Discord alerts channel or the Valour
// alerts channel. Replies go back only to the platform that asked; power actions report
// progress in one editable message, and announce a restart before doing it.

const POLL_MS = 5000;
const TIMEOUT_MS = 5 * 60 * 1000;
const COUNTDOWN_STEPS = [15, 10, 5];

const HELP = [
  '**Anathema bridge controls**',
  '`!bridger restart` — restart the hosted server',
  '`!bridger power` — stop it if running, start it if stopped',
  '`!bridger status` — report server status, TPS and player count',
  '`!bridger cmd [command]` — run a console command, brackets required',
  '`!bridger help` — this list',
].join('\n');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parse(text) {
  const trimmed = String(text || '').trim();
  if (!/^!bridger\b/i.test(trimmed)) return null;

  // "!bridger restart" is two tokens: skip the prefix only.
  const [, subcommand = 'help', ...rest] = trimmed.split(/\s+/);
  return { command: subcommand.toLowerCase(), rest };
}

function createControl({
  api,
  client,
  channelId,
  allowedUserIds,
  valourUserIds = [],
  notifyValour,
  broadcast,
  logger = console,
}) {
  let busy = null;
  let channel = null;

  async function resolveChannel() {
    if (!channel) {
      // A hung fetch would block every action silently, so bound it.
      channel = await Promise.race([
        client.channels.fetch(channelId),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`fetch of channel ${channelId} timed out after 10s`)), 10000),
        ),
      ]);
    }
    return channel;
  }

  async function notify(text) {
    try {
      const target = await resolveChannel();
      await target.send(text);
    } catch (error) {
      logger.error('[Alerts] could not post:', error.message);
    }
  }

  async function mirrorToValour(text) {
    if (!notifyValour) return;
    try {
      await notifyValour(text);
    } catch (error) {
      logger.error('[Alerts] could not mirror to Valour:', error.message);
    }
  }

  async function describeState(attributes) {
    const state = attributes?.current_state ?? 'unknown';
    const tps = attributes?.minecraft_resources?.minecraft_tps;
    const parts = [state];

    if (typeof tps === 'number' && tps > 0) {
      parts.push(`TPS ${tps.toFixed(1)}`);
    }

    try {
      const players = await api.onlinePlayers();
      parts.push(`${players.length} online`);
    } catch {
      // Player listing is optional; the state line stands on its own.
    }

    return parts.join(' · ');
  }

  async function runPowerAction({ label, signal, isDone, requestedBy, countdown }) {
    const started = Date.now();
    busy = { label, started };
    logger.log(`[Control] ${label}: starting (requested by ${requestedBy}).`);

    let message = null;
    try {
      message = await (await resolveChannel()).send(
        `**${label}** requested by ${requestedBy} — contacting the panel…`,
      );
    } catch (error) {
      // Discord being unreachable must not stop the action itself.
      logger.error(`[Control] ${label}: no progress message (${error.message}); continuing.`);
    }

    const edit = text => (message ? message.edit(text).catch(() => {}) : Promise.resolve());

    try {
      if (countdown && broadcast) {
        for (const seconds of COUNTDOWN_STEPS) {
          await edit(`**${label}** — announcing ${seconds}s warning…`);
          logger.log(`[Control] ${label}: announcing ${seconds}s warning.`);
          await broadcast(`Server restarting in ${seconds}s — please disconnect now.`);
          await sleep(POLL_MS);
        }
      }

      logger.log(`[Control] ${label}: sending power signal "${signal}".`);
      if (broadcast) {
        await broadcast(
          signal === 'restart'
            ? 'Server is restarting now.'
            : signal === 'stop'
              ? 'Server is stopping now.'
              : 'Server is starting now.',
        );
      }

      await api.power(signal);

      let lastState = 'unknown';
      let sawStopped = false;

      while (Date.now() - started < TIMEOUT_MS) {
        await sleep(POLL_MS);

        const attributes = await api.resources().catch(() => null);
        const state = attributes?.current_state ?? 'unknown';
        const elapsed = Math.round((Date.now() - started) / 1000);

        if (state === 'stopping' || state === 'offline' || state === 'starting') {
          sawStopped = true;
        }

        if (state !== lastState || elapsed % 30 === 0) {
          lastState = state;
          await edit(`**${label}** — ${state} (${elapsed}s)`);
        }

        if (isDone(state, elapsed, sawStopped)) {
          const summary = await describeState(attributes);
          const final = `**${label} complete** after ${elapsed}s — ${summary}`;
          await edit(final);
          await mirrorToValour(final);

          if (broadcast) {
            await broadcast(state === 'running' ? 'Server is back online.' : 'Server is offline.');
          }

          return;
        }
      }

      const timedOut = `**${label}** — not finished after 5 minutes (last state: ${lastState}). Check the panel.`;
      await edit(timedOut);
      await mirrorToValour(timedOut);
    } catch (error) {
      logger.error(`[Control] ${label} failed: ${error.message}`);
      const failed = `**${label} failed** — ${error.message}`;
      await edit(failed);
      await mirrorToValour(failed);
    } finally {
      busy = null;
    }
  }

  async function execute(text, { requestedBy, reply }) {
    const parsed = parse(text);
    if (!parsed) return { handled: false };

    const { command, rest } = parsed;

    if (busy) {
      // A stuck action must not block every later command forever.
      if (Date.now() - busy.started > 10 * 60 * 1000) {
        logger.warn(`[Control] clearing stale ${busy.label.toLowerCase()} lock.`);
        busy = null;
      } else {
        const elapsed = Math.round((Date.now() - busy.started) / 1000);
        await reply(`Already ${busy.label.toLowerCase()} (${elapsed}s) — hang tight.`);
        return { handled: true };
      }
    }

    if (command === 'help') {
      await reply(HELP);
      return { handled: true };
    }

    if (command === 'restart') {
      logger.log('[Control] restart: sending acknowledgement.');
      await reply('Restart queued; counting down so players can disconnect.');
      logger.log('[Control] restart: acknowledgement sent, starting action.');
      await runPowerAction({
        label: 'Restart',
        signal: 'restart',
        isDone: (state, elapsed, sawStopped) => sawStopped && state === 'running',
        requestedBy,
        countdown: true,
      });
      return { handled: true };
    }

    if (command === 'start' || command === 'stop') {
      await reply(`${command === 'start' ? 'Start' : 'Stop'} queued; progress is in the Discord alerts channel.`);
      await runPowerAction({
        label: command === 'start' ? 'Start' : 'Stop',
        signal: command,
        isDone: state => (command === 'start' ? state === 'running' : state === 'offline'),
        requestedBy,
      });
      return { handled: true };
    }

    if (command === 'power') {
      const attributes = await api.resources().catch(() => null);
      const state = attributes?.current_state ?? 'unknown';

      if (state === 'running' || state === 'offline') {
        const signal = state === 'running' ? 'stop' : 'start';
        const label = state === 'running' ? 'Stop' : 'Start';
        await reply(`${label} queued; progress is in the Discord alerts channel.`);
        await runPowerAction({
          label,
          signal,
          isDone: current => (signal === 'start' ? current === 'running' : current === 'offline'),
          requestedBy,
        });
      } else {
        await reply(`Server is ${state}; refusing to toggle mid-transition.`);
      }
      return { handled: true };
    }

    if (command === 'status') {
      const attributes = await api.resources().catch(() => null);

      if (!attributes) {
        await reply('Could not read server stats right now.');
        return { handled: true };
      }

      const state = attributes.current_state ?? 'unknown';
      const tps = attributes.minecraft_resources?.minecraft_tps;
      const players = await api.onlinePlayers().then(list => list.length).catch(() => null);

      const parts = [`**TPS** ${typeof tps === 'number' ? tps.toFixed(1) : 'n/a'}`, `state ${state}`];
      if (players !== null) parts.push(`${players} online`);

      await reply(parts.join(' · '));
      return { handled: true };
    }

    if (command === 'cmd') {
      const raw = rest.join(' ');
      const bracketed = raw.match(/^\[(.+)\]$/s);

      if (!bracketed) {
        await reply('Wrap the command in brackets, e.g. `!bridger cmd [/gamemode creative]`.');
        return { handled: true };
      }

      const consoleCommand = bracketed[1].trim();

      try {
        await api.command(consoleCommand);
        await reply(`Sent to console: \`${consoleCommand}\``);
      } catch (error) {
        await reply(`Command failed — ${error.message}`);
      }
      return { handled: true };
    }

    await reply(`Unknown command "${command}". Try \`!bridger help\`.`);
    return { handled: true };
  }

  async function handleMessage(message) {
    if (!channelId || message.channel.id !== channelId) return false;
    if (message.author.bot) return false;

    const parsed = parse(message.content);
    if (!parsed) return false;

    if (!allowedUserIds.includes(message.author.id)) {
      logger.warn(`[Control] rejected "${parsed.command}" from ${message.author.username} (${message.author.id}).`);
      await message.reply('Not authorised for bridge controls.').catch(() => {});
      return true;
    }

    await execute(message.content, {
      requestedBy: `<@${message.author.id}>`,
      reply: text => message.reply(text).catch(() => {}),
    });

    return true;
  }

  /** Entry point for commands relayed from Valour; replies stay in Valour. */
  async function handleValourCommand({ username, userId, text }) {
    logger.log(`[Control] valour command "${text}" from ${username} (${userId}).`);
    const parsed = parse(text);
    if (!parsed) return { handled: false, reason: 'not a command' };

    if (!valourUserIds.includes(String(userId))) {
      logger.warn(`[Control] rejected Valour "${parsed.command}" from ${username} (${userId}).`);
      return { handled: false, reason: 'not authorised' };
    }

    // Detached on purpose: a restart runs a 15s countdown plus a restart cycle, and the
    // HTTP caller should not be left holding the connection for minutes.
    void execute(text, {
      requestedBy: `${username} (Valour)`,
      reply: async textReply => {
        if (notifyValour) {
          await notifyValour(`**${username}**: ${textReply}`).catch(error =>
            logger.error('[Control] could not reply in Valour:', error.message),
          );
        }
      },
    }).catch(error => logger.error(`[Control] Valour command failed: ${error.message}`));

    return { handled: true };
  }

  return {
    handleMessage,
    handleValourCommand,
    notify,
    HELP,
    isBusy: () => busy !== null,
    executeText: (text, options) => execute(text, options),
  };
}

module.exports = { createControl, parse };
