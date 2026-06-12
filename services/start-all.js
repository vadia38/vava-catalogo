// start-all.js — sobe todos os microserviços de uma vez (desenvolvimento).
// Em produção, cada serviço pode ser implantado e escalado separadamente.
//
// Executar: node services/start-all.js  (ou: npm start)

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));

const SERVICOS = [
  ['clientes', 3001],
  ['catalogo', 3002],
  ['estoque', 3003],
  ['tributario', 3004],
  ['pedidos', 3005],
  ['marketplaces', 3006],
  ['usuarios', 3007],
  ['gateway', 3000],
];

console.log('Iniciando microserviços Vava...\n');

const filhos = SERVICOS.map(([nome]) => {
  const proc = spawn(process.execPath, [path.join(base, nome, 'server.js')], {
    stdio: 'inherit',
    env: process.env,
  });
  proc.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[${nome}] encerrou com código ${code}`);
  });
  return proc;
});

console.log(`
┌──────────────────────────────────────────────────┐
│  Gateway (ponto de entrada) http://localhost:3000 │
│  clientes ............................ :3001      │
│  catalogo ............................ :3002      │
│  estoque ............................. :3003      │
│  tributario .......................... :3004      │
│  pedidos ............................. :3005      │
│  marketplaces ........................ :3006      │
│  usuarios (auth ERP) ................. :3007      │
│                                                   │
│  Loja: sirva a raiz do repositório por HTTP       │
│    npx serve .   (ou python3 -m http.server 8080) │
└──────────────────────────────────────────────────┘
Ctrl+C encerra todos os serviços.
`);

const encerrar = () => {
  for (const p of filhos) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
