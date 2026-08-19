/* ============================================================
   MUDABRASIL - MOTOR DE VOTO CONTÍNUO E REVOGÁVEL
   ------------------------------------------------------------
   O coração da plataforma: um "termômetro de confiança" em que o
   cidadão expressa VOTO DE CONFIANÇA em um parlamentar e pode
   REVOGÁ-LO a qualquer momento ("Seu voto coloca, seu voto tira").

   DECISÕES DE PROJETO (regras inegociáveis do fundador):
   - ANONIMATO / ANTI-COERÇÃO (R1, R6, LGPD): o sistema NUNCA liga
     um cidadão a um voto na visão pública. O único vínculo é um
     CÓDIGO (R4) gerado UMA vez e mostrado só UMA vez ao eleitor.
     O servidor guarda apenas o HASH do código (nunca o bruto).
     A agregação (termômetro) é irreversível: ninguém — nem o
     próprio servidor — descobre "quem votou em quem".
   - DECAIMENTO: o voto nunca morre, só esfria (peso cheio até
     90 dias → linear até o piso 0,5 aos 180 dias). Reafirmar
     ("manter meu voto") reinicia a contagem.
   - SEM PEDIDO DE VOTO: a API é neutra; a pressão de campanha é
     responsabilidade da UI (que também deve ser neutra).
   - ANTI-BRIGADA: rate-limit em memória por IP (riscos citados na
     visão do fundador: manipulação por brigadas / fake votes).

   Sem dependências de npm (http, fs, crypto do Node 18+).
   Persistência em server/db.js: SQLite nativo do Node (node:sqlite,
   Node 22.5+) com fallback automático para arquivo JSON atômico —
   cada cédula é um registro autônomo (fonte de verdade: o banco).
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetchDeputados } = require('./ingest');
const db = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const VOTOS_FILE = db.VOTOS_FILE;
const VOTOS_DB = db.VOTOS_DB;
const SALT_FILE = path.join(DATA_DIR, '.salt');

/* ---- Configuração pública (espelha o contrato do config.js) ---- */
const DECADENCIA = { cheioDias: 90, pisoDias: 180, piso: 0.5 };
const ICM = {
  versao: 'v1.0',
  vigenteDesde: '2026-08-18',
  // Pesos oficiais do ICM. Neste protótipo calculamos o COMPONENTE
  // de confiança (votos); resposta/cumprimento entram quando as
  // fontes (TSE/Transparência/Radar) forem conectadas.
  pesos: { resposta: 0.40, cumprimento: 0.35, devolucao: 0.25 }
};
// Constante de saturação do índice (0-100). Quanto maior K, mais
// "difícil" chega ao topo — mantém o índice estável e comparável.
const K_SATURACAO = 100;

/* ---- Rate-limit em memória (anti-brigada) ---- */
const RATE_LIMIT = { max: 20, windowMs: 60 * 1000 }; // 20 ações/min/IP
const rateBuckets = new Map(); // ip -> { count, resetAt }

/* ---- Hook de mudança (para tempo real / SSE) ----
   O servidor registra um callback que é invocado a cada
   escrita bem-sucedida, para notificar os clientes conectados
   ao /api/stream sem expor nada além de totais agregados. */
let voteChangeHook = null;
function onVoteChange(fn) { voteChangeHook = fn; }
function notifyChange(tipo) {
  if (typeof voteChangeHook === 'function') {
    try { voteChangeHook({ tipo, ts: new Date().toISOString() }); } catch (_) { /* sem efeito colateral */ }
  }
}

/** Contagens leves de ativos/revogados (para o broadcast SSE). */
function totals() {
  const store = loadStore();
  let ativos = 0, revogados = 0;
  for (const b of Object.values(store.ballots)) { b.revoked ? revogados++ : ativos++; }
  return { totalVotosAtivos: ativos, totalRevogados: revogados };
}

function checkRateLimit(ip, action) {
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT.windowMs };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT.max) {
    return { allowed: false, retryAfterMs: bucket.resetAt - now, action };
  }
  return { allowed: true };
}

/* ---- Salvo do servidor (gerado uma vez, persistido) ---- */
function ensureSalt() {
  if (fs.existsSync(SALT_FILE)) {
    const s = fs.readFileSync(SALT_FILE, 'utf8').trim();
    if (s) return s;
  }
  const salt = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SALT_FILE, salt, { mode: 0o600 });
  return salt;
}
const SALT = ensureSalt();

/** Hash do código de verificação (o bruto nunca é persistido). */
function hashCode(code) {
  return crypto.createHash('sha256').update(String(code) + SALT).digest('hex');
}

/** Gera um código legível por humano, criptograficamente aleatório. */
function generateCode() {
  // Alfabeto sem caracteres ambíguos (0/O, 1/I/L) + 16 chars
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) code += alphabet[bytes[i] % alphabet.length];
  // Formata em grupos: XXXX-XXXX-XXXX-XXXX
  return code.replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

