#!/usr/bin/env node
// Ralph Loop stop hook.
// When the agent finishes a turn, this hook decides whether to feed the
// same prompt back for another iteration or let the session end.
//
// Ported from Cursor's ralph-loop plugin (agents/skills/hub/third_party/cursor-plugins/ralph-loop/hooks/stop-hook.sh
// and capture-response.sh, cursor/plugins@bf0c7cd, MIT © 2026 Cursor). Their logic and messages are kept. SISO's
// setup forces four changes:
//   - Node, not bash, because SISO's hooks run on the stack's node runtime (hooks.manifest.json).
//   - Claude Code's Stop input carries the last reply, so the afterAgentResponse hook that looked for
//     <promise>TEXT</promise> is folded into this one Stop hook (no done flag needed between two hooks).
//   - Claude Code continues a turn with {"decision":"block","reason":...}, not {"followup_message":...}.
//   - State lives in .claude/ralph/ (Cursor: .cursor/ralph/), and the loop binds to the first session that
//     sees it, because SISO agents share checkouts and another agent's turn must not be fed this prompt.
//
// Claude Code Stop hook API:
//   Input:  { "session_id", "transcript_path", "stop_hook_active", "last_assistant_message"?, "cwd", ... }
//   Output: { "decision": "block", "reason": "<text>" } to continue, or exit 0 with no output to stop
//
// Opt-in: nothing happens unless the ralph-loop skill wrote .claude/ralph/scratchpad.md. Fails open.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastAssistantText, readPayload } from './lib/common.mjs';

const input = await readPayload();
if (input && typeof input === 'object' && process.env.SISO_RALPH_LOOP !== 'off') {
  try {
    const out = stop(input);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // Fail open: a broken loop file must never trap a session.
  }
}

function frontmatterField(frontmatter, name) {
  const line = frontmatter.split('\n').find((row) => row.startsWith(`${name}:`));
  return line === undefined ? '' : line.slice(name.length + 1).trim();
}

function stop(hookInput) {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || '.';
  const ralphDir = join(projectDir, '.claude', 'ralph');
  const stateFile = join(ralphDir, 'scratchpad.md');
  const sessionFile = join(ralphDir, 'session');
  const end = (message) => {
    if (message) process.stderr.write(`${message}\n`);
    rmSync(stateFile, { force: true });
    rmSync(sessionFile, { force: true });
    return null;
  };

  // No active loop. Let the session end.
  if (!existsSync(stateFile)) return null;

  // Bind the loop to the first session that reaches it; stay out of every other session.
  const session = String(hookInput.session_id || '');
  const bound = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : '';
  if (session && !bound) writeFileSync(sessionFile, `${session}\n`);
  else if (session && bound && bound !== session) return null;

  // Parse state file frontmatter
  const text = readFileSync(stateFile, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const frontmatter = match ? match[1] : '';
  const iteration = frontmatterField(frontmatter, 'iteration');
  const maxIterations = frontmatterField(frontmatter, 'max_iterations');
  const completionPromise = frontmatterField(frontmatter, 'completion_promise').replace(/^"(.*)"$/, '$1');

  // Validate iteration is numeric
  if (!/^[0-9]+$/.test(iteration)) return end(`Ralph loop: state file corrupted (iteration: '${iteration}'). Stopping.`);
  if (!/^[0-9]+$/.test(maxIterations)) return end(`Ralph loop: state file corrupted (max_iterations: '${maxIterations}'). Stopping.`);

  // Check if the reply fulfilled the completion promise (upstream's afterAgentResponse hook did this).
  if (completionPromise !== 'null' && completionPromise) {
    const reply = lastAssistantText(hookInput);
    const promised = reply.match(/<promise>([\s\S]*?)<\/promise>/);
    if (promised && promised[1].trim().replace(/\s+/g, ' ') === completionPromise) {
      return end(`Ralph loop: completion promise fulfilled at iteration ${iteration}.`);
    }
  }

  // Check max iterations
  if (Number(maxIterations) > 0 && Number(iteration) >= Number(maxIterations)) {
    return end(`Ralph loop: max iterations (${maxIterations}) reached.`);
  }

  // Extract prompt text (everything after the closing --- in frontmatter)
  const promptText = (match ? match[2] : '').trim();
  if (!promptText) return end('Ralph loop: no prompt text found in state file. Stopping.');

  // Increment iteration
  const nextIteration = Number(iteration) + 1;
  const temporary = `${stateFile}.tmp.${process.pid}`;
  writeFileSync(temporary, text.replace(/^iteration: .*$/m, `iteration: ${nextIteration}`));
  renameSync(temporary, stateFile);

  // Build the followup message: iteration context + original prompt
  const header = completionPromise !== 'null' && completionPromise
    ? `[Ralph loop iteration ${nextIteration}. To complete: output <promise>${completionPromise}</promise> ONLY when genuinely true.]`
    : `[Ralph loop iteration ${nextIteration}.]`;

  // Output the block decision to continue the loop
  return { decision: 'block', reason: `${header}\n\n${promptText}` };
}
