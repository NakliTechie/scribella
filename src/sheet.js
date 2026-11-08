// A data sheet is a CSV or TSV file shown as a grid. It writes back in the format it came in.
import { parseTable } from './insert.js';

export function readSheet(text, path) {
  const rows = text.trim() ? parseTable(text) : [['']];
  const width = Math.max(...rows.map(row => row.length));
  return { separator:/\.tsv$/i.test(path) ? '\t' : ',', rows:rows.map(row => [...row, ...Array(width - row.length).fill('')]) };
}

const quote = (cell, separator) => (/[",\n\t]/.test(cell) && (separator === ',' || cell.includes('\t')) ? `"${cell.replace(/"/g, '""')}"` : cell);

export const writeSheet = ({ rows, separator }) => `${rows.map(row => row.map(cell => quote(cell, separator)).join(separator)).join('\n')}\n`;
