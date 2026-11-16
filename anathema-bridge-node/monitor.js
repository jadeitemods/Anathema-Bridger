'use strict';

// Watches the hosted server's console and state, and reports what actually matters
// to the alerts channel. Silence means "nothing new", so a crash is never swallowed.

const ANSI = /\u001b\[[0-9;]*m/g;

const ERROR_PATTERNS = [
  /\bERROR\b/,
  /\bSEVERE\b/,
  /Exception\b/,
  /OutOfMemoryError/,
  /Watchdog/,
  /crash report/i,
  /Failed to/,
  /\bCaused by:/,
];

// Lines the mod itself prints when the bridge link breaks or heals.
const BRIDGE_PATTERNS = [/Bridge WebSocket error/, /Reconnecting to bridge/, /Bridge is not connected/, /Connected to bridge/];

// Console `say` lands in the panel log as "[Server] text". Player-run /say would show
// the player's name instead, so this stays console-only.
const CONSOLE_SAY_PATTERN = /INFO\]: (?:\[Not Secure\] )?\[Server\] (.+)$/;

const MAX_ALERTS_PER_WINDOW = 5;
const ALERT_WINDOW_MS = 10 * 60 * 1000;

function clean(line) {
  return String(line ?? '').replace(ANSI, '').trim();
}

/** Longest overlap between the tail we saw last time and the start of the newest tail. */
function newLinesSince(previous, current) {
  if (previous.length === 0) {
    return current.slice(-20);
  }

  const limit = Math.min(previous.length, current.length);
  for (let overlap = limit; overlap > 0; overlap -= 1) {
    const a = previous.slice(previous.length - overlap);
    const b = current.slice(0, overlap);
    if (a.every((line, index) => line === b[index])) {
      return current.slice(overlap);
    }
  }

  return current.slice(-20);
}

function createMonitor({ api, notify, onConsoleSay, onStateChange, pollSeconds = 60, logger = console }) {
  let timer = null;
  let seen = [];
  let lastState = null;
  let windowStart = Date.now();
  let windowCount = 0;
  let suppressed = 0;

  function overBudget() {
    if (Date.now() - windowStart > ALERT_WINDOW_MS) {
      windowStart = Date.now();
      windowCount = 0;
      if (suppressed > 0) {
        void notify(`…and ${suppressed} earlier console alerts were suppressed.`);
        suppressed = 0;
      }
    }

    if (windowCount >= MAX_ALERTS_PER_WINDOW) {
      suppressed += 1;
      return true;
    }

    windowCount += 1;
    return false;
  }

  async function tick() {
    try {
      const attributes = await api.resources().catch(() => null);
      const state = attributes?.current_state ?? 'unknown';

      if (lastState !== null && state !== lastState) {
        let announcement = null;

        if (state === 'offline') {
          announcement = `Server went **offline** (was ${lastState}).`;
        } else if (lastState === 'offline' && state === 'running') {
          announcement = 'Server is back **online**.';
        } else if (state === 'stopping' || state === 'starting') {
          announcement = `Server is ${state}.`;
        }

        if (announcement) {
          await notify(announcement);
          if (onStateChange) {
            await onStateChange(announcement.replaceAll('*', ''));
          }
        }
      }
      lastState = state;

      const raw = await api.consoleTail(200);
      const tail = raw.map(clean);

      // First poll only establishes a baseline: old errors in the buffer are not news.
      if (seen.length === 0) {
        seen = tail.slice(-200);
        return;
      }

      const fresh = newLinesSince(seen, tail);
      seen = tail.slice(-200);

      if (fresh.length === 0) {
        return;
      }

      // Console `say` is relayed outwards; players already saw it in-game.
      if (onConsoleSay) {
        for (const line of fresh) {
          const match = line.match(CONSOLE_SAY_PATTERN);
          if (!match) continue;

          const text = match[1].trim();

          // Our own announcements are already posted directly; echoing them again here
          // would duplicate every one.
          if (text.startsWith('[Bridge]')) continue;

          await onConsoleSay(text);
        }
      }

      const bridgeLines = fresh.filter(line => BRIDGE_PATTERNS.some(pattern => pattern.test(line)));
      const errorLines = fresh.filter(
        line => ERROR_PATTERNS.some(pattern => pattern.test(line)) && !BRIDGE_PATTERNS.some(pattern => pattern.test(line)),
      );

      // One summary per poll: a reconnect storm should not be a wall of messages.
      if (bridgeLines.length > 0) {
        const counts = { connected: 0, disconnected: 0, reconnecting: 0 };

        for (const line of bridgeLines) {
          if (/Connected to bridge/.test(line)) counts.connected += 1;
          else if (/Bridge is not connected/.test(line)) counts.disconnected += 1;
          else counts.reconnecting += 1;
        }

        const parts = [];
        if (counts.connected) parts.push(`connected ×${counts.connected}`);
        if (counts.disconnected) parts.push(`not connected ×${counts.disconnected}`);
        if (counts.reconnecting) parts.push(`connection errors ×${counts.reconnecting}`);

        await notify(`Bridge link: ${parts.join(', ')}`);
      }

      if (errorLines.length > 0) {
        const unique = [...new Set(errorLines)].slice(0, 3);
        for (const line of unique) {
          if (overBudget()) {
            continue;
          }
          await notify(`Console: \`${truncate(line, 400)}\``);
        }
      }
    } catch (error) {
      logger.error('[Monitor] poll failed:', error.message);
    }
  }

  return {
    start() {
      if (timer) return;
      logger.log(`[Monitor] watching the hosted server every ${pollSeconds}s.`);
      timer = setInterval(() => { void tick(); }, pollSeconds * 1000);
      setImmediate(() => { void tick(); });
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

module.exports = { createMonitor, newLinesSince, clean };
