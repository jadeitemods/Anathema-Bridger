const test = require('node:test');
const assert = require('node:assert/strict');
const { createValourIngress } = require('../valourIngress');

async function startServer(t, options) {
  const server = createValourIngress(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/valour/messages`;
}

test('forwards an authenticated Valour message to the callback', async t => {
  let forwarded;
  const url = await startServer(t, {
    secret: 'test-bridge-secret',
    onMessage: async message => { forwarded = message; },
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Secret': 'test-bridge-secret',
    },
    body: JSON.stringify({ username: 'ValourUser', message: 'relay-check' }),
  });

  assert.equal(response.status, 204);
  assert.deepEqual(forwarded, { username: 'ValourUser', message: 'relay-check' });
});

test('rejects unauthenticated Valour ingress without forwarding', async t => {
  let forwarded = false;
  const url = await startServer(t, {
    secret: 'test-bridge-secret',
    onMessage: async () => { forwarded = true; },
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ValourUser', message: 'should-not-relay' }),
  });

  assert.equal(response.status, 401);
  assert.equal(forwarded, false);
});

test('rejects malformed message payloads', async t => {
  const url = await startServer(t, {
    secret: 'test-bridge-secret',
    onMessage: async () => assert.fail('invalid payload must not be forwarded'),
  });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Bridge-Secret': 'test-bridge-secret',
    },
    body: JSON.stringify({ channelId: '123', content: 'wrong shape' }),
  });

  assert.equal(response.status, 400);
});
