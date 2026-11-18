'use strict';

// Fast unit tests for the pure helpers. Anything that needs a socket, a Discord client
// or the panel API belongs in a different harness; these must finish in milliseconds so
// `npm test` stays useful.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../control');
const { newLinesSince, clean } = require('../monitor');

test('parses every supported command', () => {
  assert.deepEqual(parse('!bridger restart'), { command: 'restart', rest: [] });
  assert.deepEqual(parse('!bridger power'), { command: 'power', rest: [] });
  assert.deepEqual(parse('!bridger status'), { command: 'status', rest: [] });
  assert.deepEqual(parse('!bridger help'), { command: 'help', rest: [] });
});

test('keeps bracketed console commands intact', () => {
  const parsed = parse('!bridger cmd [/gamemode creative]');
  assert.equal(parsed.command, 'cmd');
  assert.equal(parsed.rest.join(' '), '[/gamemode creative]');
});

test('defaults to help and rejects non-commands', () => {
  assert.equal(parse('!bridger').command, 'help');
  assert.equal(parse('hello there'), null);
  assert.equal(parse('!notbridger restart'), null);
  assert.equal(parse(''), null);
});

test('finds only the lines that are new since the last poll', () => {
  assert.deepEqual(newLinesSince(['a', 'b', 'c'], ['b', 'c', 'd']), ['d']);
  assert.deepEqual(newLinesSince(['a', 'b'], ['a', 'b']), []);
  assert.deepEqual(newLinesSince([], ['a', 'b']), ['a', 'b']);

  // No overlap at all: fall back to a bounded slice rather than replaying everything.
  assert.deepEqual(newLinesSince(['x', 'y'], ['z', 'w']), ['z', 'w']);
});

test('strips panel colour codes from console lines', () => {
  assert.equal(clean('\u001b[0m[12:00:00] [Server thread/ERROR]: boom'), '[12:00:00] [Server thread/ERROR]: boom');
});
