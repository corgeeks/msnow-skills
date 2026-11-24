import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, GitError, createQueue, gitSigningOffEnv } from './git.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sf-git-'));

test('git returns trimmed stdout', () => {
  const d = tmp();
  git(d, ['init', '-q', '-b', 'main']);
  // rev-parse --abbrev-ref fails on an unborn branch; symbolic-ref works pre-commit.
  assert.equal(git(d, ['symbolic-ref', '--short', 'HEAD']), 'main');
});

test('git throws GitError on failure', () => {
  const d = tmp();
  git(d, ['init', '-q', '-b', 'main']);
  assert.throws(() => git(d, ['rev-parse', 'nope']), (e: unknown) => {
    assert.ok(e instanceof GitError);
    assert.equal(e.name, 'GitError');
    assert.deepEqual(e.args, ['rev-parse', 'nope']);
    assert.ok(e.stderr.length > 0);
    assert.ok(e.status !== null && e.status !== 0);
    assert.match(e.message, /git rev-parse nope/);
    return true;
  });
});

test('git honours o.env', () => {
  const d = tmp();
  git(d, ['init', '-q', '-b', 'main']);
  const out = git(d, ['var', 'GIT_AUTHOR_IDENT'], { env: { ...process.env, GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@y' } });
  assert.match(out, /x <x@y>/);
});

test('queue is FIFO and exclusive', async () => {
  const q = createQueue();
  const log: string[] = [];
  const job = (n: number, ms: number) => () => {
    log.push(`s${n}`);
    return new Promise<void>((r) => setTimeout(() => { log.push(`e${n}`); r(); }, ms));
  };
  await Promise.all([q.run(job(1, 30)), q.run(job(2, 20)), q.run(job(3, 10))]);
  assert.equal(log.join(','), 's1,e1,s2,e2,s3,e3');
});

test('queue isolates failures', async () => {
  const q = createQueue();
  const r = await Promise.allSettled([
    q.run(() => { throw new Error('a'); }),
    q.run(() => Promise.reject(new Error('b'))),
    q.run(() => 42),
  ]);
  assert.equal(r[0].status, 'rejected');
  assert.equal(r[1].status, 'rejected');
  assert.deepEqual(r[2], { status: 'fulfilled', value: 42 });
});

test('queue supports sync return', async () => {
  assert.equal(await createQueue().run(() => 'x'), 'x');
});

test('gitSigningOffEnv appends after existing GIT_CONFIG_COUNT entries', () => {
  const env = gitSigningOffEnv({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'x' });
  assert.deepEqual(env, {
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_1: 'commit.gpgsign', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'tag.gpgsign', GIT_CONFIG_VALUE_2: 'false',
  });
});
