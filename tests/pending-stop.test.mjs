// pending-stop: feed the hook sample PostToolUse and Stop inputs and assert block or allow.
// Runs in a temporary state home with fake transcripts; it touches no real session. Prints PASS when every case holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const hook = join(resolve(import.meta.dirname, '..'), 'hooks', 'pending-stop.mjs');
const home = mkdtempSync(join(tmpdir(), 'pending-stop-'));
const env = { ...process.env, SISO_STATE_HOME: home };
delete env.SISO_PENDING_STOP;
let counter = 0;

function session() {
  counter += 1;
  const id = `test-session-${counter}`;
  const transcript = join(home, `${id}.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } })}\n`);
  return { id, transcript };
}

function run(mode, payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [hook, mode], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const mark = (s, tool_name, tool_input, tool_response) =>
  run('mark', { session_id: s.id, transcript_path: s.transcript, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response });
const stop = (s, extra = {}) =>
  run('stop', { session_id: s.id, transcript_path: s.transcript, hook_event_name: 'Stop', stop_hook_active: false, ...extra });
const say = (s, text) => appendFileSync(s.transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`);
const background = (s, id = 'bxeegngan') => mark(s, 'Bash',
  { command: 'npm test', description: 'Run package check', run_in_background: true },
  { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id });

test('no marker: the stop is allowed', () => {
  assert.equal(stop(session()), null);
});

test('marker set by a background command: the stop is blocked with the job named', () => {
  const s = session();
  background(s);
  const out = stop(s);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^Your job Run package check is still running: hand it off as below so you are woken when it ends, then report\./);
  assert.match(out.reason, /t3_background_wait with taskIds \["bxeegngan"\] and end your turn/);
  assert.doesNotMatch(out.reason, /until .*sleep/);
  assert.match(out.reason, /pending-stop\.mjs release bash:bxeegngan/);
});

// T3's t3_background_wait: a tool_use, then T3's answer naming the ids it now tracks (17 Nov 2026).
const handOff = (s, ids, matched = ids, useId = `toolu_${ids.join('_')}`) => {
  appendFileSync(s.transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: useId, name: 'mcp__t3-code__t3_background_wait', input: { taskIds: ids } }] } })}\n`);
  appendFileSync(s.transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: useId, content: [{ type: 'text', text: JSON.stringify({ matched, unmatched: ids.filter((id) => !matched.includes(id)) }) }] }] } })}\n`);
};

test('a background command handed to T3 with t3_background_wait: the stop is allowed', () => {
  const s = session();
  background(s, 'bt3wait');
  handOff(s, ['bt3wait']);
  assert.equal(stop(s), null);
  assert.equal(existsSync(join(home, 'pending', `${s.id}.json`)), false);
});

test('t3_background_wait that T3 did not match, or for another id, keeps the block', () => {
  const s = session();
  background(s, 'bmiss');
  handOff(s, ['bmiss'], []);
  assert.equal(stop(s).decision, 'block');
  const t = session();
  background(t, 'bmine');
  handOff(t, ['bother']);
  assert.equal(stop(t).decision, 'block');
});

test('a PR hint offers watch_pull_request and never a foreground wait', () => {
  const s = session();
  mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/990\n' });
  const out = stop(s);
  assert.match(out.reason, /watch_pull_request and end your turn/);
  assert.doesNotMatch(out.reason, /foreground wait|gh run watch/);
});

test('loop limit: three blocks while stop_hook_active, then the stop is allowed', () => {
  const s = session();
  background(s);
  assert.equal(stop(s).decision, 'block');
  assert.equal(stop(s, { stop_hook_active: true }).decision, 'block');
  assert.equal(stop(s, { stop_hook_active: true }).decision, 'block');
  assert.equal(stop(s, { stop_hook_active: true }), null);
  // A new user turn resets the count: the marker is still armed.
  assert.equal(stop(s).decision, 'block');
});

test('a reply that ends in "?" is allowed and keeps the marker', () => {
  const s = session();
  background(s);
  assert.equal(stop(s, { last_assistant_message: 'Which branch should this land on?' }), null);
  say(s, 'Should I wait for it?  ');
  assert.equal(stop(s), null);
  say(s, 'Still waiting.');
  assert.equal(stop(s).decision, 'block');
});

test('marker cleared by the completion notification in the transcript', () => {
  const s = session();
  background(s, 'bdone1');
  appendFileSync(s.transcript, `${JSON.stringify({ type: 'queue-operation', operation: 'enqueue',
    content: '<task-notification>\n<task-id>bdone1</task-id>\n<status>completed</status>\n</task-notification>' })}\n`);
  assert.equal(stop(s), null);
  assert.equal(existsSync(join(home, 'pending', `${s.id}.json`)), false);
});

test('a notification from before the job started does not clear it', () => {
  const s = session();
  appendFileSync(s.transcript, `${JSON.stringify({ type: 'queue-operation', content: '<task-id>bold</task-id>' })}\n`);
  background(s, 'bold');
  assert.equal(stop(s).decision, 'block');
});

test('marker cleared by the release command', () => {
  const s = session();
  background(s, 'brel');
  mark(s, 'Bash', { command: "node ~/.siso/agent-hooks/0.1.0/hooks/pending-stop.mjs release bash:brel 'handed to the Mini job'" }, { stdout: 'ok' });
  assert.equal(stop(s), null);
});

test('marker cleared by stopping the background command', () => {
  const s = session();
  background(s, 'bkill');
  mark(s, 'TaskStop', { task_id: 'bkill' }, { message: 'stopped' });
  assert.equal(stop(s), null);
});

// Shaan, 19 Nov: "I'm sending messages and they end up queuing". T3 wakes the parent with "Delegated task <id> (...)
// [status]" when a child ends, so running delegates are handed off at birth and the owner's turn ends at once.
test('running delegates never block the stop, and set no marker', () => {
  const s = session();
  for (const n of [1, 2, 3, 4, 5, 6]) {
    mark(s, 'mcp__t3-code__delegate_task', { title: `builder ${n}` },
      JSON.stringify({ taskId: `node:delegated-task:command%3Amcp%3Aabc%3Adelegate-task%3Ajob-${n}`, childThreadId: `thread:job-${n}`, status: 'running' }));
  }
  mark(s, 'mcp__t3-code__delegate_task', { title: 'Still going', mode: 'wait' },
    JSON.stringify({ taskId: 'node:delegated-task:remote-delegate%3Arun-1', status: 'running', workState: 'working', waitTimedOut: true }));
  assert.equal(stop(s), null);
  assert.equal(existsSync(join(home, 'pending', `${s.id}.json`)), false);
});

test('delegates beside a background command: only the command is named', () => {
  const s = session();
  mark(s, 'mcp__t3-code__delegate_task', { title: 'builder' },
    JSON.stringify({ taskId: 'node:delegated-task:job-x', childThreadId: 'thread:job-x', status: 'running' }));
  background(s, 'bmix');
  const out = stop(s);
  assert.match(out.reason, /^Your job Run package check is still running/);
  assert.doesNotMatch(out.reason, /t3_thread_wait|builder/);
});

test('a delegate marker written by the old version is dropped at the next stop', () => {
  const s = session();
  const path = join(home, 'pending', `${s.id}.json`);
  mkdirSync(join(home, 'pending'), { recursive: true });
  writeFileSync(path, JSON.stringify({ session_id: s.id, transcript_path: s.transcript, blocks: 0, items: {
    'delegate:job-old': { kind: 'delegate', id: 'job-old', label: 'old builder', thread_id: 'thread:old', started_at: new Date().toISOString(), offset: 0 }
  } }));
  assert.equal(stop(s), null);
  assert.equal(existsSync(path), false);
});

test('PR: blocked after gh pr create, allowed after gh pr merge or watch_pull_request', () => {
  const s = session();
  mark(s, 'Bash', { command: 'git push -u origin HEAD && gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/970\n' });
  assert.match(stop(s).reason, /^Your job PR https:\/\/github\.com\/sisodias\/siso\/pull\/970 is still running/);
  mark(s, 'Bash', { command: 'gh pr merge 970 --squash --delete-branch' }, { stdout: '' });
  assert.equal(stop(s), null);

  const t = session();
  mark(t, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/971\n' });
  mark(t, 'mcp__t3-code__watch_pull_request', { url: 'https://github.com/sisodias/siso/pull/971' },
    [{ type: 'text', text: JSON.stringify({ number: 971, url: 'https://github.com/sisodias/siso/pull/971', watching: true }) }]);
  assert.equal(stop(t), null);
});

// Agent Zero, 16 Nov: PRs 967 and 968 were merged yet the hook kept blocking, for the three reasons below.
test('PR: create and merge in one command, with a variable number and 2>&1, clears that PR only', () => {
  const s = session();
  mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/972\n' });
  mark(s, 'Bash', { command: 'url=$(gh pr create --fill 2>&1); n=${url##*/}; for i in 1 2 3; do gh pr merge $n --squash --delete-branch=false 2>&1 && break; sleep 4; done' },
    { stdout: 'https://github.com/sisodias/siso/pull/973\nMERGED abc\n' });
  const out = stop(s);
  assert.match(out.reason, /pull\/972 is still running/);
  assert.doesNotMatch(out.reason, /pull\/973/);
});

test('PR: a redirect such as 2>&1 is not read as the PR number', () => {
  const s = session();
  mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/974\n' });
  mark(s, 'Bash', { command: 'gh pr merge $n --squash 2>&1 | tail -1' }, { stdout: '' });
  assert.equal(stop(s), null);
});

// 16 Nov: one command merged PRs 974 and 978 (with a gh pr view and a head SHA between them); only 974 was cleared,
// so the merged 978 blocked the stop.
test('PR: every gh pr merge in one command clears its own PR, and only those', () => {
  const s = session();
  for (const n of [974, 978, 980]) mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: `https://github.com/sisodias/siso/pull/${n}\n` });
  mark(s, 'Bash', { command: 'gh pr merge 974 --repo sisodias/siso --squash --match-head-commit 602fad60ed 2>&1 | tail -3; gh pr view 974 --json state; gh pr merge 978 --repo sisodias/siso --squash --delete-branch 2>&1 | tail -3; gh pr view 980 --json state' },
    { stdout: '974 MERGED\n978 MERGED\n' });
  const out = stop(s);
  assert.match(out.reason, /pull\/980 is still running/);
  assert.doesNotMatch(out.reason, /pull\/97[48]\b/);
});

