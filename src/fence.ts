// fence.ts — extract fenced code blocks from an agent's reply.
//
// Models writing long structured answers (a 33-task PRD) routinely emit
// SEVERAL ```json blocks in one turn — successive drafts, or examples before
// the real payload. The naive "first fence to next fence" read grabs a fragment
// between two openers (an opener line itself contains the closing marker!) and
// JSON.parse fails on a document that was RIGHT THERE. These helpers pair
// openers with their real closers line-wise and hand every candidate back, so
// callers can pick the best one instead of the first one.

/** every fenced block body, in order; an unterminated tail still counts */
export function fencedBlocks(text: string): string[] {
  const blocks: string[] = [];
  let cur: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("```")) {
      if (cur) cur.push(raw);
      continue;
    }
    const tagged = /^```[A-Za-z]/.test(line);
    if (cur) {
      // A TAGGED fence-line both closes the open block AND opens the next one:
      // models drafting long PRDs chain ```json after ```json, and the payload
      // sits behind the LAST opener. A BARE ``` just closes.
      blocks.push(cur.join("\n"));
      cur = null;
    }
    if (tagged) cur = [];
    // a bare ``` with nothing open is a stray closer: ignore it
  }
  // a model that dies mid-fence still said something worth trying
  if (cur && cur.length) blocks.push(cur.join("\n"));
  return blocks;
}

/**
 * The last fenced block that parses as a JSON object, tried newest-first: the
 * final block is usually the refined answer, earlier ones discarded drafts.
 * Returns null when nothing fenced parses.
 */
export function lastJsonObject(text: string): unknown | null {
  const blocks = fencedBlocks(text);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const body = blocks[i];
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const parsed: unknown = JSON.parse(body.slice(start, end + 1));
      if (typeof parsed === "object" && parsed !== null) return parsed;
    } catch {
      // control characters inside strings, trailing commas — try an earlier block
    }
  }
  return null;
}
