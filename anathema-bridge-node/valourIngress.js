const http = require('node:http');

const MAX_BODY_BYTES = 32 * 1024;
const MAX_USERNAME_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 1800;

function createValourIngress({ secret, onMessage, onCommand, maxBodyBytes = MAX_BODY_BYTES }) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('A non-empty bridge secret is required for Valour ingress');
  }
  if (typeof onMessage !== 'function') {
    throw new TypeError('onMessage must be a function');
  }

  function readBody(req, res, handler) {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        if (!res.headersSent) res.writeHead(413).end();
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });

    req.on('end', async () => {
      if (tooLarge) return;

      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400).end();
        return;
      }

      await handler(payload, res);
    });
  }

  return http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }

    if (req.url !== '/valour/messages' && req.url !== '/valour/command') {
      res.writeHead(404).end();
      return;
    }

    if (req.headers['x-bridge-secret'] !== secret) {
      req.resume();
      res.writeHead(401).end();
      return;
    }

    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      req.resume();
      res.writeHead(415).end();
      return;
    }

    if (req.url === '/valour/command') {
      if (typeof onCommand !== 'function') {
        req.resume();
        res.writeHead(503).end();
        return;
      }

      readBody(req, res, async payload => {
        const username = payload && payload.username;
        const userId = payload && payload.userId;
        const text = payload && payload.text;

        if (typeof username !== 'string' || typeof text !== 'string' ||
            username.trim().length === 0 || text.trim().length === 0 ||
            username.length > MAX_USERNAME_LENGTH || text.length > MAX_MESSAGE_LENGTH) {
          res.writeHead(400).end();
          return;
        }

        try {
          const result = await onCommand({ username, userId, text });
          res.writeHead(result?.handled ? 204 : 403).end();
        } catch {
          res.writeHead(502).end();
        }
      });

      return;
    }

    readBody(req, res, async payload => {
      const username = payload && payload.username;
      const message = payload && payload.message;
      if (typeof username !== 'string' || typeof message !== 'string' ||
          username.trim().length === 0 || message.trim().length === 0 ||
          username.length > MAX_USERNAME_LENGTH || message.length > MAX_MESSAGE_LENGTH) {
        res.writeHead(400).end();
        return;
      }

      try {
        await onMessage({ username, message });
        res.writeHead(204).end();
      } catch {
        res.writeHead(502).end();
      }
    });
  });
}

module.exports = { createValourIngress };
