// Microserviço de ESTOQUE — porta 3003
// Saldo único por SKU compartilhado entre o e-commerce e o ERP.
// - A loja consulta disponibilidade e o serviço de pedidos baixa o saldo na venda.
// - O ERP envia saldos (POST /sync) e consome as movimentações geradas pela loja.
//
// Executar: node services/estoque/server.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, jsonDB, uid, ApiError } from '../_lib/micro.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');

// Saldos iniciais de demonstração (mesmos SKUs do catálogo).
const SEED = {
  saldos: Object.fromEntries(
    ['SKU-0001', 'SKU-0002', 'SKU-0003', 'SKU-0004', 'SKU-0005', 'SKU-0006',
     'SKU-0007', 'SKU-0008', 'SKU-0009', 'SKU-0010', 'SKU-0011', 'SKU-0012']
      .map((sku, i) => [sku, 20 + ((i * 7) % 60)])
  ),
  movimentos: [],
};

const { data: db, save } = jsonDB(dir, SEED);
const PORT = Number(process.env.ESTOQUE_PORT || 3003);

function movimentar({ sku, tipo, quantidade, origem, referencia }) {
  if (!sku) throw new ApiError(400, 'Campo obrigatório: sku.');
  const qtd = Number(quantidade);
  if (!qtd || qtd <= 0) throw new ApiError(400, 'Quantidade deve ser maior que zero.');
  if (!['entrada', 'saida', 'ajuste'].includes(tipo)) {
    throw new ApiError(400, "Tipo deve ser 'entrada', 'saida' ou 'ajuste'.");
  }
  const atual = Number(db.saldos[sku] || 0);
  let novo = atual;
  if (tipo === 'entrada') novo = atual + qtd;
  if (tipo === 'saida') {
    if (qtd > atual) throw new ApiError(409, `Saldo insuficiente para ${sku}: disponível ${atual}, solicitado ${qtd}.`);
    novo = atual - qtd;
  }
  if (tipo === 'ajuste') novo = qtd; // ajuste define o saldo absoluto

  db.saldos[sku] = novo;
  const mov = {
    id: uid('mov_'),
    sku,
    tipo,
    quantidade: qtd,
    saldoAnterior: atual,
    saldoNovo: novo,
    origem: origem || 'api',
    referencia: referencia || '',
    data: new Date().toISOString(),
    exportadoErp: false,
  };
  db.movimentos.push(mov);
  return mov;
}

createService({
  name: 'estoque',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/saldos',
      handler: () => Object.entries(db.saldos).map(([sku, saldo]) => ({ sku, saldo })),
    },
    {
      method: 'GET',
      path: '/saldos/:sku',
      handler: ({ params }) => ({ sku: params.sku, saldo: Number(db.saldos[params.sku] || 0) }),
    },
    {
      method: 'GET',
      path: '/movimentos',
      handler: ({ query }) => {
        let lista = db.movimentos;
        if (query.get('origem')) lista = lista.filter((m) => m.origem === query.get('origem'));
        if (query.get('pendentesErp') === 'true') lista = lista.filter((m) => !m.exportadoErp);
        return lista;
      },
    },
    {
      method: 'POST',
      path: '/movimentos',
      handler: ({ body }) => {
        const mov = movimentar(body);
        save();
        return { status: 201, body: mov };
      },
    },
    // Baixa em lote com reserva tudo-ou-nada (usada pelo serviço de pedidos).
    {
      method: 'POST',
      path: '/movimentos/lote',
      handler: ({ body }) => {
        const itens = Array.isArray(body.itens) ? body.itens : [];
        if (!itens.length) throw new ApiError(400, 'Informe ao menos um item.');
        // Valida tudo antes de aplicar qualquer baixa (atomicidade simples).
        for (const item of itens) {
          if (item.tipo !== 'saida') continue;
          const disponivel = Number(db.saldos[item.sku] || 0);
          if (Number(item.quantidade) > disponivel) {
            throw new ApiError(409, `Saldo insuficiente para ${item.sku}: disponível ${disponivel}, solicitado ${item.quantidade}.`);
          }
        }
        const movimentos = itens.map((item) => movimentar({ ...item, origem: body.origem, referencia: body.referencia }));
        save();
        return { status: 201, body: { movimentos } };
      },
    },
    // Marca movimentações como já importadas pelo ERP.
    {
      method: 'POST',
      path: '/movimentos/marcar-exportados',
      handler: ({ body }) => {
        const ids = new Set(body.ids || []);
        let marcados = 0;
        for (const m of db.movimentos) {
          if (ids.has(m.id) && !m.exportadoErp) {
            m.exportadoErp = true;
            marcados++;
          }
        }
        save();
        return { marcados };
      },
    },
    // O ERP envia os saldos consolidados (sobrescreve saldo por SKU).
    {
      method: 'POST',
      path: '/sync',
      handler: ({ body }) => {
        const saldos = Array.isArray(body.saldos) ? body.saldos : [];
        let atualizados = 0;
        for (const { sku, saldo } of saldos) {
          if (!sku) continue;
          db.saldos[sku] = Number(saldo) || 0;
          atualizados++;
        }
        save();
        return { atualizados, total: Object.keys(db.saldos).length };
      },
    },
  ],
});
