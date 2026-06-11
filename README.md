# Vava Store — E-commerce + Microserviços

E-commerce com visual **simples e tecnológico** (tema escuro), integrado ao [Vava ERP](https://github.com/vadia38/web-erp) por uma arquitetura de **microserviços** em Node.js puro — **sem nenhuma dependência externa** (não precisa de `npm install`).

> Projeto educacional: cada módulo de negócio tem o seu próprio backend, com API própria, banco próprio e porta própria — prontos para serem integrados (ou implantados) de forma independente, quando quiser.

---

## 🗺️ Arquitetura

```
        Vava Store (loja)                    Vava ERP (web-erp)
        index.html + assets/                 módulo "Integração E-commerce"
               │                                      │
               └──────────► API GATEWAY :3000 ◄───────┘
                                 │  (roteia /api/<serviço>/*)
        ┌──────────┬─────────────┼──────────────┬──────────┬─────────────┐
        ▼          ▼             ▼              ▼          ▼             ▼
    CLIENTES    CATÁLOGO      ESTOQUE      TRIBUTÁRIO   PEDIDOS    MARKETPLACES
      :3001       :3002        :3003          :3004       :3005        :3006
    cadastro    produtos      saldo único   ICMS · IPI   checkout:   Meli·Shopee
    unificado   da loja       por SKU       PIS · COFINS orquestra   Amazon·Magalu
    loja + ERP  (sync c/ ERP) (sync c/ ERP) por NCM/UF   estoque+    anúncios e
                                                         impostos    pedidos/canal
```

| Serviço | Porta | Responsabilidade | Banco |
|---|---|---|---|
| **gateway** | 3000 | Ponto único de entrada; roteia `/api/<serviço>/*` e agrega o health check | — |
| **clientes** | 3001 | Cadastro unificado de clientes (loja + ERP), login/registro da loja, sync bidirecional | `services/clientes/data/db.json` |
| **catalogo** | 3002 | Produtos exibidos na loja; recebe publicações do ERP (merge por SKU) | `services/catalogo/data/db.json` |
| **estoque** | 3003 | Saldo por SKU + movimentações; baixa em lote tudo-ou-nada; sync com o ERP | `services/estoque/data/db.json` |
| **tributario** | 3004 | Motor tributário: ICMS (interno/interestadual por UF), IPI (por NCM), PIS e COFINS | — (stateless) |
| **pedidos** | 3005 | Checkout: baixa estoque → calcula impostos → grava o pedido; fila de exportação p/ ERP | `services/pedidos/data/db.json` |
| **marketplaces** | 3006 | Canais externos (Mercado Livre, Shopee, Amazon, Magalu): anúncios por canal, webhook/simulador de pedidos com comissão | `services/marketplaces/data/db.json` |

Cada serviço usa apenas `services/_lib/micro.js` (HTTP + roteador + persistência em JSON, ~150 linhas). Para implantar um serviço sozinho, copie a pasta dele + o `_lib`.

---

## 🚀 Como executar

### Opção 1 — Docker (recomendado)

```bash
docker compose up --build
```

Sobe **7 containers**: a loja (nginx) + gateway + 5 microserviços, cada um na sua imagem.

- Loja: `http://localhost:8080`
- Gateway: `http://localhost:3000` (único serviço exposto ao navegador)
- Os serviços conversam pela rede interna do compose (`http://clientes:3001`, ...)
- Os bancos JSON ficam em **volumes nomeados** — os dados sobrevivem a `docker compose restart`

Para subir um serviço sozinho:

```bash
docker build -f services/Dockerfile --build-arg SERVICO=tributario --build-arg PORTA=3004 -t vava-tributario .
docker run -p 3004:3004 vava-tributario
```

### Opção 2 — Node.js direto

Requisitos: **Node.js 18+** (sem `npm install` — zero dependências).

```bash
# 1. Sobe os 6 microserviços (gateway + 5 módulos)
npm start          # ou: node services/start-all.js

# 2. Em outro terminal, sirva a loja por HTTP
npx serve .        # ou: python3 -m http.server 8080
```

Abra `http://localhost:8080`. O selo no topo mostra **● integrado ao ERP** quando o gateway responde.

Cada serviço também sobe sozinho: `npm run servico:tributario`, `node services/clientes/server.js`, etc. As portas e URLs são configuráveis por variáveis de ambiente (`GATEWAY_PORT`, `CLIENTES_URL`, ...).

### Modo demonstração (sem backend)

Se o gateway estiver fora do ar (ex.: loja aberta pelo GitHub Pages), a loja entra em **modo demonstração**: catálogo, estoque, cadastro, impostos e pedidos funcionam localmente no navegador, com as mesmas regras de negócio. Ao subir o backend, recarregue a página.

---

## 🔗 Integração com o Vava ERP

No ERP (repositório `web-erp`), o módulo **Integração E-commerce** usa o gateway para:

1. **👥 Sincronizar clientes** — cadastro unificado: merge bidirecional por CPF/CNPJ ou e-mail. Quem cria conta na loja aparece no ERP; clientes do ERP podem ativar conta na loja.
2. **📦 Publicar catálogo** — produtos ativos do ERP viram o catálogo da loja (custo e saldo interno não são expostos).
3. **📊 Enviar saldos de estoque** — o saldo do ERP vira a disponibilidade mostrada na loja; cada venda na loja baixa o saldo na hora.
4. **🛒 Importar pedidos** — pedidos confirmados viram vendas faturadas no ERP, gerando baixa de estoque, contas a receber e NF-e de saída **com os impostos apurados pelo motor tributário** (CFOP 5102/6102 conforme a UF).

### Fluxo de um pedido

```
loja → POST /api/pedidos/pedidos
         1) estoque: baixa em lote (tudo-ou-nada; estorna se algo falhar)
         2) tributário: ICMS/IPI/PIS/COFINS por item (UF origem → UF destino)
         3) pedido confirmado (fila pendentesErp=true)
ERP  → importa → venda + estoque + financeiro + NF-e → marca como exportado
```

---

## 🧪 Exemplos de API (via gateway)

```bash
curl http://localhost:3000/health                          # saúde de todos os serviços
curl http://localhost:3000/api/catalogo/produtos           # catálogo
curl http://localhost:3000/api/estoque/saldos/SKU-0011     # saldo de um SKU

# motor tributário
curl -X POST http://localhost:3000/api/tributario/calcular \
  -H 'Content-Type: application/json' \
  -d '{"ufOrigem":"SP","ufDestino":"BA","itens":[{"ncm":"8517.13.00","quantidade":2,"valorUnitario":2200}]}'

# checkout (orquestração completa)
curl -X POST http://localhost:3000/api/pedidos/pedidos \
  -H 'Content-Type: application/json' \
  -d '{"cliente":{"nome":"Ana","uf":"BA"},"itens":[{"sku":"SKU-0011","nome":"Smartphone X","ncm":"8517.13.00","quantidade":1,"precoUnitario":2200}]}'

# marketplaces: conectar canal, publicar anúncios e receber um pedido
curl -X POST http://localhost:3000/api/marketplaces/canais/mercado-livre/conectar -H 'Content-Type: application/json' -d '{}'
curl -X POST http://localhost:3000/api/marketplaces/anuncios/publicar -H 'Content-Type: application/json' -d '{}'
curl -X POST http://localhost:3000/api/marketplaces/webhooks/mercado-livre \
  -H 'Content-Type: application/json' \
  -d '{"comprador":{"nome":"Maria","uf":"RJ"},"itens":[{"sku":"SKU-0012","quantidade":1}]}'
```

---

## 📂 Estrutura

```
vava-catalogo/
├── index.html                 # Loja (SPA: catálogo, carrinho, checkout, conta)
├── assets/
│   ├── css/styles.css         # Visual simples e tecnológico (tema escuro)
│   └── js/
│       ├── api.js             # Integração com o gateway + modo demonstração
│       └── app.js             # Rotas e páginas da loja
├── services/
│   ├── _lib/micro.js          # Base comum (HTTP, rotas, JSON, CORS)
│   ├── Dockerfile             # Imagem genérica (build-arg SERVICO)
│   ├── gateway/server.js      # :3000
│   ├── clientes/server.js     # :3001
│   ├── catalogo/server.js     # :3002
│   ├── estoque/server.js      # :3003
│   ├── tributario/server.js   # :3004
│   ├── pedidos/server.js      # :3005
│   ├── marketplaces/server.js # :3006
│   └── start-all.js           # Sobe tudo em desenvolvimento (sem Docker)
├── Dockerfile.loja            # Loja servida pelo nginx
├── docker-compose.yml         # Orquestra loja + gateway + 5 serviços
└── package.json               # Apenas scripts (zero dependências)
```

---

## ⚠️ Observações

- As tabelas tributárias (ICMS por UF, IPI por capítulo de NCM, PIS/COFINS) são **simplificadas para fins didáticos** e não substituem um motor fiscal homologado.
- A autenticação da loja é didática (hash SHA-256, sem sessão/token real). Não usar em produção.
- Os bancos `data/db.json` são criados na primeira execução e ficam fora do git.
