// report-guard: a final reply never asks Shaan to run a command, and a pinned thread woken by another agent closes short.
// Shaan, 19 Nov: "I don't understand why you would ever ask me to run a fucking command".
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REASON_COMMAND, reportGuard } from '../hooks/lib/report-guard.mjs';

const guard = (text, extra = {}) => reportGuard({ text, lastUserText: 'go', pinned: false, ...extra });
const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const wake = '[from: Ops · partner co-founder] Done: ...';

test('report guard blocks a reply that asks the reader to run a command', () => {
  for (const text of [
    "**Your next step, before 02:50Z: run this one command in a terminal.**\n```\nssh edge-vps 'sudo touch /etc/streaming/live-hold'\n```",
    "You'll need to paste this command: `sudo pacman -Syu`",
    'Run this command in your terminal to sign in: `siso-login partner`'
  ]) assert.equal(guard(text), REASON_COMMAND, text);
});

test('report guard passes a mention that is not an ask', () => {
  for (const text of [
    'To re-check: `bash infra/lima/ship.sh <ref>` on any ref.',
    'I ran the command and it printed PASS.',
    "You don't need to run a command for this.",
    'The builder runs the command on the box.',
    'Agents never ask you to run a command now; a hook refuses it.'
  ]) assert.equal(guard(text), null, text);
});

// Shaan, 19 Nov: "give it more power and less guardrails". A run that already happened is news, not an ask.
test('report guard: the verb as a noun or after has/was is a mention; an ask next to it still blocks', () => {
  for (const text of [
    'Shaan, the run in the terminal finished clean.',
    'The test run in CI passed, Shaan.',
    'Shaan, your last run in the shell was clean.',
    'The migration has run in your terminal, Shaan.'
  ]) assert.equal(guard(text), null, text);
  for (const text of [
    'Shaan, run this in your terminal: `siso-login partner`',
    'In your terminal run `pnpm test`.',
    'After that run the migration in your shell.',
    'Open a terminal and type `siso-login partner`, Shaan.',
    'Before the run ends, run this command in your terminal.',
    'Shaan, the next step: paste this command into the shell.'
  ]) assert.equal(guard(text), REASON_COMMAND, text);
});

test('report guard: a long reply to an agent wake in a pinned thread blocks; the rest pass', () => {
  const out = guard(words(120), { pinned: true, lastUserText: wake });
  assert.match(out, /^SISO report guard: another agent's message started this turn, and this reply is 120 words\./);
  assert.equal(guard(words(40), { pinned: true, lastUserText: wake }), null);
  assert.equal(guard(words(120), { pinned: true, lastUserText: 'Now bigger picture wise...' }), null);
  assert.equal(guard(words(120), { pinned: false, lastUserText: wake }), null);
});

test('report guard checks the command ask before the length', () => {
  const text = `Run this command in your terminal: \`ls\`\n${words(120)}`;
  assert.equal(guard(text, { pinned: true, lastUserText: wake }), REASON_COMMAND);
});

// End to end through pending-stop's Stop mode, in the style of pending-stop.test.mjs.
const hook = join(resolve(import.meta.dirname, '..'), 'hooks', 'pending-stop.mjs');
const home = mkdtempSync(join(tmpdir(), 'report-guard-'));
const env = { ...process.env, SISO_STATE_HOME: home, T3CODE_THREAD_ID: 'mine', T3CODE_CLI_PATH: join(home, 'missing') };
delete env.SISO_PENDING_STOP;
let counter = 0;

function stop(userText, extra = {}, extraEnv = {}) {
  counter += 1;
  const transcript = join(home, `s${counter}.jsonl`);
  writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: userText } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>noise</system-reminder>' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const result = spawnSync(process.execPath, [hook, 'stop'], {
    input: JSON.stringify({ session_id: `rg-${counter}`, transcript_path: transcript, hook_event_name: 'Stop', stop_hook_active: false, ...extra }),
    encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 10000
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

const ask = 'Run this command in your terminal to sign in: `siso-login partner`';

test('report guard through pending-stop: a command ask blocks once, stop_hook_active lets it end', () => {
  const out = stop('go', { last_assistant_message: ask });
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /report guard/);
  assert.equal(stop('go', { last_assistant_message: ask, stop_hook_active: true }), null);
  assert.equal(stop('go', { last_assistant_message: 'Done: PR merged, check PASS.' }), null);
});

test('report guard through pending-stop: an agent wake in a pinned thread, read via the t3 CLI', () => {
  const cli = join(home, 't3-pinned');
  writeFileSync(cli, `#!/bin/sh\n[ "$1 $2 $3" = "thread show --json" ] && [ "$6" = "mine" ] && echo '{"thread":{"pinned":true}}'\n`);
  chmodSync(cli, 0o755);
  const out = stop(wake, { last_assistant_message: words(120) }, { T3CODE_CLI_PATH: cli });
  assert.match(out.reason, /this reply is 120 words/);
  // No CLI, so not pinned: the turn ends.
  assert.equal(stop(wake, { last_assistant_message: words(120) }), null);
});

test('a reminder in front of Shaan\'s own words does not make the turn an agent wake', () => {
  const root = mkdtempSync(join(tmpdir(), 'rg-reminder-'));
  const transcript = join(root, 't.jsonl');
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  writeFileSync(transcript, [
    { type: 'user', message: { content: '[from: Ops] Done: the kit is merged.' } },
    { type: 'user', message: { content: '<system-reminder>\nAttribution lines.\n</system-reminder>\nkeep Agent Zero running' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: long }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = spawnSync(process.execPath, [new URL('../hooks/pending-stop.mjs', import.meta.url).pathname, 'stop'], {
    input: JSON.stringify({ session_id: 'rg-reminder', transcript_path: transcript, last_assistant_message: long }),
    encoding: 'utf8', env: { ...process.env, SISO_HOOK_STATE_DIR: root, XDG_STATE_HOME: root, T3CODE_THREAD_ID: '' },
  });
  assert.equal(run.stdout.trim(), '');
});
