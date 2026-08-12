/**
 * The browser terminal must not type xterm.js's own capability answers into the
 * remote shell. Run: yarn test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { filterTerminalInput } from '../../apps/web/src/lib/deploy/terminal-input.ts';

const ESC = '\x1b';

test('primary and secondary device attribute replies are dropped', () => {
  // What xterm.js answers to `CSI c` and `CSI > c`. Echoed at a prompt these are
  // the `1;2c0;276;0c` runs that filled the console.
  assert.equal(filterTerminalInput(`${ESC}[?1;2c`), '');
  assert.equal(filterTerminalInput(`${ESC}[>0;276;0c`), '');
  assert.equal(filterTerminalInput(`${ESC}[?1;2c${ESC}[>0;276;0c`), '');
});

test('the tertiary DCS reply is dropped too', () => {
  assert.equal(filterTerminalInput(`${ESC}P!|00000000${ESC}\\`), '');
});

test('a reply riding along with real input keeps only the input', () => {
  assert.equal(filterTerminalInput(`${ESC}[?1;2cls -la\r`), 'ls -la\r');
});

test('real keystrokes pass through untouched', () => {
  // Arrow keys, Escape, Ctrl+C, and plain text are input, not answers: dropping
  // any of them would break the terminal instead of fixing the noise.
  for (const keys of ['ls -la\r', `${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`, ESC, '\x03', 'sudo systemctl status\r']) {
    assert.equal(filterTerminalInput(keys), keys);
  }
});
