// importar-painel.js — importa produtos de um "Painel de Orçamento" (HTML
// exportado com os dados embutidos em `let DEFAULT_P=[...]`) para o catálogo
// da plataforma, via gateway.
//
// Uso:
//   node scripts/importar-painel.js <painel.html> [url-do-gateway]
//   node scripts/importar-painel.js <painel.html> --salvar-seed
//
// Com --salvar-seed, grava services/catalogo/seed-painel.json: o serviço de
// catálogo carrega esse arquivo no primeiro boot, então os produtos passam a
// fazer parte da instalação (Docker incluído) sem precisar reimportar.
//
// Campos do painel: i (código único), r (referência), n (nome),
// c (categoria), sc (marca), img (foto em data URL). O painel não tem preço —
// os produtos entram com preço 0 para serem precificados no ERP.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CATEGORIAS = {
  botoes: 'Botões', micro: 'Microventiladores', chicotes: 'Chicotes',
  led: 'LED', maq: 'Máquinas de vidro', conectores: 'Conectores e cabos',
  ferramentas: 'Ferramentas', estribos: 'Estribos', automotivo: 'Automotivo',
  reles: 'Relés e eletrônicos', baterias: 'Baterias', outros: 'Outros',
};
const MARCAS = {
  fiat: 'Fiat', ford: 'Ford', gm: 'GM', vw: 'VW', renault: 'Renault',
  honda: 'Honda', nissan: 'Nissan', hyundai: 'Hyundai/Kia', peugeot: 'Peugeot', outros: 'Outros',
};

// NCM padrão por categoria do painel (o painel não traz NCM). Valores
// didáticos plausíveis — confira com seu contador antes de faturar.
const NCM_POR_CATEGORIA = {
  botoes: '8536.50.90',      // interruptores e comutadores
  micro: '8414.59.90',       // ventiladores
  chicotes: '8544.30.00',    // jogos de fios para veículos
  led: '8539.52.00',         // lâmpadas LED
  maq: '8708.29.99',         // partes de carroceria (máq. de vidro)
  conectores: '8536.90.90',  // conectores elétricos
  ferramentas: '8205.40.00', // ferramentas manuais
  estribos: '8708.29.99',    // partes/acessórios de carroceria
  automotivo: '8708.99.90',  // autopeças diversas
  reles: '8536.41.00',       // relés p/ tensão <= 60V
  baterias: '8507.10.10',    // acumuladores de chumbo
};

function extrairProdutos(arquivo) {
  const src = fs.readFileSync(arquivo, 'utf8');
  if (arquivo.endsWith('.json')) return JSON.parse(src);
  const m = src.match(/let DEFAULT_P=(\[.*?\]);/s);
  if (!m) throw new Error('Não encontrei `let DEFAULT_P=[...]` no arquivo — é um painel exportado?');
  return JSON.parse(m[1]);
}

function mapear(painel) {
  return painel
    .filter((p) => p.i && p.n)
    .map((p) => ({
      sku: String(p.i),
      nome: p.n,
      categoria: CATEGORIAS[p.c] || p.c || 'Outros',
      unidade: 'un',
      ncm: NCM_POR_CATEGORIA[p.c] || '',
      precoVenda: 0, // o painel de orçamento não traz preço: definir no ERP
      descricao: [p.r ? `Ref. ${p.r}` : '', p.sc ? `Marca: ${MARCAS[p.sc] || p.sc}` : '']
        .filter(Boolean).join(' · '),
      marca: MARCAS[p.sc] || p.sc || '',
      fotos: p.img ? [p.img] : [],
      ativo: true,
    }));
}

async function main() {
  const [arquivo, destino] = process.argv.slice(2);
  if (!arquivo) {
    console.error('Uso: node scripts/importar-painel.js <painel.html> [url-do-gateway | --salvar-seed]');
    process.exit(1);
  }

  const produtos = mapear(extrairProdutos(arquivo));
  const comFoto = produtos.filter((p) => p.fotos.length).length;
  console.log(`Painel lido: ${produtos.length} produtos (${comFoto} com foto).`);

  if (destino === '--salvar-seed') {
    const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const saida = path.join(raiz, 'services', 'catalogo', 'seed-painel.json');
    fs.writeFileSync(saida, JSON.stringify(produtos));
    console.log(`Seed gravado em ${saida} — o serviço de catálogo carrega este arquivo no primeiro boot.`);
    return;
  }

  const gateway = (destino || 'http://localhost:3000').replace(/\/$/, '');
  const LOTE = 100;
  let criados = 0;
  let atualizados = 0;
  for (let i = 0; i < produtos.length; i += LOTE) {
    const res = await fetch(`${gateway}/api/catalogo/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produtos: produtos.slice(i, i + LOTE) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.erro || `Erro ${res.status}`);
    criados += data.criados;
    atualizados += data.atualizados;
    console.log(`  lote ${i / LOTE + 1}: +${data.criados} novos, ~${data.atualizados} atualizados`);
  }
  console.log(`Concluído: ${criados} criados, ${atualizados} atualizados no catálogo (${gateway}).`);
  console.log('No ERP, use Integração → "Importar catálogo da loja" para trazer os produtos para o cadastro.');
}

main().catch((err) => { console.error('FALHA:', err.message); process.exit(1); });
