// End-to-end headless revive: the real resumer, the real headless backend, a
// real spawned process. The unit tests cover each half; this proves the seam
// between them, which is where a pane-less revive would actually break —
// capturePane() returning '' has to route the dispatch through reopen(), and
// reopen() has to hand the prompt over in argv because there is nothing to
// type into.

import { test as baseTest, after } from 'node:test';

// Spawns a POSIX shim as the "agent". The behaviour under test is
// platform-independent and covered on Windows by test/headless.test.js.
const test = process.platform === 'win32'
  ? (name, fn) => baseTest(name, { skip: 'unix-only harness (sh agent shim)' }, fn)
  : baseTest;
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-headless-revive-'));
process.env.UNSNOOZE_STATE_DIR = DIR;
process.env.UNSNOOZE_NOTIFICATIONS = 'off';
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');
process.env.UNSNOOZE_VERIFY_DELAY_MS = '0';

const { dispatchOne } = await import('../src/resumer.js');
const { upsertSession } = await import('../src/state.js');
const { createHeadless } = await import('../src/multiplexers/headless.js');
const { RESUME_SESSION_NAME } = await import('../src/config.js');

after(() => rmSync(DIR, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

// A stand-in for `node bin/unsnooze.js _run claude …`: records the argv it was
// launched with so we can assert what a real revive would have run.
const RECORD = join(DIR, 'argv.txt');
const SHIM = join(DIR, 'fake-agent.sh');
writeFileSync(SHIM, `#!/bin/sh\nprintf '%s\\n' "$@" > "${RECORD}"\necho "agent started"\n`);
chmodSync(SHIM, 0o755);

function seed(overrides = {}) {
  const rec = {
    sessionId: '00000000-0000-4000-8000-000000000042',
    cwd: DIR, pane: null, mux: 'headless', paneOwner: null,
    muxSession: 'unsnooze-headless', agent: 'claude',
    status: 'stopped', limitType: '5h', detectedVia: 'hook',
    detectedAt: Date.now() - 3_600_000, resetAt: Date.now() - 1000,
    resetSource: 'absolute', attempts: 0,
    ...overrides,
  };
  const state = upsertSession(rec);
  return Object.values(state.sessions).find(s => s.sessionId === rec.sessionId);
}

test('a headless revive spawns a real process and carries the prompt in argv', async () => {
  const rec = seed();
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  const result = await dispatchOne(rec, {
    mux,
    resolveMux: () => mux,
    selfCmd: [SHIM],   // stands in for [node, bin/unsnooze.js]
  });

  assert.equal(result, 'reopen', 'no pane to type into means the reopen path');

  // The child is detached; give it a moment to write.
  for (let i = 0; i < 40 && !existsSync(RECORD); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(existsSync(RECORD), 'the revive must actually start a process');

  const argv = readFileSync(RECORD, 'utf-8').trim().split('\n');
  assert.deepEqual(argv.slice(0, 3), ['_run', 'claude', '--resume'],
    `revive argv was ${JSON.stringify(argv)}`);
  assert.equal(argv[3], '00000000-0000-4000-8000-000000000042');
  assert.ok(argv[4] && argv[4].length > 0,
    'the resume prompt must ride in argv — headless can never type it');
});

test('the revive output is captured where a user can actually read it', async () => {
  const logDir = join(DIR, 'logs');
  assert.ok(existsSync(logDir), 'headless must create its log dir');
  // Named for the session the revive actually landed in, not the record's
  // muxSession: headless deliberately has no sessionExists(), so reviveTarget()
  // cannot confirm the old session and falls through to RESUME_SESSION_NAME.
  const log = join(logDir, `${RESUME_SESSION_NAME}.log`);
  for (let i = 0; i < 40 && !existsSync(log); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(existsSync(log), `expected a log at ${log}`);
  assert.match(readFileSync(log, 'utf-8'), /agent started/,
    'with no pane to scroll back through, the log is the only record');
});

// #25: every headless Codex revival used to run the TUI form, which exits 1
// before touching the session ("stdin is not a terminal"). The seam that has
// to hold is backendCanType(headless) → codex.resumeArgs(canType: false) →
// argv, through the real resumer.
test('a headless codex revive runs `exec resume`, not the TUI', async () => {
  const record = join(DIR, 'argv-codex.txt');
  const shim = join(DIR, 'fake-codex-launcher.sh');
  writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);
  chmodSync(shim, 0o755);
  const rec = seed({ agent: 'codex', sessionId: '019f56fe-3508-7f10-8bb2-5e1db403916f', detectedVia: 'transcript' });
  const mux = createHeadless({ logDir: join(DIR, 'logs'), env: {} });

  const result = await dispatchOne(rec, { mux, resolveMux: () => mux, selfCmd: [shim] });
  assert.equal(result, 'reopen');
  for (let i = 0; i < 40 && !existsSync(record); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  const argv = readFileSync(record, 'utf-8').trim().split('\n');
  assert.deepEqual(argv.slice(0, 5), ['_run', 'codex', 'exec', 'resume', '019f56fe-3508-7f10-8bb2-5e1db403916f'],
    `revive argv was ${JSON.stringify(argv)}`);
  assert.ok(argv[5] && argv[5].length > 0, 'the wake prompt rides in argv');
});
