import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlIndex } from './pr-ref.ts';

const pr7 = 'https://github.com/o/r/pull/7';

test('urlIndex ignores a longer URL that shares the prefix', () => {
  assert.equal(urlIndex(`old PR ${pr7}0 gone`, pr7), -1);
  assert.equal(urlIndex(`${pr7}0 then ${pr7}`, pr7), `${pr7}0 then `.length);
});

test('urlIndex finds the URL at the end of a sentence or in parentheses', () => {
  assert.equal(urlIndex(`Merge PR #7 (${pr7}) now`, pr7), `Merge PR #7 (`.length);
  assert.equal(urlIndex(`see ${pr7}.`, pr7), 'see '.length);
  assert.equal(urlIndex('no link here', pr7), -1);
});
