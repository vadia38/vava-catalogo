// Microserviço de MARKETPLACES — porta 3006
// Integração com canais de venda externos (Mercado Livre, Shopee, Amazon,
// Magalu). Responsabilidades:
//   - Gerenciar a conexão de cada canal (didática: sem OAuth real);
//   - Publicar ANÚNCIOS a partir do catálogo (merge por canal+SKU);
//   - Receber pedidos dos canais (webhook didático + simulador) e injetá-los
//     no MESMO fluxo do serviço de pedidos: baixa de estoque + motor
//     tributário + fila de exportação para o ERP — com canal e comissão.
//
// Executar: node services/marketplaces/server.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, jsonDB, uid, callService, ApiError } from '../_lib/micro.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

// Canais suportados (comissões didáticas, aproximadas das praticadas em 2025).
const SEED = {
  canais: [
    { id: 'mercado-livre', nome: 'Mercado Livre', icone: '🤝', comissaoPct: 13.0, conectado: false },
    { id: 'shopee', nome: 'Shopee', icone: '🛍️', comissaoPct: 14.0, conectado: false },
    { id: 'amazon', nome: 'Amazon', icone: '📦', comissaoPct: 15.0, conectado: false },
    { id: 'magalu', nome: 'Magalu', icone: '🏬', comissaoPct: 12.8, conectado: false },
  ],
  anuncios: [],
};

const { data: db, save } = jsonDB(dir, SEED);

const PORT = Number(process.env.MARKETPLACES_PORT || 3006);
const CATALOGO_URL = process.env.CATALOGO_URL || 'http://localhost:3002';
const PEDIDOS_URL = process.env.PEDIDOS_URL || 'http://localhost:3005';

const round2 = (v) => Math.round(v * 100) / 100;

function canalOu404(id) {
  const canal = db.canais.find((c) => c.id === id);
  if (!canal) throw new ApiError(404, `Canal desconhecido: ${id}. Disponíveis: ${db.canais.map((c) => c.id).join(', ')}`);
  return canal;
}

function canalConectado(id) {
  const canal = canalOu404(id);
  if (!canal.conectado) throw new ApiError(409, `O canal ${canal.nome} não está conectado.`);
  return canal;
}

// Converte um pedido vindo do marketplace no pedido padrão da plataforma:
// o serviço de PEDIDOS faz a baixa de estoque e o cálculo tributário.
async function registrarPedidoDoCanal(canal, { comprador, itens }) {
  if (!Array.isArray(itens) || !itens.length) throw new ApiError(400, 'Informe ao menos um item.');

  const linhas = itens.map((item) => {
    const anuncio = db.anuncios.find((a) => a.canal === canal.id && a.sku === item.sku && a.status === 'ativo');
    if (!anuncio) throw new ApiError(404, `Não há anúncio ativo de ${item.sku} no canal ${canal.nome}.`);
    return {
      sku: anuncio.sku,
      nome: anuncio.titulo,
      ncm: anuncio.ncm || '',
      quantidade: Number(item.quantidade) || 1,
      precoUnitario: anuncio.preco,
    };
  });

  const subtotal = round2(linhas.reduce((acc, l) => acc + l.quantidade * l.precoUnitario, 0));
  const comissao = { percentual: canal.comissaoPct, valor: round2(subtotal * canal.comissaoPct / 100) };

  const pedido = await callService(PEDIDOS_URL, 'POST', '/pedidos', {
    canal: canal.id,
    comissao,
    cliente: {
      nome: comprador?.nome || `Comprador ${canal.nome}`,
      uf: comprador?.uf || 'SP',
      cidade: comprador?.cidade || '',
      email: comprador?.email || '',
      documento: comprador?.documento || '',
      origem: `marketplace:${canal.id}`,
    },
    itens: linhas,
  });

  for (const l of linhas) {
    const anuncio = db.anuncios.find((a) => a.canal === canal.id && a.sku === l.sku);
    if (anuncio) anuncio.vendidos = (anuncio.vendidos || 0) + l.quantidade;
  }
  save();
  return pedido;
}

