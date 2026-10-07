import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT ?? 5174);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  const file = join(root, pathname === '/' ? '/index.html' : pathname);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': mime[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, {'content-type': 'text/plain'});
    res.end('not found');
  }
}).listen(port, '127.0.0.1');
