// Простой статический сервер для стенда Фазы 0.
// Никаких CSP-заголовков не ставит намеренно: стенд — это контрольная точка,
// от которой отличается поведение внутри SillyTavern.

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.PORT ?? 8123);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
    '.wad': 'application/octet-stream',
};

createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
    const path = join(ROOT, rel === '' ? 'sandbox/phase0.html' : rel);

    // Защита от выхода за пределы репозитория.
    if (!path.startsWith(ROOT)) {
        res.writeHead(403).end('forbidden');
        return;
    }

    try {
        const info = await stat(path);
        if (info.isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'Content-Length': info.size,
            'Cache-Control': 'no-store',
        });
        createReadStream(path).pipe(res);
    } catch {
        res.writeHead(404).end('not found');
    }
}).listen(PORT, '127.0.0.1', () => {
    console.log(`стенд: http://127.0.0.1:${PORT}/sandbox/phase0.html`);
});