createService({
  name: 'marketplaces',
  port: PORT,
  routes: [
    // ----- Canais ---------------------------------------------------------
    { method: 'GET', path: '/canais', handler: () => db.canais },
    {
      method: 'POST',
      path: '/canais/:id/conectar',
      handler: ({ params, body }) => {
        const canal = canalOu404(params.id);
        canal.conectado = true;
        canal.conta = body.conta || `loja-vava@${canal.id}`;
        canal.conectadoEm = new Date().toISOString();
        save();
        return canal;
      },
    },
    {
      method: 'POST',
      path: '/canais/:id/desconectar',
      handler: ({ params }) => {
        const canal = canalOu404(params.id);
        canal.conectado = false;
        // Pausa os anúncios do canal: sem conexão não há venda.
        for (const a of db.anuncios) if (a.canal === canal.id) a.status = 'pausado';
        save();
        return canal;
      },
    },

    // ----- Anúncios -------------------------------------------------------
    {
      method: 'GET',
      path: '/anuncios',
      handler: ({ query }) => {
        let lista = db.anuncios;
        if (query.get('canal')) lista = lista.filter((a) => a.canal === query.get('canal'));
        if (query.get('sku')) lista = lista.filter((a) => a.sku === query.get('sku'));
        return lista;
      },
    },
    // Publica o catálogo nos canais conectados (ou em um canal específico).
    // Busca os produtos no serviço de CATÁLOGO; merge por canal+SKU.
    {
      method: 'POST',
      path: '/anuncios/publicar',
      handler: async ({ body }) => {
        const canais = body.canal ? [canalConectado(body.canal)] : db.canais.filter((c) => c.conectado);
        if (!canais.length) throw new ApiError(409, 'Nenhum canal conectado. Conecte um canal antes de publicar.');

        let produtos = await callService(CATALOGO_URL, 'GET', '/produtos');
        if (Array.isArray(body.skus) && body.skus.length) {
          produtos = produtos.filter((p) => body.skus.includes(p.sku));
        }

        let criados = 0;
        let atualizados = 0;
        for (const canal of canais) {
          for (const p of produtos) {
            const existente = db.anuncios.find((a) => a.canal === canal.id && a.sku === p.sku);
            const dados = {
              titulo: p.nome,
              ncm: p.ncm || '',
              categoria: p.categoria || '',
              preco: Number(p.precoVenda),
              comissaoPct: canal.comissaoPct,
              status: 'ativo',
            };
            if (existente) {
              Object.assign(existente, dados, { atualizadoEm: new Date().toISOString() });
              atualizados++;
            } else {
              db.anuncios.push({
                id: uid('anu_'), canal: canal.id, sku: p.sku, vendidos: 0,
                ...dados, criadoEm: new Date().toISOString(),
              });
              criados++;
            }
          }
        }
        save();
        return { canais: canais.map((c) => c.id), criados, atualizados, total: db.anuncios.length };
      },
    },
    {
      method: 'PUT',
      path: '/anuncios/:id',
      handler: ({ params, body }) => {
        const a = db.anuncios.find((x) => x.id === params.id);
        if (!a) throw new ApiError(404, 'Anúncio não encontrado.');
        const { id, canal, sku, criadoEm, ...resto } = body;
        Object.assign(a, resto, { atualizadoEm: new Date().toISOString() });
        save();
        return a;
      },
    },

    // ----- Entrada de pedidos ----------------------------------------------
    // Webhook: o marketplace chama esta rota a cada venda.
    // Em produção, defina WEBHOOK_SECRET — o canal precisa enviar o header
    // `x-webhook-token` com o mesmo valor.
    // Payload: { comprador: { nome, uf, ... }, itens: [{ sku, quantidade }] }
    {
      method: 'POST',
      path: '/webhooks/:canal',
      handler: async ({ params, body, req }) => {
        const segredo = process.env.WEBHOOK_SECRET;
        if (segredo && req.headers['x-webhook-token'] !== segredo) {
          throw new ApiError(401, 'Webhook não autorizado (x-webhook-token inválido).');
        }
        const canal = canalConectado(params.canal);
        const pedido = await registrarPedidoDoCanal(canal, body);
        return { status: 201, body: pedido };
      },
    },
    // Simulador: gera um pedido aleatório do canal (para demonstração).
    {
      method: 'POST',
      path: '/pedidos/simular',
      handler: async ({ body }) => {
        const canal = canalConectado(body.canal);
        const ativos = db.anuncios.filter((a) => a.canal === canal.id && a.status === 'ativo');
        if (!ativos.length) throw new ApiError(409, `Nenhum anúncio ativo em ${canal.nome}. Publique o catálogo antes.`);

        const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
        const escolha = [...ativos].sort(() => Math.random() - 0.5).slice(0, rnd(1, Math.min(2, ativos.length)));
        const nomes = ['Mariana Costa', 'João Pereira', 'Luciana Reis', 'Rafael Gomes', 'Beatriz Nunes', 'Otávio Ramos'];
        const ufs = ['SP', 'RJ', 'MG', 'BA', 'RS', 'PE', 'GO', 'CE'];

        const pedido = await registrarPedidoDoCanal(canal, {
          comprador: { nome: nomes[rnd(0, nomes.length - 1)], uf: ufs[rnd(0, ufs.length - 1)] },
          itens: escolha.map((a) => ({ sku: a.sku, quantidade: rnd(1, 2) })),
        });
        return { status: 201, body: pedido };
      },
    },

    // ----- Resumo por canal -------------------------------------------------
    {
      method: 'GET',
      path: '/resumo',
      handler: async () => {
        const pedidos = await callService(PEDIDOS_URL, 'GET', '/pedidos').catch(() => []);
        const porCanal = {};
        for (const canal of db.canais) {
          const doCanal = pedidos.filter((p) => p.canal === canal.id);
          porCanal[canal.id] = {
            nome: canal.nome,
            conectado: canal.conectado,
            anunciosAtivos: db.anuncios.filter((a) => a.canal === canal.id && a.status === 'ativo').length,
            pedidos: doCanal.length,
            receita: round2(doCanal.reduce((acc, p) => acc + (p.total || 0), 0)),
            comissoes: round2(doCanal.reduce((acc, p) => acc + (p.comissao?.valor || 0), 0)),
          };
        }
        return porCanal;
      },
    },
  ],
});
