import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';
import { createService } from './service.mjs';

const root = fileURLToPath(new URL('../dist', import.meta.url));
const service = await createService(process.env);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) { req.url = req.url.slice(4); return service.app(req, res); }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(path).on('error', () => res.destroy()).pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end('Not found');
  }
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log('Verity is available at http://127.0.0.1:' + server.address().port);
});

async function shutdown() {
  server.close();
  const deadline = setTimeout(() => process.exit(1), 40_000);
  deadline.unref();
  try {
    await service.close();
    process.exit(0);
  } catch (error) {
    console.error('Verity shutdown:', error.message);
    process.exit(1);
  }
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
