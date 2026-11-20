// Hooks ported from Cursor's plugins (ralph-loop, advisor, continual-learning): feed each sample Claude Code inputs in
// a temporary project and assert continue, stay quiet, or record. Touches no real project. Prints PASS when all hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const hooks = join(resolve(import.meta.dirname, '..'), 'hooks');

function project() {
  return mkdtempSync(join(tmpdir(), 'upstream-hooks-'));
}

function run(hook, args, payload, dir, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extraEnv };
  delete env.SISO_RALPH_LOOP;
  delete env.SISO_ADVISOR;
  const result = spawnSync(process.execPath, [join(hooks, hook), ...args], {
    input: JSON.stringify(payload), encoding: 'utf8', env, timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function ralphState(dir, { iteration = 1, max = 0, promise = 'null', prompt = 'Build the thing.' } = {}) {
  mkdirSync(join(dir, '.claude', 'ralph'), { recursive: true });
  const promiseLine = promise === 'null' ? 'null' : `"${promise}"`;
  writeFileSync(join(dir, '.claude', 'ralph', 'scratchpad.md'),
    `---\niteration: ${iteration}\nmax_iterations: ${max}\ncompletion_promise: ${promiseLine}\n---\n\n${prompt}\n`);
}

const ralph = (dir, extra = {}) => run('ralph-loop.mjs', [], { session_id: 's1', hook_event_name: 'Stop', stop_hook_active: false, ...extra }, dir);

test('ralph-loop: no state file lets the session end', () => {
  assert.equal(ralph(project()), null);
});

test('ralph-loop: an active loop feeds the prompt back and counts the iteration', () => {
  const dir = project();
  ralphState(dir, { promise: 'COMPLETE' });
  const out = ralph(dir, { last_assistant_message: 'still working' });
  assert.equal(out.decision, 'block');
  assert.equal(out.reason, '[Ralph loop iteration 2. To complete: output <promise>COMPLETE</promise> ONLY when genuinely true.]\n\nBuild the thing.');
  assert.match(readFileSync(join(dir, '.claude', 'ralph', 'scratchpad.md'), 'utf8'), /^iteration: 2$/m);
});

test('ralph-loop: the completion promise in the reply ends the loop and clears state', () => {
  const dir = project();
  ralphState(dir, { promise: 'COMPLETE' });
  assert.equal(ralph(dir, { last_assistant_message: 'All green. <promise> COMPLETE </promise>' }), null);
  assert.equal(existsSync(join(dir, '.claude', 'ralph', 'scratchpad.md')), false);
});

test('ralph-loop: max_iterations ends the loop', () => {
  const dir = project();
  ralphState(dir, { iteration: 3, max: 3 });
  assert.equal(ralph(dir), null);
  assert.equal(existsSync(join(dir, '.claude', 'ralph', 'scratchpad.md')), false);
});

test('ralph-loop: a corrupted state file stops instead of looping', () => {
  const dir = project();
  ralphState(dir, { iteration: 'x' });
  assert.equal(ralph(dir), null);
});

test('ralph-loop: another session sharing the checkout is never fed the prompt', () => {
  const dir = project();
  ralphState(dir);
  assert.equal(ralph(dir).decision, 'block');
  assert.equal(ralph(dir, { session_id: 's2' }), null);
});

function advisorState(dir, state = {}) {
  mkdirSync(join(dir, '.claude', 'advisor'), { recursive: true });
  writeFileSync(join(dir, '.claude', 'advisor', 'state.json'), JSON.stringify({ enabled: true, model: 'opus', ...state }));
}
const advisor = (dir, mode, extra = {}) => run('advisor.mjs', [mode], { session_id: 's1', ...extra }, dir);
const edit = (dir, file = '/repo/src/a.ts', extra = {}) => advisor(dir, 'mark', { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: file }, ...extra });

test('advisor: off unless state.json is enabled', () => {
  const dir = project();
  advisorState(dir, { enabled: false });
  edit(dir);
  assert.equal(existsSync(join(dir, '.claude', 'advisor', 'pending')), false);
  assert.equal(advisor(dir, 'stop', { last_assistant_message: 'done' }), null);
});

test('advisor: edits then a stop ask for the consult once per batch', () => {
  const dir = project();
  advisorState(dir);
  edit(dir);
  const out = advisor(dir, 'stop', { last_assistant_message: 'Done.' });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^\[Advisor\] Files changed since the last advisor consult/);
  assert.match(out.reason, /\(model: opus\)/);
  assert.equal(advisor(dir, 'stop', { last_assistant_message: 'Done.' }), null);
});

test('advisor: a reply ending in a question stays quiet and keeps the marker armed', () => {
  const dir = project();
  advisorState(dir);
  edit(dir);
  assert.equal(advisor(dir, 'stop', { last_assistant_message: 'Which one do you want?' }), null);
  assert.equal(existsSync(join(dir, '.claude', 'advisor', 'pending')), true);
});

test('advisor: a consult by advisor-subagent clears the marker and is logged', () => {
  const dir = project();
  advisorState(dir);
  edit(dir);
  advisor(dir, 'record', { hook_event_name: 'SubagentStop', agent_type: 'advisor-subagent', last_assistant_message: 'Verdict: ship.' });
  assert.equal(existsSync(join(dir, '.claude', 'advisor', 'pending')), false);
  assert.match(readFileSync(join(dir, '.claude', 'advisor', 'log.md'), 'utf8'), /Verdict: ship\./);
  assert.equal(JSON.parse(readFileSync(join(dir, '.claude', 'advisor', 'state.json'), 'utf8')).consults, 1);
});

test('advisor: its own state files and other sessions do not arm it', () => {
  const dir = project();
  advisorState(dir);
  edit(dir, join(dir, '.claude', 'advisor', 'state.json'));
  assert.equal(existsSync(join(dir, '.claude', 'advisor', 'pending')), false);
  edit(dir, '/repo/b.ts', { session_id: 's1' });
  edit(dir, '/repo/c.ts', { session_id: 's2' });
  assert.equal(advisor(dir, 'stop', { session_id: 's2', last_assistant_message: 'Done.' }), null);
});

test('continual-learning: asks for the memory update only after enough turns, then resets', () => {
  const dir = project();
  const transcript = join(dir, 't.jsonl');
  const env = { CONTINUAL_LEARNING_MIN_TURNS: '2', CONTINUAL_LEARNING_MIN_MINUTES: '1' };
  const stop = (n) => {
    writeFileSync(transcript, `${n}\n`);
    return run('continual-learning.mjs', [], { session_id: 's1', transcript_path: transcript, stop_hook_active: false }, dir, env);
  };
  assert.equal(stop(1), null);
  const out = stop(2);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^Run the `continual-learning` skill now\./);
  assert.equal(stop(3), null);
});

if (process.argv[1] === import.meta.filename) {
  process.on('exit', (code) => {
    if (code === 0) console.log('PASS upstream hooks: ralph-loop loops, ends and binds; advisor asks once, stays quiet on "?", logs consults; continual-learning waits for its thresholds');
  });
}
