// Microserviço de CLIENTES — porta 3001
// Cadastro unificado de clientes entre o e-commerce e o ERP.
// - CRUD de clientes (mesmo formato de registro usado pelo Vava ERP)
// - Autenticação simples da loja (registrar / login)
// - Sincronização bidirecional (merge por documento ou e-mail)
//
// Executar: node services/clientes/server.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService, jsonDB, uid, ApiError, hashSenha, verificarSenha, ehHashLegado } from '../_lib/micro.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const { data: db, save } = jsonDB(dir, { clientes: [] });

const PORT = Number(process.env.CLIENTES_PORT || 3001);

const publico = ({ senhaHash, ...c }) => c; // nunca expõe o hash da senha

function buscarPorChave(documento, email) {
  return db.clientes.find(
    (c) =>
      (documento && c.documento && c.documento === documento) ||
      (email && c.email && c.email.toLowerCase() === String(email).toLowerCase())
  );
}

function validar(body) {
  if (!body.nome) throw new ApiError(400, 'Campo obrigatório: nome.');
  if (!body.email && !body.documento) throw new ApiError(400, 'Informe ao menos e-mail ou documento (CPF/CNPJ).');
}

createService({
  name: 'clientes',
  port: PORT,
  routes: [
    {
      method: 'GET',
      path: '/clientes',
      handler: ({ query }) => {
        const busca = (query.get('busca') || '').toLowerCase();
        let lista = db.clientes;
        if (busca) {
          lista = lista.filter((c) =>
            [c.nome, c.email, c.documento, c.cidade].some((v) => String(v || '').toLowerCase().includes(busca))
          );
        }
        return lista.map(publico);
      },
    },
    {
      method: 'GET',
      path: '/clientes/:id',
      handler: ({ params }) => {
        const c = db.clientes.find((x) => x.id === params.id);
        if (!c) throw new ApiError(404, 'Cliente não encontrado.');
        return publico(c);
      },
    },
    {
      method: 'POST',
      path: '/clientes',
      handler: ({ body }) => {
        validar(body);
        if (buscarPorChave(body.documento, body.email)) {
          throw new ApiError(409, 'Já existe cliente com este documento ou e-mail.');
        }
        const cliente = {
          id: uid('cli_'),
          tipo: body.tipo || 'PF',
          nome: body.nome,
          documento: body.documento || '',
          email: body.email || '',
          telefone: body.telefone || '',
          cidade: body.cidade || '',
          uf: body.uf || '',
          ativo: body.ativo !== false,
          origem: body.origem || 'api',
          criadoEm: new Date().toISOString(),
        };
        db.clientes.push(cliente);
        save();
        return { status: 201, body: publico(cliente) };
      },
    },
    {
      method: 'PUT',
      path: '/clientes/:id',
      handler: ({ params, body }) => {
        const c = db.clientes.find((x) => x.id === params.id);
        if (!c) throw new ApiError(404, 'Cliente não encontrado.');
        const { id, senhaHash, criadoEm, ...resto } = body;
        Object.assign(c, resto, { atualizadoEm: new Date().toISOString() });
        save();
        return publico(c);
      },
    },
    {
      method: 'DELETE',
      path: '/clientes/:id',
      handler: ({ params }) => {
        const antes = db.clientes.length;
        db.clientes = db.clientes.filter((x) => x.id !== params.id);
        if (db.clientes.length === antes) throw new ApiError(404, 'Cliente não encontrado.');
        save();
        return { ok: true };
      },
    },

    // ----- Autenticação da loja (didática: hash SHA-256, sem sessão real) -----
    {
      method: 'POST',
      path: '/auth/registrar',
      handler: ({ body }) => {
        validar(body);
        if (!body.senha || String(body.senha).length < 4) {
          throw new ApiError(400, 'Senha obrigatória (mínimo 4 caracteres).');
        }
        const existente = buscarPorChave(body.documento, body.email);
        if (existente && existente.senhaHash) {
          throw new ApiError(409, 'Já existe uma conta com este e-mail ou documento. Faça login.');
        }
        // Se o cliente já existia (ex.: cadastrado pelo ERP), apenas ativa a conta da loja.
        const cliente = existente || {
          id: uid('cli_'),
          ativo: true,
          criadoEm: new Date().toISOString(),
        };
        Object.assign(cliente, {
          tipo: body.tipo || cliente.tipo || 'PF',
          nome: body.nome,
          documento: body.documento || cliente.documento || '',
          email: body.email || cliente.email || '',
          telefone: body.telefone || cliente.telefone || '',
          cidade: body.cidade || cliente.cidade || '',
          uf: body.uf || cliente.uf || '',
          origem: cliente.origem || 'ecommerce',
          senhaHash: hashSenha(body.senha),
        });
        if (!existente) db.clientes.push(cliente);
        save();
        return { status: 201, body: publico(cliente) };
      },
    },
    {
      method: 'POST',
      path: '/auth/login',
      handler: ({ body }) => {
        const c = db.clientes.find(
          (x) => x.email && x.email.toLowerCase() === String(body.email || '').toLowerCase()
        );
        if (!c || !c.senhaHash || !verificarSenha(body.senha || '', c.senhaHash)) {
          throw new ApiError(401, 'E-mail ou senha inválidos.');
        }
        // migra hash legado (SHA-256 sem salt) para scrypt no primeiro login
        if (ehHashLegado(c.senhaHash)) {
          c.senhaHash = hashSenha(body.senha);
          save();
        }
        return publico(c);
      },
    },

    // ----- Sincronização com o ERP (merge por documento/e-mail) -----
    {
      method: 'POST',
      path: '/sync',
      handler: ({ body }) => {
        const recebidos = Array.isArray(body.clientes) ? body.clientes : [];
        let criados = 0;
        let atualizados = 0;
        for (const r of recebidos) {
          if (!r.nome) continue;
          const existente = buscarPorChave(r.documento, r.email);
          if (existente) {
            const { id, senhaHash, criadoEm, ...resto } = r;
            Object.assign(existente, resto, { atualizadoEm: new Date().toISOString() });
            atualizados++;
          } else {
            db.clientes.push({
              tipo: 'PF',
              ativo: true,
              ...r,
              id: uid('cli_'),
              origem: r.origem || 'erp',
              criadoEm: new Date().toISOString(),
            });
            criados++;
          }
        }
        save();
        return { criados, atualizados, total: db.clientes.length, clientes: db.clientes.map(publico) };
      },
    },
  ],
});
