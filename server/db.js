/* ============================================================
   MUDABRASIL — CAMADA DE ARMAZENAMENTO DE VOTOS
   ------------------------------------------------------------
   Abstrai a persistência das cédulas anônimas com dois backends:

   - SQLITE (padrão, Node 22.5+): banco nativo do Node
     (`node:sqlite`), zero dependências de npm, um arquivo
     `server/data/votos.db`.
   - JSON (fallback automático, Node 18–22.4): o arquivo
     `server/data/votos.json` com escrita atômica (tmp+rename).

   MIGRAÇÃO AUTOMÁTICA: na primeira inicialização em modo SQLite,
   se a urna .db está vazia e existe um votos.json legado com
   cédulas, todas são importadas (o arquivo JSON fica como
   backup histórico; a partir daí o .db é a fonte da verdade).

   A API é idêntica nos dois backends, por isso o motor de voto
   (votes.js) e os testes não precisam saber qual está ativo.
   Cédulas usam o MESMO formato dos dois mundos:
     { ballotId, politicianId, uf, createdAt, reaffirmedAt,
       revoked, revokedAt }   (datas em epoch ms)
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const VOTOS_DB = path.join(DATA_DIR, 'votos.db');
const VOTOS_FILE = path.join(DATA_DIR, 'votos.json');

/* ---- Detecção do backend (Node 22.5+ tem node:sqlite) ----
   MB_STORAGE pode forçar o backend: 'sqlite', 'json' ou 'auto'
   (padrão). Útil em testes e em ambientes sem node:sqlite. */
const FORCED = process.env.MB_STORAGE; // 'sqlite' | 'json' | undefined
let DatabaseSync = null;
if (FORCED !== 'json') {
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) { /* Node antigo → JSON */ }
}
if (FORCED === 'sqlite' && !DatabaseSync) {
  throw new Error('MB_STORAGE=sqlite foi pedido, mas node:sqlite não existe neste Node (use Node 22.5+)');
}
const BACKEND = DatabaseSync ? 'sqlite' : 'json';

let db = null;      // instância DatabaseSync (somente sqlite)
let inited = false; // init() já executado (migração em 1ª execução)

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

/* ============================================================
   BACKEND JSON (fallback)
   ============================================================ */
function jsonRead() {
  try {
    const raw = JSON.parse(fs.readFileSync(VOTOS_FILE, 'utf8'));
    if (raw && typeof raw.ballots === 'object' && raw.ballots) return raw.ballots;
  } catch (_) { /* ausente ou corrompido → urna vazia */ }
  return {};
}
function jsonWriteAll(ballots) {
  ensureDir();
  const store = {
    updatedAt: new Date().toISOString(),
    ballots,
    meta: { created: new Date().toISOString() }
  };
  const tmp = VOTOS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, VOTOS_FILE); // escrita atômica
}

/* ============================================================
   BACKEND SQLITE (padrão)
   ============================================================ */
