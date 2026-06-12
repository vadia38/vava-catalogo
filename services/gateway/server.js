// API GATEWAY — porta 3000
// Ponto único de entrada para a loja e para o ERP. Encaminha cada rota
// /api/<serviço>/* para o microserviço correspondente e agrega o health check.
//
//   /api/clientes/*     → clientes     :3001
//   /api/catalogo/*     → catalogo     :3002
//   /api/estoque/*      → estoque      :3003
//   /api/tributario/*   → tributario   :3004
//   /api/pedidos/*      → pedidos      :3005
//   /api/marketplaces/* → marketplaces :3006
//   /api/usuarios/*     → usuarios     :3007
//
// Proteções de produção:
//   - CORS restrito por ALLOWED_ORIGINS (lista separada por vírgula; padrão *)
//   - Rate limit em memória por IP (RATE_LIMIT_RPM, padrão 300 req/min)
//   - Limite de corpo (MAX_BODY_MB, padrão 8 MB — fotos de produto)
//   - Headers de segurança nas respostas
//   - ROTAS ADMINISTRATIVAS exigem Bearer token validado no serviço de
//     usuários (sync de cadastros, gestão de catálogo/anúncios/canais, etc.)
//
// Executar: node services/gateway/server.js

import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT || 3000);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean);
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM || 300);
const MAX_BODY = Number(process.env.MAX_BODY_MB || 8) * 1024 * 1024;

const SERVICOS = {
  clientes: process.env.CLIENTES_URL || 'http://localhost:3001',
  catalogo: process.env.CATALOGO_URL || 'http://localhost:3002',
  estoque: process.env.ESTOQUE_URL || 'http://localhost:3003',
  tributario: process.env.TRIBUTARIO_URL || 'http://localhost:3004',
  pedidos: process.env.PEDIDOS_URL || 'http://localhost:3005',
  marketplaces: process.env.MARKETPLACES_URL || 'http://localhost:3006',
  usuarios: process.env.USUARIOS_URL || 'http://localhost:3007',
};

// Rotas que exigem usuário autenticado (operações administrativas/do ERP).
// As rotas públicas da loja (catálogo GET, cálculo tributário, checkout,
// registro/login de cliente, webhooks) seguem abertas.
const PROTEGIDAS = [
  { metodos: ['GET', 'POST', 'PUT', 'DELETE'], padrao: /^\/api\/usuarios\/usuarios/ },
  { metodos: ['POST'], padrao: /^\/api\/clientes\/sync$/ },
  { metodos: ['GET'], padrao: /^\/api\/clientes\/clientes/ },          // listagem de PII só autenticado
  { metodos: ['PUT', 'DELETE'], padrao: /^\/api\/clientes\/clientes\// },
  { metodos: ['POST', 'PUT', 'DELETE'], padrao: /^\/api\/catalogo\/(sync|produtos)/ },
  { metodos: ['POST'], padrao: /^\/api\/estoque\/(sync|movimentos)/ },
  { metodos: ['POST'], padrao: /^\/api\/pedidos\/pedidos\/marcar-exportados$/ },
  { metodos: ['PUT'], padrao: /^\/api\/pedidos\/pedidos\/[^/]+\/status$/ },
  { metodos: ['GET'], padrao: /^\/api\/pedidos\/pedidos\??/, somenteComFiltro: 'pendentesErp' },
  { metodos: ['POST', 'PUT'], padrao: /^\/api\/marketplaces\/(canais|anuncios|pedidos\/simular)/ },
];

function exigeAutenticacao(metodo, pathname, query) {
  for (const regra of PROTEGIDAS) {
    if (!regra.metodos.includes(metodo)) continue;
    if (!regra.padrao.test(pathname)) continue;
    if (regra.somenteComFiltro && !query.has(regra.somenteComFiltro)) continue;
    return true;
  }
  return false;
}

// Cache curto de validação de token (evita uma chamada por requisição).
const cacheTokens = new Map(); // token → { ok, ate }
async function tokenValido(token) {
  if (!token) return false;
  const agora = Date.now();
  const c = cacheTokens.get(token);
  if (c && c.ate > agora) return c.ok;
  let ok = false;
  try {
    const r = await fetch(`${SERVICOS.usuarios}/auth/sessao`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
    ok = r.ok;
  } catch {
    ok = false;
  }
  cacheTokens.set(token, { ok, ate: agora + 30_000 });
  if (cacheTokens.size > 5000) cacheTokens.clear();
  return ok;
}

// Rate limit simples em memória (janela deslizante por minuto).
const hits = new Map(); // ip → { ate, total }
function dentroDoLimite(ip) {
  const agora = Date.now();
  const h = hits.get(ip);
  if (!h || h.ate < agora) {
    hits.set(ip, { ate: agora + 60_000, total: 1 });
    return true;
  }
  h.total++;
  return h.total <= RATE_LIMIT_RPM;
}

function aplicarCors(req, res) {
  const origem = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origem && ALLOWED_ORIGINS.includes(origem)) {
    res.setHeader('Access-Control-Allow-Origin', origem);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Headers de segurança
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

const server = http.createServer(async (req, res) => {
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '?';
  if (!dentroDoLimite(ip)) {
    send(429, { erro: 'Limite de requisições excedido. Tente novamente em instantes.' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health agregado: consulta todos os serviços em paralelo.
  if (url.pathname === '/health' || url.pathname === '/api/health') {
    const status = await Promise.all(
      Object.entries(SERVICOS).map(async ([nome, base]) => {
        try {
          const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
          return [nome, r.ok ? 'ok' : 'erro'];
        } catch {
          return [nome, 'offline'];
        }
      })
    );
    send(200, { gateway: 'ok', servicos: Object.fromEntries(status), hora: new Date().toISOString() });
    return;
  }

  // /api/<serviço>/<resto> → http://<serviço>/<resto>
  const match = url.pathname.match(/^\/api\/([^/]+)(\/.*)?$/);
  const destino = match && SERVICOS[match[1]];
  if (!destino) {
    send(404, { erro: `Serviço desconhecido. Disponíveis: ${Object.keys(SERVICOS).join(', ')}` });
    return;
  }

  // Autenticação das rotas administrativas (o login fica sempre aberto).
  const ehLogin = /^\/api\/usuarios\/auth\/(login|logout|sessao|trocar-senha)$/.test(url.pathname);
  if (!ehLogin && exigeAutenticacao(req.method, url.pathname, url.searchParams)) {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await tokenValido(token))) {
      send(401, { erro: 'Autenticação necessária: faça login no ERP (Bearer token).' });
      return;
    }
  }

  try {
    const chunks = [];
    let tamanho = 0;
    for await (const chunk of req) {
      tamanho += chunk.length;
      if (tamanho > MAX_BODY) {
        send(413, { erro: `Corpo da requisição excede ${MAX_BODY / 1024 / 1024} MB.` });
        return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const resposta = await fetch(`${destino}${match[2] || '/'}${url.search}`, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        'X-Forwarded-For': ip,
      },
      body: body.length ? body : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const texto = await resposta.text();
    res.writeHead(resposta.status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(texto);
  } catch (err) {
    send(502, { erro: `Serviço '${match[1]}' indisponível: ${err.message}` });
  }
});

server.listen(PORT, () => {
  console.log(`[gateway] ouvindo em http://localhost:${PORT}`);
  console.log(`[gateway] CORS: ${ALLOWED_ORIGINS.join(', ')} | rate limit: ${RATE_LIMIT_RPM} req/min/IP`);
  console.log('[gateway] rotas:', Object.entries(SERVICOS).map(([n, u]) => `/api/${n} → ${u}`).join(' | '));
});
