# Dockerfile genérico dos microserviços (Node.js puro, sem dependências).
# O build arg SERVICO define qual serviço a imagem executa:
#   docker build -f services/Dockerfile --build-arg SERVICO=tributario --build-arg PORTA=3004 .
# O docker-compose.yml na raiz monta todos automaticamente.

FROM node:22-alpine

WORKDIR /app

ARG SERVICO
ARG PORTA=3000
ENV SERVICO=${SERVICO} PORTA=${PORTA}

COPY services/_lib ./services/_lib
COPY services/${SERVICO} ./services/${SERVICO}

# Diretório de dados gravável pelo usuário sem privilégios.
RUN mkdir -p services/${SERVICO}/data && chown -R node:node /app
USER node

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:${PORTA}/health || exit 1

CMD ["sh", "-c", "node services/${SERVICO}/server.js"]
