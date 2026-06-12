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

// IPI por POSIÇÃO do NCM (4 primeiros dígitos) — mais preciso que o capítulo.
const IPI_POR_POSICAO = {
  '0901': 0,   // café
  '2201': 4,   // águas
  '4802': 5,   // papel
  '8205': 8,   // ferramentas manuais
  '8414': 8,   // ventiladores/microventiladores
  '8471': 0,   // informática
  '8507': 8,   // baterias e acumuladores
  '8512': 10,  // equipamentos elétricos automotivos
  '8517': 10,  // telefonia
  '8518': 15,  // áudio (fones, alto-falantes)
  '8528': 15,  // monitores
  '8536': 10,  // interruptores, botões, relés, conectores
  '8539': 12,  // lâmpadas e LED
  '8544': 5,   // fios e chicotes elétricos
  '8708': 5,   // autopeças (partes de veículos)
  '9401': 5,   // assentos
  '9403': 5,   // móveis
  '9608': 10,  // canetas
};
// Fallback por capítulo (2 primeiros dígitos) quando a posição não está na tabela.
const IPI_POR_CAPITULO = {
  '22': 4,   // bebidas
  '48': 5,   // papel
  '82': 8,   // ferramentas
  '84': 0,   // máquinas e equipamentos de informática
  '85': 15,  // eletroeletrônicos
  '87': 5,   // veículos e autopeças
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

// Resolve a alíquota de IPI pelo NCM: posição (4 díg.) → capítulo (2 díg.) →
// padrão 0. Informa a origem da alíquota e se o NCM é válido (8 dígitos).
function aliquotaIPI(ncm) {
  const digitos = String(ncm || '').replace(/\D/g, '');
  const ncmValido = digitos.length === 8;
  const posicao = digitos.slice(0, 4);
  const capitulo = digitos.slice(0, 2);
  if (IPI_POR_POSICAO[posicao] != null) return { aliquota: IPI_POR_POSICAO[posicao], origem: 'posicao', ncmValido };
  if (IPI_POR_CAPITULO[capitulo] != null) return { aliquota: IPI_POR_CAPITULO[capitulo], origem: 'capitulo', ncmValido };
  return { aliquota: 0, origem: 'padrao', ncmValido };
}

const round2 = (v) => Math.round(v * 100) / 100;

function calcularItem(item, ufOrigem, ufDestino) {
  const quantidade = Number(item.quantidade) || 1;
  const valorUnitario = Number(item.valorUnitario ?? item.precoUnitario) || 0;
  const base = round2(quantidade * valorUnitario);

  const icmsInfo = aliquotaICMS(ufOrigem, ufDestino);
  const ipiInfo = aliquotaIPI(item.ncm);

  const icms = round2(base * icmsInfo.aliquota / 100);
  const ipi = round2(base * ipiInfo.aliquota / 100);
  const pis = round2(base * PIS / 100);
  const cofins = round2(base * COFINS / 100);

  const resultado = {
    sku: item.sku || '',
    ncm: item.ncm || '',
    quantidade,
    valorUnitario,
    base,
    impostos: {
      icms: { aliquota: icmsInfo.aliquota, operacao: icmsInfo.operacao, valor: icms },
      ipi: { aliquota: ipiInfo.aliquota, origem: ipiInfo.origem, valor: ipi },
      pis: { aliquota: PIS, valor: pis },
      cofins: { aliquota: COFINS, valor: cofins },
    },
    totalImpostos: round2(icms + ipi + pis + cofins),
  };
  if (!ipiInfo.ncmValido) {
    resultado.aviso = item.ncm
      ? `NCM "${item.ncm}" inválido (esperado 8 dígitos) — IPI ${ipiInfo.origem === 'padrao' ? 'padrão' : 'por ' + ipiInfo.origem} aplicado.`
      : 'Item sem NCM — IPI padrão (0%) aplicado. Cadastre o NCM para um cálculo mais preciso.';
  }
  return resultado;
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
        ipiPorPosicaoNcm: IPI_POR_POSICAO,
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
