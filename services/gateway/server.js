// API GATEWAY — porta 3000
// Ponto único de entrada para a loja e para o ERP. Encaminha cada rota
// /api/<serviço>/* para o microserviço correspondente e agrega o health check.
//
//   /api/clientes/*   → clientes   :3001
//   /api/catalogo/*   → catalogo   :3002
//   /api/estoque/*    → estoque    :3003
//   /api/tributario/* → tributario :3004
//   /api/pedidos/*    → pedidos    :3005
//
// Executar: node services/gateway/server.js

import http from 'node:http';

const PORT = Number(process.env.GATEWAY_PORT || 3000);

const SERVICOS = {
  clientes: process.env.CLIENTES_URL || 'http://localhost:3001',
  catalogo: process.env.CATALOGO_URL || 'http://localhost:3002',
  estoque: process.env.ESTOQUE_URL || 'http://localhost:3003',
  tributario: process.env.TRIBUTARIO_URL || 'http://localhost:3004',
  pedidos: process.env.PEDIDOS_URL || 'http://localhost:3005',
};

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

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

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const resposta = await fetch(`${destino}${match[2] || '/'}${url.search}`, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] || 'application/json' },
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
  console.log('[gateway] rotas:', Object.entries(SERVICOS).map(([n, u]) => `/api/${n} → ${u}`).join(' | '));
});
