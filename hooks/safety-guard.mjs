#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { denyPreTool, readPayload, t3Thread } from './lib/common.mjs';
import { commandFromPayload, isShellTool } from './lib/verification.mjs';

const payload = await readPayload();
if (!payload) process.exit(0);
const toolName = payload.tool_name || payload.toolName || payload.name;
// Send guard. A 'queue' send waits behind the target's whole turn; 'auto' starts an idle thread and steers a running
// one. So a send in any other mode becomes auto, and the message still goes, at once. A fresh-context send can never
// steer, so it keeps the mode it asked for.
// Because every send steers into a running turn, a send must also be worth the interruption: it carries a
// `[from <name>] request|answer|blocked:` header so the receiver knows an agent wrote it, an ack is refused, and each
// sender->target pair gets one request or blocker per 30 minutes and one answer per message received. The budget
// lives in one JSONL shared by every seat on the machine and fails open when it can't be read or written.
if (toolName === 'mcp__t3-code__t3_thread_send') {
  const input = payload.tool_input;
  if (input && typeof input === 'object') {
    const refusal = sendRefusal(input);
    if (refusal) {
      denyPreTool(`SISO send guard: ${refusal}`);
      process.exit(0);
    }
  }
  if (input && typeof input === 'object' && !input.freshContext && !['auto', 'steer', 'restart'].includes(input.mode)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, mode: 'auto' } } }));
  }
  process.exit(0);
}
// Settle guard (18 Nov 2026). Shaan: "my agent zero ... he shouldn't settle but he just auto settled". T3 settles a
// thread when a PR linked to it merges, and a pinned thread is one that stays (the standing owners). So a pinned thread
// neither links a PR nor settles itself; its report carries the PR URL instead. It reads the pin through the local t3
// CLI and fails open when it can't (another machine, no CLI, a slow server).
if (/^mcp__t3-code__(link_pull_requests?|t3_thread_organize)$/.test(toolName)) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const threadId = input.threadId || process.env.T3CODE_THREAD_ID;
  const cli = process.env.T3CODE_CLI_PATH;
  if ((toolName.endsWith('organize') && input.action !== 'settle') || input.environmentId || !threadId || !cli) process.exit(0);
  const thread = t3Thread(threadId, cli);
  if (!thread) process.exit(0);
  if (thread && thread.pinned === true) {
    denyPreTool(toolName.endsWith('organize')
      ? `SISO settle guard: this thread is pinned, so it is a standing owner, and a standing thread never settles. Shaan, 18 Nov: "he shouldn't settle". Unpin it first only if Shaan asked for that.`
      : `SISO settle guard: this thread is pinned, so it is a standing owner, and T3 settles a thread when a PR linked to it merges. Shaan, 18 Nov: "he shouldn't settle". Don't link the PR here; put its URL in your report.`);
  }
  process.exit(0);
}
// Model guard: old GPT models were started by accident, so one older than 6.2 is refused wherever work names it: a T3
// delegate, thread or thread setting, and `codex -m` / `--model` / `-c model=` in a shell. The refusal says what to use.
const GPT_FLOOR = [6, 2];
const oldGpt = (model) => {
  const match = /(?:^|[/:])gpt-(\d+)(?:\.(\d+))?(?![\d.])/i.exec(String(model).trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2] || 0)];
  return major < GPT_FLOOR[0] || (major === GPT_FLOOR[0] && minor < GPT_FLOOR[1]);
};
const refuseOldGpt = (model) => {
  denyPreTool(`SISO model guard: ${model} is older than GPT-6.2, and Shaan banned old GPT models (20 Nov: "just anything that ain't 6.2, just fucking ban it"). Use gpt-6.2-sol (or gpt-6.2-astra).`);
  process.exit(0);
};
// Houses, for the plan guard here and the house wall below, are the machine's own table in lib/houses.mjs. It names
// partners, so the public copy leaves it out; without it no house is known and both guards stay open
// (lib/houses.example.mjs shows its shape).
const housesFile = new URL('./lib/houses.mjs', import.meta.url);
const houses = existsSync(housesFile) ? await import(housesFile.href) : null;
const houseIn = (table, value, fallback) => (table?.houses?.find(([, pattern]) => pattern.test(value)) || [table?.fallback ?? fallback])[0];
if (/^mcp__t3-code__(delegate_task|t3_thread_launch|create_threads|t3_thread_configure)$/.test(toolName)) {
  const houseOf = (value) => houseIn(houses?.plans, value, 'SISO');
  const seatHouse = houseOf(process.env.CLAUDE_CONFIG_DIR || '');
  const pending = [payload.tool_input];
  while (pending.length) {
    const input = pending.pop();
    if (!input || typeof input !== 'object') continue;
    for (const [key, value] of Object.entries(input)) {
      if (key === 'providerInstanceId' && typeof value === 'string' && houseOf(value) !== seatHouse) {
        denyPreTool(`SISO plan guard: a ${seatHouse} seat may not start work on ${value} (${houseOf(value)}'s plan). Each house's agents bill to that house's plans.`);
        process.exit(0);
      }
      if (key === 'model' && typeof value === 'string' && oldGpt(value)) refuseOldGpt(value);
      if (value && typeof value === 'object') pending.push(value);
    }
  }
  process.exit(0);
}
if (!isShellTool(toolName)) process.exit(0);