/* ---- Persistência (via camada db: SQLite ou JSON) ---- */
function loadStore() {
  return { ballots: db.readAll() };
}

/* ---- Índice parlamentar (id -> dados), cache em memória ---- */
let deputiesIndex = null; // Map<id, {id,name,party,state,photo}>
async function getDeputiesIndex() {
  if (deputiesIndex) return deputiesIndex;
  const { list } = await fetchDeputados();
  const map = new Map();
  list.forEach(d => map.set(d.id, {
    id: d.id, name: d.name, party: d.party, state: d.state, photo: d.photo || null
  }));
  deputiesIndex = map;
  return map;
}

/* ---- Decaimento do voto ---- */
const MS_DIA = 86400000;
/**
 * Peso efetivo do voto com o tempo (voto esfria, não morre).
 * @param {number} anchor - epoch ms da última reafirmação (ou criação)
 * @param {number} [now]  - epoch ms de referência (padrão: agora)
 */
function voteWeight(anchor, now = Date.now()) {
  const days = Math.max(0, (now - anchor) / MS_DIA);
  const { cheioDias, pisoDias, piso } = DECADENCIA;
  if (days <= cheioDias) return 1.0;
  if (days >= pisoDias) return piso;
  const t = (days - cheioDias) / (pisoDias - cheioDias); // 0..1
  return 1.0 - (1.0 - piso) * t; // linear 1.0 -> piso
}

/* ============================================================
   OPERAÇÕES (usadas pelo server/index.js)
   ============================================================ */

/**
 * Registra um VOTO DE CONFIANÇA.
 * @param {{politicianId:string, uf?:string}} input
 * @param {string} ip - apenas p/ rate-limit (NÃO persistido)
 * @returns {Promise<{ok:true, code:string, ballotId:string, politician:object}|{ok:false,error:string,status:number}>}
 */
async function castVote(input, ip) {
  const rl = checkRateLimit(ip, 'cast');
  if (!rl.allowed) return { ok: false, status: 429, error: 'Muitas ações em pouco tempo. Aguarde um instante.' };

  const politicianId = String(input.politicianId || '').trim();
  if (!politicianId) return { ok: false, status: 400, error: 'politicianId é obrigatório' };

  const index = await getDeputiesIndex();
  const politician = index.get(politicianId);
  if (!politician) return { ok: false, status: 404, error: 'Parlamentar não encontrado' };

  const code = generateCode();
  const now = Date.now();
  const ballotId = hashCode(code);
  const ballot = {
    ballotId,
    politicianId,
    uf: input.uf ? String(input.uf).toUpperCase().slice(0, 2) : null,
    createdAt: now,
    reaffirmedAt: now, // âncora do decaimento
    revoked: false,
    revokedAt: null
  };
  db.upsert(ballot);
  notifyChange('voto');

  // Retorna o código UMA vez (nunca mais). O eleitor deve guardá-lo.
  return { ok: true, code, ballotId, politician };
}

/**
 * REVOGA um voto (o eleitor "tira de volta"). Requer o código.
 * A revogação é irreversível e anônima na agregação.
 */
function revokeVote(code, ip) {
  const rl = checkRateLimit(ip, 'revoke');
  if (!rl.allowed) return { ok: false, status: 429, error: 'Muitas ações em pouco tempo. Aguarde um instante.' };

  const ballotId = hashCode(code);
  const ballot = db.get(ballotId);
  if (!ballot) return { ok: false, status: 404, error: 'Código inválido ou não encontrado' };
  if (ballot.revoked) return { ok: false, status: 409, error: 'Este voto já foi revogado' };

  ballot.revoked = true;
  ballot.revokedAt = Date.now();
  db.upsert(ballot);
  notifyChange('revogacao');
  return { ok: true, revoked: true, politicianId: ballot.politicianId };
}

/**
 * "MANTER MEU VOTO" — reafirma a confiança e reinicia o decaimento.
 * (Ritual da spec: voto >30 dias sem reconfirmação gera aviso local.)
 */
function reaffirmVote(code, ip) {
  const rl = checkRateLimit(ip, 'reaffirm');
  if (!rl.allowed) return { ok: false, status: 429, error: 'Muitas ações em pouco tempo. Aguarde um instante.' };

  const ballotId = hashCode(code);
  const ballot = db.get(ballotId);
  if (!ballot) return { ok: false, status: 404, error: 'Código inválido ou não encontrado' };
  if (ballot.revoked) return { ok: false, status: 409, error: 'Este voto já foi revogado e não pode ser reafirmado' };

  ballot.reaffirmedAt = Date.now();
  db.upsert(ballot);
  notifyChange('manutencao');
  return { ok: true, reaffirmedAt: ballot.reaffirmedAt };
}

