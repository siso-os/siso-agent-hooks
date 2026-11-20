import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, closeSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
// Sends made by tests never touch the machine's shared send budget or speak as this thread.
delete process.env.T3CODE_THREAD_ID;
process.env.SISO_SEND_GUARD_STATE = join(mkdtempSync(join(tmpdir(), 'send-guard-')), 'sends.jsonl');
// The heavy rule only applies where a `heavy` command is on PATH (the Macs); give the build tests a fake one.
const fakeHeavyDir = mkdtempSync(join(tmpdir(), 'fake-heavy-'));
writeFileSync(join(fakeHeavyDir, 'heavy'), '#!/bin/sh\nexec "$@"\n');
chmodSync(join(fakeHeavyDir, 'heavy'), 0o755);
const withHeavy = { PATH: `${fakeHeavyDir}:${process.env.PATH}` };
const withoutHeavy = { PATH: (process.env.PATH || '').split(':').filter((dir) => dir && !existsSyncSafe(join(dir, 'heavy'))).join(':') };
function existsSyncSafe(path) { try { readFileSync(path); return true; } catch { return false; } }

function run(relativePath, payload, args = [], environment = {}) {
  return runIn(root, relativePath, payload, args, environment);
}

function runIn(base, relativePath, payload, args = [], environment = {}) {
  return spawnSync(process.execPath, [join(base, relativePath), ...args], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...environment }
  });
}

test('every hook fails open on malformed input', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'hooks.manifest.json'), 'utf8'));
  for (const hook of manifest.hooks) {
    const result = run(hook.file, '{broken');
    assert.equal(result.status, 0, hook.id);
  }
});

test('safety guard denies destructive broad commands', () => {
  for (const command of ['git reset --hard', "git reset '--hard'", 'git -C /tmp reset --hard', 'rm -rf /', 'rm -fr "$HOME"', 'rm -rf ~', 'rm -rf /;ls']) {
    const result = run('hooks/safety-guard.mjs', {
      tool_name: 'Bash', tool_input: { command }
    });
    assert.equal(result.status, 0, command);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', command);
  }
  for (const tool_name of ['exec', 'exec_command', 'functions.exec']) {
    const result = run('hooks/safety-guard.mjs', { tool_name, tool_input: { command: 'git reset --hard' } });
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', tool_name);
  }
});

// The house table is the machine's own (hooks/lib/houses.mjs, left out of the public copy; tests/houses.test.mjs holds
// its decisions where it exists). These run a copy of the hooks with the example table, and with none.
function payloadWith(table) {
  const base = mkdtempSync(join(tmpdir(), 'houses-'));
  cpSync(join(root, 'hooks'), join(base, 'hooks'), { recursive: true });
  rmSync(join(base, 'hooks', 'lib', 'houses.mjs'), { force: true });
  if (table) copyFileSync(join(root, 'hooks', 'lib', table), join(base, 'hooks', 'lib', 'houses.mjs'));
  return base;
}