let command = commandFromPayload(payload);
const rawCommand = command.split('\n')[0].trim().slice(0, 200);

// House wall (17 Nov 2026): a seat may not run a command that names another house's fenced folders (lib/houses.mjs:
// its credentials and seat configs, which hold logins). Check quoted text and heredocs too, since shells can execute
// either. The seat's house is its config dir; any other seat is the fallback house's.
const seatDir = `${process.env.CLAUDE_CONFIG_DIR || ''} ${process.env.CODEX_HOME || ''}`;
const house = houseIn(houses?.seats, seatDir, 'siso');
const fence = (houses?.fences || []).find((f) => f.house !== house && f.pattern.test(command));
if (fence) {
  denyPreTool(`SISO house wall: a ${house} seat may not run a command that names ${fence.what}. ${houses.wallNote}`);
  process.exit(0);
}
// Strip heredoc bodies (<<EOF ... EOF, <<'EOF', <<-EOF) so text being WRITTEN is never judged as a command.
const stripHeredocs = (s) => s.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1(?=\s|$)/g, '<<HEREDOC');
// Also strip single- and double-quoted string literals: text inside quotes is an argument
// (echo, grep pattern, commit message, doc body), not a command to be judged (2026-09-04, D4 #2).
const stripQuoted = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, (quoted) => (quoted.includes('$') ? quoted : '"STR"')).replace(/'(?:[^'\\]|\\.)*'/g, "'STR'");
// Words keep quotes unwrapped, so `git reset '--hard'` is still seen as the reset (quoted text stays out of commit messages).
const unstripped = stripHeredocs(command);
// ssh/scp run their quoted text on a remote shell: judge that text by the same rules (2026-10-25, u574: ssh mini 'rm -rf ~').
const remote = /\b(?:ssh|scp)\s/.test(unstripped) ? (unstripped.match(/'[^']*'|"(?:\\.|[^"\\])*"/g) || []).map((q) => q.slice(1, -1).replace(/\\([$"\\`])/g, '$1')).join('\n') : '';
const judged = remote ? `${unstripped}\n${remote}` : unstripped;
command = stripQuoted(unstripped) + (remote ? `\n${remote}` : '');
const shellWords = judged.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [];
const words = shellWords.map((word) => {
  if ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"'))) {
    return word.slice(1, -1);
  }
  return word;
});

