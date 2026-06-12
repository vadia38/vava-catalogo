// app.js — Vava Store: shell da loja, rotas e páginas.
// Rotas: #/catalogo, #/carrinho, #/checkout, #/conta, #/pedido/:id

import { api, carrinho, sessao, online, verificarConexao, gatewayUrl, setGatewayUrl } from './api.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (v) => BRL.format(Number(v) || 0);
const UFS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
const EMOJI_CAT = { 'Informática': '💻', 'Móveis': '🪑', 'Alimentos': '☕', 'Papelaria': '📄', 'Eletrônicos': '📱' };

// ----- helpers de DOM -------------------------------------------------------
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

function toast(msg, tipo = '') {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', { class: `toast ${tipo}`, text: msg });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ----- shell ----------------------------------------------------------------
let contentEl, connEl, cartBadgeEl, buscaAtual = '';

function atualizarBadge() {
  const qtd = carrinho.qtdTotal();
  cartBadgeEl.textContent = qtd;
  cartBadgeEl.style.display = qtd ? 'flex' : 'none';
}

function atualizarConn() {
  connEl.className = `conn ${online ? 'on' : 'off'}`;
  connEl.textContent = online ? '● integrado ao ERP' : '○ modo demonstração';
  connEl.title = online
    ? `Conectado ao gateway de microserviços em ${gatewayUrl()}`
    : `Gateway offline (${gatewayUrl()}). Clique para configurar. A loja funciona localmente.`;
}

function buildShell() {
  const root = document.getElementById('app');
  root.innerHTML = '';

  const busca = el('input', {
    class: 'search', placeholder: '🔍 Buscar produtos...',
    oninput: (e) => { buscaAtual = e.target.value; if (rota() === 'catalogo') render(); },
  });

  connEl = el('button', { class: 'conn off', onclick: configurarGateway });
  cartBadgeEl = el('span', { class: 'cart-badge', text: '0' });

  const conta = sessao.get();
  root.appendChild(el('header', { class: 'topbar' }, [
    el('div', { class: 'brand', onclick: () => { location.hash = '#/catalogo'; } }, [
      el('div', { class: 'brand-mark', text: 'V' }),
      el('div', {}, [
        el('div', { class: 'brand-name', text: 'Vava Store' }),
        el('div', { class: 'brand-sub', text: 'powered by microserviços' }),
      ]),
    ]),
    busca,
    el('div', { class: 'topbar-actions' }, [
      connEl,
      el('button', { class: 'btn btn-ghost', onclick: () => { location.hash = '#/conta'; } },
        [conta ? `👤 ${conta.nome.split(' ')[0]}` : '👤 Entrar']),
      el('button', { class: 'btn cart-btn', onclick: () => { location.hash = '#/carrinho'; } },
        ['🛒 Carrinho', cartBadgeEl]),
    ]),
  ]));

  contentEl = el('main', { class: 'page' });
  root.appendChild(contentEl);
  root.appendChild(el('footer', { class: 'footer', text: 'Vava Store — e-commerce didático integrado ao Vava ERP · clientes :3001 · catálogo :3002 · estoque :3003 · tributário :3004 · pedidos :3005 · marketplaces :3006' }));
  atualizarBadge();
  atualizarConn();
}

function configurarGateway() {
  const atual = gatewayUrl();
  const novo = prompt('URL do gateway de microserviços:', atual);
  if (novo && novo !== atual) setGatewayUrl(novo.replace(/\/$/, ''));
  verificarConexao().then(() => { atualizarConn(); render(); });
}

// ----- páginas ---------------------------------------------------------------
async function paginaCatalogo() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const categoria = params.get('cat') || '';

  const [produtos, categorias, saldos] = await Promise.all([
    api.listarProdutos({ busca: buscaAtual, categoria }),
    api.categorias(),
    api.saldos().catch(() => ({})),
  ]);

  const frag = document.createDocumentFragment();

  if (!buscaAtual && !categoria) {
    frag.appendChild(el('div', { class: 'hero' }, [
      el('div', { class: 'tag', text: '// loja integrada ao Vava ERP em tempo real' }),
      el('h1', { text: 'Tecnologia e suprimentos para o seu dia a dia' }),
      el('p', { text: 'Estoque sincronizado, cadastro unificado e impostos calculados pelo motor tributário a cada pedido.' }),
    ]));
  }

  if (!online) {
    frag.appendChild(el('div', { class: 'notice', html: '⚠️ <strong>Modo demonstração:</strong> o gateway de microserviços não foi encontrado — os dados estão simulados neste navegador. Suba o backend com <code>npm start</code> e recarregue.' }));
  }

  const chips = el('div', { class: 'chips' }, [
    el('button', { class: `chip ${!categoria ? 'active' : ''}`, text: 'Todos', onclick: () => { location.hash = '#/catalogo'; } }),
    ...categorias.map((c) => el('button', {
      class: `chip ${categoria === c ? 'active' : ''}`, text: `${EMOJI_CAT[c] || '📦'} ${c}`,
      onclick: () => { location.hash = `#/catalogo?cat=${encodeURIComponent(c)}`; },
    })),
  ]);
  frag.appendChild(chips);

  if (!produtos.length) {
    frag.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'icon', text: '🔎' }), el('div', { text: 'Nenhum produto encontrado.' })]));
  } else {
    frag.appendChild(el('div', { class: 'grid' }, produtos.map((p) => {
      const saldo = Number(saldos[p.sku] ?? 0);
      const stockClass = saldo <= 0 ? 'no-stock' : saldo < 10 ? 'low-stock' : 'in-stock';
      const stockText = saldo <= 0 ? 'sem estoque' : saldo < 10 ? `restam ${saldo} un` : `${saldo} em estoque`;
      return el('div', { class: 'card' }, [
        p.fotos && p.fotos.length
          ? el('div', { class: 'card-thumb' }, el('img', { class: 'card-foto', src: p.fotos[0], alt: p.nome }))
          : el('div', { class: 'card-thumb', text: p.emoji || EMOJI_CAT[p.categoria] || '📦' }),
        el('div', { class: 'card-body' }, [
          el('div', { class: 'card-cat', text: `${p.categoria} · ${p.sku}` }),
          el('div', { class: 'card-name', text: p.nome }),
          el('div', { class: 'card-desc', text: p.descricao || '' }),
          el('div', { class: 'card-price', text: fmt(p.precoVenda) }),
          el('div', { class: `card-stock mono ${stockClass}`, text: `▸ ${stockText}` }),
          el('button', {
            class: 'btn btn-primary', text: saldo <= 0 ? 'Indisponível' : 'Adicionar ao carrinho',
            ...(saldo <= 0 ? { disabled: '' } : {}),
            onclick: () => { carrinho.adicionar(p); atualizarBadge(); toast(`${p.nome} adicionado ao carrinho.`, 'success'); },
          }),
        ]),
      ]);
    })));
  }
  return frag;
}