test('house wall: the house table fences another house\'s logins; with no table every seat is open', () => {
  const example = payloadWith('houses.example.mjs');
  const open = payloadWith(null);
  const seats = { home: { CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' }, acme: { CLAUDE_CONFIG_DIR: '/home/u/.config/claude-acme', CODEX_HOME: '' } };
  const decide = (base, seat, command) => {
    const result = runIn(base, 'hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command } }, [], seats[seat]);
    assert.equal(result.status, 0, command);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : { permissionDecision: 'allow' };
  };
  for (const [seat, command, want] of [
    ['home', 'ls ~/ACME_Workspace/notes', 'allow'],
    ['home', 'cat ~/ACME_Workspace/.credentials/key', 'deny'],
    ['home', `python3 -c "print(open('/home/u/ACME_Workspace/.credentials/key').read())"`, 'deny'],
    ['home', "cat <<'EOF' | sh\ntar -c $HOME/ACME_Workspace/.credentials\nEOF", 'deny'],
    ['home', 'jq . ~/.config/claude-acme/settings.json', 'deny'],
    ['acme', 'cat ~/ACME_Workspace/.credentials/key', 'allow']
  ]) {
    assert.equal(decide(example, seat, command).permissionDecision, want, `${seat}: ${command}`);
    assert.equal(decide(open, seat, command).permissionDecision, 'allow', `no table, ${seat}: ${command}`);
  }
  assert.equal(decide(example, 'home', 'ls ~/ACME_Workspace/.credentials').permissionDecisionReason,
    "SISO house wall: a home seat may not run a command that names ACME's credentials or seat config. Credentials and seat config folders hold logins.");
});

test('plan guard: a seat may not start T3 work on another house\'s provider, nested or not; with no table every plan is open', () => {
  const example = payloadWith('houses.example.mjs');
  const open = payloadWith(null);
  for (const tool of ['delegate_task', 't3_thread_launch', 'create_threads', 't3_thread_configure']) {
    for (const [CLAUDE_CONFIG_DIR, seatHouse] of [['', 'HOME'], ['/home/u/.claude', 'HOME'], ['/home/u/.config/claude-acme', 'ACME']]) {
      for (const [providerInstanceId, planHouse] of [['claudeAcme', 'ACME'], ['CODEXACME', 'ACME'], ['codex', 'HOME']]) {
        const payload = { tool_name: `mcp__t3-code__${tool}`, tool_input: { task: 'x', target: { providerInstanceId, model: 'm' } } };
        const label = `${CLAUDE_CONFIG_DIR || 'default'} ${tool} ${providerInstanceId}`;
        const result = runIn(example, 'hooks/safety-guard.mjs', payload, [], { CLAUDE_CONFIG_DIR, CODEX_HOME: '' });
        assert.equal(result.status, 0, label);
        if (seatHouse === planHouse) assert.equal(result.stdout, '', label);
        else {
          const out = JSON.parse(result.stdout).hookSpecificOutput;
          assert.equal(out.permissionDecision, 'deny', label);
          assert.equal(out.permissionDecisionReason,
            `SISO plan guard: a ${seatHouse} seat may not start work on ${providerInstanceId} (${planHouse}'s plan). Each house's agents bill to that house's plans.`, label);
        }
        assert.equal(runIn(open, 'hooks/safety-guard.mjs', payload, [], { CLAUDE_CONFIG_DIR, CODEX_HOME: '' }).stdout, '', `no table: ${label}`);
      }
    }
    const environment = { CLAUDE_CONFIG_DIR: '/home/u/.claude', CODEX_HOME: '' };
    for (const tool_input of [
      { threads: [{ providerInstanceId: 'codex' }, { providerInstanceId: 'claudeAcme' }] },
      { threads: [{ nested: [null, { target: { providerInstanceId: 'codexAcme' } }] }], providerInstanceId: 'codex' }
    ]) {
      const result = runIn(example, 'hooks/safety-guard.mjs', { tool_name: `mcp__t3-code__${tool}`, tool_input }, [], environment);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(tool_input));
    }
    for (const tool_input of [undefined, null, {}, { task: 'x' }, { threads: [null, {}, { target: {} }] }]) {
      const result = run('hooks/safety-guard.mjs', { tool_name: `mcp__t3-code__${tool}`, tool_input }, [], environment);
      assert.equal(result.status, 0);
      assert.equal(result.stdout, '');
    }
  }
  const manifest = JSON.parse(readFileSync(join(root, 'hooks.manifest.json'), 'utf8'));
  assert.ok(manifest.profiles.claude.events.PreToolUse.some((entry) => entry.hook === 'safety-guard'
    && entry.matcher === '^mcp__t3-code__(delegate_task|t3_thread_launch|create_threads|t3_thread_configure|t3_thread_send|t3_thread_organize|link_pull_requests?)$'));
});

test('safety guard allows ordinary commands', () => {
  const result = run('hooks/safety-guard.mjs', {
    tool_name: 'Bash', tool_input: { command: 'npm test' }
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('model guard refuses a GPT model older than 6.2 wherever work names one', () => {
  const environment = { CLAUDE_CONFIG_DIR: '/home/u/.claude', CODEX_HOME: '' };
  const denied = (result, model, label) => {
    assert.equal(result.status, 0, label);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'deny', label);
    assert.equal(out.permissionDecisionReason, `SISO model guard: ${model} is older than GPT-6.2, and Shaan banned old GPT models (20 Nov: "just anything that ain't 6.2, just fucking ban it"). Use gpt-6.2-sol (or gpt-6.2-astra).`, label);
  };
  const allowed = (result, label) => { assert.equal(result.status, 0, label); assert.equal(result.stdout, '', label); };
  const t3 = (tool, tool_input) => run('hooks/safety-guard.mjs', { tool_name: `mcp__t3-code__${tool}`, tool_input }, [], environment);
  for (const tool of ['delegate_task', 't3_thread_launch', 'create_threads', 't3_thread_configure']) {
    for (const model of ['gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.1-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'GPT-6.1-SOL', 'openai/gpt-6.1-sol']) {
      denied(t3(tool, { task: 'x', target: { providerInstanceId: 'codex', model } }), model, `${tool} ${model}`);
      denied(t3(tool, { threads: [{ providerInstanceId: 'codex', model: 'gpt-6.2-sol' }, { model }] }), model, `${tool} threads ${model}`);
      denied(t3(tool, { threadId: 't', model }), model, `${tool} top ${model}`);
    }
    for (const model of ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.3-sol', 'gpt-7-sol', 'claude-opus-5-5', 'claude-haiku-5-5']) {
      allowed(t3(tool, { task: 'x', target: { providerInstanceId: 'codex', model } }), `${tool} ${model}`);
    }
  }
  const shell = (command) => run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command } }, [], environment);
  for (const [command, model] of [
    ['codex exec -m gpt-6.1-sol "fix it"', 'gpt-6.1-sol'],
    ['cd /tmp && codex --model=gpt-6.1-terra exec x', 'gpt-6.1-terra'],
    ['codex exec -c model="gpt-6.1-astra" x', 'gpt-6.1-astra'],
    ['CODEX_HOME=/x timeout 600 codex exec --model gpt-6-sol x', 'gpt-6-sol'],
    ['/usr/local/bin/codex exec -m=gpt-5.6-sol x', 'gpt-5.6-sol'],
    ["ssh mini 'codex exec -m gpt-6.1-sol x'", 'gpt-6.1-sol']
  ]) denied(shell(command), model, command);
  for (const command of [
    'codex exec -m gpt-6.2-sol "never use gpt-6.1-sol"', 'codex exec --model gpt-6.2-astra x', 'grep -n gpt-6.1-sol notes.md',
    'echo codex -m gpt-6.1-sol', 'codex exec x'
  ]) allowed(shell(command), command);
});

test('send guard turns every queued T3 send into auto and leaves the rest alone', () => {
  for (const mode of ['queue', undefined, 'later']) {
    const tool_input = { threadId: 't', message: '[from t] request: x', environmentId: 'e', ...(mode === undefined ? {} : { mode }) };
    const result = run('hooks/safety-guard.mjs', { tool_name: 'mcp__t3-code__t3_thread_send', tool_input });
    assert.equal(result.status, 0, String(mode));
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse', String(mode));
    assert.equal(out.permissionDecision, undefined, String(mode));
    assert.deepEqual(out.updatedInput, { ...tool_input, mode: 'auto' }, String(mode));
  }
  for (const tool_input of [{ threadId: 't', message: '[from t] request: x', mode: 'auto' }, { threadId: 't', message: '[from t] request: x', mode: 'steer' },
    { threadId: 't', message: '[from t] request: x', mode: 'restart' }, { threadId: 't', message: '[from t] request: x', mode: 'queue', freshContext: true }, null, 'x']) {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'mcp__t3-code__t3_thread_send', tool_input });
    assert.equal(result.status, 0, JSON.stringify(tool_input));
    assert.equal(result.stdout, '', JSON.stringify(tool_input));
  }
});

test('send guard lets agents message only when it matters', () => {
  const state = join(mkdtempSync(join(tmpdir(), 'send-budget-')), 'sends.jsonl');
  const send = (from, threadId, message, extra = {}) => {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'mcp__t3-code__t3_thread_send', tool_input: { threadId, message, mode: 'auto', ...extra } },
      [], { T3CODE_THREAD_ID: from, SISO_SEND_GUARD_STATE: extra.state || state });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    return result.stdout === '' ? null : JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  };
  // (a) no header: refused, and the refusal shows the format.
  for (const message of ['Merged #12, all green.', 'from A: request: x', '[from A] fyi: started', '', 'request: check x']) {
    assert.match(send('A', 'B', message) || '', /\[from <your name>\] request:.*answer:.*blocked:/, message);
  }
  // (b) an ack is refused, whatever its header.
  for (const message of ['[from X] answer: thanks, received', '[from X] answer: Got it 👍', '[from X] request: ok, on it!', '[from X] blocked:',
    '[from X] answer:\nThanks so much, noted.']) {
    assert.match(send('X', 'Y', message) || '', /an ack interrupts a running turn; send nothing/, message);
  }
  assert.equal(send('X', 'Y', '[from X] answer: thanks, the check is `npm test` in agents/harness/stack'), null);
  // (c) one request or blocker per pair per 30 minutes; another pair is untouched.
  assert.equal(send('A', 'B', '[from A] request: run `npm test`; PASS when hooks.test is green'), null);
  const second = send('A', 'B', '[from A] blocked: the Mini is unreachable over SSH');
  assert.match(second || '', /in the last 30 minutes/);
  const opens = /after (\d\d:\d\d)Z/.exec(second)[1];
  const expected = new Date(Date.now() + 30 * 60 * 1000).toISOString().slice(11, 16);
  assert.ok([expected, new Date(Date.now() + 29 * 60 * 1000).toISOString().slice(11, 16)].includes(opens), opens);
  assert.match(second, /PR, brain file or repo/);
  assert.equal(send('A', 'C', '[from A] request: merge #7 once siso-ci is green'), null);
  assert.equal(send('A', 'B', '[from A] request: same thread on another machine', { environmentId: 'mini' }), null);
  // (d) after B messages A, A may answer B once; a second answer has nothing to answer, so it is a request, and refused.
  assert.equal(send('B', 'A', '[from B] request: which tag did you release? check: git tag -l'), null);
  assert.equal(send('A', 'B', '[from A] answer: stack-20261120-1400-abcdef12'), null);
  assert.match(send('A', 'B', '[from A] answer: and doctor passes') || '', /counts as a request/);
  // (e) a state file that can't be written never blocks a well-formed request, and says nothing.
  const blocker = join(mkdtempSync(join(tmpdir(), 'send-blocked-')), 'file');
  writeFileSync(blocker, 'not a directory');
  for (let index = 0; index < 2; index += 1) {
    assert.equal(send('A', 'B', '[from A] request: run the check', { state: join(blocker, 'sends.jsonl') }), null);
  }
  // Header and ack rules still hold with no known sender, and the budget is skipped.
  const anonymous = (message) => run('hooks/safety-guard.mjs', { tool_name: 'mcp__t3-code__t3_thread_send', tool_input: { threadId: 'B', message, mode: 'auto' } },
    [], { SISO_SEND_GUARD_STATE: state }).stdout;
  assert.match(anonymous('hello'), /"deny"/);
  assert.match(anonymous('[from A] answer: thanks'), /"deny"/);
  assert.equal(anonymous('[from A] request: x'), '');
  assert.equal(anonymous('[from A] request: x'), '');
  // Entries older than a day are pruned on write.
  writeFileSync(state, `${JSON.stringify({ t: Date.now() - 2 * 24 * 60 * 60 * 1000, from: 'old', to: '/x', kind: 'request' })}\n`);
  assert.equal(send('P', 'Q', '[from P] request: x'), null);
  const kept = readFileSync(state, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(kept.map((entry) => [entry.from, entry.to, entry.kind]), [['P', '/Q', 'request']]);
});

