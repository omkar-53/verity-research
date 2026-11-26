import type { Plan, Session } from './model';

export async function api<T>(path: string, method = 'GET', payload?: unknown): Promise<T> {
  const response = await fetch('/api/' + path, { method, credentials: 'same-origin',
    headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Research service unavailable.');
  return result as T;
}

export async function submitResearch(plan: Plan, files: File[]) {
  const uploads = [];
  if (files.length) {
    const { readPdf } = await import('./pdf');
    for (const file of files) {
      try { uploads.push(await readPdf(file)); }
      catch { throw Error('Unable to extract ' + file.name + '. Check that it is a readable, unlocked PDF.'); }
    }
  }
  return api<Session>('research', 'POST', { ...plan, uploads });
}
