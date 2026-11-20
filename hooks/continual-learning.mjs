#!/usr/bin/env node
// Continual-learning stop hook: every so many completed turns and minutes, ask the agent to run the
// `continual-learning` skill, which mines new transcripts for durable corrections and facts.
//
// Ported from Cursor's continual-learning plugin (agents/skills/hub/third_party/cursor-plugins/continual-learning/
// hooks/continual-learning-stop.ts, cursor/plugins@bf0c7cd, MIT © 2026 Cursor). Thresholds, trial mode, env names
// and the follow-up message are kept. SISO's setup forces these changes:
//   - Node, not bun: SISO's hooks run on the stack's node runtime, and `import { stdin } from "bun"` has no node twin.
//   - Claude Code Stop: a counted turn is one that did not continue from a stop hook (`stop_hook_active` false; Cursor:
//     status "completed" and loop_count 0), and the hook continues the turn with {"decision":"block","reason":...}.
//   - State lives in .claude/hooks/state/ (Cursor: .cursor/hooks/state/).
//
// NOT WIRED. hooks.manifest.json lists it but no profile event runs it: the follow-up edits AGENTS.md on a
// turn-count trigger, and SISO keeps reviewed repo facts in .agents/memory/ and lessons through `reflect`. It needs a
// ruling before it is switched on (harness-port report, CONFLICTS).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readPayload } from './lib/common.mjs';

const PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const STATE_PATH = resolve(PROJECT_DIR, '.claude/hooks/state/continual-learning.json');
const INCREMENTAL_INDEX_PATH = resolve(PROJECT_DIR, '.claude/hooks/state/continual-learning-index.json');
const DEFAULT_MIN_TURNS = 10;
const DEFAULT_MIN_MINUTES = 120;
const TRIAL_DEFAULT_MIN_TURNS = 3;
const TRIAL_DEFAULT_MIN_MINUTES = 15;
const TRIAL_DEFAULT_DURATION_MINUTES = 24 * 60;

const FOLLOWUP_MESSAGE =
  `Run the \`continual-learning\` skill now. Use the \`agents-memory-updater\` subagent for the full memory update flow. Use incremental transcript processing with index file \`${INCREMENTAL_INDEX_PATH}\`: only consider transcripts not in the index or transcripts whose mtime is newer than indexed mtime. Have the subagent refresh index mtimes, remove entries for deleted transcripts, and update \`AGENTS.md\` only for high-signal recurring user corrections and durable workspace facts. Exclude one-off/transient details and secrets. If no meaningful updates exist, respond exactly: No high-signal memory updates.`;

