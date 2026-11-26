// Smoke test a deployed service using a guest workspace and synthetic evidence.
const base = process.env.VERITY_TEST_URL;
if (!base || !base.startsWith('https://')) throw Error('Set VERITY_TEST_URL to the HTTPS Verity deployment.');
let cookie = '';
async function api(path, method = 'GET', body) {
  const response = await fetch(new URL('/api/' + path, base), {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const setCookie = response.headers.getSetCookie().at(-1);
  if (setCookie) cookie = setCookie.split(';')[0];
  const value = await response.json();
  if (!response.ok) throw Error(path + ' HTTP ' + response.status + ': ' + (value.error || 'Unknown error'));
  return value;
}
await api('account');
const claim = 'Does incremental compilation reduce build time compared with a full rebuild?';
const plan = await api('plan', 'POST', { claim });
const { id } = await api('research', 'POST', {
  ...plan,
  claim,
  query: 'incremental compilation build time',
  questions: [claim],
  searchOnline: false,
  attachments: ['Synthetic controlled observation.pdf'],
  uploads: [{
    source: {
      id: 'pdf-0123456789abcdef01234567', title: 'Synthetic controlled observation',
      provider: 'Local upload', authors: [], type: 'PDF', access: 'full', venue: 'Test fixture',
    },
    passages: [{ location: 'PDF page 1', text: 'In this synthetic controlled trial, incremental compilation reduced median build time from 60 seconds to 30 seconds compared with a full rebuild on the same codebase.' }],
  }],
});
const deadline = Date.now() + 6 * 60000;
while (Date.now() < deadline) {
  const report = await api('research/' + id);
  if (report.status === 'complete') {
    console.log(JSON.stringify({ status: report.status, model: report.analysis?.model, indexed: report.analysis?.indexed, verified: report.analysis?.verified, citations: report.evidence?.length }));
    process.exit(0);
  }
  if (report.status === 'failed' || report.status === 'stopped') throw Error('Investigation ' + report.status + ': ' + report.error);
  await new Promise((resolve) => setTimeout(resolve, 3000));
}
throw Error('Hosted investigation did not finish within six minutes.');