// Model guard, shell side: the model a `codex` command line asks for.
for (const segment of judged.split(/[;&|\n()]/)) {
  const tokens = (segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((token) => token.replace(/["']/g, ''));
  let at = 0;
  while (at < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[at]) || /^(?:env|command|exec|nohup|npx|timeout|\d+[smh]?)$/.test(tokens[at]))) at++;
  if (!/(?:^|\/)codex$/.test(tokens[at] || '')) continue;
  for (let i = at + 1; i < tokens.length; i++) {
    const token = tokens[i];
    let model = null;
    if (token === '-m' || token === '--model') model = tokens[i + 1];
    else if (/^(?:-m|--model)=/.test(token)) model = token.replace(/^[^=]*=/, '');
    else if ((token === '-c' || token === '--config') && /^model=/.test(tokens[i + 1] || '')) model = tokens[i + 1].slice(6);
    else if (/^(?:-c|--config)=model=/.test(token)) model = token.replace(/^[^=]*=model=/, '');
    if (model && oldGpt(model)) refuseOldGpt(model);
  }
}

// Steer guard (17 Nov 2026). Shaan: "I send messages, and it says waiting to be read ... it should be auto sent
// through". T3 hands a message to a running Claude turn only between tool calls, so a foreground wait (gh run watch,
// a long sleep, a poll loop) holds his message until it returns, up to the Bash limit of 10 minutes. A wait goes to
// the background instead; T3 wakes the thread when it exits. Claude's Bash only: the remedy is Claude's.
const WAIT_LIMIT = 60;
const toSeconds = (value) => {
  const m = String(value).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  return m ? Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]] : null;
};
function foregroundWait() {
  const input = payload.tool_input || {};
  if (toolName !== 'Bash' || input.run_in_background) return null;
  // `bash -c '...'` runs its quoted text, so judge that text too (quotes are otherwise stripped above).
  const inner = [...unstripped.matchAll(/\b(?:ba|z)?sh\s+-l?c\s+('[^']*'|"(?:\\.|[^"\\])*")/g)].map((m) => m[1].slice(1, -1));
  const body = [command, ...inner].join('\n');
  const waits = /\bgh\s+run\s+watch\b/.test(body)
    || /\bgh\s+pr\s+checks\b[^\n;|&]*--watch\b/.test(body)
    || /\b(?:until|while)\b[\s\S]*?\bdo\b(?:(?!\bdone\b)[\s\S])*?\bsleep\b/.test(body)
    || [...body.matchAll(/\bsleep\s+(\S+)/g)].some((m) => toSeconds(m[1]) > WAIT_LIMIT);
  if (!waits) return null;
  const toolLimit = Number(input.timeout) > 0 ? Number(input.timeout) / 1000 : 120;
  const wrapper = unstripped.match(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)?timeout\s+(?:--?[a-z-]+(?:=\S+)?\s+)*(\d[\d.]*[smhd]?)\s/);
  const bound = Math.min(toolLimit, (wrapper && toSeconds(wrapper[1])) ?? Infinity);
  return bound > WAIT_LIMIT ? Math.round(bound) : null;
}
const waitFor = foregroundWait();
if (waitFor) {
  denyPreTool(`SISO steer guard: this waits in the foreground for up to ${waitFor}s. While a foreground command runs, Shaan's messages sit in T3 as "waiting to be read": a turn takes them only between tool calls. Run it with run_in_background: true, call t3_background_wait with its task id, and end your turn; T3 wakes this thread when it exits, and his messages reach you at once. A PR's checks: watch_pull_request, then end your turn. A short wait: wrap it in timeout ${WAIT_LIMIT} or less.`);
  process.exit(0);
}

// No repo without a home (siso-os ARCHITECTURE 11b): a new repo in sisodias or siso-os gets its row in
// siso-os steps/repo-map/repo-homes.tsv first, then `gh repo create` (or `gh api .../repos -f name=`) may run. Where
// the table is not on this machine the guard cannot look, so it lets the command through.
function newRepoWithoutHome(tokens) {
  const homes = process.env.SISO_REPO_HOMES || join(process.env.HOME || '', 'Projects/siso-os/steps/repo-map/repo-homes.tsv');
  if (!existsSync(homes)) return null;
  const stop = (w) => /^(?:&&|\|\|?|;)$/.test(w);
  const wanted = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!/(?:^|\/)gh$/.test(tokens[i])) continue;
    if (tokens[i + 1] === 'repo' && tokens[i + 2] === 'create') {
      const takesValue = /^(?:-d|--description|-h|--homepage|-p|--template|-t|--team|-g|--gitignore|-l|--license|-s|--source|-r|--remote)$/;
      for (let j = i + 3; j < tokens.length && !stop(tokens[j]); j++) {
        if (takesValue.test(tokens[j])) { j++; continue; }
        if (!tokens[j].startsWith('-')) { wanted.push(tokens[j].replace(/;$/, '')); break; }
      }
    } else if (tokens[i + 1] === 'api') {
      let owner = null; let name = null;
      for (let j = i + 2; j < tokens.length && !stop(tokens[j]); j++) {
        const path = tokens[j].match(/^\/?(?:orgs\/([\w.-]+)|user)\/repos$/);
        if (path) owner = path[1] || 'sisodias';
        const field = /^(?:-f|-F|--field|--raw-field)$/.test(tokens[j]) ? tokens[j + 1] : tokens[j].match(/^(?:-f|-F)(name=.*)$/)?.[1];
        if (field && field.startsWith('name=')) name = field.slice(5);
      }
      if (owner && name) wanted.push(`${owner}/${name}`);
    }
  }
  if (!wanted.length) return null;
  const rows = new Set(readFileSync(homes, 'utf8').split('\n').map((line) => line.split('\t').slice(0, 2).join('/').toLowerCase()));
  for (const name of wanted) {
    const full = (name.includes('/') ? name : `sisodias/${name}`).replace(/\.git$/, '');
    if (/^(?:sisodias|siso-os)\//i.test(full) && !rows.has(full.toLowerCase())) return full;
  }
  return null;
}

