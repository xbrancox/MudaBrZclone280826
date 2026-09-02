/* ============================================================
   MUDABRASIL - SERVIDOR (frontend + API de dados públicos + VOTO)
   ------------------------------------------------------------
   Um único comando sobe o site inteiro e a API:

       node server/index.js
       → http://localhost:8080

   Rotas de DADOS PÚBLICOS:
     GET /api/candidatos          lista de candidatos (dados reais)
                                  ?busca=&uf=&partido=&ordem=&refresh=1
     GET /api/candidatos/:id      detalhe + enriquecimento sob demanda
     GET /api/status              metadados da fonte (origem, modo)

   Rotas de VOTO (motor de voto contínuo e revogável):
     POST /api/voto               registrar voto de confiança → {code}
     POST /api/voto/revogar       revogar voto (código)
     POST /api/voto/manter        reafirmar ("manter meu voto")
     GET  /api/voto?code=         ver meu voto (mascarado na UI)
     GET  /api/termometro         agregação pública irreversível
     GET  /api/stream             SSE: eventos ao vivo (novos votos, etc.)
     GET  /api/health             saúde do serviço (uptime, storage, totais)

   O frontend continua funcionando 100% estático: se a API não
   responder (ex.: aberto via file://), ele usa o modo DEMO com
   dados sintéticos embutidos. Sem dependências de npm.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { fetchDeputados, enrichBills, readEnrichCache, enrichAllDeputies, DEP_FILE } = require('./ingest');
const { fetchSenadores, SENADO_FILE } = require('./senado');
const votes = require('./votes');
const db = require('./db');
const auth = require('./auth');
const verificacao = require('./verificacao');
const reclamacoes = require('./reclamacoes');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 8080;

/* ---- Armazenamento de votos (SQLite nativo; JSON em Node antigo) ---- */
const { migrated } = db.init();
const STORAGE_LABEL = db.backend() === 'sqlite'
  ? 'SQLite nativo (votos.db)'
  : 'arquivo JSON (votos.json — Node sem node:sqlite)';

/* ---- Atualização automática dos dados públicos (cron in-process) ----
   Rebusca a Câmara a cada N horas (MB_REFRESH_HOURS, padrão 24).
   .unref() impede que o timer segure o processo aberto em testes. */
const REFRESH_HOURS = Math.max(1, parseInt(process.env.MB_REFRESH_HOURS, 10) || 24);
setInterval(() => {
  fetchDeputados({ force: true })
    .then(r => console.log('[auto] dados públicos atualizados: ' + r.count + ' deputados'))
    .catch(e => console.error('[auto] falha na atualização agendada: ' + e.message));
  fetchSenadores({ force: true })
    .then(r => console.log('[auto] dados do Senado atualizados: ' + r.count + ' senadores'))
    .catch(e => console.error('[auto] falha na atualização do Senado: ' + e.message));
}, REFRESH_HOURS * 3600 * 1000).unref();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2'
};

/* Headers de segurança/privacidade aplicados a todas as respostas JSON:
   nosniff impede reinterpretação de MIME; no-referrer garante que a
   origem nunca vaza para redirecionamentos (ética de anonimato). */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function sendJson(res, status, obj, methods = 'GET, POST, OPTIONS') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': SEC_HEADERS['X-Content-Type-Options'],
    'Referrer-Policy': SEC_HEADERS['Referrer-Policy']
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1024 * 64) { req.destroy(); reject(new Error('Body muito grande')); } });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON invalido: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

/** Lê e faz parse do body (JSON) de uma requisição POST. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('Payload muito grande')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (_) { reject(new Error('JSON inválido no body')); }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'desconhecido';
}

/* ---------- Tempo real (SSE) ----------
   Clientes conectados em /api/stream recebem, a cada escrita
   bem-sucedida no motor de voto, um evento "termometro" com
   apenas TOTAIS agregados (nunca identifica quem votou em
   quem). O cliente, ao receber o evento, refaz o GET
   /api/termometro completo. */
