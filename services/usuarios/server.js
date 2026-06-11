// Microserviço de USUÁRIOS — porta 3007
// Autenticação e permissões do ERP em modo produção:
//   - Senhas com scrypt + salt (nunca SHA-256 puro);
//   - Sessões com token aleatório e expiração (8h), persistidas;
//   - Proteção contra força bruta (5 tentativas por e-mail+IP / 15 min);
//   - CRUD de usuários restrito a administradores autenticados;
//   - GET /auth/sessao é usado pelo GATEWAY para validar tokens das rotas
//     administrativas dos demais serviços.
//
// Admin inicial: env ADMIN_EMAIL / ADMIN_SENHA (padrão admin@vava.com /
// admin123 — TROQUE em produção).
//
// Executar: node services/usuarios/server.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createService, jsonDB, uid, ApiError,
  hashSenha, verificarSenha, ehHashLegado, tokenAleatorio, lerToken,
} from '../_lib/micro.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const { data: db, save } = jsonDB(dir, { usuarios: [], sessoes: {} });

const PORT = Number(process.env.USUARIOS_PORT || 3007);
const SESSAO_HORAS = Number(process.env.SESSAO_HORAS || 8);
const MAX_TENTATIVAS = 5;
const JANELA_TENTATIVAS_MS = 15 * 60 * 1000;

const publico = ({ senhaHash, ...u }) => u;

// ----- Admin inicial ---------------------------------------------------------
function ensureAdmin() {
  if (db.usuarios.some((u) => u.modulos?.includes('*') && u.ativo !== false)) return;
  const email = process.env.ADMIN_EMAIL || 'admin@vava.com';
  const senha = process.env.ADMIN_SENHA || 'admin123';
  db.usuarios.push({
    id: uid('usr_'), nome: 'Administrador', email,
    senhaHash: hashSenha(senha), perfil: 'admin', modulos: ['*'],
    ativo: true, criadoEm: new Date().toISOString(),
  });
  save();
  console.log(`[usuarios] admin inicial criado: ${email}${process.env.ADMIN_SENHA ? '' : ' (senha padrão admin123 — troque!)'}`);
}
ensureAdmin();

// ----- Sessões ----------------------------------------------------------------
function limparSessoesExpiradas() {
  const agora = Date.now();
  let mudou = false;
  for (const [token, s] of Object.entries(db.sessoes)) {
    if (new Date(s.expiraEm).getTime() < agora) {
      delete db.sessoes[token];
      mudou = true;
    }
  }
  if (mudou) save();
}

function usuarioDoToken(req) {
  limparSessoesExpiradas();
  const token = lerToken(req);
  const sessao = token && db.sessoes[token];
  if (!sessao) throw new ApiError(401, 'Sessão inválida ou expirada. Faça login novamente.');
  const u = db.usuarios.find((x) => x.id === sessao.usuarioId);
  if (!u || u.ativo === false) {
    delete db.sessoes[token];
    save();
    throw new ApiError(401, 'Usuário inativo ou removido.');
  }
  return { usuario: u, token };
}

function exigirAdmin(req) {
  const { usuario, token } = usuarioDoToken(req);
  if (!usuario.modulos?.includes('*')) throw new ApiError(403, 'Apenas administradores podem gerenciar usuários.');
  return { usuario, token };
}

// ----- Força bruta (memória) ---------------------------------------------------
const tentativas = new Map(); // chave email|ip → [timestamps]
function registrarTentativa(chave) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter((t) => agora - t < JANELA_TENTATIVAS_MS);
  lista.push(agora);
  tentativas.set(chave, lista);
  return lista.length;
}
function bloqueado(chave) {
  const agora = Date.now();
  const lista = (tentativas.get(chave) || []).filter((t) => agora - t < JANELA_TENTATIVAS_MS);
  return lista.length >= MAX_TENTATIVAS;
}

// ----- Validações de segurança do cadastro -------------------------------------
function validarUsuario(body, atual) {
  if (!atual && (!body.nome || !body.email)) throw new ApiError(400, 'Campos obrigatórios: nome e e-mail.');
  if (body.email) {
    const conflito = db.usuarios.find(
      (x) => x.email.toLowerCase() === String(body.email).toLowerCase().trim() && x.id !== atual?.id
    );
    if (conflito) throw new ApiError(409, `Já existe usuário com o e-mail ${body.email}.`);
  }
  if (body.senha != null && String(body.senha).length < 8) {
    throw new ApiError(400, 'Senha deve ter no mínimo 8 caracteres.');
  }
}

function protegerUltimoAdmin(atual, novosModulos, removendo = false) {
  if (!atual.modulos?.includes('*')) return;
  const perdeAdmin = removendo || !(novosModulos || []).includes('*');
  if (!perdeAdmin) return;
  const outros = db.usuarios.filter((x) => x.id !== atual.id && x.modulos?.includes('*') && x.ativo !== false);
  if (!outros.length) throw new ApiError(409, 'Este é o único administrador ativo — promova outro usuário antes.');
}

