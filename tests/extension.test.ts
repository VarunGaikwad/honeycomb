import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { askQuestion } from '../src/extension/ask-user.ts';
import { ensureQuietStartup } from '../src/extension/quiet-startup.ts';
import type { AskQuestion } from '../src/types/index.ts';

const question: AskQuestion = {
  id: 'kind',
  header: 'Kind',
  question: 'Choose a kind',
  multiSelect: false,
  options: [
    { label: 'Mammal', description: 'Warm-blooded', recommended: true },
    { label: 'Bird', description: 'Has feathers' },
  ],
};

test('askQuestion returns a selected structured option', async () => {
  const ctx = {
    ui: {
      select: async () => 'Mammal (recommended) — Warm-blooded',
      input: async () => undefined,
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(await askQuestion(ctx, question), {
    id: 'kind',
    selected: ['Mammal'],
    customText: null,
  });
});

test('askQuestion collects custom text and selections in multi-select mode', async () => {
  const choices = [
    'Mammal (recommended) — Warm-blooded',
    'Type a custom answer…',
    'Done selecting',
  ];
  const ctx = {
    ui: {
      select: async () => choices.shift(),
      input: async () => 'Reptile',
    },
  } as unknown as ExtensionContext;

  assert.deepEqual(await askQuestion(ctx, { ...question, multiSelect: true }), {
    id: 'kind',
    selected: ['Mammal'],
    customText: 'Reptile',
  });
});

test('ensureQuietStartup preserves settings and does not override an explicit value', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-extension-'));
  try {
    await ensureQuietStartup(cwd);
    const settingsPath = path.join(cwd, '.pi', 'settings.json');
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { quietStartup: true });

    await writeFile(settingsPath, '{"quietStartup":false,"theme":"dark"}\n', 'utf8');
    await ensureQuietStartup(cwd);
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
      quietStartup: false,
      theme: 'dark',
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
