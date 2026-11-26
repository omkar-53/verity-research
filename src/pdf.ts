import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Passage, Source } from './model';

GlobalWorkerOptions.workerSrc = pdfWorker;

const maxPages = 60;

export async function readPdf(file: File): Promise<{ source: Source; passages: Passage[]; warning?: string }> {
  const bytes = await file.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const id = 'pdf-' + [...new Uint8Array(hash).slice(0, 12)].map((value) => value.toString(16).padStart(2, '0')).join('');
  const task = getDocument({ data: bytes, isEvalSupported: false });
  try {
    const document = await task.promise;
    const passages: Passage[] = [];
    for (let index = 1; index <= Math.min(document.numPages, maxPages); index++) {
      const page = await document.getPage(index);
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
      if (text) passages.push({ text, location: 'PDF page ' + index });
      page.cleanup();
    }
    const source: Source = {
      id,
      title: file.name.replace(/\.pdf$/i, ''),
      authors: [],
      venue: 'User-provided document',
      type: 'PDF',
      access: passages.length ? 'full' : 'metadata',
      provider: 'Local upload',
    };
    const warning = !passages.length ? file.name + ' has no extractable text. Scanned pages require a text layer.'
      : document.numPages > maxPages ? 'Only the first ' + maxPages + ' pages of ' + file.name + ' were examined.' : undefined;
    return { passages, source, warning };
  } finally {
    await task.destroy();
  }
}
