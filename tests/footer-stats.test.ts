import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footerStats, compactNumber, durationText } from '../src/tui/footer-stats.ts';

test('footer totals usage across models and counts user messages once', () => {
  const usage = { input: 10, output: 5, cacheRead: 20, cacheWrite: 3, cost: { total: 0.1 } };
  const entries = [
    { type: 'message', message: { role: 'user' } },
    { type: 'message', message: { role: 'assistant', provider: 'a', model: 'one', usage, durationMs: 1200 } },
    { type: 'message', message: { role: 'assistant', provider: 'b', model: 'two', usage } },
    { type: 'compaction', usage },
  ];
  const stats = footerStats(entries as any);
  assert.equal(stats.input, 99);
  assert.equal(stats.output, 15);
  assert.equal(stats.read, 60);
  assert.equal(stats.prompts, 1);
  assert.equal(stats.timed, 1);
  assert.equal(stats.assistants, 2);
  assert.equal(stats.models.length, 2);
  assert.equal(compactNumber(1200), '1.2k');
  assert.equal(durationText(61000), '1m1s');
});
