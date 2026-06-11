// Microserviço de CATÁLOGO — porta 3002
// Produtos exibidos na loja. Compatível com o cadastro de produtos do Vava ERP
// (mesmos campos: sku, nome, categoria, unidade, precoVenda, ncm...).
// O ERP publica produtos aqui via POST /sync (merge por SKU).
//
// Executar: node services/catalogo/server.js

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createService, jsonDB, uid, ApiError } from '../_lib/micro.js';

const base = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(base, 'data');

// Catálogo inicial de demonstração (mesmos produtos do seed do ERP).
const SEED = {
  produtos: [
    ['SKU-0001', 'Notebook Pro 14"', 'Informática', 'un', 4500, '8471.30.19', 'Notebook leve com 16 GB de RAM e SSD de 512 GB.'],
    ['SKU-0002', 'Mouse sem fio', 'Informática', 'un', 89, '8471.60.53', 'Mouse óptico sem fio com receptor USB.'],
    ['SKU-0003', 'Teclado mecânico', 'Informática', 'un', 320, '8471.60.52', 'Teclado mecânico ABNT2 com iluminação.'],
    ['SKU-0004', 'Monitor 27" 4K', 'Informática', 'un', 1800, '8528.52.20', 'Monitor IPS 27 polegadas resolução 4K.'],
    ['SKU-0005', 'Cadeira ergonômica', 'Móveis', 'un', 950, '9401.30.10', 'Cadeira de escritório com ajuste lombar.'],
    ['SKU-0006', 'Mesa de escritório', 'Móveis', 'un', 700, '9403.30.00', 'Mesa em MDF 140x70 cm.'],
    ['SKU-0007', 'Café em grãos 1kg', 'Alimentos', 'kg', 58, '0901.21.00', 'Café especial torra média.'],
    ['SKU-0008', 'Água mineral 500ml', 'Alimentos', 'cx', 36, '2201.10.00', 'Caixa com 12 garrafas.'],
    ['SKU-0009', 'Caneta esferográfica', 'Papelaria', 'cx', 24, '9608.10.00', 'Caixa com 50 canetas azuis.'],
    ['SKU-0010', 'Papel A4 resma', 'Papelaria', 'un', 28, '4802.56.99', 'Resma com 500 folhas 75g.'],
    ['SKU-0011', 'Smartphone X', 'Eletrônicos', 'un', 2200, '8517.13.00', 'Smartphone tela 6.5" 128 GB.'],
    ['SKU-0012', 'Fone bluetooth', 'Eletrônicos', 'un', 250, '8518.30.00', 'Fone sem fio com cancelamento de ruído.'],
  ].map(([sku, nome, categoria, unidade, precoVenda, ncm, descricao]) => ({
    id: uid('prd_'), sku, nome, categoria, unidade, precoVenda, ncm, descricao,
    ativo: true, criadoEm: new Date().toISOString(),
  })),
};

// Produtos importados de um Painel de Orçamento (scripts/importar-painel.js
// --salvar-seed). Se o arquivo existir, entra no seed do primeiro boot.
try {
  const painel = JSON.parse(fs.readFileSync(path.join(base, 'seed-painel.json'), 'utf8'));
  SEED.produtos.push(...painel.map((p) => ({ ...p, id: uid('prd_'), criadoEm: new Date().toISOString() })));
  console.log(`[catalogo] seed-painel.json: +${painel.length} produtos no seed inicial`);
} catch { /* sem seed do painel */ }

const { data: db, save } = jsonDB(dir, SEED);
const PORT = Number(process.env.CATALOGO_PORT || 3002);

createService({
  name: 'catalogo',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/produtos',
      handler: ({ query }) => {
        const busca = (query.get('busca') || '').toLowerCase();
        const categoria = query.get('categoria') || '';
        let lista = db.produtos.filter((p) => p.ativo !== false);
        if (categoria) lista = lista.filter((p) => p.categoria === categoria);
        if (busca) {
          lista = lista.filter((p) =>
            [p.nome, p.sku, p.categoria, p.descricao].some((v) => String(v || '').toLowerCase().includes(busca))
          );
        }
        return lista;
      },
    },
    {
      method: 'GET',
      path: '/categorias',
      handler: () => [...new Set(db.produtos.filter((p) => p.ativo !== false).map((p) => p.categoria))].sort(),
    },
    {
      method: 'GET',
      path: '/produtos/:id',
      handler: ({ params }) => {
        const p = db.produtos.find((x) => x.id === params.id || x.sku === params.id);
        if (!p) throw new ApiError(404, 'Produto não encontrado.');
        return p;
      },
    },
    {
      method: 'POST',
      path: '/produtos',
      handler: ({ body }) => {
        if (!body.nome || !body.sku) throw new ApiError(400, 'Campos obrigatórios: nome e sku.');
        if (db.produtos.some((p) => p.sku === body.sku)) throw new ApiError(409, 'Já existe produto com este SKU.');
        const produto = { ativo: true, ...body, id: uid('prd_'), criadoEm: new Date().toISOString() };
        db.produtos.push(produto);
        save();
        return { status: 201, body: produto };
      },
    },
    {
      method: 'PUT',
      path: '/produtos/:id',
      handler: ({ params, body }) => {
        const p = db.produtos.find((x) => x.id === params.id || x.sku === params.id);
        if (!p) throw new ApiError(404, 'Produto não encontrado.');
        const { id, criadoEm, ...resto } = body;
        Object.assign(p, resto, { atualizadoEm: new Date().toISOString() });
        save();
        return p;
      },
    },
    {
      method: 'DELETE',
      path: '/produtos/:id',
      handler: ({ params }) => {
        const antes = db.produtos.length;
        db.produtos = db.produtos.filter((x) => x.id !== params.id && x.sku !== params.id);
        if (db.produtos.length === antes) throw new ApiError(404, 'Produto não encontrado.');
        save();
        return { ok: true };
      },
    },

    // Publicação de produtos a partir do ERP (merge por SKU).
    {
      method: 'POST',
      path: '/sync',
      handler: ({ body }) => {
        const recebidos = Array.isArray(body.produtos) ? body.produtos : [];
        let criados = 0;
        let atualizados = 0;
        for (const r of recebidos) {
          if (!r.sku || !r.nome) continue;
          const existente = db.produtos.find((p) => p.sku === r.sku);
          // O catálogo não guarda custo, saldo nem metadados internos do ERP.
          const { id, custo, estoque, estoqueMinimo, criadoEm, publicadoEcommerce, publicadoEm, ...resto } = r;
          if (existente) {
            Object.assign(existente, resto, { atualizadoEm: new Date().toISOString() });
            atualizados++;
          } else {
            db.produtos.push({ ativo: true, ...resto, id: uid('prd_'), criadoEm: new Date().toISOString() });
            criados++;
          }
        }
        save();
        return { criados, atualizados, total: db.produtos.length };
      },
    },
  ],
});
