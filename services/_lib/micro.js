// micro.js — base mínima compartilhada pelos microserviços.
// Node.js puro (sem dependências externas): servidor HTTP, roteador simples,
// parse de JSON, CORS e persistência em arquivo JSON.
//
// Cada serviço é independente: para implantá-lo sozinho, basta copiar a pasta
// do serviço junto com este arquivo.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const uid = (prefix = '') =>
  prefix + crypto.randomBytes(6).toString('hex') + Date.now().toString(36);

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------------------------------------------------------------------------
// Persistência: um arquivo JSON por serviço (data/db.json).
// ---------------------------------------------------------------------------
export function jsonDB(dir, seed = {}) {
  const file = path.join(dir, 'db.json');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    data = JSON.parse(JSON.stringify(seed));
  }
  const save = () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  };
  save();
  return { data, save };
}

// ---------------------------------------------------------------------------
// Servidor: createService({ name, port, routes })
// routes: [{ method, path: '/clientes/:id', handler(ctx) }]
// ctx = { params, query, body, req, res }
// handler retorna { status?, body } ou lança ApiError.
// ---------------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function compileRoute(route) {
  const keys = [];
  const pattern = route.path.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return '([^/]+)';
  });
  return { ...route, keys, regex: new RegExp(`^${pattern}/?$`) };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'Corpo da requisição não é um JSON válido.');
  }
}

export function createService({ name, port, routes }) {
  const compiled = routes.map(compileRoute);

  const server = http.createServer(async (req, res) => {
    // CORS liberado: as interfaces (loja e ERP) rodam em origens diferentes.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/health') {
      send(200, { servico: name, status: 'ok', hora: new Date().toISOString() });
      return;
    }

    try {
      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.regex);
        if (!match) continue;
        const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const result = await route.handler({ params, query: url.searchParams, body, req, res });
        send(result?.status || 200, result?.body ?? result ?? {});
        return;
      }
      send(404, { erro: `Rota não encontrada: ${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      if (status === 500) console.error(`[${name}]`, err);
      send(status, { erro: err.message || 'Erro interno.' });
    }
  });

  server.listen(port, () => {
    console.log(`[${name}] ouvindo em http://localhost:${port}`);
  });
  return server;
}

// Cliente HTTP mínimo para comunicação serviço → serviço.
export async function callService(baseUrl, method, pathname, body) {
  const res = await fetch(baseUrl + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.erro || `Falha ao chamar ${baseUrl}${pathname}`);
  return data;
}