test('two release commands in one Bash call clear both markers', () => {
  const s = session();
  mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/975\n' });
  mark(s, 'Bash', { command: 'gh pr create --fill' }, { stdout: 'https://github.com/sisodias/siso/pull/976\n' });
  mark(s, 'Bash', { command: "node pending-stop.mjs release pr:https://github.com/sisodias/siso/pull/975 'merged' && node pending-stop.mjs release pr:https://github.com/sisodias/siso/pull/976 'merged'" }, { stdout: 'ok' });
  assert.equal(stop(s), null);
});

test('a subagent\'s own background command does not arm the parent', () => {
  const s = session();
  run('mark', { session_id: s.id, transcript_path: s.transcript, agent_id: 'sub-1', tool_name: 'Bash',
    tool_input: { command: 'sleep 9', run_in_background: true }, tool_response: { backgroundTaskId: 'bsub' } });
  assert.equal(stop(s), null);
});

test('a marker older than the TTL is dropped', () => {
  const s = session();
  background(s, 'bstale');
  const path = join(home, 'pending', `${s.id}.json`);
  const state = JSON.parse(readFileSync(path, 'utf8'));
  state.items['bash:bstale'].started_at = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
  writeFileSync(path, JSON.stringify(state));
  assert.equal(stop(s), null);
});

test('switched off, or fed garbage, it allows', () => {
  const s = session();
  background(s, 'boff');
  assert.equal(stop(s).decision, 'block'); // armed
  const off = spawnSync(process.execPath, [hook, 'stop'], { input: JSON.stringify({ session_id: s.id, transcript_path: s.transcript }),
    encoding: 'utf8', env: { ...env, SISO_PENDING_STOP: 'off' } });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
  for (const mode of ['mark', 'stop', '']) {
    const bad = spawnSync(process.execPath, [hook, mode], { input: '{broken', encoding: 'utf8', env });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
  }
});

test('release, run by hand, only prints', () => {
  const result = spawnSync(process.execPath, [hook, 'release', 'all', 'handed', 'off'], { encoding: 'utf8', env, input: '' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /release all recorded/);
});

process.on('exit', (code) => {
  if (!code && !process.exitCode) console.log('PASS pending-stop: marker set blocks, marker cleared allows, loop limit 3 allows, "?" allows');
});