async function paginaCarrinho() {
  const itens = carrinho.itens();
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h2', { class: 'page-title', text: '🛒 Carrinho' }));

  if (!itens.length) {
    frag.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'icon', text: '🛒' }),
      el('div', { text: 'Seu carrinho está vazio.' }),
      el('p', {}, [el('a', { href: '#/catalogo', text: '← Voltar ao catálogo' })]),
    ]));
    return frag;
  }

  const tabela = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Produto' }), el('th', { text: 'Qtd' }),
      el('th', { class: 'num', text: 'Unitário' }), el('th', { class: 'num', text: 'Total' }), el('th'),
    ])),
    el('tbody', {}, itens.map((i) => el('tr', {}, [
      el('td', { text: `${i.emoji || '📦'} ${i.nome}` }),
      el('td', {}, el('span', { class: 'qty' }, [
        el('button', { text: '−', onclick: () => { carrinho.alterar(i.sku, i.quantidade - 1); render(); } }),
        el('span', { text: String(i.quantidade) }),
        el('button', { text: '+', onclick: () => { carrinho.alterar(i.sku, i.quantidade + 1); render(); } }),
      ])),
      el('td', { class: 'num', text: fmt(i.precoUnitario) }),
      el('td', { class: 'num', text: fmt(i.precoUnitario * i.quantidade) }),
      el('td', {}, el('button', { class: 'btn btn-sm', text: '✕', onclick: () => { carrinho.alterar(i.sku, 0); render(); } })),
    ]))),
  ]);

  frag.appendChild(el('div', { class: 'panel' }, tabela));
  frag.appendChild(el('div', { class: 'panel' }, [
    el('div', { class: 'total-line big' }, [el('span', { text: 'Total' }), el('span', { text: fmt(carrinho.total()) })]),
    el('div', { style: 'display:flex; gap:10px; margin-top:14px;' }, [
      el('button', { class: 'btn', text: '← Continuar comprando', onclick: () => { location.hash = '#/catalogo'; } }),
      el('button', { class: 'btn btn-primary', text: 'Finalizar pedido →', onclick: () => { location.hash = '#/checkout'; } }),
    ]),
  ]));
  return frag;
}

