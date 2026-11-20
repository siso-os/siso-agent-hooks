#!/usr/bin/env node
// Advisor hooks: remember edits since the last advisor consult, log each consult, and at the end of a turn that
// edited files without one, ask the agent (once per batch of edits) to run the pre-completion consult.
//
// Ported from Cursor's advisor plugin (agents/skills/hub/third_party/cursor-plugins/advisor/hooks/{lib,mark-pending,
// record-consult,capture-response,stop-hook}.sh, cursor/plugins@bf0c7cd, MIT © 2026 Cursor). Their state layout,
// binding rule and messages are kept. SISO's setup forces these changes:
//   - Node, not bash, because SISO's hooks run on the stack's node runtime (hooks.manifest.json).
//   - Claude Code events: afterFileEdit -> PostToolUse on Edit|Write|MultiEdit|NotebookEdit, subagentStop ->
//     SubagentStop, stop -> Stop with {"decision":"block","reason":...} instead of {"followup_message":...}.
//     Claude Code's Stop input carries the last reply, so capture-response.sh (which saved it) is folded into stop.
//   - State lives in .claude/advisor/ (Cursor: .cursor/advisor/), and conversation_id is Claude Code's session_id.
//
//   node advisor.mjs mark     PostToolUse: files changed since the last consult
//   node advisor.mjs record   SubagentStop: count the consult, clear the marker, append the advice to log.md
//   node advisor.mjs stop     Stop: ask for the consult once per batch of edits
//
// State lives in $CLAUDE_PROJECT_DIR/.claude/advisor/:
//   state.json   written by the cursor-advisor skill, kept current here
//   pending      marker: files were edited since the last consult
//   log.md       one entry per completed consult
// Opt-in: every mode exits quietly unless state.json says "enabled": true. Fails open.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { lastAssistantText, readPayload } from './lib/common.mjs';

const mode = process.argv[2] || '';
const input = await readPayload();
if (input && typeof input === 'object' && ['mark', 'record', 'stop'].includes(mode) && process.env.SISO_ADVISOR !== 'off') {
  try {
    const out = run(mode, input);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // Fail open: advisor state must never trap a turn.
  }
}

function paths(hookInput) {
  const advisorDir = join(process.env.CLAUDE_PROJECT_DIR || hookInput.cwd || '.', '.claude', 'advisor');
  return {
    advisorDir,
    stateFile: join(advisorDir, 'state.json'),
    pendingFile: join(advisorDir, 'pending'),
    logFile: join(advisorDir, 'log.md'),
  };
}

// Atomically apply a change to state.json.
function updateState(stateFile, change) {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  change(state);
  const temporary = `${stateFile}.tmp.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temporary, stateFile);
}

// Bind the state to the first conversation that touches it and keep transcript_path current. Returns false when
// the hook input belongs to a different conversation, so callers stay out of conversations that did not enable the
// advisor. A fresh bind also drops per-conversation markers so a re-bind cannot inherit the previous one's edits.
function bindConversation(hookInput, p, state) {
  const conversation = String(hookInput.session_id || '');
  if (conversation) {
    if (!state.conversation_id) {
      updateState(p.stateFile, (s) => { s.conversation_id = conversation; });
      rmSync(p.pendingFile, { force: true });
    } else if (state.conversation_id !== conversation) {
      return false;
    }
  }
  const transcript = hookInput.transcript_path || '';
  if (transcript && transcript !== state.transcript_path) {
    updateState(p.stateFile, (s) => { s.transcript_path = transcript; });
  }
  return true;
}

function run(hookMode, hookInput) {
  const p = paths(hookInput);
  // Exit quietly unless advisor mode is on.
  if (!existsSync(p.stateFile)) return null;
  const state = JSON.parse(readFileSync(p.stateFile, 'utf8'));
  if (state.enabled !== true) return null;
  if (!bindConversation(hookInput, p, state)) return null;

  if (hookMode === 'mark') {
    const filePath = String(hookInput.tool_input?.file_path || hookInput.tool_input?.notebook_path || '');
    // The plugin's own state is not work product.
    if (!filePath || filePath.includes('/.claude/advisor/')) return null;
    writeFileSync(p.pendingFile, '');
    return null;
  }

  if (hookMode === 'record') {
    const agentType = String(hookInput.agent_type || hookInput.subagent_type || '');
    if (agentType !== 'advisor-subagent') return null;
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    updateState(p.stateFile, (s) => { s.consults = (s.consults || 0) + 1; s.last_consult_at = now; });
    rmSync(p.pendingFile, { force: true });
    const description = hookInput.description || 'Advisor consult';
    const summary = String(hookInput.last_assistant_message || hookInput.summary || '').slice(0, 6000);
    appendFileSync(p.logFile, `## ${now} — ${description}\n\n${summary ? `${summary}\n\n` : '_No summary captured._\n\n'}`);
    return null;
  }

  // stop
  if (state.nudge === false) return null;
  if (!existsSync(p.pendingFile)) return null;

  // The agent stopped to ask the user something. Stay quiet and leave the marker
  // armed so the reminder fires after the user answers and the work resumes.
  if (lastAssistantText(hookInput).replace(/\s+/g, '').slice(-1) === '?') return null;

  rmSync(p.pendingFile, { force: true });
  const model = state.model || 'the configured advisor model';
  const message = `[Advisor] Files changed since the last advisor consult and the turn ended without one. If this work is done, or you were about to declare it done, run the pre-completion consult now per the cursor-advisor skill: build the briefing, spawn the \`advisor-subagent\` subagent (model: ${model}), act on the verdict, and report it in one line. If the change was trivial, or you are waiting on the user, say so in one line and stop.`;
  return { decision: 'block', reason: message };
}