function openSqlite() {
  if (db) return;
  ensureDir();
  db = new DatabaseSync(VOTOS_DB);
  // tolera o outro processo (servidor vs. testes) segurar o lock
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ballots (
      id             TEXT PRIMARY KEY,
      politician_id  TEXT NOT NULL,
      uf             TEXT,
      created_at     INTEGER NOT NULL,
      reaffirmed_at  INTEGER,
      revoked        INTEGER NOT NULL DEFAULT 0,
      revoked_at     INTEGER,
      updated_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_ballots_politician ON ballots(politician_id);
  `);
}
const rowToBallot = r => ({
  ballotId: r.id,
  politicianId: r.politician_id,
  uf: r.uf,
  createdAt: r.created_at,
  reaffirmedAt: r.reaffirmed_at,
  revoked: !!r.revoked,
  revokedAt: r.revoked_at
});
const ballotParams = b => [
  b.ballotId, b.politicianId, b.uf || null,
  b.createdAt, b.reaffirmedAt || null,
  b.revoked ? 1 : 0, b.revokedAt || null, Date.now()
];
const UPSERT_SQL = `
  INSERT INTO ballots (id, politician_id, uf, created_at, reaffirmed_at, revoked, revoked_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    politician_id  = excluded.politician_id,
    uf             = excluded.uf,
    created_at     = excluded.created_at,
    reaffirmed_at  = excluded.reaffirmed_at,
    revoked        = excluded.revoked,
    revoked_at     = excluded.revoked_at,
    updated_at     = excluded.updated_at`;

/* ============================================================
   API PÚBLICA (idêntica nos dois backends)
   ============================================================ */

/**
 * Inicializa o backend e, no SQLite, roda a migração única
 * legado JSON → banco. Idempotente — chame no boot do servidor.
 * @returns {{backend:string, migrated:number}}
 */
function init() {
  if (inited) return { backend: BACKEND, migrated: 0 };
  inited = true;
  let migrated = 0;
  if (BACKEND === 'sqlite') {
    openSqlite();
    const n = db.prepare('SELECT COUNT(*) AS n FROM ballots').get().n;
    if (n === 0) {
      const legacy = jsonRead();
      const list = Object.values(legacy);
      if (list.length) {
        importAll(legacy);
        migrated = list.length;
      }
    }
  }
  return { backend: BACKEND, migrated };
}

/** Busca uma cédula pelo id (hash do código). Null se não existir. */
function get(id) {
  if (BACKEND === 'sqlite') {
    openSqlite();
    const r = db.prepare('SELECT * FROM ballots WHERE id = ?').get(id);
    return r ? rowToBallot(r) : null;
  }
  return jsonRead()[id] || null;
}

/** Insere ou atualiza UMA cédula (todas as escritas do motor). */
function upsert(ballot) {
  if (BACKEND === 'sqlite') {
    openSqlite();
    db.prepare(UPSERT_SQL).run(...ballotParams(ballot));
    return;
  }
  const all = jsonRead();
  all[ballot.ballotId] = ballot;
  jsonWriteAll(all);
}

/** Lê TODAS as cédulas (objeto key→cédula). Usado na agregação. */
function readAll() {
  if (BACKEND === 'sqlite') {
    openSqlite();
    const out = {};
    for (const r of db.prepare('SELECT * FROM ballots').all()) out[r.id] = rowToBallot(r);
    return out;
  }
  return jsonRead();
}

/** Total de cédulas na urna. */
function count() {
  if (BACKEND === 'sqlite') {
    openSqlite();
    return db.prepare('SELECT COUNT(*) AS n FROM ballots').get().n;
  }
  return Object.keys(jsonRead()).length;
}

/** Esvazia a urna (também remove o JSON legado no SQLite, para
    ele não "ressuscitar" via migração numa inicialização nova). */
function clear() {
  if (BACKEND === 'sqlite') {
    openSqlite();
    db.exec('DELETE FROM ballots');
  }
  try { fs.unlinkSync(VOTOS_FILE); } catch (_) { /* não existia */ }
}

/**
 * Substitui o conteúdo inteiro da urna pelas cédulas dadas
 * (usado na migração automática e nos testes — a mesma camada
 * de armazenamento do servidor, sem rota "de costas" na API).
 */
function importAll(ballotsObj) {
  if (BACKEND === 'sqlite') {
    openSqlite();
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM ballots');
      const ins = db.prepare(UPSERT_SQL);
      for (const b of Object.values(ballotsObj || {})) ins.run(...ballotParams(b));
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* já falhou */ }
      throw e;
    }
    return;
  }
  jsonWriteAll(ballotsObj || {});
}

/** Fecha o banco (usado nos testes). */
function close() {
  if (BACKEND === 'sqlite' && db) { try { db.close(); } catch (_) {} }
  db = null;
  inited = false;
}

function backend() { return BACKEND; }
function file() { return BACKEND === 'sqlite' ? VOTOS_DB : VOTOS_FILE; }

module.exports = {
  init, get, upsert, readAll, count, clear, importAll, close,
  backend, file,
  VOTOS_DB, VOTOS_FILE
};
