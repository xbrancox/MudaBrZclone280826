/* ============================================================
   MUDABRASIL - INTEGRAÇÃO SENADO FEDERAL
   ------------------------------------------------------------
   Busca dados de senadores da Federação pelos Dados Abertos
   (legis.senado.leg.br / dadosabertos.senado.leg.br).

   Estratégia: tenta JSON primeiro, depois XML (parse manual),
   fallback gracioso se WAF/403 bloquear (comum neste ambiente).
   Zero dependências — usa o fetch global do Node.

   Fonte: Senado Federal — Dados Abertos
   ============================================================ */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SENADO_FILE = path.join(DATA_DIR, 'senadores.json');
const API_BASE = 'https://legis.senado.leg.br/dadosabertos';
const UA = 'MudaBrasil/1.0 (plataforma civica; dados abertos)';

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/* Tenta o endpoint .json (formato=json) */
async function fetchSenadoresJson() {
  try {
    const res = await fetch(`${API_BASE}/senador/lista/atual?formato=json`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    // A API pode devolver {senadores: [...]} ou apenas [...]
    const lista = json.senadores || json._senadores || json || [];
    if (Array.isArray(lista) && lista.length > 0) {
      return lista.map(normalizeSenador).map(s => ({ ...s, source: 'senado' }));
    }
    return [];
  } catch (e) {
    console.warn('[senado] JSON endpoint falhou:', e.message);
    return null; // diferenciado: sinaliza "teve erro" vs "vazio"
  }
}

/* Parse XML simples sem dependências externas */
function parseSimpleXML(text) {
  const result = [];
  // <senador> ... </senador>
  const regexSenador = /<senador[^>]*>([\s\S]*?)<\/senador>/gi;
  let match;
  while ((match = regexSenador.exec(text)) !== null) {
    const corpo = match[1];
    const normalize = (tag) => {
      const rx = new RegExp(`<${tag}[^>]*>([\s\S]*?)<\/${tag}>`, 'i');
      const m = rx.exec(corpo);
      return m ? m[1].trim() : null;
    };
    result.push({
      nome: normalize('nome') || null,
      uf: normalize('estado') || normalize('siglaUf') || null,
      partido: normalize('siglaPartido') || normalize('partido') || null,
      email: normalize('email') || null,
      uri: normalize('uri') || null
    });
  }
  return result;
}

/* Tenta o endpoint XML bruto */
async function fetchSenadoresXml() {
  try {
    const res = await fetch(`${API_BASE}/senador/lista/atual`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/xml' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const raw = parseSimpleXML(text);
    if (raw && raw.length > 0) {
      return raw.map(normalizeSenador).map(s => ({ ...s, source: 'senado' }));
    }
    return [];
  } catch (e) {
    console.warn('[senado] XML endpoint falhou:', e.message);
    return null;
  }
}

/* Normaliza um senador bruto para o schema unificado do frontend */
function normalizeSenador(s) {
  return {
    id: 'senado-' + (s.uri ? s.uri.replace(/^.*\\/, '') : 'desconhecido'),
    source: 'senado',
    name: s.name || s.nome || 'Senador',
    party: s.party || s.partido || 'Sem Partido',
    partyName: s.party || s.partido || 'Sem Partido',
    number: null,
    age: null,
    education: null,
    state: s.state || s.uf || s.siglaUf || null,
    position: 'Senador Federal',
    termCount: null,
    votesLastElection: null,
    annualIncome: null,
    assets: null,
    billsAuthored: null,
    billsApproved: null,
    attendanceRate: null,
    lawsuits: null,
    transparencyScore: null,
    focusArea: null,
    bio: null,
    photo: s.photo || null,
    email: s.email || null,
    legislatura: null,
    dataSources: ['Senado Federal (dados abertos)'],
    hasFullData: false
  };
}

async function fetchSenadores({ force = false } = {}) {
  ensureDirs();
  // Primeiro tenta cache
  if (!force && fs.existsSync(SENADO_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(SENADO_FILE, 'utf8'));
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return { list: cached, fromCache: true, count: cached.length };
      }
    } catch (_) { /* cache corrompido -> rebusca */ }
  }

  // Tenta JSON primeiro
  const jsonResult = await fetchSenadoresJson();
  if (jsonResult && jsonResult.length > 0) {
    fs.writeFileSync(SENADO_FILE, JSON.stringify(jsonResult, null, 2));
    return { list: jsonResult, fromCache: false, count: jsonResult.length };
  }

  // Fallback: tenta XML
  const xmlResult = await fetchSenadoresXml();
  if (xmlResult && xmlResult.length > 0) {
    fs.writeFileSync(SENADO_FILE, JSON.stringify(xmlResult, null, 2));
    return { list: xmlResult, fromCache: false, count: xmlResult.length };
  }

  // Fallback final: tentar cache "zumbi" (último conhecido) se existir
  console.info('[senado] APIs indisponíveis — usando dados Câmara apenas.');
  return { list: [], fromCache: false, count: 0, note: 'senado-bloqueado' };
}

module.exports = { fetchSenadores, normalizeSenador, DATA_DIR, SENADO_FILE };