function isHardGitReset(tokens) {
  const gitIndex = tokens.findIndex((word) => /(?:^|\/)git$/i.test(word));
  if (gitIndex < 0) return false;
  const gitArgs = tokens.slice(gitIndex + 1);
  const resetIndex = gitArgs.indexOf('reset');
  if (resetIndex < 0) return false;
  return gitArgs.slice(resetIndex + 1).includes('--hard');
}

// No --force (AGENTS.md hard rule 2): force pushes, incl. --force-with-lease and +refspec, and forced worktree removal (2026-10-19, u079).
function isGitForce(tokens) {
  return tokens.some((word, gitIndex) => {
    if (!/(?:^|\/)git$/i.test(word)) return false;
    const gitArgs = tokens.slice(gitIndex + 1);
    const end = gitArgs.findIndex((w) => /^(?:&&|\|\|?|;)$/.test(w) || /;$/.test(w));
    const args = (end < 0 ? gitArgs : gitArgs.slice(0, end + 1)).map((w) => w.replace(/;$/, ''));
    const pushIndex = args.indexOf('push');
    if (pushIndex >= 0 && args.slice(pushIndex + 1).some((w) => /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(w) || /^-[a-z]*f[a-z]*$/i.test(w) || /^\+\S/.test(w))) return true;
    const worktreeIndex = args.indexOf('worktree');
    return worktreeIndex >= 0 && args[worktreeIndex + 1] === 'remove' && args.slice(worktreeIndex + 2).some((w) => /^(?:--force|-f)$/.test(w));
  });
}

// Builds, installs, browsers and whole-disk scans must take a heavy slot (2026-10-20). Judged at the command start only,
// so `heavy -- tsc`, git, `node script.mjs` and test runs pass.
// The heavy slot is a Mac-mini/laptop-macOS tool; where `heavy` is not on PATH (Omarchy) the rewrite would turn
// `pnpm install` into `heavy: command not found`, so the rule is off there.
const hasHeavy = (process.env.PATH || '').split(':').some((dir) => dir && existsSync(join(dir, 'heavy')));
const heavyBare = hasHeavy ? /^\s*(?:tsc|playwright|vite\s+build|pnpm\s+install|npm\s+(?:ci|install))(?=\s|$)/ : /(?!)/;
const rootScan = /^\s*(?:find|bfs)\s+\/(?=\s|$)/;
const heavyHint = heavyBare.test(command) ? `Run it as: heavy -- ${rawCommand}`
  : rootScan.test(command) ? 'Scope the search to a directory' : null;

const forbidden = [
  { test: () => isHardGitReset(words), reason: 'git reset --hard can discard uncommitted work' },
  { test: () => isGitForce(words), reason: 'no --force (AGENTS.md hard rule 2): merge origin/<trunk> into a pushed branch instead of rebasing, and remove a worktree only when it is clean' },
  { pattern: /\bgit\s+checkout\s+--\s+/i, reason: 'git checkout -- can overwrite user changes' },
  { pattern: /\bpkill\s+-f\b/i, reason: 'pkill -f can terminate unrelated processes' },
  // rm is judged within its own command (up to ; | & or newline), so a narrow rm beside a later `df -m /` passes (u843).
  { pattern: /\brm\s+-(?=[^\n;|&]*r)(?=[^\n;|&]*f)[^\n;|&]*\s+['"]?(?:\/|~\/?|\$HOME|\$\{HOME\})['"]?(?=[\s;|&]|$)/i, reason: 'recursive deletion targets a broad home or root path' }
];

// Claude's Bash takes updatedInput to avoid retyping a denied command as `heavy -- X`, so the
// first line is rewritten in place (normal permission flow still applies); Codex tools keep the deny.
const homeless = newRepoWithoutHome(words);
if (homeless) {
  denyPreTool(`SISO homes wall: ${homeless} has no row in siso-os steps/repo-map/repo-homes.tsv. Add its row (org, repo, kind from ARCHITECTURE 11b, home) and commit it first; then create the repo.`);
  process.exit(0);
}
if (heavyBare.test(command) && toolName === 'Bash' && !command.includes('\n') && payload.tool_input?.command) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    updatedInput: { ...payload.tool_input, command: `heavy -- ${payload.tool_input.command.trimStart()}` } } }));
} else if (heavyHint) {
  denyPreTool(heavyHint);
} else for (const rule of forbidden) {
  if ((rule.test && rule.test()) || (rule.pattern && rule.pattern.test(command))) {
    denyPreTool(`SISO safety guard blocked this command: ${rule.reason}. Resolve an explicit narrow target or use a recoverable operation.`);
    break;
  }
}

