#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';

const extension = fileURLToPath(new URL('../', import.meta.url));
const { error, status, signal } = spawnSync('pi', ['--extension', extension, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

if (error) {
  console.error(error.code === 'ENOENT'
    ? 'bee: Pi was not found on PATH. Install the Pi coding agent first.'
    : `bee: could not start Pi: ${error.message}`);
  process.exitCode = error.code === 'ENOENT' ? 127 : 1;
} else {
  process.exitCode = status ?? (signal ? 128 + constants.signals[signal] : 1);
}