test('settle guard keeps a pinned thread from linking PRs or settling, and fails open', () => {
  const fakeDir = mkdtempSync(join(tmpdir(), 'fake-t3-'));
  const fake = (name, body) => { const path = join(fakeDir, name); writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path; };
  const pinned = fake('pinned', `[ "$1 $2 $3" = "thread show --json" ] && [ "$6" = "mine" ] && echo '{"thread":{"pinned":true}}'`);
  const loose = fake('loose', `echo '{"pinned":false}'`);
  const broken = fake('broken', 'exit 3');
  const self = { T3CODE_THREAD_ID: 'mine' };
  const denied = (tool, tool_input, environment) => {
    const result = run('hooks/safety-guard.mjs', { tool_name: `mcp__t3-code__${tool}`, tool_input }, [], environment);
    assert.equal(result.status, 0);
    return result.stdout === '' ? null : JSON.parse(result.stdout).hookSpecificOutput;
  };
  for (const tool of ['link_pull_request', 'link_pull_requests']) {
    const out = denied(tool, { url: 'https://github.com/o/r/pull/1' }, { ...self, T3CODE_CLI_PATH: pinned });
    assert.equal(out.permissionDecision, 'deny', tool);
    assert.match(out.permissionDecisionReason, /^SISO settle guard: .*Don't link the PR here; put its URL in your report\.$/, tool);
    assert.equal(denied(tool, { url: 'u', threadId: 'mine' }, { T3CODE_CLI_PATH: pinned }).permissionDecision, 'deny', tool);
    assert.equal(denied(tool, { url: 'u' }, { ...self, T3CODE_CLI_PATH: loose }), null, tool);
    assert.equal(denied(tool, { url: 'u' }, { ...self, T3CODE_CLI_PATH: broken }), null, tool);
    assert.equal(denied(tool, { url: 'u' }, { ...self, T3CODE_CLI_PATH: join(fakeDir, 'missing') }), null, tool);
    assert.equal(denied(tool, { url: 'u' }, { T3CODE_THREAD_ID: '', T3CODE_CLI_PATH: pinned }), null, tool);
    assert.equal(denied(tool, { url: 'u', threadId: 'other' }, { ...self, T3CODE_CLI_PATH: pinned }), null, tool);
    assert.equal(denied(tool, { url: 'u', environmentId: 'remote' }, { ...self, T3CODE_CLI_PATH: pinned }), null, tool);
  }
  assert.match(denied('t3_thread_organize', { action: 'settle' }, { ...self, T3CODE_CLI_PATH: pinned }).permissionDecisionReason,
    /^SISO settle guard: .*a standing thread never settles\./);
  for (const action of ['pin', 'unpin', 'unsettle', 'snooze', 'archive', 'mark_unread']) {
    assert.equal(denied('t3_thread_organize', { action }, { ...self, T3CODE_CLI_PATH: pinned }), null, action);
  }
  assert.equal(denied('t3_thread_organize', { action: 'settle' }, { ...self, T3CODE_CLI_PATH: loose }), null);
});

test('safety guard rewrites a bare build in Claude Bash to heavy, keeping the other input fields', () => {
  for (const command of ['tsc --noEmit', 'vite build', 'playwright test', 'pnpm install', 'npm ci', 'npm install --prefix x', '  tsc -p .']) {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command, description: 'd', timeout: 5 } }, [], withHeavy);
    assert.equal(result.status, 0, command);
    const out = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, undefined, command);
    assert.deepEqual(out.updatedInput, { command: `heavy -- ${command.trimStart()}`, description: 'd', timeout: 5 }, command);
  }
});

