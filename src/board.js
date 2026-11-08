// A whiteboard for figures: shapes in a JSON file beside the paper, drawn as SVG on screen and saved as a PDF that TeX
// can include with \includegraphics.
import { PDFDocument, rgb } from '../vendor/pdf-lib/pdf-lib.esm.js';

export const blankBoard = () => ({ width:640, height:400, shapes:[] });

export function readBoard(text) {
  try {
    const board = JSON.parse(text);
    return Array.isArray(board.shapes) ? { width:Number(board.width) || 640, height:Number(board.height) || 400, shapes:board.shapes } : blankBoard();
  } catch (_) { return blankBoard(); }
}

const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' })[char]);
const pathOf = points => points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

export function shapeSvg(shape) {
  const stroke = 'stroke="#222" stroke-width="2" fill="none"';
  if (shape.kind === 'pen') return `<path d="${pathOf(shape.points)}" ${stroke} stroke-linecap="round" stroke-linejoin="round"/>`;
  if (shape.kind === 'rect') return `<rect x="${shape.x}" y="${shape.y}" width="${shape.w}" height="${shape.h}" ${stroke}/>`;
  if (shape.kind === 'ellipse') return `<ellipse cx="${shape.x + shape.w / 2}" cy="${shape.y + shape.h / 2}" rx="${Math.abs(shape.w / 2)}" ry="${Math.abs(shape.h / 2)}" ${stroke}/>`;
  if (shape.kind === 'arrow') {
    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1), head = 10;
    const wing = turn => [shape.x2 - head * Math.cos(angle + turn), shape.y2 - head * Math.sin(angle + turn)];
    return `<path d="${pathOf([[shape.x1, shape.y1], [shape.x2, shape.y2]])} ${pathOf([wing(0.5), [shape.x2, shape.y2], wing(-0.5)])}" ${stroke}/>`;
  }
  if (shape.kind === 'text') return `<text x="${shape.x}" y="${shape.y}" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#222">${escape(shape.text)}</text>`;
  return '';
}

export const boardSvg = board => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${board.width} ${board.height}" width="${board.width}" height="${board.height}">${board.shapes.map(shapeSvg).join('')}</svg>`;

// PDF space starts at the bottom left, so each y is flipped.
export async function boardPdf(board) {
  const pdf = await PDFDocument.create(), page = pdf.addPage([board.width, board.height]);
  const black = rgb(0.13, 0.13, 0.13), flip = y => board.height - y, font = await pdf.embedFont('Helvetica');
  for (const shape of board.shapes) {
    if (shape.kind === 'pen' && shape.points.length > 1) page.drawSvgPath(pathOf(shape.points), { x:0, y:board.height, borderColor:black, borderWidth:2 });
    if (shape.kind === 'rect') page.drawRectangle({ x:Math.min(shape.x, shape.x + shape.w), y:flip(Math.max(shape.y, shape.y + shape.h)), width:Math.abs(shape.w), height:Math.abs(shape.h), borderColor:black, borderWidth:2 });
    if (shape.kind === 'ellipse') page.drawEllipse({ x:shape.x + shape.w / 2, y:flip(shape.y + shape.h / 2), xScale:Math.abs(shape.w / 2), yScale:Math.abs(shape.h / 2), borderColor:black, borderWidth:2 });
    if (shape.kind === 'arrow') page.drawSvgPath(shapeSvg(shape).match(/d="([^"]+)"/)[1], { x:0, y:board.height, borderColor:black, borderWidth:2 });
    if (shape.kind === 'text') page.drawText(String(shape.text), { x:shape.x, y:flip(shape.y), size:16, font, color:black });
  }
  return pdf.save();
}