function formCliente(prefixo = {}) {
  const campos = {};
  const campo = (nome, label, attrs = {}) => {
    campos[nome] = el('input', { value: prefixo[nome] || '', ...attrs });
    return el('div', {}, [el('label', { text: label }), campos[nome]]);
  };
  campos.tipo = el('select', {}, [
    el('option', { value: 'PF', text: 'Pessoa Física' }),
    el('option', { value: 'PJ', text: 'Pessoa Jurídica' }),
  ]);
  campos.uf = el('select', {}, [
    el('option', { value: '', text: 'UF...' }),
    ...UFS.map((uf) => el('option', { value: uf, text: uf, ...(prefixo.uf === uf ? { selected: '' } : {}) })),
  ]);
  const wrap = el('div', {}, [
    el('div', { class: 'row' }, [
      el('div', {}, [el('label', { text: 'Tipo' }), campos.tipo]),
      campo('nome', 'Nome completo / Razão social'),
    ]),
    el('div', { class: 'row' }, [
      campo('documento', 'CPF / CNPJ (somente números)'),
      campo('email', 'E-mail', { type: 'email' }),
      campo('telefone', 'Telefone'),
    ]),
    el('div', { class: 'row' }, [
      campo('cidade', 'Cidade'),
      el('div', {}, [el('label', { text: 'UF (define o ICMS)' }), campos.uf]),
    ]),
  ]);
  return { wrap, campos, valores: () => ({
    tipo: campos.tipo.value, nome: campos.nome.value.trim(), documento: campos.documento.value.trim(),
    email: campos.email.value.trim(), telefone: campos.telefone.value.trim(),
    cidade: campos.cidade.value.trim(), uf: campos.uf.value,
  }) };
}