test('safety guard denies bare builds in Codex tools and whole-disk scans anywhere', () => {
  const cases = [['exec_command', 'tsc --noEmit'], ['exec', 'npm ci'], ['Bash', 'find / -name effect'], ['Bash', 'bfs / -name x']];
  for (const [tool_name, command] of cases) {
    const result = run('hooks/safety-guard.mjs', { tool_name, tool_input: { command } }, [], withHeavy);
    assert.equal(result.status, 0, command);
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny', command);
    assert.match(decision.permissionDecisionReason, /^Run it as: heavy -- |^Scope the search to a directory$/, command);
  }
});

test('without a heavy command on PATH, bare builds pass untouched and whole-disk scans are still denied', () => {
  for (const [tool_name, command] of [['Bash', 'pnpm install'], ['exec_command', 'tsc --noEmit'], ['Bash', 'npm ci']]) {
    const result = run('hooks/safety-guard.mjs', { tool_name, tool_input: { command } }, [], withoutHeavy);
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
  }
  const scan = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command: 'find / -name x' } }, [], withoutHeavy);
  assert.equal(JSON.parse(scan.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('safety guard lets heavy-wrapped builds, git, scripts and tests through', () => {
  for (const command of ['heavy -- tsc --noEmit', 'heavy --class quick -- npm ci', 'git status', 'node scripts/build.mjs', 'npm test', 'find ./src -name x', 'pnpm -v', 'rm -r /abs/narrow/path ; df -m /', 'rm -rf build/out && df -m /']) {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
  }
});

test('steer guard: long foreground waits are denied in Claude Bash, with the hand-off named', () => {
  const ten = 600000;
  for (const [command, timeout] of [
    ['gh run watch 44119413265 -R o/r --exit-status > /dev/null 2>&1; echo "exit $?"', ten],
    ['gh run watch 1', undefined],
    ['gh pr checks 12 --watch', ten],
    ["timeout 580 bash -c 'until test -s /x/done; do sleep 10; done'", ten],
    ['while ! curl -s localhost:1; do sleep 5; done', undefined],
    ['sleep 300 && gh pr checks 3', ten],
    ['cd /repo && sleep 2m', undefined]
  ]) {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command, timeout } });
    const out = JSON.parse(result.stdout || '{}').hookSpecificOutput;
    assert.equal(out?.permissionDecision, 'deny', command);
    assert.match(out.permissionDecisionReason, /waiting to be read/, command);
    assert.match(out.permissionDecisionReason, /t3_background_wait/, command);
  }
});

