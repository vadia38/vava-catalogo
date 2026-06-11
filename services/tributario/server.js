// Microserviço TRIBUTÁRIO — porta 3004
// Motor de cálculo de impostos compartilhado entre e-commerce e ERP.
// Calcula ICMS (interno/interestadual por UF), IPI (por capítulo do NCM),
// PIS e COFINS (regime não cumulativo) para uma lista de itens.
//
// ⚠️ Tabelas SIMPLIFICADAS para fins didáticos — não usar em produção fiscal.
//
// Executar: node services/tributario/server.js

import { createService, ApiError } from '../_lib/micro.js';

const PORT = Number(process.env.TRIBUTARIO_PORT || 3004);

// ----- Tabelas (didáticas) -----------------------------------------------
const ICMS_INTERNO = {
  AC: 19, AL: 19, AM: 20, AP: 18, BA: 20.5, CE: 20, DF: 20, ES: 17, GO: 19,
  MA: 22, MG: 18, MS: 17, MT: 17, PA: 19, PB: 20, PE: 20.5, PI: 21, PR: 19.5,
  RJ: 22, RN: 20, RO: 19.5, RR: 20, RS: 17, SC: 17, SE: 19, SP: 18, TO: 20,
};
const ICMS_INTERNO_PADRAO = 18;

// Estados do Sul/Sudeste (exceto ES): alíquota interestadual de 7% quando o
// destino é Norte/Nordeste/Centro-Oeste/ES; 12% nos demais casos.
const SUL_SUDESTE = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);

// IPI por capítulo do NCM (2 primeiros dígitos) — recorte didático.
const IPI_POR_CAPITULO = {
  '22': 4,   // bebidas
  '48': 5,   // papel
  '84': 0,   // máquinas e equipamentos de informática
  '85': 15,  // eletroeletrônicos
  '94': 5,   // móveis
  '96': 10,  // canetas e artigos diversos
};
const PIS = 1.65;
const COFINS = 7.6;

function aliquotaICMS(ufOrigem, ufDestino) {
  const origem = String(ufOrigem || '').toUpperCase();
  const destino = String(ufDestino || '').toUpperCase();
  if (!destino || !origem || origem === destino) {
    return { aliquota: ICMS_INTERNO[destino || origem] ?? ICMS_INTERNO_PADRAO, operacao: 'interna' };
  }
  const destinoFavorecido = !SUL_SUDESTE.has(destino) || destino === 'ES';
  const aliquota = SUL_SUDESTE.has(origem) && destinoFavorecido ? 7 : 12;
  return { aliquota, operacao: 'interestadual' };
}

function aliquotaIPI(ncm) {
  const capitulo = String(ncm || '').replace(/\D/g, '').slice(0, 2);
  return IPI_POR_CAPITULO[capitulo] ?? 0;
}

const round2 = (v) => Math.round(v * 100) / 100;

function calcularItem(item, ufOrigem, ufDestino) {
  const quantidade = Number(item.quantidade) || 1;
  const valorUnitario = Number(item.valorUnitario ?? item.precoUnitario) || 0;
  const base = round2(quantidade * valorUnitario);

  const icmsInfo = aliquotaICMS(ufOrigem, ufDestino);
  const ipiAliq = aliquotaIPI(item.ncm);

  const icms = round2(base * icmsInfo.aliquota / 100);
  const ipi = round2(base * ipiAliq / 100);
  const pis = round2(base * PIS / 100);
  const cofins = round2(base * COFINS / 100);

  return {
    sku: item.sku || '',
    ncm: item.ncm || '',
    quantidade,
    valorUnitario,
    base,
    impostos: {
      icms: { aliquota: icmsInfo.aliquota, operacao: icmsInfo.operacao, valor: icms },
      ipi: { aliquota: ipiAliq, valor: ipi },
      pis: { aliquota: PIS, valor: pis },
      cofins: { aliquota: COFINS, valor: cofins },
    },
    totalImpostos: round2(icms + ipi + pis + cofins),
  };
}

createService({
  name: 'tributario',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/regras',
      handler: () => ({
        observacao: 'Tabelas simplificadas para fins didáticos.',
        icmsInterno: ICMS_INTERNO,
        icmsInterestadual: { sulSudesteParaDemais: 7, demaisCasos: 12 },
        ipiPorCapituloNcm: IPI_POR_CAPITULO,
        pis: PIS,
        cofins: COFINS,
      }),
    },
    {
      method: 'POST',
      path: '/calcular',
      handler: ({ body }) => {
        const itens = Array.isArray(body.itens) ? body.itens : [];
        if (!itens.length) throw new ApiError(400, 'Informe ao menos um item em `itens`.');
        const ufOrigem = body.ufOrigem || 'SP';
        const ufDestino = body.ufDestino || ufOrigem;

        const calculados = itens.map((i) => calcularItem(i, ufOrigem, ufDestino));
        const soma = (sel) => round2(calculados.reduce((acc, i) => acc + sel(i), 0));

        return {
          ufOrigem,
          ufDestino,
          itens: calculados,
          totais: {
            base: soma((i) => i.base),
            icms: soma((i) => i.impostos.icms.valor),
            ipi: soma((i) => i.impostos.ipi.valor),
            pis: soma((i) => i.impostos.pis.valor),
            cofins: soma((i) => i.impostos.cofins.valor),
            impostos: soma((i) => i.totalImpostos),
          },
        };
      },
    },
  ],
});