async function paginaCheckout() {
  const itens = carrinho.itens();
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h2', { class: 'page-title', text: '📦 Finalizar pedido' }));

  if (!itens.length) {
    frag.appendChild(el('div', { class: 'empty', text: 'Carrinho vazio — adicione produtos antes do checkout.' }));
    return frag;
  }

  const conta = sessao.get();
  if (!conta) {
    frag.appendChild(el('div', { class: 'panel' }, [
      el('h3', { text: 'Identifique-se para continuar' }),
      el('p', { class: 'muted', text: 'O cadastro é unificado: a mesma conta vale para a loja e para o ERP.' }),
      el('button', { class: 'btn btn-primary', text: 'Entrar ou criar conta', onclick: () => { location.hash = '#/conta?volta=checkout'; } }),
    ]));
    return frag;
  }

  const form = formCliente(conta);
  const resumoEl = el('div');
  const impostosEl = el('div', { class: 'muted', style: 'font-size:13px;' });

  async function atualizarResumo() {
    const uf = form.campos.uf.value || conta.uf;
    resumoEl.innerHTML = '';
    const subtotal = carrinho.total();
    resumoEl.appendChild(el('div', { class: 'total-line' }, [el('span', { text: `Itens (${carrinho.qtdTotal()})` }), el('span', { text: fmt(subtotal) })]));
    resumoEl.appendChild(el('div', { class: 'total-line big' }, [el('span', { text: 'Total' }), el('span', { text: fmt(subtotal) })]));

    impostosEl.innerHTML = '';
    if (!uf) {
      impostosEl.textContent = 'Selecione a UF de entrega para calcular os impostos.';
      return;
    }
    try {
      const trib = await api.calcularImpostos({
        ufOrigem: 'SP', ufDestino: uf,
        itens: itens.map((i) => ({ sku: i.sku, ncm: i.ncm, quantidade: i.quantidade, valorUnitario: i.precoUnitario })),
      });
      const t = trib.totais;
      impostosEl.appendChild(el('div', { style: 'border-top:1px solid var(--border); margin-top:10px; padding-top:10px;' }, [
        el('div', { class: 'mono', style: 'color:var(--accent); margin-bottom:6px;', text: `// impostos inclusos no preço — motor tributário (SP → ${uf})` }),
        el('div', { class: 'total-line' }, [el('span', { text: 'ICMS' }), el('span', { class: 'mono', text: fmt(t.icms) })]),
        el('div', { class: 'total-line' }, [el('span', { text: 'IPI' }), el('span', { class: 'mono', text: fmt(t.ipi) })]),
        el('div', { class: 'total-line' }, [el('span', { text: 'PIS' }), el('span', { class: 'mono', text: fmt(t.pis) })]),
        el('div', { class: 'total-line' }, [el('span', { text: 'COFINS' }), el('span', { class: 'mono', text: fmt(t.cofins) })]),
        el('div', { class: 'total-line' }, [el('span', { text: 'Carga tributária' }), el('span', { class: 'mono', text: fmt(t.impostos) })]),
      ]));
    } catch (err) {
      impostosEl.textContent = `Não foi possível calcular os impostos: ${err.message}`;
    }
  }
  form.campos.uf.addEventListener('change', atualizarResumo);

  const btnConfirmar = el('button', { class: 'btn btn-primary', style: 'width:100%; margin-top:14px;', text: '✓ Confirmar pedido' });
  btnConfirmar.addEventListener('click', async () => {
    const dados = form.valores();
    if (!dados.nome || !dados.uf) {
      toast('Preencha ao menos nome e UF de entrega.', 'error');
      return;
    }
    btnConfirmar.disabled = true;
    btnConfirmar.textContent = 'Processando...';
    try {
      const pedido = await api.criarPedido({
        cliente: { ...conta, ...dados },
        itens: itens.map(({ emoji, ...i }) => i),
      });
      sessao.set({ ...conta, ...dados });
      carrinho.limpar();
      atualizarBadge();
      location.hash = `#/pedido/${pedido.id}`;
      window.__ultimoPedido = pedido;
    } catch (err) {
      toast(err.message, 'error');
      btnConfirmar.disabled = false;
      btnConfirmar.textContent = '✓ Confirmar pedido';
    }
  });

  frag.appendChild(el('div', { class: 'split' }, [
    el('div', { class: 'panel' }, [el('h3', { text: `Dados de entrega — ${conta.nome}` }), form.wrap]),
    el('div', { class: 'panel' }, [el('h3', { text: 'Resumo' }), resumoEl, impostosEl, btnConfirmar]),
  ]));
  atualizarResumo();
  return frag;
}