test('steer guard: background, short, bounded and quoted waits pass', () => {
  for (const [command, extra] of [
    ['gh run watch 1 --exit-status', { run_in_background: true }],
    ["timeout 580 bash -c 'until test -s /x; do sleep 10; done'", { run_in_background: true }],
    ["timeout 45 bash -c 'until curl -s localhost:9377/health; do sleep 2; done'", { timeout: ten() }],
    ['until curl -s localhost:1; do sleep 1; done', { timeout: 30000 }],
    ['sleep 20; gh pr checks 1518 -R o/r', {}],
    ['git commit -m "no more gh run watch or sleep 900 here"', {}],
    ['cat list | while read l; do echo "$l"; done; sleep 5', {}],
    ['npm test', { timeout: ten() }]
  ]) {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command, ...extra } });
    assert.equal(result.status, 0, command);
    assert.equal(result.stdout, '', command);
  }
  // Codex shells are not judged: the remedy is Claude's.
  const codex = run('hooks/safety-guard.mjs', { tool_name: 'exec_command', tool_input: { command: 'gh run watch 1' } });
  assert.equal(codex.stdout, '');
  function ten() { return 600000; }
});

test('checkpoint stores metadata without conversation bodies', () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const result = run('hooks/checkpoint.mjs', {
    session_id: 'abc', cwd: '/tmp/project', prompt: 'private prompt body'
  }, [], { SISO_STATE_HOME: state });
  assert.equal(result.status, 0);
  const checkpoint = readFileSync(join(state, 'checkpoints', 'abc.json'), 'utf8');
  assert.doesNotMatch(checkpoint, /private prompt body/);
});

