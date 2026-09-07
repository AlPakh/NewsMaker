'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 4173);
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.json':'application/json; charset=utf-8','.md':'text/markdown; charset=utf-8','.png':'image/png','.jpg':'image/jpeg'};
const server = http.createServer((req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const target = path.resolve(root, '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
    if (!target.startsWith(root + path.sep) || /(?:^|[\\/])\.[^\\/]/.test(path.relative(root,target))) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.readFile(target, (error, data) => {
      if (error) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {'Content-Type':types[path.extname(target)] || 'application/octet-stream','Cache-Control':'no-cache'});
      res.end(data);
    });
  } catch { res.writeHead(400); res.end('Bad request'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Газетная мастерская: http://127.0.0.1:${port}`));