function parsePositiveInt(value, fallback) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseBoolean(value) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readEnvValue(primary, legacy) {
  return process.env[primary] ?? process.env[legacy];
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

function loadState() {
  const fallback = {
    version: 1,
    lastRunAtMs: 0,
    turnsSinceLastRun: 0,
    lastTranscriptMtimeMs: null,
    lastProcessedGenerationId: null,
    trialStartedAtMs: null,
  };
  if (!existsSync(STATE_PATH)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    if (parsed.version !== 1) return fallback;
    return {
      version: 1,
      lastRunAtMs: finite(parsed.lastRunAtMs) ? parsed.lastRunAtMs : 0,
      turnsSinceLastRun: finite(parsed.turnsSinceLastRun) && parsed.turnsSinceLastRun >= 0 ? parsed.turnsSinceLastRun : 0,
      lastTranscriptMtimeMs: finite(parsed.lastTranscriptMtimeMs) ? parsed.lastTranscriptMtimeMs : null,
      lastProcessedGenerationId: typeof parsed.lastProcessedGenerationId === 'string' ? parsed.lastProcessedGenerationId : null,
      trialStartedAtMs: finite(parsed.trialStartedAtMs) ? parsed.trialStartedAtMs : null,
    };
  } catch {
    return fallback;
  }
}

function saveState(state) {
  const directory = dirname(STATE_PATH);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function getTranscriptMtimeMs(transcriptPath) {
  if (!transcriptPath) return null;
  try {
    return statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
}

function shouldCountTurn(input) {
  return input.stop_hook_active !== true;
}

async function main() {
  try {
    const input = await readPayload();
    if (!input || typeof input !== 'object') return 0;
    const state = loadState();

    if (input.generation_id && input.generation_id === state.lastProcessedGenerationId) return 0;
    state.lastProcessedGenerationId = input.generation_id ?? null;

    const countedTurn = shouldCountTurn(input);
    const turnsSinceLastRun = state.turnsSinceLastRun + (countedTurn ? 1 : 0);
    const now = Date.now();

    const trialEnabled = parseBoolean(readEnvValue('CONTINUAL_LEARNING_TRIAL_MODE', 'CONTINUOUS_LEARNING_TRIAL_MODE'));
    if (trialEnabled && countedTurn && state.trialStartedAtMs === null) state.trialStartedAtMs = now;

    const trialDurationMinutes = parsePositiveInt(
      readEnvValue('CONTINUAL_LEARNING_TRIAL_DURATION_MINUTES', 'CONTINUOUS_LEARNING_TRIAL_DURATION_MINUTES'),
      TRIAL_DEFAULT_DURATION_MINUTES);
    const trialMinTurns = parsePositiveInt(
      readEnvValue('CONTINUAL_LEARNING_TRIAL_MIN_TURNS', 'CONTINUOUS_LEARNING_TRIAL_MIN_TURNS'), TRIAL_DEFAULT_MIN_TURNS);
    const trialMinMinutes = parsePositiveInt(
      readEnvValue('CONTINUAL_LEARNING_TRIAL_MIN_MINUTES', 'CONTINUOUS_LEARNING_TRIAL_MIN_MINUTES'), TRIAL_DEFAULT_MIN_MINUTES);
    const inTrialWindow = trialEnabled && state.trialStartedAtMs !== null
      && now - state.trialStartedAtMs < trialDurationMinutes * 60_000;

    const minTurns = parsePositiveInt(readEnvValue('CONTINUAL_LEARNING_MIN_TURNS', 'CONTINUOUS_LEARNING_MIN_TURNS'), DEFAULT_MIN_TURNS);
    const minMinutes = parsePositiveInt(readEnvValue('CONTINUAL_LEARNING_MIN_MINUTES', 'CONTINUOUS_LEARNING_MIN_MINUTES'), DEFAULT_MIN_MINUTES);

    const effectiveMinTurns = inTrialWindow ? trialMinTurns : minTurns;
    const effectiveMinMinutes = inTrialWindow ? trialMinMinutes : minMinutes;
    const minutesSinceLastRun = state.lastRunAtMs > 0 ? Math.floor((now - state.lastRunAtMs) / 60000) : Number.POSITIVE_INFINITY;
    const transcriptMtimeMs = getTranscriptMtimeMs(input.transcript_path);
    const hasTranscriptAdvanced = transcriptMtimeMs !== null
      && (state.lastTranscriptMtimeMs === null || transcriptMtimeMs > state.lastTranscriptMtimeMs);

    const shouldTrigger = countedTurn && turnsSinceLastRun >= effectiveMinTurns
      && minutesSinceLastRun >= effectiveMinMinutes && hasTranscriptAdvanced;

    if (shouldTrigger) {
      state.lastRunAtMs = now;
      state.turnsSinceLastRun = 0;
      state.lastTranscriptMtimeMs = transcriptMtimeMs;
      saveState(state);
      process.stdout.write(`${JSON.stringify({ decision: 'block', reason: FOLLOWUP_MESSAGE })}\n`);
      return 0;
    }

    state.turnsSinceLastRun = turnsSinceLastRun;
    saveState(state);
    return 0;
  } catch (error) {
    process.stderr.write(`[continual-learning-stop] failed ${error}\n`);
    return 0;
  }
}

process.exitCode = await main();