test('verify stop blocks completion after unverified mutation', () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const transcript = join(state, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
    JSON.stringify({ message: { content: [{ type: 'text', text: 'Implemented and complete.' }] } })
  ].join('\n'));
  const result = run('hooks/verify-stop.mjs', {
    session_id: 'verify-me', transcript_path: transcript, stop_hook_active: false
  }, [], { SISO_STATE_HOME: state });
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  const repeated = run('hooks/verify-stop.mjs', {
    session_id: 'verify-me', transcript_path: transcript, stop_hook_active: false
  }, [], { SISO_STATE_HOME: state });
  assert.equal(JSON.parse(repeated.stdout).decision, 'block');
});

test('verify stop recognizes Codex apply_patch and last assistant message fields', () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const transcript = join(state, 'transcript.jsonl');
  writeFileSync(transcript, JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'apply_patch', input: { command: '*** Begin Patch' } }] }
  }));
  const result = run('hooks/verify-stop.mjs', {
    session_id: 'codex', transcript_path: transcript, stop_hook_active: false,
    last_assistant_message: 'Implemented and complete.'
  }, [], { SISO_STATE_HOME: state });
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});

test('verify stop recognizes actual Codex custom tool call records and shell mutations', () => {
  for (const call of [
    { name: 'apply_patch', input: { command: '*** Begin Patch' } },
    { name: 'exec', input: JSON.stringify({ command: "sed -i '' 's/a/b/' app.js" }) }
  ]) {
    const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
    const transcript = join(state, 'transcript.jsonl');
    writeFileSync(transcript, JSON.stringify({
      type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', ...call }
    }));
    const result = run('hooks/verify-stop.mjs', {
      session_id: 'codex-real', transcript_path: transcript, stop_hook_active: false,
      last_assistant_message: 'Implemented and complete.'
    }, [], { SISO_STATE_HOME: state });
    assert.equal(JSON.parse(result.stdout).decision, 'block', call.name);
  }
});

