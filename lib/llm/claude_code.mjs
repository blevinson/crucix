// Claude Code Provider — uses Claude Pro/Max subscription via the local `claude` CLI.
// Auth: reads ~/.claude OAuth credentials (or HOME/.claude inside a pod). No API key.
//
// Mirrors the shape of codex.mjs (subscription-billed, not API-key-billed). Each
// complete() spawns one `claude --print` subprocess; concurrent calls are bounded
// by a module-level semaphore so the sweep loop can't fork 10 CLI processes at once.
//
// `--bare` is intentionally NOT used — bare mode forces ANTHROPIC_API_KEY auth and
// disables OAuth, which would break subscription billing. We disable everything
// else (tools, session persistence, hooks aren't relevant in --print) explicitly.

import { spawn } from 'child_process';
import { LLMProvider } from './provider.mjs';

const DEFAULT_MODEL = 'sonnet'; // alias resolves to the latest Sonnet at request time
const DEFAULT_BIN = process.env.CLAUDE_CODE_BIN || 'claude';
const DEFAULT_CONCURRENCY = parseInt(process.env.CLAUDE_CODE_CONCURRENCY || '2', 10);

// Module-level semaphore: the CLI is process-heavy (each invocation boots Node +
// loads the SDK), so two concurrent ideation calls is plenty for crucix's 15-min
// sweep cadence. Increase via env if a service truly needs more throughput.
let _inflight = 0;
const _waiters = [];
async function _acquire() {
  if (_inflight < DEFAULT_CONCURRENCY) {
    _inflight++;
    return;
  }
  await new Promise(resolve => _waiters.push(resolve));
  _inflight++;
}
function _release() {
  _inflight--;
  const next = _waiters.shift();
  if (next) next();
}

function _stripCodeFences(text) {
  if (!text) return text;
  const t = text.trim();
  if (!t.startsWith('```')) return t;
  return t.replace(/^```(?:json|javascript|js)?\n?/, '').replace(/\n?```$/, '').trim();
}

export class ClaudeCodeProvider extends LLMProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'claude_code';
    this.model = config.model || DEFAULT_MODEL;
    this.bin = config.bin || DEFAULT_BIN;
  }

  // We can't synchronously prove the subscription is logged in without spawning
  // the CLI; assume true and let complete() surface auth errors at call time.
  // Setting CLAUDE_CODE_DISABLED=true is the explicit opt-out.
  get isConfigured() {
    return process.env.CLAUDE_CODE_DISABLED !== 'true';
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    const timeoutMs = opts.timeout || 120000;
    const model = opts.model || this.model;

    await _acquire();
    try {
      const args = [
        '--print',
        '--no-session-persistence',
        '--output-format', 'json',
        '--model', model,
        '--disallowedTools', '*',
      ];
      if (systemPrompt) {
        args.push('--system-prompt', systemPrompt);
      }
      if (opts.maxTokens) {
        // claude CLI doesn't expose a max-tokens knob directly; skip silently.
        // Subscription billing makes this a non-cost concern in practice.
      }

      const result = await this._spawn(this.bin, args, userMessage, timeoutMs);

      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (e) {
        throw new Error(
          `claude_code: failed to parse CLI output as JSON: ${e.message}\n` +
          `stdout (first 200 chars): ${result.stdout.slice(0, 200)}\n` +
          `stderr (first 200 chars): ${result.stderr.slice(0, 200)}`
        );
      }

      if (parsed.is_error) {
        throw new Error(`claude_code: ${parsed.result || 'unknown error'}`);
      }
      if (parsed.subtype && parsed.subtype !== 'success') {
        throw new Error(`claude_code: subtype=${parsed.subtype} result=${parsed.result?.slice(0, 200)}`);
      }

      const text = _stripCodeFences(parsed.result || '');
      const usage = parsed.usage || {};

      return {
        text,
        usage: {
          inputTokens:
            (usage.input_tokens || 0) +
            (usage.cache_read_input_tokens || 0) +
            (usage.cache_creation_input_tokens || 0),
          outputTokens: usage.output_tokens || 0,
        },
        model: parsed.modelUsage ? Object.keys(parsed.modelUsage)[0] || model : model,
      };
    } finally {
      _release();
    }
  }

  _spawn(bin, args, stdinBody, timeoutMs) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawn(bin, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          // Inherit env (including HOME) so the CLI finds OAuth credentials.
          env: process.env,
        });
      } catch (e) {
        reject(new Error(`claude_code: failed to spawn ${bin}: ${e.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`claude_code: CLI timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', chunk => { stdout += chunk; });
      proc.stderr.on('data', chunk => { stderr += chunk; });

      proc.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`claude_code: spawn error: ${err.message}`));
      });

      proc.on('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(
            `claude_code: CLI exited ${code}\nstderr: ${stderr.slice(0, 500)}`
          ));
          return;
        }
        resolve({ stdout, stderr });
      });

      // Feed user message via stdin and close.
      try {
        proc.stdin.end(stdinBody || '', 'utf8');
      } catch (e) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`claude_code: failed to write stdin: ${e.message}`));
      }
    });
  }
}
