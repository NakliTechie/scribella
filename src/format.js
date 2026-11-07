// Indents a LaTeX file by its environments. It changes only leading whitespace and trailing spaces, so what TeX reads
// stays the same; verbatim text is left exactly as it is.
const VERBATIM = /\\begin\{(verbatim|lstlisting|minted|comment)\*?\}/;
const VERBATIM_END = /\\end\{(verbatim|lstlisting|minted|comment)\*?\}/;
const UNIT = '  ';

export function formatLatex(source) {
  let depth = 0, inside = false;
  const out = [];
  for (const raw of source.split('\n')) {
    if (inside) {
      out.push(raw);
      if (VERBATIM_END.test(raw)) { inside = false; depth = Math.max(0, depth - 1); }
      continue;
    }
    const line = raw.trim();
    if (!line) { out.push(''); continue; }
    if (VERBATIM.test(line) && !VERBATIM_END.test(line)) { out.push(UNIT.repeat(depth) + line); inside = true; depth += 1; continue; }
    const code = line.replace(/(?<!\\)%.*$/, '');
    const opens = (code.match(/\\begin\{(?!document\})/g) || []).length, closes = (code.match(/\\end\{(?!document\})/g) || []).length;
    const leading = /^\\end\{(?!document\})/.test(line) ? 1 : 0;
    out.push(UNIT.repeat(Math.max(0, depth - leading)) + line);
    depth = Math.max(0, depth + opens - closes);
  }
  return out.join('\n');
}