test('verification lifecycle state survives transcript tail truncation', () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const transcript = join(state, 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } })}\n${'x'.repeat(160000)}`);
  const tracked = run('hooks/verification-state.mjs', {
    session_id: 'tracked', hook_event_name: 'PostToolUse', tool_name: 'apply_patch',
    tool_input: { command: '*** Begin Patch' }, tool_response: { exit_code: 0 }
  }, [], { SISO_STATE_HOME: state });
  assert.equal(tracked.status, 0);
  const blocked = run('hooks/verify-stop.mjs', {
    session_id: 'tracked', transcript_path: transcript, stop_hook_active: false,
    last_assistant_message: 'Implemented and complete.'
  }, [], { SISO_STATE_HOME: state });
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');

  run('hooks/verification-state.mjs', {
    session_id: 'tracked', hook_event_name: 'PostToolUse', tool_name: 'exec',
    tool_input: { command: 'npm test' }, tool_response: { exit_code: 0 }
  }, [], { SISO_STATE_HOME: state });
  const allowed = run('hooks/verify-stop.mjs', {
    session_id: 'tracked', transcript_path: transcript, stop_hook_active: false,
    last_assistant_message: 'Implemented and complete.'
  }, [], { SISO_STATE_HOME: state });
  assert.equal(allowed.stdout, '');
});

test('verify stop allows a post-mutation test', () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const transcript = join(state, 'transcript.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', id: 'verify-1', name: 'Bash', input: { command: 'npm test' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: 'verify-1', content: 'all tests passed' }] } }),
    JSON.stringify({ message: { content: [{ type: 'text', text: 'Implemented and complete.' }] } })
  ].join('\n'));
  const result = run('hooks/verify-stop.mjs', {
    session_id: 'verified', transcript_path: transcript, stop_hook_active: false
  }, [], { SISO_STATE_HOME: state });
  assert.equal(result.stdout, '');
});

test('verify stop does not accept an issued or failed test as verification', () => {
  for (const resultBlock of [null, { type: 'tool_result', tool_use_id: 'verify-1', is_error: true }]) {
    const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
    const transcript = join(state, 'transcript.jsonl');
    const lines = [
      { message: { content: [{ type: 'tool_use', name: 'Edit', input: {} }] } },
      { message: { content: [{ type: 'tool_use', id: 'verify-1', name: 'Bash', input: { command: 'npm test' } }] } },
      ...(resultBlock ? [{ message: { content: [resultBlock] } }] : []),
      { message: { content: [{ type: 'text', text: 'Implemented and complete.' }] } }
    ];
    writeFileSync(transcript, lines.map(JSON.stringify).join('\n'));
    const result = run('hooks/verify-stop.mjs', {
      session_id: 'not-verified', transcript_path: transcript, stop_hook_active: false
    }, [], { SISO_STATE_HOME: state });
    assert.equal(JSON.parse(result.stdout).decision, 'block');
  }
});

test('state-writing hooks fail open when state storage is unavailable', () => {
  for (const hook of ['hooks/agent-state.mjs', 'hooks/checkpoint.mjs', 'hooks/skill-events.mjs']) {
    const result = run(hook, {
      session_id: 'abc', tool_name: 'Skill', tool_input: { skill: 'test' }
    }, [], { SISO_STATE_HOME: '/dev/null' });
    assert.equal(result.status, 0, hook);
  }
});

test('transcript reader bounds I/O for large sparse transcripts', async () => {
  const state = mkdtempSync(join(tmpdir(), 'siso-hook-state-'));
  const transcript = join(state, 'large.jsonl');
  const descriptor = openSync(transcript, 'w');
  closeSync(descriptor);
  truncateSync(transcript, 64 * 1024 * 1024);
  const result = run('hooks/verify-stop.mjs', {
    session_id: 'sparse', transcript_path: transcript, stop_hook_active: false
  }, [], { SISO_STATE_HOME: state });
  assert.equal(result.status, 0);
});

test('safety guard refuses a new sisodias or siso-os repo with no row in the homes table', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-homes-'));
  const homes = join(dir, 'repo-homes.tsv');
  writeFileSync(homes, 'org\trepo\tstate\tverdict\tkind\thome\nsisodias\thas-home\tlive\tKEEP\tapps\tsisodias/has-home\n');
  const decision = (command, env = { SISO_REPO_HOMES: homes }) => {
    const result = run('hooks/safety-guard.mjs', { tool_name: 'Bash', tool_input: { command } }, [], { ...withoutHeavy, ...env });
    assert.equal(result.status, 0, command);
    return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'allow';
  };
  for (const command of ['gh repo create sisodias/no-home --private', 'gh repo create no-home --private --clone',
    'gh repo create -d "a thing" siso-os/no-home --public', 'cd x && gh repo create sisodias/no-home.git',
    'gh api orgs/sisodias/repos -f name=no-home -F private=true', 'gh api -X POST user/repos -f name=no-home']) {
    assert.equal(decision(command), 'deny', command);
  }
  for (const command of ['gh repo create sisodias/has-home --private', 'gh repo create other-org/not-ours --private',
    'gh repo view sisodias/no-home', 'gh api repos/sisodias/no-home', 'git commit -m "gh repo create sisodias/no-home"',
    'gh repo create --template sisodias/no-home sisodias/has-home']) {
    assert.equal(decision(command), 'allow', command);
  }
  assert.equal(decision('gh repo create sisodias/no-home', { SISO_REPO_HOMES: join(dir, 'absent.tsv') }), 'allow', 'no table on this machine');
});
