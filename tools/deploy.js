'use strict';

// Optional one-command deploy for a BisectHosting server.
//
// Writes the two mod settings into the server's fabric-server-launcher.properties,
// pulls the built jar into /mods, and optionally restarts and waits for the mod to
// connect. Everything it needs comes from config.json.
//
//   node tools/deploy.js                 # config + jar, no restart
//   node tools/deploy.js --restart       # then restart and wait for the bridge
//   node tools/deploy.js --dry-run       # show what would change
//
// Anyone who would rather upload the jar and paste two lines by hand can ignore this
// script entirely; the two approaches are equivalent.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.ANATHEMA_CONFIG || path.join(ROOT, 'config.json');
const API_BASE = 'https://games.bisecthosting.com';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const restart = args.includes('--restart');

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) fail(`missing ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function newestJar() {
  const dir = path.join(ROOT, 'anathema-bridge-mod', 'build', 'libs');
  if (!fs.existsSync(dir)) fail(`no build output at ${dir} — run .\\gradlew build first`);

  const jars = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.jar') && !name.includes('-sources'))
    .sort();

  if (jars.length === 0) fail('no jar found — run .\\gradlew build first');
  return jars[jars.length - 1];
}

function artifactUrl(publicUrl, jarName, token) {
  const base = publicUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/[^/]*$/, '');
  return `${base}/artifacts/${token}/${jarName}`;
}

function upsert(lines, key, value) {
  const index = lines.findIndex(line => line.startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = `${key}=${value}`;
  } else {
    lines.push(`${key}=${value}`);
  }
}

async function main() {
  const config = loadConfig();
  const { apiKey, serverId } = config.hostedserver ?? {};
  const bridge = config.bridge ?? {};

  if (!apiKey || !serverId) fail('hostedserver.apiKey and hostedserver.serverId are required in config.json');
  if (!bridge.secret) fail('bridge.secret is required');
  if (!bridge.publicUrl) fail('bridge.publicUrl is required (the wss:// address the mod dials)');
  if (!bridge.artifactToken) fail('bridge.artifactToken is required so the jar can be fetched');

  const jar = newestJar();
  const jarUrl = artifactUrl(bridge.publicUrl, jar, bridge.artifactToken);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  const call = async (method, route, body) => {
    const response = await fetch(`${API_BASE}/api/client/servers/${serverId}${route}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`${method} ${route} → HTTP ${response.status}`);
    }
    const text = await response.text();
    if (!text) return null;

    // /files/contents returns the raw file, not JSON.
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  console.log(`config:   ${CONFIG_PATH}`);
  console.log(`jar:      ${jar}`);
  console.log(`fetching: ${jarUrl}`);

  if (dryRun) {
    console.log('\n(dry run — nothing written)');
    return;
  }

  // 1. Properties: keep everything else, replace or add our two keys.
  const current = await call('POST', '/files/contents', { file: '/fabric-server-launcher.properties' });
  const text = typeof current === 'string' ? current : current?.content ?? '';
  const lines = text.split(/\r?\n/).filter(line => line.length > 0);

  upsert(lines, 'serverJar', 'server.jar');
  upsert(lines, 'anathema.bridge.url', bridge.publicUrl);
  upsert(lines, 'anathema.bridge.secret', bridge.secret);

  await call('POST', '/files/write', {
    file: '/fabric-server-launcher.properties',
    content: `${lines.join('\n')}\n`,
  });
  console.log('✔ fabric-server-launcher.properties updated');

  // 2. Jar: replace any existing copy, then let the panel fetch it.
  await call('POST', '/files/delete', { root: '/mods', files: [jar] }).catch(() => {});
  await call('POST', '/files/pull', { url: jarUrl, directory: '/mods', filename: jar, foreground: true });
  console.log(`✔ ${jar} installed in /mods`);

  if (!restart) {
    console.log('\nDone. Restart the server to load it, or re-run with --restart.');
    return;
  }

  // 3. Restart and wait for the mod to report itself.
  await call('POST', '/power', { signal: 'restart' });
  console.log('… restart requested, waiting for the bridge');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 8000));
    const tail = await call('GET', '/console?tail=150');
    const linesOut = Array.isArray(tail?.data) ? tail.data : [];
    if (linesOut.some(line => String(line).includes('Connected to bridge'))) {
      console.log('✔ server is back and connected to the bridge');
      return;
    }
  }

  console.error('⚠ restarted, but the bridge never reported in — check the console');
  process.exitCode = 1;
}

main().catch(error => fail(error.message));