const streamClients = new Set();

votes.onVoteChange(info => {
  const payload = Object.assign({}, info, votes.totals());
  const frame = 'event: termometro\ndata: ' + JSON.stringify(payload) + '\n\n';
  for (const client of streamClients) {
    try { client.write(frame); } catch (_) { streamClients.delete(client); }
  }
});

/**
 * Aplica busca + filtros + ordenação sobre a lista. Null-safe:
 * campos ausentes (nulos) não quebram a ordenação.
 */
function applyQuery(list, q) {
  let out = list;
  const busca = (q.busca || '').toLowerCase().trim();
  if (busca) {
    out = out.filter(c =>
      (c.name || '').toLowerCase().includes(busca) ||
      (c.party || '').toLowerCase().includes(busca) ||
      (c.state || '').toLowerCase().includes(busca) ||
      (c.focusArea || '').toLowerCase().includes(busca)
    );
  }
  if (q.uf && q.uf !== 'all') out = out.filter(c => c.state === q.uf);
  if (q.partido && q.partido !== 'all') out = out.filter(c => c.party === q.partido);

  const [field, order] = (q.ordem || 'name:asc').split(':');
  const dir = order === 'desc' ? -1 : 1;
  out = [...out].sort((a, b) => {
    let va = a[field], vb = b[field];
    const aNull = va == null, bNull = vb == null;
    if (aNull && bNull) return 0;
    if (aNull) return 1;  // nulos sempre por último
    if (bNull) return -1;
    if (typeof va === 'string' || typeof vb === 'string') {
      return dir * String(va).localeCompare(String(vb), 'pt-BR');
    }
    return dir * (va - vb);
  });
  return out;
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const ip = clientIp(req);

  /* ---------- OPERAÇÃO ---------- */

  if (p === '/api/health') {
    let registros = 0;
    try { registros = db.countBallots(); } catch (_) { /* storage indisponível */ }
    return sendJson(res, 200, {
      ok: true,
      uptimeSec: Math.round(process.uptime()),
      storage: db.backend(),
      storageArquivo: db.file(),
      totalRegistros: registros,
      totalVotosAtivos: votes.totals().totalVotosAtivos,
      totalRevogados: votes.totals().totalRevogados,
      atualizacaoDadosPublicos: 'a cada ' + REFRESH_HOURS + 'h (automática)'
    });
  }

  /* ---------- DADOS PÚBLICOS ---------- */

  if (p === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      source: 'camara+senado',
      api: 'https://dadosabertos.camara.leg.br/api/v2',
      senadoApi: 'https://legis.senado.leg.br/dadosabertos',
      aviso: 'Os dados reais vêm das APIs abertas da Câmara dos Deputados e do Senado Federal. ' +
             'TSE, Portal da Transparência e CNJ são as fontes de produção ' +
             '(ver README.md).'
    });
  }

  if (p === '/api/senadores') {
    try {
      const { list, fromCache, count } = await fetchSenadores({ force: q.refresh === '1' });
      const senadores = applyQuery(list, q);
      return sendJson(res, 200, {
        mode: 'real',
        source: 'Senado Federal',
        total: count,
        retornados: senadores.length,
        doCache: fromCache,
        dataFonte: 'Dados Abertos do Senado Federal',
        senadores
      });
    } catch (e) {
      return sendJson(res, 502, {
        mode: 'error',
        source: 'Senado Federal',
        error: 'Falha ao buscar dados reais: ' + e.message,
        senadores: []
      });
    }
  }

  if (p === '/api/candidatos') {
    try {
      const [depResult, senResult] = await Promise.all([
        fetchDeputados({ force: q.refresh === '1' }),
        fetchSenadores({ force: q.refresh === '1' })
      ]);
      const deputados = depResult.list.map(d => ({ ...d, position: 'Deputado Federal' }));
      const senadores = senResult.list.map(s => ({ ...s, position: 'Senador Federal' }));
      const todos = [...deputados, ...senadores];
      // Estatísticas já enriquecidas (cache em disco) entram na listagem,
      // sem novas chamadas à API — cada card ganha "N PLs" quando disponível.
      for (const c of todos) {
        if (c.id && c.id.indexOf('camara-') === 0) {
          const enrich = readEnrichCache(c.id.slice(7));
          if (enrich && enrich.billsAuthored != null) {
            c.billsAuthored = enrich.billsAuthored;
            c.hasFullData = true;
          }
        }
      }
      const candidatos = applyQuery(todos, q);
      return sendJson(res, 200, {
        mode: 'real',
        source: 'Câmara dos Deputados + Senado Federal',
        total: todos.length,
        retornados: candidatos.length,
        doCache: depResult.fromCache && senResult.fromCache,
        atualizadoEm: new Date().toISOString(),
        candidatos,
        detalhes: {
          deputados: deputados.length,
          senadores: senadores.length
        }
      });
    } catch (e) {
      return sendJson(res, 502, {
        mode: 'error',
        source: 'Câmara dos Deputados + Senado Federal',
        error: 'Falha ao buscar dados reais: ' + e.message,
        candidatos: []
      });
    }
  }

  const m = p.match(/^\/api\/candidatos\/(camara-|senado-)?([\w-]+)$/);
  if (m && m[0] !== '/api/candidatos/comparar' && !p.startsWith('/api/candidatos/detalhes/')) {
    const id = m[0].replace('/api/candidatos/', '');
    try {
      // Busca em deputados e senadores (o id carrega o prefixo 'camara-' ou 'senado-')
      const [depResult, senResult] = await Promise.all([
        fetchDeputados(),
        fetchSenadores()
      ]);
      let cand = depResult.list.find(c => c.id === id);
      let fonte = 'Câmara dos Deputados';
      if (!cand) {
        cand = senResult.list.find(c => c.id === id);
        fonte = 'Senado Federal';
      }
      if (!cand) return sendJson(res, 404, { error: 'Candidato não encontrado' });

      if (id.startsWith('camara-')) {
        const camaraId = id.replace('camara-', '');
        const enrich = await enrichBills(camaraId);
        if (enrich && enrich.billsAuthored != null) {
          cand.billsAuthored = enrich.billsAuthored;
          cand.hasFullData = true;
        }
      }
      return sendJson(res, 200, { mode: 'real', source: fonte, candidato: cand });
    } catch (e) {
      return sendJson(res, 502, { error: e.message });
    }
  }

  /* ---------- VOTO CONTÍNUO E REVOGÁVEL ---------- */

  if (p === '/api/termometro' && req.method === 'GET') {
    try {
      return sendJson(res, 200, await votes.getTermometro({ topN: parseInt(q.top || '10', 10) }));
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'Falha ao computar termômetro: ' + e.message });
    }
  }

  if (p === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': SEC_HEADERS['X-Content-Type-Options'],
      'Referrer-Policy': SEC_HEADERS['Referrer-Policy']
    });
    res.write('retry: 10000\n\n');
    res.write('event: welcome\ndata: ' +
      JSON.stringify(Object.assign({ ok: true, ts: new Date().toISOString() }, votes.totals())) +
      '\n\n');
    streamClients.add(res);
    // Heartbeat mantém a conexão viva atrás de proxies/CDN.
    const heartbeat = setInterval(() => {
      try { res.write(':hb\n\n'); } catch (_) { /* cliente já foi */ }
    }, 30000);
    req.on('close', () => { clearInterval(heartbeat); streamClients.delete(res); });
    return;
  }

  if (p === '/api/voto' && req.method === 'GET') {
    const code = q.code || '';
    if (!code) return sendJson(res, 400, { ok: false, error: 'Parâmetro code é obrigatório' });
    const r = votes.viewVote(code.trim());
    if (r.ok) return sendJson(res, 200, r);
    return sendJson(res, r.status || 500, r);
  }

  if (p === '/api/voto' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await votes.castVote(body, ip);
      return sendJson(res, r.ok ? 201 : (r.status || 400), r);
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: 'Erro interno ao votar: ' + e.message });
    }
  }

  if (p === '/api/voto/revogar' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const code = String(body.code || '').trim();
    if (!code) return sendJson(res, 400, { ok: false, error: 'Código é obrigatório' });
    const r = votes.revokeVote(code, ip);
    return sendJson(res, r.ok ? 200 : (r.status || 400), r);
  }

  if (p === '/api/voto/manter' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const code = String(body.code || '').trim();
    if (!code) return sendJson(res, 400, { ok: false, error: 'Código é obrigatório' });
    const r = votes.reaffirmVote(code, ip);
    return sendJson(res, r.ok ? 200 : (r.status || 400), r);
  }

  /* ---------- AUTENTICAÇÃO (Google + Telefone) ---------- */

  if (p === '/api/auth/google' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.loginWithGoogle(body.idToken || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 401, { ok: false, error: e.message }); }
  }

  if (p === '/api/auth/otp/send' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.sendOtp(body.phone || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/auth/otp/verify' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.verifyOtp(body.phone || '', body.code || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 401, { ok: false, error: e.message }); }
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const token = q.sessionToken || (req.headers.authorization || '').replace('Bearer ', '');
    const voter = auth.getVoterFromToken(token);
    if (!voter) return sendJson(res, 401, { ok: false, error: 'Não autenticado' });
    return sendJson(res, 200, { ok: true, voter: { id: voter.id, method: voter.method, name: voter.name, photo: voter.photo, voterHash: voter.voterHash } });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const token = q.sessionToken || (req.headers.authorization || '').replace('Bearer ', '');
    auth.logout(token);
    return sendJson(res, 200, { ok: true });
  }

  /* ---------- E-MAIL AUTH ---------- */

  if (p === '/api/auth/email/send' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.sendEmailOtp(body.email || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/auth/email/verify' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.verifyEmailOtp(body.email || '', body.code || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 401, { ok: false, error: e.message }); }
  }

  if (p === '/api/auth/register' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = await auth.register(body.email || '', body.name || '', body.phone || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  /* ---------- VERIFICAÇÃO DE POLÍTICOS ---------- */
  /* ---------- VERIFICAÇÃO DE POLÍTICOS ---------- */

  if (p === '/api/verificacao/iniciar' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    try {
      const r = verificacao.startVerification(body.politicianId || '', body.email || '');
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/verificacao/confirmar' && req.method === 'GET') {
    const token = q.token || '';
    try {
      const r = verificacao.confirmVerification(token);
      return sendJson(res, 200, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/verificacao/dominios' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, dominios: verificacao.getAuthorizedDomains() });
  }

  if (p === '/api/verificacao/stats' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, stats: verificacao.getStats() });
  }

  if (p.startsWith('/api/verificacao/politico/') && req.method === 'GET') {
    const pid = decodeURIComponent(p.replace('/api/verificacao/politico/', ''));
    return sendJson(res, 200, { ok: true, details: verificacao.getVerificationDetails(pid), stats: reclamacoes.getPoliticianStats(pid) });
  }

  /* ---------- RECLAMAÇÕES, APOIOS, RESPOSTAS ---------- */

  if (p === '/api/reclamacoes' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const token = body.sessionToken || '';
    const voter = auth.getVoterFromToken(token);
    if (!voter) return sendJson(res, 401, { ok: false, error: 'Faça login para reclamar' });
    try {
      const r = reclamacoes.createComplaint({ politicianId: body.politicianId, voterHash: voter.voterHash, voterIp: ip, content: body.content });
      return sendJson(res, 201, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/reclamacoes' && req.method === 'GET') {
    const pid = q.politicianId;
    if (pid) {
      const list = reclamacoes.listComplaints(pid, { limit: parseInt(q.limit || 20), offset: parseInt(q.offset || 0) });
      return sendJson(res, 200, { ok: true, complaints: list });
    }
    const list = reclamacoes.listAllComplaints({ limit: parseInt(q.limit || 50), offset: parseInt(q.offset || 0) });
    return sendJson(res, 200, { ok: true, complaints: list, stats: reclamacoes.getGlobalStats() });
  }

  if (p === '/api/apoios' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const token = body.sessionToken || '';
    const voter = auth.getVoterFromToken(token);
    if (!voter) return sendJson(res, 401, { ok: false, error: 'Faça login para apoiar' });
    try {
      const r = reclamacoes.createSupport({ politicianId: body.politicianId, voterHash: voter.voterHash, voterIp: ip, content: body.content });
      return sendJson(res, 201, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/apoios' && req.method === 'GET') {
    const pid = q.politicianId;
    if (!pid) return sendJson(res, 400, { ok: false, error: 'politicianId é obrigatório' });
    const list = reclamacoes.listSupports(pid, { limit: parseInt(q.limit || 20), offset: parseInt(q.offset || 0) });
    return sendJson(res, 200, { ok: true, supports: list });
  }

  if (p === '/api/respostas' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
    const token = body.sessionToken || '';
    const voter = auth.getVoterFromToken(token);
    if (!voter) return sendJson(res, 401, { ok: false, error: 'Faça login' });
    try {
      const r = reclamacoes.createResponse({ complaintId: body.complaintId, politicianId: body.politicianId, content: body.content, sessionToken: token });
      return sendJson(res, 201, r);
    } catch (e) { return sendJson(res, 400, { ok: false, error: e.message }); }
  }

  if (p === '/api/rankings' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, rankings: reclamacoes.getRankings(), stats: reclamacoes.getGlobalStats() });
  }

  if (p.startsWith('/api/estatisticas/politico/') && req.method === 'GET') {
    const pid = decodeURIComponent(p.replace('/api/estatisticas/politico/', ''));
    return sendJson(res, 200, { ok: true, stats: reclamacoes.getPoliticianStats(pid) });
  }

  // === PLs - PROJETOS DE LEI ===
  if (p === '/api/pls' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const search = url.searchParams.get('q') || '';
    const party = url.searchParams.get('party') || '';
    const chamber = url.searchParams.get('chamber') || '';
    const list = Object.values(db.getPlsByFilters({ search, party, chamber, limit: 200 }));
    return sendJson(res, 200, { ok: true, total: list.length, pls: list });
  }

  if (p.startsWith('/api/pls/') && req.method === 'GET') {
    const id = decodeURIComponent(p.replace('/api/pls/', ''));
    const pl = db.getPl(id);
    if (!pl) return sendJson(res, 404, { error: 'PL nao encontrado' });
    return sendJson(res, 200, { ok: true, pl });
  }

  if (p === '/api/pls/voto' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { plId, vote, sessionToken } = body;
    if (!plId || !['aprovo', 'nao_aprovo'].includes(vote)) return sendJson(res, 400, { error: 'plId e vote (aprovo|nao_aprovo) sao obrigatorios' });
    const voter = auth.getVoterFromToken(sessionToken);
    if (!voter) return sendJson(res, 401, { error: 'Autenticacao necessaria para votar em PL' });
    const r = db.castPlVote(plId, voter.voterHash, vote);
    const pl = db.getPl(plId);
    return sendJson(res, 200, { ok: true, ...r, pl });
  }

  if (p === '/api/pls/meu-voto' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const plId = url.searchParams.get('plId');
    const sessionToken = url.searchParams.get('sessionToken') || url.searchParams.get('token');
    const voter = auth.getVoterFromToken(sessionToken);
    if (!voter || !plId) return sendJson(res, 200, { ok: true, vote: null });
    return sendJson(res, 200, { ok: true, vote: db.getPlVoteForVoter(plId, voter.voterHash) });
  }

  // === CÓDIGO DE VERIFICAÇÃO DE VOTO (Conferir Voto) ===
  if (p === '/api/voto/codigo' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { sessionToken } = body;
    const voter = auth.getVoterFromToken(sessionToken);
    if (!voter) return sendJson(res, 401, { error: 'Autenticacao necessaria' });
    const code = db.generateVoteCode(voter.voterHash);
    // Formata com espaços
    const formatted = code.match(/.{1,4}/g).join(' ');
    return sendJson(res, 200, { ok: true, code, formatted, voterHash: voter.voterHash });
  }

  if (p === '/api/voto/codigos' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const sessionToken = url.searchParams.get('sessionToken') || url.searchParams.get('token');
    const voter = auth.getVoterFromToken(sessionToken);
    if (!voter) return sendJson(res, 401, { error: 'Autenticacao necessaria' });
    const codes = db.getVoteCodesForVoter(voter.voterHash).map(c => ({
      ...c,
      formatted: c.code.match(/.{1,4}/g).join(' ')
    }));
    return sendJson(res, 200, { ok: true, codes });
  }

  if (p === '/api/voto/conferir' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const { code } = body;
    const r = db.verifyVoteCode(code);
    if (!r) return sendJson(res, 404, { error: 'Codigo nao encontrado' });
    // Retorna os votos ativos do eleitor
    const all = db.readAllBallots();
    const meusVotos = Object.values(all).filter(b => b.voterHash === r.voterHash || b.id.startsWith('voter-'));
    return sendJson(res, 200, { ok: true, code: r.code, voterHash: r.voterHash, votos: meusVotos });
  }

  // === DETALHES COMPLETOS DE CANDIDATO (fontes oficiais) ===
  if (p.startsWith('/api/candidatos/detalhes/') && req.method === 'GET') {
    const id = decodeURIComponent(p.replace('/api/candidatos/detalhes/', ''));
    const d = db.getPoliticianFullDetails(id);
    if (!d) return sendJson(res, 404, { error: 'Candidato nao encontrado' });
    return sendJson(res, 200, { ok: true, candidato: d });
  }

  // === COMPARAÇÃO (até 3 políticos) ===
  if (p === '/api/candidatos/comparar' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const ids = (body.ids || []).slice(0, 3);
    if (ids.length < 2) return sendJson(res, 400, { error: 'Selecione pelo menos 2 candidatos' });
    try {
      const [depResult, senResult] = await Promise.all([
        fetchDeputados(),
        fetchSenadores()
      ]);
      const all = [...depResult.list, ...senResult.list];
      const candidatos = ids
        .map(id => all.find(c => c.id === id))
        .filter(Boolean)
        .map(c => ({ ...c, ...db.getPoliticianFullDetails(c.id) }));
      if (candidatos.length < 2) return sendJson(res, 404, { error: 'Candidatos não encontrados' });
      return sendJson(res, 200, { ok: true, candidatos });
    } catch (e) {
      return sendJson(res, 500, { error: 'Falha ao comparar: ' + e.message });
    }
  }

  // === POLÍTICOS COM VOTOS REVOGADOS ===
  if (p === '/api/voto/revogados' && req.method === 'GET') {
    const stats = db.getRevokedStats();
    return sendJson(res, 200, { ok: true, total: stats.length, politicos: stats });
  }

  // === MEUS VOTOS (para revogar) ===
  if (p === '/api/voto/meus' && req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const sessionToken = url.searchParams.get('sessionToken') || url.searchParams.get('token');
    const voter = auth.getVoterFromToken(sessionToken);
    if (!voter) return sendJson(res, 401, { error: 'Autenticacao necessaria' });
    const all = db.readAllBallots();
    const meus = Object.values(all).filter(b => !b.revoked);
    // Enriquece com dados do político
    const enriched = meus.map(b => {
      const pol = db.getPolitician(b.politicianId);
      return { ...b, politician: pol };
    });
    return sendJson(res, 200, { ok: true, total: enriched.length, votos: enriched });
  }

  return sendJson(res, 404, { error: 'Rota de API não encontrada' });
}

function serveStatic(res, url) {
  let u = decodeURIComponent(url.pathname);
  if (u === '/') u = '/index.html';
  const safe = path.normalize(u).replace(/^(\.\.[/\\])+/, '');
  let fp = path.join(ROOT, safe);
  if (!fp.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 - Acesso negado');
  }
  if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
  if (!fs.existsSync(fp)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 - Não encontrado: ' + u);
  }
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': SEC_HEADERS['X-Content-Type-Options'],
    'Referrer-Policy': SEC_HEADERS['Referrer-Policy']
  });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(res, url);
  } catch (e) {
    return sendJson(res, 500, { error: 'Erro interno: ' + e.message });
  }
});

server.listen(PORT, () => {
  console.log('\n  🇧🇷  MudaBrasil rodando em  http://localhost:' + PORT + '\n');
  console.log('    Frontend:       http://localhost:' + PORT + '/');
  console.log('    Termômetro:     http://localhost:' + PORT + '/pages/termometro.html');
  console.log('    Candidatos:     http://localhost:' + PORT + '/pages/candidatos.html');
  console.log('    API (lista):    http://localhost:' + PORT + '/api/candidatos');
  console.log('    API (senadores): http://localhost:' + PORT + '/api/senadores');
  console.log('    API (voto):     POST http://localhost:' + PORT + '/api/voto');
  console.log('    API (termômetro):GET  http://localhost:' + PORT + '/api/termometro');
  console.log('    Tempo real:     GET  http://localhost:' + PORT + '/api/stream (SSE)');
  console.log('    Health:         GET  http://localhost:' + PORT + '/api/health\n');
  console.log('    Parlamentares:  http://localhost:' + PORT + '/pages/parlamentares.html');
  console.log('    Auth:           POST /api/auth/{google,otp/send,otp/verify,me,logout}');
  console.log('    Verificação:    /api/verificacao/{iniciar,confirmar,dominios,stats,politico/:id}');
  console.log('    Reclamações:    /api/{reclamacoes,apoios,respostas,rankings}');
  console.log('    Dados reais:    ' + DEP_FILE);
  console.log('    Senadores:      ' + SENADO_FILE);
  console.log('    Votos:          ' + db.file() + '  [' + STORAGE_LABEL + ']');
  if (migrated > 0) console.log('    Migração:       ' + migrated + ' cédulas importadas de votos.json → votos.db');
  console.log('    Atualização:    dados públicos a cada ' + REFRESH_HOURS + 'h (automática)');
  console.log('    Encerramento:   Ctrl+C / SIGTERM fecham o banco com segurança\n');
  // Pré-enriquecimento em background: popula o cache de proposições de
  // autoria dos deputados em ritmo suave (250ms entre chamadas), para os
  // cards da listagem exibirem "N PLs" sem esperar o usuário abrir o detalhe.
  enrichAllDeputies({ delayMs: 250 }).catch(err =>
    console.warn('[enrich] lote em segundo plano falhou: ' + err.message)
  );
});

/* ---- Encerramento gracioso ----
   Em SIGINT/SIGTERM (Ctrl+C, docker stop, systemctl stop) fecha o
   banco de forma ordenada antes de sair — nenhuma cédula perdida,
   nenhum arquivo corrompido. (No Windows, kill direto pelo processo
   ignora o handler; em Linux/Docker, que é o alvo de produção,
   o encerramento é limpo.) */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[server] ' + signal + ' recebido — encerrando com segurança…');
  try { db.close(); } catch (_) { /* já fechado */ }
  server.close(() => process.exit(0));
  // Rede de segurança: se conexões SSE mantiverem o servidor aberto,
  // sai de qualquer forma em 2 s.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
