// markdown.ts — markdown-lite PURO pro chat do studio: headings, **bold**,
// `code` inline, bullets e code fences, já HARD-WRAPPED na largura dada.
// Devolve linhas de spans estilizados; a view só mapeia span -> <Text>.
// ponytail: char-wrap (sem word-break); troca por word-wrap se incomodar.

export type SpanStyle = "plain" | "bold" | "code" | "heading" | "bullet";

export interface Span {
  text: string;
  style: SpanStyle;
}

export function mdToLines(text: string, width: number): Span[][] {
  const w = Math.max(1, width);
  const out: Span[][] = [];
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue; // fence markers themselves are chrome, not content
    }
    if (inFence) {
      pushWrapped(out, [{ text: raw, style: "code" }], w);
      continue;
    }
    const h = /^#{1,3}\s+(.*)$/.exec(raw);
    if (h) {
      pushWrapped(out, [{ text: h[1], style: "heading" }], w);
      continue;
    }
    const b = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (b) {
      pushWrapped(out, [{ text: "• ", style: "bullet" }, ...inline(b[1])], w);
      continue;
    }
    pushWrapped(out, inline(raw), w);
  }
  return out.length ? out : [[{ text: "", style: "plain" }]];
}

// inline: **bold** e `code`; o resto plain.
function inline(s: string): Span[] {
  const spans: Span[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    if (m.index > last) spans.push({ text: s.slice(last, m.index), style: "plain" });
    if (m[2] !== undefined) spans.push({ text: m[2], style: "bold" });
    else spans.push({ text: m[3], style: "code" });
    last = m.index + m[0].length;
  }
  if (last < s.length) spans.push({ text: s.slice(last), style: "plain" });
  return spans.length ? spans : [{ text: "", style: "plain" }];
}

// hard-wrap: fatia a sequência de spans em linhas de até `width` chars,
// preservando o estilo de cada pedaço.
function pushWrapped(out: Span[][], spans: Span[], width: number): void {
  let line: Span[] = [];
  let used = 0;
  for (const sp of spans) {
    let rest = sp.text;
    while (rest.length > 0) {
      const room = width - used;
      if (room === 0) {
        out.push(line);
        line = [];
        used = 0;
        continue;
      }
      const take = rest.slice(0, room);
      line.push({ text: take, style: sp.style });
      used += take.length;
      rest = rest.slice(take.length);
    }
  }
  out.push(line.length ? line : [{ text: "", style: "plain" }]);
}
