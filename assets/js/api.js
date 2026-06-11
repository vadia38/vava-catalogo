// api.js — camada de integração da loja com os microserviços (via gateway).
// Se o gateway estiver fora do ar (ex.: loja aberta pelo GitHub Pages sem
// backend), a loja entra em MODO DEMONSTRAÇÃO: catálogo, estoque, impostos e
// pedidos passam a funcionar localmente (localStorage), com as mesmas regras.

const GATEWAY_KEY = 'vava_store_gateway';
const DEMO_KEY = 'vava_store_demo_db';
const SESSAO_KEY = 'vava_store_sessao';
const CARRINHO_KEY = 'vava_store_carrinho';

export const gatewayUrl = () => localStorage.getItem(GATEWAY_KEY) || 'http://localhost:3000';
export const setGatewayUrl = (url) => localStorage.setItem(GATEWAY_KEY, url);

export let online = false;

async function http(method, path, body) {
  const res = await fetch(gatewayUrl() + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.erro || `Erro ${res.status}`);
  return data;
}

export async function verificarConexao() {
  try {
    const res = await fetch(gatewayUrl() + '/health', { signal: AbortSignal.timeout(2500) });
    online = res.ok;
  } catch {
    online = false;
  }
  return online;
}

// ---------------------------------------------------------------------------
// MODO DEMONSTRAÇÃO — mini-réplica local dos serviços (mesmas regras, didático)
// ---------------------------------------------------------------------------
const DEMO_PRODUTOS = [
  ['SKU-0001', 'Notebook Pro 14"', 'Informática', 4500, '8471.30.19', '💻', 'Notebook leve com 16 GB de RAM e SSD de 512 GB.'],
  ['SKU-0002', 'Mouse sem fio', 'Informática', 89, '8471.60.53', '🖱️', 'Mouse óptico sem fio com receptor USB.'],
  ['SKU-0003', 'Teclado mecânico', 'Informática', 320, '8471.60.52', '⌨️', 'Teclado mecânico ABNT2 com iluminação.'],
  ['SKU-0004', 'Monitor 27" 4K', 'Informática', 1800, '8528.52.20', '🖥️', 'Monitor IPS 27 polegadas resolução 4K.'],
  ['SKU-0005', 'Cadeira ergonômica', 'Móveis', 950, '9401.30.10', '🪑', 'Cadeira de escritório com ajuste lombar.'],
  ['SKU-0006', 'Mesa de escritório', 'Móveis', 700, '9403.30.00', '🗄️', 'Mesa em MDF 140x70 cm.'],
  ['SKU-0007', 'Café em grãos 1kg', 'Alimentos', 58, '0901.21.00', '☕', 'Café especial torra média.'],
  ['SKU-0008', 'Água mineral 500ml', 'Alimentos', 36, '2201.10.00', '💧', 'Caixa com 12 garrafas.'],
  ['SKU-0009', 'Caneta esferográfica', 'Papelaria', 24, '9608.10.00', '🖊️', 'Caixa com 50 canetas azuis.'],
  ['SKU-0010', 'Papel A4 resma', 'Papelaria', 28, '4802.56.99', '📄', 'Resma com 500 folhas 75g.'],
  ['SKU-0011', 'Smartphone X', 'Eletrônicos', 2200, '8517.13.00', '📱', 'Smartphone tela 6.5" 128 GB.'],
  ['SKU-0012', 'Fone bluetooth', 'Eletrônicos', 250, '8518.30.00', '🎧', 'Fone sem fio com cancelamento de ruído.'],
].map(([sku, nome, categoria, precoVenda, ncm, emoji, descricao]) => ({
  id: sku, sku, nome, categoria, precoVenda, ncm, emoji, descricao, unidade: 'un', ativo: true,
}));