createService({
  name: 'usuarios',
  port: PORT,
  routes: [
    // ----- Autenticação -----
    {
      method: 'POST',
      path: '/auth/login',
      handler: ({ body, req }) => {
        const email = String(body.email || '').toLowerCase().trim();
        const ip = req.socket?.remoteAddress || '?';
        const chave = `${email}|${ip}`;
        if (bloqueado(chave)) {
          throw new ApiError(429, 'Muitas tentativas. Aguarde 15 minutos e tente novamente.');
        }
        const u = db.usuarios.find((x) => x.email.toLowerCase() === email);
        if (!u || !verificarSenha(body.senha || '', u.senhaHash)) {
          registrarTentativa(chave);
          throw new ApiError(401, 'E-mail ou senha inválidos.');
        }
        if (u.ativo === false) throw new ApiError(403, 'Usuário desativado. Fale com um administrador.');
        tentativas.delete(chave);
        // migra hash legado de forma transparente
        if (ehHashLegado(u.senhaHash)) u.senhaHash = hashSenha(body.senha);
        u.ultimoAcesso = new Date().toISOString();

        const token = tokenAleatorio();
        db.sessoes[token] = {
          usuarioId: u.id,
          criadaEm: new Date().toISOString(),
          expiraEm: new Date(Date.now() + SESSAO_HORAS * 3600 * 1000).toISOString(),
        };
        save();
        return { token, expiraEm: db.sessoes[token].expiraEm, usuario: publico(u) };
      },
    },
    {
      method: 'GET',
      path: '/auth/sessao',
      handler: ({ req }) => {
        const { usuario } = usuarioDoToken(req);
        return publico(usuario);
      },
    },
    {
      method: 'POST',
      path: '/auth/logout',
      handler: ({ req }) => {
        const token = lerToken(req);
        if (token && db.sessoes[token]) {
          delete db.sessoes[token];
          save();
        }
        return { ok: true };
      },
    },
    {
      method: 'POST',
      path: '/auth/trocar-senha',
      handler: ({ req, body }) => {
        const { usuario } = usuarioDoToken(req);
        if (!verificarSenha(body.senhaAtual || '', usuario.senhaHash)) {
          throw new ApiError(401, 'Senha atual incorreta.');
        }
        if (String(body.novaSenha || '').length < 8) throw new ApiError(400, 'Nova senha deve ter no mínimo 8 caracteres.');
        usuario.senhaHash = hashSenha(body.novaSenha);
        save();
        return { ok: true };
      },
    },

    // ----- CRUD (somente administradores) -----
    {
      method: 'GET',
      path: '/usuarios',
      handler: ({ req }) => {
        exigirAdmin(req);
        return db.usuarios.map(publico);
      },
    },
    {
      method: 'POST',
      path: '/usuarios',
      handler: ({ req, body }) => {
        exigirAdmin(req);
        validarUsuario(body, null);
        if (!body.senha) throw new ApiError(400, 'Senha é obrigatória para novos usuários.');
        const u = {
          id: uid('usr_'),
          nome: body.nome,
          email: String(body.email).trim(),
          senhaHash: hashSenha(body.senha),
          perfil: body.perfil || 'personalizado',
          modulos: Array.isArray(body.modulos) ? body.modulos : [],
          ativo: body.ativo !== false,
          criadoEm: new Date().toISOString(),
        };
        db.usuarios.push(u);
        save();
        return { status: 201, body: publico(u) };
      },
    },
    {
      method: 'PUT',
      path: '/usuarios/:id',
      handler: ({ req, params, body }) => {
        exigirAdmin(req);
        const u = db.usuarios.find((x) => x.id === params.id);
        if (!u) throw new ApiError(404, 'Usuário não encontrado.');
        validarUsuario(body, u);
        const novosModulos = Array.isArray(body.modulos) ? body.modulos : u.modulos;
        if (body.ativo === false || body.modulos) protegerUltimoAdmin(u, body.ativo === false ? [] : novosModulos);
        Object.assign(u, {
          nome: body.nome ?? u.nome,
          email: body.email ? String(body.email).trim() : u.email,
          perfil: body.perfil ?? u.perfil,
          modulos: novosModulos,
          ativo: body.ativo ?? u.ativo,
          atualizadoEm: new Date().toISOString(),
        });
        if (body.senha) u.senhaHash = hashSenha(body.senha);
        // sessões de usuário desativado caem na hora
        if (u.ativo === false) {
          for (const [t, s] of Object.entries(db.sessoes)) if (s.usuarioId === u.id) delete db.sessoes[t];
        }
        save();
        return publico(u);
      },
    },
    {
      method: 'DELETE',
      path: '/usuarios/:id',
      handler: ({ req, params }) => {
        const { usuario: eu } = exigirAdmin(req);
        if (eu.id === params.id) throw new ApiError(409, 'Você não pode excluir o próprio usuário logado.');
        const u = db.usuarios.find((x) => x.id === params.id);
        if (!u) throw new ApiError(404, 'Usuário não encontrado.');
        protegerUltimoAdmin(u, [], true);
        db.usuarios = db.usuarios.filter((x) => x.id !== params.id);
        for (const [t, s] of Object.entries(db.sessoes)) if (s.usuarioId === params.id) delete db.sessoes[t];
        save();
        return { ok: true };
      },
    },
  ],
});
