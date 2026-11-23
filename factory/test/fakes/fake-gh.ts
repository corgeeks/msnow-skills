// Offline `gh` stand-in. Env: FAKE_GH_REMOTE (bare repo), FAKE_GH_STATE (JSON file, created if missing).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_COMMIT_FLAGS, git } from '../../src/daemon/git.ts';

interface Pr { number: number; branch: string; title: string; body: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; comments: string[]; unknownViews?: number; headSha?: string }
interface State { next: number; prs: Record<string, Pr> }

const remote = process.env.FAKE_GH_REMOTE!;
const statePath = process.env.FAKE_GH_STATE!;
const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { next: 1, prs: {} };
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const die = (code: number, msg: string): never => { process.stderr.write(msg + '\n'); process.exit(code); };

const [group, sub, ...rest] = process.argv.slice(2);
if (group !== 'pr') die(2, `fake-gh: unknown command ${group}`);

// Parse `[positional] --flag value...` with only the allowed flags (bool flags take no value).
function parse(allowed: string[], bools: string[] = []) {
  const flags: Record<string, string> = {};
  const pos: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (bools.includes(name)) flags[name] = 'true';
    else if (allowed.includes(name) && i + 1 < rest.length) flags[name] = rest[++i];
    else die(2, `fake-gh: unknown flag ${a}`);
  }
  return { flags, pos };
}
const remoteSha = (branch: string) => git(remote, ['ls-remote', remote, `refs/heads/${branch}`]).split(/\s/)[0] ?? '';
const pr = (n: string | undefined) => state.prs[n ?? ''] ?? die(1, `fake-gh: no pull request ${n}`);

switch (sub) {
  case 'create': {
    const { flags } = parse(['base', 'head', 'title', 'body-file']);
    if (flags.base !== 'main') die(2, 'fake-gh: --base must be main');
    if (!flags.head || !remoteSha(flags.head)) die(1, `fake-gh: head branch ${flags.head} not on remote`);
    const n = state.next++;
    state.prs[n] = { number: n, branch: flags.head, title: flags.title ?? '', body: readFileSync(flags['body-file'], 'utf8'), state: 'OPEN', comments: [] };
    save();
    process.stdout.write(`https://github.com/fake/repo/pull/${n}\n`);
    break;
  }
  case 'comment': {
    const { flags, pos } = parse(['body-file']);
    pr(pos[0]).comments.push(readFileSync(flags['body-file'], 'utf8'));
    save();
    break;
  }
  case 'view': {
    const { pos } = parse(['json']);
    const p = pr(pos[0]);
    let mergeable = 'MERGEABLE';
    if ((p.unknownViews ?? 0) > 0) { p.unknownViews!--; mergeable = 'UNKNOWN'; save(); }
    const headRefOid = p.state === 'MERGED' ? p.headSha! : remoteSha(p.branch) || p.headSha || '';
    process.stdout.write(JSON.stringify({ number: p.number, state: p.state, mergeable, mergeStateStatus: 'CLEAN', headRefOid, statusCheckRollup: [] }) + '\n');
    break;
  }
  case 'merge': {
    const { flags, pos } = parse(['match-head-commit'], ['squash']);
    if (!flags.squash) die(2, 'fake-gh: only --squash is supported');
    const p = pr(pos[0]);
    if (p.state !== 'OPEN') die(1, `fake-gh: pull request ${p.number} is ${p.state}`);
    const sha = remoteSha(p.branch);
    if (flags['match-head-commit'] !== sha) die(1, 'head commit mismatch');
    const dir = mkdtempSync(join(tmpdir(), 'fake-gh-'));
    try {
      git(dir, ['clone', '-q', remote, 'w']);
      const w = join(dir, 'w');
      git(w, ['checkout', 'main']);
      git(w, ['merge', '--squash', `origin/${p.branch}`]);
      git(w, [...DAEMON_COMMIT_FLAGS, 'commit', '-m', `${p.title} (#${p.number})`]);
      git(w, ['push', 'origin', 'main']);
    } catch (e) {
      die(1, `fake-gh: merge failed: ${(e as Error).message}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    p.state = 'MERGED';
    p.headSha = sha;
    save();
    break;
  }
  case 'close': {
    const { flags, pos } = parse(['comment']);
    const p = pr(pos[0]);
    p.state = 'CLOSED';
    p.headSha = remoteSha(p.branch) || p.headSha;
    if (flags.comment) p.comments.push(flags.comment);
    save();
    break;
  }
  default:
    die(2, `fake-gh: unknown subcommand pr ${sub}`);
}