function demoDB() {
  try {
    const raw = localStorage.getItem(DEMO_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* recria abaixo */ }
  const db = {
    clientes: [],
    saldos: Object.fromEntries(DEMO_PRODUTOS.map((p, i) => [p.sku, 20 + ((i * 7) % 60)])),
    pedidos: [],
  };
  localStorage.setItem(DEMO_KEY, JSON.stringify(db));
  return db;
}
const demoSave = (db) => localStorage.setItem(DEMO_KEY, JSON.stringify(db));
const uid = (p = '') => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const round2 = (v) => Math.round(v * 100) / 100;

// Réplica didática do motor tributário (mesmas tabelas do serviço).
const ICMS_INTERNO = { BA: 20.5, MG: 18, PR: 19.5, RJ: 22, RS: 17, SC: 17, SP: 18 };
const SUL_SUDESTE = new Set(['SP', 'RJ', 'MG', 'PR', 'SC', 'RS']);
const IPI = { 22: 4, 48: 5, 84: 0, 85: 15, 94: 5, 96: 10 };

function demoCalcular({ ufOrigem = 'SP', ufDestino, itens }) {
  const calc = itens.map((i) => {
    const base = round2((Number(i.quantidade) || 1) * (Number(i.valorUnitario) || 0));
    let icmsAliq;
    let operacao;
    if (!ufDestino || ufOrigem === ufDestino) {
      icmsAliq = ICMS_INTERNO[ufDestino || ufOrigem] ?? 18;
      operacao = 'interna';
    } else {
      const favorecido = !SUL_SUDESTE.has(ufDestino) || ufDestino === 'ES';
      icmsAliq = SUL_SUDESTE.has(ufOrigem) && favorecido ? 7 : 12;
      operacao = 'interestadual';
    }
    const ipiAliq = IPI[String(i.ncm || '').replace(/\D/g, '').slice(0, 2)] ?? 0;
    const impostos = {
      icms: { aliquota: icmsAliq, operacao, valor: round2(base * icmsAliq / 100) },
      ipi: { aliquota: ipiAliq, valor: round2(base * ipiAliq / 100) },
      pis: { aliquota: 1.65, valor: round2(base * 1.65 / 100) },
      cofins: { aliquota: 7.6, valor: round2(base * 7.6 / 100) },
    };
    return {
      ...i, base, impostos,
      totalImpostos: round2(impostos.icms.valor + impostos.ipi.valor + impostos.pis.valor + impostos.cofins.valor),
    };
  });
  const soma = (sel) => round2(calc.reduce((a, i) => a + sel(i), 0));
  return {
    ufOrigem, ufDestino, itens: calc,
    totais: {
      base: soma((i) => i.base),
      icms: soma((i) => i.impostos.icms.valor),
      ipi: soma((i) => i.impostos.ipi.valor),
      pis: soma((i) => i.impostos.pis.valor),
      cofins: soma((i) => i.impostos.cofins.valor),
      impostos: soma((i) => i.totalImpostos),
    },
  };
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// API pública da loja — usa o gateway quando online, senão o modo demo.
// ---------------------------------------------------------------------------
export const api = {
  async listarProdutos({ busca = '', categoria = '' } = {}) {
    if (online) {
      const qs = new URLSearchParams();
      if (busca) qs.set('busca', busca);
      if (categoria) qs.set('categoria', categoria);
      return http('GET', `/api/catalogo/produtos?${qs}`);
    }
    let lista = DEMO_PRODUTOS;
    if (categoria) lista = lista.filter((p) => p.categoria === categoria);
    if (busca) {
      const b = busca.toLowerCase();
      lista = lista.filter((p) => [p.nome, p.sku, p.categoria, p.descricao].some((v) => String(v).toLowerCase().includes(b)));
    }
    return lista;
  },

  async categorias() {
    if (online) return http('GET', '/api/catalogo/categorias');
    return [...new Set(DEMO_PRODUTOS.map((p) => p.categoria))].sort();
  },

  async produto(sku) {
    if (online) return http('GET', `/api/catalogo/produtos/${sku}`);
    return DEMO_PRODUTOS.find((p) => p.sku === sku) || null;
  },

  async saldos() {
    if (online) {
      const lista = await http('GET', '/api/estoque/saldos');
      return Object.fromEntries(lista.map((s) => [s.sku, s.saldo]));
    }
    return demoDB().saldos;
  },

  async calcularImpostos(payload) {
    if (online) return http('POST', '/api/tributario/calcular', payload);
    return demoCalcular(payload);
  },

  async registrar(dados) {
    if (online) return http('POST', '/api/clientes/auth/registrar', dados);
    const db = demoDB();
    if (db.clientes.some((c) => c.email === dados.email)) throw new Error('Já existe uma conta com este e-mail.');
    const cliente = { ...dados, id: uid('cli_'), origem: 'ecommerce', senhaHash: await sha256hex(dados.senha) };
    delete cliente.senha;
    db.clientes.push(cliente);
    demoSave(db);
    const { senhaHash, ...pub } = cliente;
    return pub;
  },

  async login(email, senha) {
    if (online) return http('POST', '/api/clientes/auth/login', { email, senha });
    const db = demoDB();
    const hash = await sha256hex(senha);
    const c = db.clientes.find((x) => x.email === email && x.senhaHash === hash);
    if (!c) throw new Error('E-mail ou senha inválidos.');
    const { senhaHash, ...pub } = c;
    return pub;
  },

  async criarPedido(payload) {
    if (online) return http('POST', '/api/pedidos/pedidos', payload);
    // Demo: replica a orquestração localmente (estoque → impostos → pedido).
    const db = demoDB();
    for (const i of payload.itens) {
      const disp = Number(db.saldos[i.sku] || 0);
      if (i.quantidade > disp) throw new Error(`Saldo insuficiente para ${i.sku}: disponível ${disp}.`);
    }
    for (const i of payload.itens) db.saldos[i.sku] -= i.quantidade;
    const tributos = demoCalcular({
      ufOrigem: 'SP',
      ufDestino: payload.cliente.uf,
      itens: payload.itens.map((i) => ({ sku: i.sku, ncm: i.ncm, quantidade: i.quantidade, valorUnitario: i.precoUnitario })),
    });
    const subtotal = round2(payload.itens.reduce((a, i) => a + i.quantidade * i.precoUnitario, 0));
    const pedido = {
      id: uid('ped_'),
      numero: `EC-${Date.now().toString(36).toUpperCase()}`,
      status: 'confirmado',
      cliente: payload.cliente,
      ufOrigem: 'SP',
      ufDestino: payload.cliente.uf,
      itens: payload.itens.map((i) => ({ ...i, total: round2(i.quantidade * i.precoUnitario) })),
      subtotal,
      impostos: tributos.totais,
      total: subtotal,
      criadoEm: new Date().toISOString(),
    };
    db.pedidos.push(pedido);
    demoSave(db);
    return pedido;
  },

  async meusPedidos(clienteId) {
    if (online) return http('GET', `/api/pedidos/pedidos?clienteId=${encodeURIComponent(clienteId)}`);
    return demoDB().pedidos.filter((p) => p.cliente?.id === clienteId).reverse();
  },
};

// ---------------------------------------------------------------------------
// Sessão do cliente e carrinho (sempre locais ao navegador)
// ---------------------------------------------------------------------------
export const sessao = {
  get: () => {
    try { return JSON.parse(localStorage.getItem(SESSAO_KEY)); } catch { return null; }
  },
  set: (cliente) => localStorage.setItem(SESSAO_KEY, JSON.stringify(cliente)),
  sair: () => localStorage.removeItem(SESSAO_KEY),
};

export const carrinho = {
  itens() {
    try { return JSON.parse(localStorage.getItem(CARRINHO_KEY)) || []; } catch { return []; }
  },
  salvar(itens) {
    localStorage.setItem(CARRINHO_KEY, JSON.stringify(itens));
    window.dispatchEvent(new CustomEvent('store:carrinho'));
  },
  adicionar(produto, quantidade = 1) {
    const itens = this.itens();
    const existente = itens.find((i) => i.sku === produto.sku);
    if (existente) existente.quantidade += quantidade;
    else itens.push({
      sku: produto.sku, nome: produto.nome, ncm: produto.ncm || '',
      precoUnitario: Number(produto.precoVenda), quantidade, emoji: produto.emoji,
    });
    this.salvar(itens);
  },
  alterar(sku, quantidade) {
    let itens = this.itens();
    const item = itens.find((i) => i.sku === sku);
    if (!item) return;
    item.quantidade = quantidade;
    if (item.quantidade <= 0) itens = itens.filter((i) => i.sku !== sku);
    this.salvar(itens);
  },
  limpar() { this.salvar([]); },
  total() { return round2(this.itens().reduce((a, i) => a + i.quantidade * i.precoUnitario, 0)); },
  qtdTotal() { return this.itens().reduce((a, i) => a + i.quantidade, 0); },
};
