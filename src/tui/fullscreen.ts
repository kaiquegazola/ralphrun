// fullscreen.ts — tiny alt-screen helper: enter/exit the terminal alternate
// screen buffer and hide/show the cursor. ?1007 (alternate scroll) makes the
// mouse wheel send ↑/↓ arrows while in the alt buffer on most terminals, so
// the chat scrolls with the wheel WITHOUT mouse capture (text selection keeps
// working). Accepts any writable so tests can capture the escape sequences.

export interface AnsiOut {
  write(s: string): unknown;
}

export function enterAltScreen(out: AnsiOut = process.stdout): void {
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1007h");
}

export function exitAltScreen(out: AnsiOut = process.stdout): void {
  out.write("\x1b[?1007l\x1b[?1049l\x1b[?25h");
}

// OSC 2: set the terminal window/tab title. TTY-only (callers gate on isTTY, so
// the escape never lands in piped/CI output); the shell reclaims the title on
// its next prompt after ralphrun exits.
export function setTitle(title: string, out: AnsiOut = process.stdout): void {
  out.write(`\x1b]2;${title}\x07`);
}
