/**
 * What the browser terminal is allowed to send to the host.
 *
 * xterm.js answers terminal capability queries by itself and reports the answer
 * through the same `onData` callback as a keystroke. tmux asks who it is talking
 * to when it attaches, but input travels browser -> HTTP POST -> SSH -> tmux, so
 * the answer lands long after tmux stopped waiting for it. tmux then hands the
 * leftover bytes to the pane's shell, which echoes them, and the prompt fills
 * with `1;2c0;276;0c` repeating -- the visible halves of a primary and a
 * secondary Device Attributes reply.
 *
 * Everything that asks these questions has a default to fall back on, so a
 * late answer is worth strictly less than no answer at all.
 */

/**
 * Primary DA (`CSI ? … c`), secondary DA (`CSI > … c`), and the tertiary DA
 * reply, which comes back as a DCS string instead of a CSI one.
 */
const CAPABILITY_REPLY = /\x1b\[[?>][0-9;]*c|\x1bP!\|[0-9A-Fa-f]*\x1b\\/g;

/**
 * Strip the self-generated capability answers from one `onData` payload.
 *
 * Returns an empty string when the payload was nothing but an answer, which the
 * caller should treat as "not a keystroke" and skip sending. Real input is
 * passed through untouched, including escape sequences for arrow keys and the
 * Escape key itself: those are not replies and the shell needs them.
 */
export function filterTerminalInput(data: string): string {
  return data.replace(CAPABILITY_REPLY, '');
}
