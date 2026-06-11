// Microserviço de PEDIDOS — porta 3005
// Recebe o checkout da loja e ORQUESTRA os demais serviços:
//   1. Baixa o saldo no serviço de ESTOQUE (lote tudo-ou-nada);
//   2. Calcula os impostos no serviço TRIBUTÁRIO;
//   3. Persiste o pedido confirmado.
// O ERP importa os pedidos confirmados como vendas (GET /pedidos?pendentesErp=true).
//
// Executar: node services/pedidos/server.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, jsonDB, uid, callService, ApiError } from '../_lib/micro.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const { data: db, save } = jsonDB(dir, { pedidos: [] });

const PORT = Number(process.env.PEDIDOS_PORT || 3005);
const ESTOQUE_URL = process.env.ESTOQUE_URL || 'http://localhost:3003';
const TRIBUTARIO_URL = process.env.TRIBUTARIO_URL || 'http://localhost:3004';
const UF_ORIGEM = process.env.UF_ORIGEM_LOJA || 'SP'; // UF do centro de distribuição

const round2 = (v) => Math.round(v * 100) / 100;

createService({
  name: 'pedidos',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/pedidos',
      handler: ({ query }) => {
        let lista = db.pedidos;
        if (query.get('clienteId')) lista = lista.filter((p) => p.cliente?.id === query.get('clienteId'));
        if (query.get('status')) lista = lista.filter((p) => p.status === query.get('status'));
        if (query.get('pendentesErp') === 'true') lista = lista.filter((p) => !p.exportadoErp && p.status === 'confirmado');
        return [...lista].reverse();
      },
    },
    {
      method: 'GET',
      path: '/pedidos/:id',
      handler: ({ params }) => {
        const p = db.pedidos.find((x) => x.id === params.id);
        if (!p) throw new ApiError(404, 'Pedido não encontrado.');
        return p;
      },
    },
    {
      method: 'POST',
      path: '/pedidos',
      handler: async ({ body }) => {
        const itens = Array.isArray(body.itens) ? body.itens : [];
        if (!itens.length) throw new ApiError(400, 'O pedido precisa de ao menos um item.');
        if (!body.cliente?.nome) throw new ApiError(400, 'Dados do cliente são obrigatórios.');
        const ufDestino = body.cliente.uf || body.ufDestino;
        if (!ufDestino) throw new ApiError(400, 'Informe a UF de entrega para o cálculo dos impostos.');

        // 1) Baixa de estoque (tudo-ou-nada).
        const numero = `EC-${Date.now().toString(36).toUpperCase()}`;
        let baixa;
        try {
          baixa = await callService(ESTOQUE_URL, 'POST', '/movimentos/lote', {
            origem: 'ecommerce',
            referencia: numero,
            itens: itens.map((i) => ({ sku: i.sku, tipo: 'saida', quantidade: i.quantidade })),
          });
        } catch (err) {
          throw new ApiError(err.status === 409 ? 409 : 502, `Estoque: ${err.message}`);
        }

        // 2) Cálculo de impostos. Se falhar, estorna a baixa de estoque.
        let tributos;
        try {
          tributos = await callService(TRIBUTARIO_URL, 'POST', '/calcular', {
            ufOrigem: UF_ORIGEM,
            ufDestino,
            itens: itens.map((i) => ({ sku: i.sku, ncm: i.ncm, quantidade: i.quantidade, valorUnitario: i.precoUnitario })),
          });
        } catch (err) {
          await callService(ESTOQUE_URL, 'POST', '/movimentos/lote', {
            origem: 'ecommerce',
            referencia: `${numero}-ESTORNO`,
            itens: itens.map((i) => ({ sku: i.sku, tipo: 'entrada', quantidade: i.quantidade })),
          }).catch(() => {});
          throw new ApiError(502, `Tributário: ${err.message}`);
        }

        // 3) Persiste o pedido.
        const subtotal = round2(itens.reduce((acc, i) => acc + Number(i.quantidade) * Number(i.precoUnitario), 0));
        const pedido = {
          id: uid('ped_'),
          numero,
          status: 'confirmado',
          cliente: body.cliente,
          ufOrigem: UF_ORIGEM,
          ufDestino,
          itens: itens.map((i) => ({
            sku: i.sku, nome: i.nome, ncm: i.ncm || '',
            quantidade: Number(i.quantidade), precoUnitario: Number(i.precoUnitario),
            total: round2(Number(i.quantidade) * Number(i.precoUnitario)),
          })),
          subtotal,
          impostos: tributos.totais,
          total: subtotal, // preço da loja já é o preço final; impostos demonstrados no detalhe
          movimentosEstoque: baixa.movimentos.map((m) => m.id),
          exportadoErp: false,
          criadoEm: new Date().toISOString(),
        };
        db.pedidos.push(pedido);
        save();
        return { status: 201, body: pedido };
      },
    },
    {
      method: 'PUT',
      path: '/pedidos/:id/status',
      handler: ({ params, body }) => {
        const p = db.pedidos.find((x) => x.id === params.id);
        if (!p) throw new ApiError(404, 'Pedido não encontrado.');
        if (!['confirmado', 'enviado', 'entregue', 'cancelado'].includes(body.status)) {
          throw new ApiError(400, 'Status inválido.');
        }
        p.status = body.status;
        p.atualizadoEm = new Date().toISOString();
        save();
        return p;
      },
    },
    // O ERP marca os pedidos que já importou como vendas.
    {
      method: 'POST',
      path: '/pedidos/marcar-exportados',
      handler: ({ body }) => {
        const ids = new Set(body.ids || []);
        let marcados = 0;
        for (const p of db.pedidos) {
          if (ids.has(p.id) && !p.exportadoErp) {
            p.exportadoErp = true;
            marcados++;
          }
        }
        save();
        return { marcados };
      },
    },
  ],
});
