import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { BI_CONFIG } from '../src/config/index.ts';
import { loadProjectConfig } from '../src/config/project.ts';
import { askQuestion } from '../src/extension/ask-user.ts';
import { ensureQuietStartup } from '../src/extension/quiet-startup.ts';
import { registerSystemInstruction } from '../src/slash/system-instruction.ts';
import extension from '../src/index.ts';
import { installTui } from '../src/tui/index.ts';
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

test('system instruction uses the core prompt from configuration', async () => {
  let handler: ((event: any, ctx: any) => Promise<{ systemPrompt: string }>) | undefined;
  registerSystemInstruction({
    on: (_event: string, callback: typeof handler) => { handler = callback; },
  } as any);

  const result = await handler!({ systemPromptOptions: {
    customPrompt: 'custom prefix',
    cwd: '/project',
    selectedTools: [],
    hiddenTools: [],
    toolSnippets: {},
    toolGuidelines: {},
    contextFiles: [],
    skills: [],
    sections: {},
    appendSystemPrompt: '',
  } }, { isProjectTrusted: () => true });
  assert.ok(result.systemPrompt.includes(BI_CONFIG.systemPrompt.core.join('\n')));
  assert.ok(result.systemPrompt.startsWith('custom prefix'));
});

test('project-specific system prompt is added only for trusted projects', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-prompt-config-'));
  try {
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'config.json'), JSON.stringify({
      systemPrompt: { additional: 'Use this project’s established conventions.' },
    }));
    let handler: ((event: any, ctx: any) => Promise<{ systemPrompt: string }>) | undefined;
    registerSystemInstruction({
      on: (_event: string, callback: typeof handler) => { handler = callback; },
    } as any);
    const event = { systemPromptOptions: {
      customPrompt: '',
      cwd,
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      contextFiles: [],
      skills: [],
      sections: {},
      appendSystemPrompt: '',
    } };

    const trusted = await handler!(event, { isProjectTrusted: () => true });
    assert.ok(trusted.systemPrompt.includes('Use this project’s established conventions.'));
    assert.ok(trusted.systemPrompt.indexOf(BI_CONFIG.systemPrompt.core[0]) <
      trusted.systemPrompt.indexOf('Use this project’s established conventions.'));

    const untrusted = await handler!(event, { isProjectTrusted: () => false });
    assert.ok(!untrusted.systemPrompt.includes('Use this project’s established conventions.'));
    assert.ok(untrusted.systemPrompt.includes(BI_CONFIG.systemPrompt.core[0]));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('TUI header text and shortcuts come from configuration', () => {
  let createHeader: ((tui: unknown, theme: { fg: (_color: string, text: string) => string }) => {
    render(width: number): string[];
  }) | undefined;
  installTui({
    cwd: '/project',
    ui: {
      setHeader: (factory: typeof createHeader) => { createHeader = factory; },
      setFooter: () => {},
    },
  } as any);

  const header = createHeader!({}, { fg: (_color, text) => text });
  const rendered = header.render(100).join('\n');
  assert.ok(rendered.includes(BI_CONFIG.ui.tagline));
  assert.ok(rendered.includes(BI_CONFIG.ui.gettingStarted));
  assert.ok(rendered.includes(BI_CONFIG.ui.commands[0].command));
  assert.ok(rendered.includes(BI_CONFIG.ui.keys[0].key));
});

test('session startup creates project config and default settings', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-startup-defaults-'));
  try {
    const handlers = new Map<string, (...args: any[]) => unknown>();
    extension({
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
    } as any);
    await handlers.get('session_start')!({}, {
      cwd,
      mode: 'rpc',
      ui: { notify: () => {} },
    });
    const projectConfig = JSON.parse(await readFile(path.join(cwd, '.pi', 'config.json'), 'utf8'));
    assert.deepEqual(projectConfig, {
      filesystem: BI_CONFIG.filesystem,
      git: BI_CONFIG.git,
      output: BI_CONFIG.output,
      startup: BI_CONFIG.startup,
      systemPrompt: { additional: '' },
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, '.pi', 'settings.json'), 'utf8')), {
      quietStartup: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('session startup notification comes from configuration', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-startup-'));
  try {
    await mkdir(path.join(cwd, '.pi'), { recursive: true });
    await writeFile(path.join(cwd, '.pi', 'config.json'), JSON.stringify({
      startup: { autoEnableQuietStartup: false },
    }));
    const handlers = new Map<string, (...args: any[]) => unknown>();
    extension({
      registerTool: () => {},
      registerCommand: () => {},
      on: (event: string, handler: (...args: any[]) => unknown) => { handlers.set(event, handler); },
    } as any);
    const messages: string[] = [];
    await handlers.get('session_start')!({}, {
      cwd,
      mode: 'rpc',
      ui: { notify: (message: string) => messages.push(message) },
    });
    assert.ok(messages.includes(BI_CONFIG.ui.startupMessage));
    assert.deepEqual(JSON.parse(await readFile(path.join(cwd, '.pi', 'config.json'), 'utf8')), {
      startup: { autoEnableQuietStartup: false },
    });
    await assert.rejects(readFile(path.join(cwd, '.pi', 'settings.json')), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('project config accepts only allowlisted and bounded preferences', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-project-config-'));
  const configPath = path.join(cwd, '.pi', 'config.json');
  try {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      filesystem: { defaultReadLimit: 500, maxReadLineLength: 20_001, maxGrepMatches: 50 },
      git: { defaultLogLimit: 101 },
      output: { maxChars: 2_000 },
      startup: { autoEnableQuietStartup: false },
      systemPrompt: { additional: 'Use local conventions.' },
      toolGroups: { execution: false },
      execution: { allowCommand: 'unsafe' },
    }));
    assert.deepEqual(await loadProjectConfig(cwd), {
      filesystem: { defaultReadLimit: 500, maxGrepMatches: 50 },
      output: { maxChars: 2_000 },
      startup: { autoEnableQuietStartup: false },
      systemPrompt: { additional: 'Use local conventions.' },
    });

    await writeFile(configPath, JSON.stringify({ systemPrompt: { additional: 'x'.repeat(8_001) } }));
    assert.deepEqual(await loadProjectConfig(cwd), {});

    await writeFile(configPath, '{ invalid json');
    assert.deepEqual(await loadProjectConfig(cwd), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('ensureQuietStartup can opt out without creating project settings', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'bi-extension-'));
  try {
    await ensureQuietStartup(cwd, false);
    await assert.rejects(readFile(path.join(cwd, '.pi', 'settings.json')), { code: 'ENOENT' });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
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