async function paginaPedido(id) {
  const pedido = window.__ultimoPedido?.id === id ? window.__ultimoPedido : null;
  const frag = document.createDocumentFragment();
  if (!pedido) {
    frag.appendChild(el('div', { class: 'empty', text: 'Pedido processado. Veja os detalhes em Minha Conta.' }));
    frag.appendChild(el('p', { style: 'text-align:center;' }, el('a', { href: '#/conta', text: 'Ir para Minha Conta →' })));
    return frag;
  }
  const t = pedido.impostos || {};
  frag.appendChild(el('div', { class: 'hero' }, [
    el('h1', { text: '✅ Pedido confirmado!' }),
    el('p', { class: 'mono', text: `Nº ${pedido.numero} · estoque baixado e impostos apurados pelos microserviços.` }),
  ]));
  frag.appendChild(el('div', { class: 'panel' }, [
    el('h3', { text: 'Itens' }),
    el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Produto' }), el('th', { class: 'num', text: 'Qtd' }), el('th', { class: 'num', text: 'Total' })])),
      el('tbody', {}, pedido.itens.map((i) => el('tr', {}, [
        el('td', { text: i.nome }), el('td', { class: 'num', text: String(i.quantidade) }), el('td', { class: 'num', text: fmt(i.total) }),
      ]))),
    ]),
    el('div', { class: 'total-line big' }, [el('span', { text: 'Total pago' }), el('span', { text: fmt(pedido.total) })]),
    el('div', { class: 'muted mono', style: 'margin-top:10px; font-size:12.5px;', text:
      `Impostos inclusos (${pedido.ufOrigem} → ${pedido.ufDestino}): ICMS ${fmt(t.icms)} · IPI ${fmt(t.ipi)} · PIS ${fmt(t.pis)} · COFINS ${fmt(t.cofins)}` }),
  ]));
  frag.appendChild(el('p', {}, el('a', { href: '#/catalogo', text: '← Voltar à loja' })));
  return frag;
}

