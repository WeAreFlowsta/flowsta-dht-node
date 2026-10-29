import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putErrors, registrationVerdict, PUT_ERROR } from '../lib/registration.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-10-29T07:30:00Z');
const STARTED = NOW - 3 * 24 * 60 * MIN;
const URL = 'https://bootstrap-7.example.org/bootstrap/c3BhY2U/YWdlbnQ';

/** Docker-timestamped log lines: a refused registration every 5 minutes, per network. */
function logOf(minutesAgo, networks = 1) {
  const lines = [];
  for (const m of minutesAgo) {
    for (let n = 0; n < networks; n++) {
      const at = new Date(NOW - m * MIN).toISOString();
      // As the conductor writes it: coloured level and field names.
      lines.push(`${at} \x1b[2m${at}\x1b[0m \x1b[33m WARN\x1b[0m kitsune2_bootstrap_client: ${PUT_ERROR} \x1b[3murl\x1b[0m\x1b[2m=\x1b[0m"${URL.replace('c3BhY2U', 'space' + n)}" \x1b[3mstatus\x1b[0m\x1b[2m=\x1b[0m500`);
    }
    lines.push(`${new Date(NOW - m * MIN).toISOString()} WARN kitsune2_gossip::timeout: Initiated round timed out`);
  }
  return lines.join('\n');
}
const every5 = [29, 24, 19, 14, 9, 4];

test('reads the time and the bootstrap address of each refused registration', () => {
  const e = putErrors(logOf([4], 2));
  assert.equal(e.length, 2);
  assert.equal(e[0].at, NOW - 4 * MIN);
  assert.match(e[0].url, /^https:\/\/bootstrap-7\.example\.org\/bootstrap\//);
});

test('steady refusals for 30 minutes, still failing: restart, and the bootstrap to check first', () => {
  const v = registrationVerdict(putErrors(logOf(every5, 2)), { now: NOW, startedAt: STARTED });
  assert.equal(v.restart, true);
  assert.equal(v.bootstrap, 'https://bootstrap-7.example.org');
  assert.match(v.reason, /^12 refused registrations in 30 minutes/);
});

test('one network stuck is enough (six in 30 minutes)', () => {
  assert.equal(registrationVerdict(putErrors(logOf(every5, 1)), { now: NOW, startedAt: STARTED }).restart, true);
});

test('a short burst is not stuck: it must span the window and still be failing', () => {
  assert.equal(registrationVerdict(putErrors(logOf([9, 8, 7, 6, 5, 4], 1)), { now: NOW, startedAt: STARTED }).restart, false);
  assert.equal(registrationVerdict(putErrors(logOf([29, 27, 25, 23, 21, 19], 1)), { now: NOW, startedAt: STARTED }).restart, false);
});

test('never within 30 minutes of a start, never twice in 6 hours', () => {
  const errors = putErrors(logOf(every5, 2));
  assert.equal(registrationVerdict(errors, { now: NOW, startedAt: NOW - 20 * MIN }).restart, false);
  assert.equal(registrationVerdict(errors, { now: NOW, startedAt: STARTED, lastRestartAt: NOW - 5 * 60 * MIN }).restart, false);
  assert.equal(registrationVerdict(errors, { now: NOW, startedAt: STARTED, lastRestartAt: NOW - 7 * 60 * MIN }).restart, true);
});

test('a clean log changes nothing', () => {
  assert.deepEqual(putErrors('2026-10-29T07:29:00Z INFO all good\n'), []);
  assert.equal(registrationVerdict([], { now: NOW, startedAt: STARTED }).restart, false);
});
