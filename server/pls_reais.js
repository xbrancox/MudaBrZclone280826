/* ============================================================
   MUDABRASIL — PLs REAIS DA CÂMARA (aba "PLs no Congresso")
   ------------------------------------------------------------
   Busca os projetos de lei (PL) reais mais recentes da API de
   Dados Abertos da Câmara, com autor de cada um, e devolve no
   formato interno da plataforma.

   - Cache local de 24h (server/data/pls_reais.json)
   - Id estável "pl-camara-{id}" preserva contagens de voto
     (upsertPl não zera approval/rejection no conflito)
   - Qualquer falha lança erro — o chamador cai no fallback
     (seed local), e a página nunca fica vazia.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CACHE_FILE = path.join(DATA_DIR, 'pls_reais.json');
const TTL_MS = 24 * 3600 * 1000;
const UA = 'MudaBrasil/1.0 (plataforma civica de transparencia; dados abertos)';
const QTDE = 30;

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' em ' + url);
  return res.json();
}

function readCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c && c.ts && (Date.now() - c.ts) < TTL_MS && Array.isArray(c.pls)) return c.pls;
  } catch (_) { /* sem cache */ }
  return null;
}

function writeCache(pls) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ ts: Date.now(), pls }));
  } catch (_) { /* cache é best-effort */ }
}

async function fetchAutores(proposicaoId) {
  try {
    const d = await getJson('https://dadosabertos.camara.leg.br/api/v2/proposicoes/' + encodeURIComponent(proposicaoId) + '/autores');
    const a = (d.dados || [])[0] || {};
    return {
      author: a.nome || 'Autoria não informada',
      party: a.siglaPartido || null,
      uf: a.siglaUf || null
    };
  } catch (_) {
    return { author: 'Autoria não informada', party: null, uf: null };
  }
}

async function fetchRealPls({ force = false } = {}) {
  if (!force) {
    const cached = readCache();
    if (cached) return cached;
  }
  const ano = new Date().getFullYear();
  const d = await getJson('https://dadosabertos.camara.leg.br/api/v2/proposicoes?siglaTipo=PL&ano=' + ano +
    '&ordenarPor=id&ordem=DESC&itens=' + QTDE);
  const lista = (d.dados || []).slice(0, QTDE);
  if (!lista.length) throw new Error('Câmara não retornou PLs para ' + ano);

  const pls = [];
  for (const p of lista) {
    const aut = await fetchAutores(p.id);
    pls.push({
      id: 'pl-camara-' + p.id,
      camaraId: String(p.id),
      number: p.numero + '/' + p.ano,
      year: p.ano,
      author: aut.author,
      party: aut.party,
      uf: aut.uf,
      title: (p.ementa || '').slice(0, 160),
      ementa: p.ementa || '',
      status: (p.status && (p.status.descricaoTramitacao || p.status.descricaoSituacao)) || 'Tramitando',
      chamber: 'Câmara',
      tema: p.tema || null,
      url: 'https://www.camara.leg.br/proposicoesweb/fichadetalhamento?idProposicao=' + p.id
    });
    await new Promise(r => setTimeout(r, 120));
  }
  writeCache(pls);
  return pls;
}

module.exports = { fetchRealPls };