function sendRefusal(input) {
  const instead = 'Status (started, merged, done, FYI) is never a message: write it in your PR, brain file or repo, where owners read it from GitHub.';
  const header = /^\[from ([^\]\n]+)\] (request|answer|blocked):(.*)$/;
  const message = typeof input.message === 'string' ? input.message : '';
  const [firstLine, ...rest] = message.replace(/^\s+/, '').split('\n');
  const match = header.exec(firstLine);
  if (!match) {
    return 'every message to another thread starts with `[from <your name>] request:`, `[from <your name>] answer:` or '
      + '`[from <your name>] blocked:` on its first line, so the receiver knows an agent wrote it, not Shaan. '
      + `Send only a request with the check that proves it, an answer they asked for, or a blocker. ${instead}`;
  }
  const kind = match[2];
  if (isAck(`${match[3]}\n${rest.join('\n')}`)) {
    return `an ack interrupts a running turn; send nothing. ${instead}`;
  }
  const sender = process.env.T3CODE_THREAD_ID;
  const target = typeof input.threadId === 'string' ? input.threadId : '';
  if (!sender || !target) return null;
  return sendBudget(sender, `${input.environmentId || ''}/${target}`, kind, instead);
}

function isAck(body) {
  const text = body.toLowerCase().trim();
  if (!text) return true;
  if (text.length > 160 || /[?\d]|https?:|#\w/.test(text)) return false;
  const phrases = /\b(thank you|thanks|thx|ty|cheers|received|got it|got this|ok|okay|noted|on it|will do|ack|acknowledged|understood|roger|copy that|sounds good|great|perfect|appreciated|nice|cool|all good|done)\b/g;
  const filler = new Set(['and', 'all', 'it', 'the', 'that', 'this', 'your', 'message', 'msg', 'a', 'i', 'im', 'ill', 'will', 'so', 'much', 'very', 'for', 'too', 'yes', 'yep', 'sure', 'here', 'now', 'mate', 'team', 'both', 'again', 'loud', 'clear']);
  const words = text.replace(phrases, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return words.every((word) => filler.has(word));
}

function sendBudget(sender, target, kind, instead) {
  const WINDOW = 30 * 60 * 1000;
  const DAY = 24 * 60 * 60 * 1000;
  const path = process.env.SISO_SEND_GUARD_STATE || join(homedir(), '.siso', 'state', 'thread-sends.jsonl');
  const now = Date.now();
  let entries;
  let stale;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, '');
    const all = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    entries = all.filter((entry) => entry && typeof entry.t === 'number' && now - entry.t < DAY);
    stale = all.length > entries.length;
  } catch {
    return null;
  }
  const self = `/${sender}`;
  const lastAt = (filter) => entries.filter(filter).reduce((latest, entry) => Math.max(latest, entry.t), 0);
  const lastOut = lastAt((entry) => entry.from === sender && entry.to === target);
  const lastIn = lastAt((entry) => entry.from === target.replace(/^[^/]*\//, '') && entry.to === self);
  let recorded = kind;
  if (kind === 'answer' && !(lastIn && lastIn > lastOut)) recorded = 'request';
  if (recorded !== 'answer') {
    const lastRequest = lastAt((entry) => entry.from === sender && entry.to === target && entry.kind !== 'answer');
    if (lastRequest && now - lastRequest < WINDOW) {
      const opens = new Date(lastRequest + WINDOW).toISOString().slice(11, 16);
      const why = kind === 'answer' ? 'they have sent you nothing since your last message, so this answer counts as a request, and ' : '';
      return `${why}you already sent this thread a request or blocker in the last 30 minutes (one per 30 minutes per thread). `
        + `Put it in your next message to them after ${opens}Z, batched with everything else for that owner. ${instead}`;
    }
  }
  const entry = JSON.stringify({ t: now, from: sender, to: target, kind: recorded });
  try {
    if (stale) {
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${[...entries.map((kept) => JSON.stringify(kept)), entry].join('\n')}\n`);
      renameSync(temporary, path);
    } else {
      appendFileSync(path, `${entry}\n`);
    }
  } catch { /* The budget fails open; the send still goes. */ }
  return null;
}
