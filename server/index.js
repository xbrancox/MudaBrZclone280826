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
const { fetchDeputados, enrichBills, DEP_FILE } = require('./ingest');
const votes = require('./votes');
const db = require('./db');

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
    try { registros = db.count(); } catch (_) { /* storage indisponível */ }
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
      source: 'camara',
      api: 'https://dadosabertos.camara.leg.br/api/v2',
      aviso: 'Os dados reais vêm da API aberta da Câmara dos Deputados. ' +
             'TSE, Portal da Transparência e CNJ são as fontes de produção ' +
             '(ver README.md).'
    });
  }

  if (p === '/api/candidatos') {
    try {
      const { list, fromCache, updatedAt, count } =
        await fetchDeputados({ force: q.refresh === '1' });
      const candidatos = applyQuery(list, q);
      return sendJson(res, 200, {
        mode: 'real',
        source: 'Câmara dos Deputados (dados reais)',
        total: count,
        retornados: candidatos.length,
        doCache: fromCache,
        atualizadoEm: updatedAt,
        candidatos
      });
    } catch (e) {
      return sendJson(res, 502, {
        mode: 'error',
        source: 'Câmara dos Deputados',
        error: 'Falha ao buscar dados reais: ' + e.message,
        candidatos: []
      });
    }
  }

  const m = p.match(/^\/api\/candidatos\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    try {
      const { list } = await fetchDeputados();
      const cand = list.find(c => c.id === id);
      if (!cand) return sendJson(res, 404, { error: 'Candidato não encontrado' });
      const camaraId = id.replace('camara-', '');
      const enrich = await enrichBills(camaraId);
      if (enrich && enrich.billsAuthored != null) {
        cand.billsAuthored = enrich.billsAuthored;
        cand.hasFullData = true;
      }
      return sendJson(res, 200, { mode: 'real', source: 'Câmara dos Deputados', candidato: cand });
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
  console.log('    API (voto):     POST http://localhost:' + PORT + '/api/voto');
  console.log('    API (termômetro):GET  http://localhost:' + PORT + '/api/termometro');
  console.log('    Tempo real:     GET  http://localhost:' + PORT + '/api/stream (SSE)');
  console.log('    Health:         GET  http://localhost:' + PORT + '/api/health\n');
  console.log('    Dados reais:    ' + DEP_FILE);
  console.log('    Votos:          ' + db.file() + '  [' + STORAGE_LABEL + ']');
  if (migrated > 0) console.log('    Migração:       ' + migrated + ' cédulas importadas de votos.json → votos.db');
  console.log('    Atualização:    dados públicos a cada ' + REFRESH_HOURS + 'h (automática)');
  console.log('    Encerramento:   Ctrl+C / SIGTERM fecham o banco com segurança\n');
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
