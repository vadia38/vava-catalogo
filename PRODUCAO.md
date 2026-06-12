# Guia de produção

O que já vem pronto para produção e o que você ainda precisa configurar antes de expor a plataforma na internet.

## ✅ O que a plataforma já faz

| Proteção | Onde |
|---|---|
| Senhas com **scrypt + salt** (ERP e clientes da loja; hashes SHA-256 antigos migram no primeiro login) | serviços `usuarios` e `clientes` |
| **Sessões com token** aleatório (32 bytes) e expiração (8h, configurável) persistidas no servidor | serviço `usuarios` |
| **Força bruta**: 5 tentativas por e-mail+IP a cada 15 min | serviço `usuarios` |
| **Rotas administrativas exigem Bearer token** (sync de cadastros, PII de clientes, gestão de catálogo/anúncios/canais, fila de pedidos do ERP) | gateway |
| **CORS restrito** por variável `ALLOWED_ORIGINS` | gateway |
| **Rate limit** por IP (`RATE_LIMIT_RPM`, padrão 300/min) e limite de corpo (`MAX_BODY_MB`, padrão 8 MB) | gateway |
| Headers de segurança (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`) | gateway |
| **Webhook de marketplaces com segredo** (`WEBHOOK_SECRET` + header `x-webhook-token`) | serviço `marketplaces` |
| Containers com usuário sem privilégios, healthcheck e `restart: unless-stopped` | Docker |
| ERP nunca fica sem administrador; sessões caem na hora ao desativar um usuário | serviço `usuarios` |

## ⚙️ Checklist antes de ir ao ar

1. **Credenciais do admin** — defina no `.env` (nunca use o padrão):
   ```bash
   ADMIN_EMAIL=voce@suaempresa.com
   ADMIN_SENHA=uma-senha-longa-e-unica
   ```
2. **CORS** — restrinja às origens reais:
   ```bash
   ALLOWED_ORIGINS=https://loja.suaempresa.com,https://erp.suaempresa.com
   ```
3. **Webhook** — gere um segredo forte: `WEBHOOK_SECRET=$(openssl rand -hex 24)`
4. **HTTPS** — coloque um proxy reverso (nginx/Caddy/Traefik) na frente da loja, do ERP e do gateway com TLS. Nunca exponha as portas 3001–3007 diretamente; **só o gateway** fala com o mundo.
5. **Backups** — os volumes Docker (`*-data`) guardam os bancos JSON; agende cópia (ex.: `docker run --rm -v vava-catalogo_usuarios-data:/d alpine tar czf - /d > backup.tgz`).
6. No ERP, confirme que a tela de login mostra **"🔐 Autenticação via microserviço de usuários"** — se aparecer o aviso amarelo de modo local, o gateway não está acessível.

```bash
# subir com as variáveis do .env
docker compose up -d --build
```

## ⚠️ Limites conhecidos (didáticos por escolha)

- **Persistência em JSON**: simples e auditável, mas sem transações/concorrência de um banco real. Para volume de produção sério, troque a camada `jsonDB` por PostgreSQL — cada serviço tem sua persistência isolada justamente para isso.
- **Pedidos da loja**: o histórico (`?clienteId=`) é aberto por id de cliente — clientes da loja não têm token de sessão. Próximo passo natural: emitir tokens também no serviço de clientes.
- **Dados do ERP** (vendas, financeiro, fiscal) continuam no `localStorage` do navegador — o backend guarda usuários, catálogo, estoque, pedidos e anúncios. Migrar os demais cadastros para serviços segue o mesmo padrão dos existentes.
- **Tabelas tributárias** são simplificadas; homologue com contador antes de emitir documentos fiscais reais.
