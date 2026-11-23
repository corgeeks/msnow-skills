// RPC fake for `omp --mode rpc`. Behaviour chosen by FAKE_OMP_SCENARIO; see sf1 omp-session-runner spec.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const cwdIdx = argv.indexOf('--cwd');
const cwd = cwdIdx >= 0 ? argv[cwdIdx + 1] : process.cwd();
const scenario = process.env.FAKE_OMP_SCENARIO ?? 'complete';
if (process.env.FAKE_OMP_ARGV_FILE) writeFileSync(process.env.FAKE_OMP_ARGV_FILE, JSON.stringify(argv));

process.stderr.write(`fake-omp start scenario=${scenario}\n`);
const out = (o: object) => process.stdout.write(JSON.stringify(o) + '\n');
const ignoreClose = scenario === 'hang_ignore_abort' || scenario === 'no_ready';

if (scenario === 'no_ready') setInterval(() => {}, 1 << 30);
else out({ type: 'ready' });
if (scenario === 'crash') process.exit(3);

const result = (status: string, error?: object) => out({ id: 'p1', type: 'prompt_result', status, ...(error && { error }) });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const cmd = JSON.parse(line) as { id?: string; type: string };
  switch (cmd.type) {
    case 'prompt': {
      out({ id: cmd.id, type: 'response', command: 'prompt', success: true });
      if (scenario === 'hang' || scenario === 'hang_ignore_abort') return;
      if (scenario === 'edit') execSync(process.env.FAKE_OMP_EDIT ?? 'true', { cwd, stdio: 'ignore' });
      const tools = process.env.FAKE_OMP_TOOLS
        ? JSON.parse(process.env.FAKE_OMP_TOOLS) as { toolName: string; args: object }[]
        : [{ toolName: 'read', args: { path: 'a.txt' } }, { toolName: 'bash', args: { command: 'ls' } }];
      tools.forEach((t, i) => out({ type: 'tool_execution_start', toolCallId: `t${i}`, ...t }));
      if (scenario === 'cost_cap') return result('error', { code: 'cost_cap', message: 'cost cap reached' });
      if (scenario === 'error') return result('error', { code: 'model_error', message: 'fake failure' });
      out({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: process.env.FAKE_OMP_TEXT ?? 'ok' }], stopReason: 'stop' } });
      return result('completed');
    }
    case 'abort':
      if (scenario === 'hang') result('aborted');
      return;
    case 'get_state':
      return out({ id: cmd.id, type: 'response', command: 'get_state', success: true, data: { sessionFile: '/fake/session.jsonl', sessionId: 'fake-session' } });
    case 'get_session_stats':
      return out({ id: cmd.id, type: 'response', command: 'get_session_stats', success: true, data: { cost: 0.01 } });
  }
});
rl.on('close', () => { if (!ignoreClose) process.exit(0); });
if (ignoreClose) setInterval(() => {}, 1 << 30);
