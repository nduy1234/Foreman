import api, { route } from '@forge/api';

/** Max PDF size we will parse inside a Forge function (memory + 5 min budget). */
export const MAX_PDF_BYTES = 15 * 1024 * 1024;

/** Download a Jira attachment as bytes (asApp, so it also works from the async consumer). */
export async function downloadAttachment(attachmentId: string): Promise<Uint8Array> {
  const res = await api.asApp().requestJira(route`/rest/api/3/attachment/content/${attachmentId}`, { method: 'GET' });
  if (!res.ok) throw new Error(`Could not download attachment ${attachmentId}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_PDF_BYTES) throw new Error(`PDF is too large to review (${Math.round(buf.byteLength / 1e6)} MB, limit 15 MB)`);
  return buf;
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: { str?: string; hasEOL?: boolean }[] }> }>;
  destroy?: () => Promise<void>;
}

/** Join pdf.js text items into lines; exported for unit tests. */
export function itemsToText(items: { str?: string; hasEOL?: boolean }[]): string {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    line += item.str;
    if (item.hasEOL) {
      lines.push(line.trimEnd());
      line = '';
    } else if (item.str && !item.str.endsWith(' ')) {
      line += ' ';
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join('\n');
}

export function cleanExtractedText(pages: string[]): string {
  return pages
    .join('\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract text from a PDF with unpdf's bundled serverless pdf.js build (`unpdf/pdfjs`).
 * We import the build directly: unpdf's main entry probes for the optional `pdfjs-dist`
 * package, which Forge's bundler cannot resolve. Lazy import keeps pdf.js out of cold starts.
 */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const pdfjs = (await import('unpdf/pdfjs')) as unknown as {
    getDocument: (src: Record<string, unknown>) => { promise: Promise<PdfDoc> };
  };
  const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, disableFontFace: true }).promise;
  const pages: string[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    pages.push(itemsToText(content.items));
  }
  await doc.destroy?.();
  const clean = cleanExtractedText(pages);
  if (clean.length < 40) throw new Error('No extractable text in this PDF (it may be a scanned image). Paste the sheet notes instead.');
  return { text: clean, pages: doc.numPages };
}
