#!/usr/bin/env node
import { denyPreTool, readPayload } from './lib/common.mjs';
import { commandFromPayload, isShellTool } from './lib/verification.mjs';

const payload = await readPayload();
if (!payload) process.exit(0);
const toolName = payload.tool_name || payload.toolName || payload.name;
if (!isShellTool(toolName)) process.exit(0);

let command = commandFromPayload(payload);
const rawCommand = command.split('\n')[0].trim().slice(0, 200);
// Strip heredoc bodies (<<EOF ... EOF, <<'EOF', <<-EOF) so text being WRITTEN is never judged as a command.
const stripHeredocs = (s) => s.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1(?=\s|$)/g, '<<HEREDOC');
// Also strip single- and double-quoted string literals: text inside quotes is an argument
// (echo, grep pattern, commit message, doc body), not a command to be judged (2026-09-04, D4 #2).
const stripQuoted = (s) => s.replace(/"(?:[^"\\]|\\.)*"/g, (quoted) => (quoted.includes('$') ? quoted : '"STR"')).replace(/'(?:[^'\\]|\\.)*'/g, "'STR'");
// Words keep quotes unwrapped, so `git reset '--hard'` is still seen as the reset (quoted text stays out of commit messages).
const unstripped = stripHeredocs(command);
command = stripQuoted(unstripped);
const shellWords = unstripped.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g) || [];
const words = shellWords.map((word) => {
  if ((word.startsWith("'") && word.endsWith("'")) || (word.startsWith('"') && word.endsWith('"'))) {
    return word.slice(1, -1);
  }
  return word;
});

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
const heavyBare = /^\s*(?:tsc|playwright|vite\s+build|pnpm\s+install|npm\s+(?:ci|install))(?=\s|$)/;
const rootScan = /^\s*(?:find|bfs)\s+\/(?=\s|$)/;
const heavyHint = heavyBare.test(command) ? `Run it as: heavy -- ${rawCommand}`
  : rootScan.test(command) ? 'Scope the search to a directory' : null;

const forbidden = [
  { test: () => isHardGitReset(words), reason: 'git reset --hard can discard uncommitted work' },
  { test: () => isGitForce(words), reason: 'no --force (AGENTS.md hard rule 2): merge origin/<trunk> into a pushed branch instead of rebasing, and remove a worktree only when it is clean' },
  { pattern: /\bgit\s+checkout\s+--\s+/i, reason: 'git checkout -- can overwrite user changes' },
  { pattern: /\bpkill\s+-f\b/i, reason: 'pkill -f can terminate unrelated processes' },
  { pattern: /\brm\s+-(?=[^\n]*r)(?=[^\n]*f)[^\n]*\s+['"]?(?:\/|~\/?|\$HOME|\$\{HOME\})['"]?(?:\s|$)/i, reason: 'recursive deletion targets a broad home or root path' }
];

if (heavyHint) {
  denyPreTool(heavyHint);
} else for (const rule of forbidden) {
  if ((rule.test && rule.test()) || (rule.pattern && rule.pattern.test(command))) {
    denyPreTool(`SISO safety guard blocked this command: ${rule.reason}. Resolve an explicit narrow target or use a recoverable operation.`);
    break;
  }
}
