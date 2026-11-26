import { describe, expect, it, vi } from 'vitest';

vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));

import { cleanExtractedText, extractPdfText, itemsToText } from '../src/services/pdfText';
import { quoteFoundIn } from '../src/services/planReview';

/** Build a minimal valid one-page PDF with Helvetica text lines. */
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const stream = ['BT', '/F1 10 Tf', '14 TL', '40 760 Td', ...lines.map((l) => `(${esc(l)}) Tj T*`), 'ET'].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('PDF text extraction', () => {
  it('extracts sheet notes from a text PDF so quotes can be validated against it', async () => {
    const pdf = makePdf([
      'SHEET A-301 - LEVEL 3 FLOOR PLAN',
      '4. Corridor clear width: 40 in. minimum at all residential corridors.',
      '5. West wing corridor terminates in a dead end 55 ft long.',
    ]);
    const { text, pages } = await extractPdfText(pdf);
    expect(pages).toBe(1);
    expect(text).toContain('SHEET A-301');
    expect(quoteFoundIn('Corridor clear width: 40 in. minimum at all residential corridors.', text)).toBe(true);
  });

  it('rejects PDFs without extractable text', async () => {
    await expect(extractPdfText(makePdf(['x']))).rejects.toThrow(/No extractable text/);
  });

  it('joins pdf.js items into lines', () => {
    expect(itemsToText([{ str: 'Corridor', hasEOL: false }, { str: 'width', hasEOL: true }, { str: 'Line 2' }])).toBe('Corridor width\nLine 2');
    expect(cleanExtractedText(['a  b \n\n\n\n c', 'd'])).toBe('a b\n\nc\n\nd');
  });
});