/**
 * "VER MEU VOTO" — o eleitor consulta o próprio voto pelo código.
 * Retorna os dados; a UI aplica o mascaramento anti-print (R6).
 * NUNCA expõe identidade — só o vínculo do próprio eleitor.
 */
function viewVote(code) {
  const ballotId = hashCode(code);
  const ballot = db.get(ballotId);
  if (!ballot) return { ok: false, status: 404, error: 'Código inválido ou não encontrado' };

  const anchor = ballot.reaffirmedAt || ballot.createdAt;
  return {
    ok: true,
    ballot: {
      politicianId: ballot.politicianId,
      uf: ballot.uf,
      createdAt: ballot.createdAt,
      reaffirmedAt: ballot.reaffirmedAt,
      revoked: ballot.revoked,
      revokedAt: ballot.revokedAt,
      pesoAtual: round4(voteWeight(anchor)),
      diasDesdeReafirmacao: Math.floor((Date.now() - anchor) / MS_DIA),
      precisaReafirmar: (Date.now() - anchor) > 30 * MS_DIA && !ballot.revoked
    }
  };
}

/**
 * TERMÔMETRO — agregação pública e IRREVERSÍVEL.
 * Nunca mapeia código -> parlamentar. Só totais por parlamentar.
 */
async function getTermometro({ topN = 10 } = {}) {
  const store = loadStore();
  const now = Date.now();

  const index = await getDeputiesIndex();
  const byPolitician = new Map(); // id -> {votos, peso, revogacoes}
  let totalAtivos = 0, totalRevogados = 0;

  for (const b of Object.values(store.ballots)) {
    let bucket = byPolitician.get(b.politicianId);
    if (!bucket) { bucket = { votos: 0, peso: 0, revogacoes: 0 }; byPolitician.set(b.politicianId, bucket); }
    if (b.revoked) {
      bucket.revogacoes++;
      totalRevogados++;
    } else {
      const anchor = b.reaffirmedAt || b.createdAt;
      bucket.votos++;
      bucket.peso += voteWeight(anchor, now);
      totalAtivos++;
    }
  }

  const top = [];
  for (const [pid, agg] of byPolitician.entries()) {
    const pol = index.get(pid) || { id: pid, name: '(parlamentar)', party: '—', state: '—', photo: null };
    const indice = 100 * (agg.peso / (agg.peso + K_SATURACAO)); // saturação 0-100
    top.push({
      politicianId: pid,
      name: pol.name,
      party: pol.party,
      state: pol.state,
      photo: pol.photo,
      votosAtivos: agg.votos,
      revogacoes: agg.revogacoes,
      pesoEfetivo: round2(agg.peso),
      indice: round1(indice)
    });
  }
  top.sort((a, b) => b.indice - a.indice || b.votosAtivos - a.votosAtivos);

  return {
    mode: 'real',
    ok: true,
    metodo: 'Índice de Confiança MudaBrasil (ICM) — componente de confiança',
    icm: ICM,
    decadencia: DECADENCIA,
    atualizadoEm: new Date(now).toISOString(),
    totalVotosAtivos: totalAtivos,
    totalRevogados: totalRevogados,
    totalRegistros: totalAtivos + totalRevogados,
    topN: top.slice(0, topN),
    porIndice: top, // ranking completo (para gráficos/ordenação no cliente)
    tendencia: buildTendency(store, now),
    porUf: buildPorUf(store)
  };
}

/**
 * Tendência: confiança acumulada (votos ativos) por dia nos últimos N dias.
 * Para cada dia t, conta cédulas criadas até t e ainda vigentes em t
 * (não revogadas, ou revogadas depois de t).
 */
function buildTendency(store, now, dias = 30) {
  const ballots = Object.values(store.ballots);
  const out = [];
  for (let d = dias - 1; d >= 0; d--) {
    const t = now - d * MS_DIA;
    const dayStart = new Date(t); dayStart.setHours(0, 0, 0, 0);
    const ts = dayStart.getTime();
    let ativos = 0;
    for (const b of ballots) {
      if (b.createdAt > ts) continue; // ainda não tinha sido criada
      if (b.revoked && b.revokedAt <= ts) continue; // já tinha sido revogada
      ativos++;
    }
    out.push({ at: new Date(ts).toISOString().slice(0, 10), ativos });
  }
  return out;
}

function buildPorUf(store) {
  const porUf = {};
  for (const b of Object.values(store.ballots)) {
    if (b.revoked || !b.uf) continue;
    porUf[b.uf] = (porUf[b.uf] || 0) + 1;
  }
  return porUf;
}

/* ---- util ---- */
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

module.exports = {
  castVote, revokeVote, reaffirmVote, viewVote, getTermometro,
  voteWeight, onVoteChange, totals,
  DECADENCIA, ICM, K_SATURACAO, VOTOS_FILE, VOTOS_DB, db
};