async function paginaConta() {
  const frag = document.createDocumentFragment();
  const conta = sessao.get();
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const destinoVolta = params.get('volta') === 'checkout' ? '#/checkout' : '#/conta';

  if (conta) {
    frag.appendChild(el('h2', { class: 'page-title', text: `👤 Olá, ${conta.nome}` }));
    frag.appendChild(el('p', { class: 'page-sub mono', text: `${conta.email || ''} · ${conta.cidade || ''}/${conta.uf || '—'} · cadastro unificado loja + ERP` }));
    frag.appendChild(el('button', { class: 'btn', text: 'Sair da conta', onclick: () => { sessao.sair(); buildShell(); render(); } }));

    const painel = el('div', { class: 'panel', style: 'margin-top:18px;' }, [el('h3', { text: '📑 Meus pedidos' }), el('div', { class: 'muted', text: 'Carregando...' })]);
    frag.appendChild(painel);
    api.meusPedidos(conta.id).then((pedidos) => {
      painel.lastChild.remove();
      if (!pedidos.length) {
        painel.appendChild(el('div', { class: 'muted', text: 'Nenhum pedido ainda.' }));
        return;
      }
      painel.appendChild(el('table', {}, [
        el('thead', {}, el('tr', {}, [el('th', { text: 'Pedido' }), el('th', { text: 'Data' }), el('th', { text: 'Status' }), el('th', { class: 'num', text: 'Total' })])),
        el('tbody', {}, pedidos.map((p) => el('tr', {}, [
          el('td', { class: 'mono', text: p.numero }),
          el('td', { text: new Date(p.criadoEm).toLocaleString('pt-BR') }),
          el('td', {}, el('span', { class: `badge ${p.status}`, text: p.status })),
          el('td', { class: 'num', text: fmt(p.total) }),
        ]))),
      ]));
    }).catch((err) => { painel.lastChild.textContent = `Erro ao carregar pedidos: ${err.message}`; });
    return frag;
  }

  // --- login / cadastro ---
  frag.appendChild(el('h2', { class: 'page-title', text: '👤 Minha conta' }));
  frag.appendChild(el('p', { class: 'page-sub', text: 'Uma conta só para a loja e para o ERP — o cadastro de clientes é compartilhado pelo microserviço de clientes.' }));

  const emailLogin = el('input', { type: 'email', placeholder: 'voce@email.com' });
  const senhaLogin = el('input', { type: 'password', placeholder: '••••••' });
  const painelLogin = el('div', { class: 'panel' }, [
    el('h3', { text: 'Já tenho conta' }),
    el('label', { text: 'E-mail' }), emailLogin,
    el('label', { text: 'Senha' }), senhaLogin,
    el('button', { class: 'btn btn-primary', style: 'margin-top:14px;', text: 'Entrar', onclick: async () => {
      try {
        const cliente = await api.login(emailLogin.value.trim(), senhaLogin.value);
        sessao.set(cliente);
        toast(`Bem-vindo de volta, ${cliente.nome}!`, 'success');
        buildShell();
        location.hash = destinoVolta;
        render();
      } catch (err) { toast(err.message, 'error'); }
    } }),
  ]);

  const form = formCliente();
  const senhaNova = el('input', { type: 'password', placeholder: 'mínimo 4 caracteres' });
  const painelCadastro = el('div', { class: 'panel' }, [
    el('h3', { text: 'Criar conta' }),
    form.wrap,
    el('label', { text: 'Senha' }), senhaNova,
    el('button', { class: 'btn btn-primary', style: 'margin-top:14px;', text: 'Cadastrar', onclick: async () => {
      const dados = form.valores();
      if (!dados.nome || !dados.email) { toast('Preencha ao menos nome e e-mail.', 'error'); return; }
      try {
        const cliente = await api.registrar({ ...dados, senha: senhaNova.value });
        sessao.set(cliente);
        toast('Conta criada! Cadastro disponível também no ERP.', 'success');
        buildShell();
        location.hash = destinoVolta;
        render();
      } catch (err) { toast(err.message, 'error'); }
    } }),
  ]);

  frag.appendChild(el('div', { class: 'split' }, [painelCadastro, painelLogin]));
  return frag;
}

// ----- roteador ---------------------------------------------------------------
function rota() {
  const hash = location.hash.replace(/^#\/?/, '').split('?')[0];
  return hash || 'catalogo';
}

const PAGINAS = {
  catalogo: paginaCatalogo,
  carrinho: paginaCarrinho,
  checkout: paginaCheckout,
  conta: paginaConta,
};

async function render() {
  const r = rota();
  contentEl.innerHTML = '<div class="empty muted">Carregando...</div>';
  try {
    let frag;
    if (r.startsWith('pedido/')) frag = await paginaPedido(r.split('/')[1]);
    else frag = await (PAGINAS[r] || paginaCatalogo)();
    contentEl.innerHTML = '';
    contentEl.appendChild(frag);
  } catch (err) {
    console.error(err);
    contentEl.innerHTML = '';
    contentEl.appendChild(el('div', { class: 'empty' }, [
      el('div', { class: 'icon', text: '⚠️' }),
      el('div', { text: `Erro ao carregar a página: ${err.message}` }),
    ]));
  }
}

async function init() {
  buildShell();
  window.addEventListener('hashchange', render);
  window.addEventListener('store:carrinho', atualizarBadge);
  if (!location.hash) location.hash = '#/catalogo';
  await verificarConexao();
  atualizarConn();
  render();
  // Reverifica a conexão com o backend periodicamente.
  setInterval(async () => {
    const antes = online;
    await verificarConexao();
    if (antes !== online) { atualizarConn(); render(); }
  }, 15000);
}

document.addEventListener('DOMContentLoaded', init);
