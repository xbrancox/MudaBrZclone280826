/* ============================================================
   MudaBrasil APP — lógica (vanilla, sem build)
   Telas: votar · apuração · radar · meu voto · menu (sem login — sessão anônima automática)
   Regras fixas: sem PLs no app; conferir/revogar só no site;
   radar resumido; dados ausentes = vazio honesto.
   ============================================================ */
'use strict';

const API = (window.MudaBrasil && window.MudaBrasil.API_BASE) || '';
const APP_V = '2.0.0';
const SITE_URL = (window.MudaBrasil && window.MudaBrasil.SERVIDO_PELO_BACKEND)
  ? location.origin
  : 'https://mudabrasil-redesign-production.up.railway.app';

/* cargos do app → códigos TSE (7=Dep.Estadual, 8=Dep.Distrital) */
const CARGOS = [
  { id: 'presidente',   nome: 'Presidente',       tse: [1], uf: false },
  { id: 'governador',   nome: 'Governador',       tse: [3], uf: true  },
  { id: 'senador',      nome: 'Senador',          tse: [5], uf: true  },
  { id: 'dep-federal',  nome: 'Deputado Federal', tse: [6], uf: true  },
  { id: 'dep-estadual', nome: 'Deputado Estadual',tse: [7, 8], uf: true }
];
const DK_CORES = ['#2ECC71', '#FFD700', '#4a90d9', '#ff7a6e'];
const COR_OUTROS = '#a78bfa';
const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
const AVATAR_CORES = ['#FFD700', '#4a90f0', '#2ECC71', '#ff9d8a', '#a78bfa', '#7dd3fc'];

const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hora = ts => new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/* armazenamento à prova de bloqueio: navegadores embutidos (Instagram,
   WhatsApp, Facebook) podem lançar erro ao tocar localStorage — se isso
   acontecesse no boot, o app inteiro morria e o botão ENTRAR ficava morto */
const memStore = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (_) { return (k in memStore) ? memStore[k] : null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (_) { memStore[k] = v; } },
  del(k) { try { localStorage.removeItem(k); } catch (_) { delete memStore[k]; } }
};

const state = {
  token: store.get('mb_app_token') || '',
  name: store.get('mb_app_name') || '',
  myVotes: {},                 // cargo → { politicianId, candidato }
  cargo: 'presidente',
  uf: store.get('mb_app_uf') || '',
  page: 1,
  totalPages: 1,
  apuTimer: null
};
const listState = { q: '', pagina: 1, totalPaginas: 1, items: [] };
if (window.__mblog) window.__mblog('app.js v4 carregado | token=' + (state.token ? 'sim' : 'não'));

/* ===== util ===== */
function initials(nome) {
  const p = String(nome || '?').trim().split(/\s+/).filter(w => w.length > 2);
  const a = (p[0] || nome || '?')[0], b = (p.length > 1 ? p[p.length - 1][0] : (p[0] || '')[1] || '');
  return (a + b).toUpperCase();
}
function avatarHTML(nome, foto, tam, corIdx) {
  const cor = AVATAR_CORES[(String(nome || '').length + (corIdx || 0)) % AVATAR_CORES.length];
  const img = foto ? `<img src="${esc(foto)}" alt="" onerror="this.remove()">` : '';
  return `<span class="avatar" style="width:${tam}px;height:${tam}px;background:${cor};font-size:${Math.round(tam * .32)}px">${img}${img ? '' : esc(initials(nome))}</span>`;
}
let toastTimer = null;
function toast(msg, tipo) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'on' + (tipo ? ' ' + tipo : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, tipo === 'err' ? 3400 : 2400);
}
function vibrate(pat) { try { if (navigator.vibrate) navigator.vibrate(pat); } catch (_) { } }

/* ===== sheet ===== */
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  const sh = $('#sheet');
  sh.classList.add('open');
  requestAnimationFrame(() => sh.classList.add('show'));
}
function closeSheet() {
  const sh = $('#sheet');
  sh.classList.remove('show');
  setTimeout(() => sh.classList.remove('open'), 160);
}
document.querySelector('#sheet .bk').addEventListener('click', closeSheet);

/* ===== api ===== */
async function api(path, opts) {
  opts = opts || {};
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let r, j;
  try {
    r = await fetch(API + path, Object.assign({}, opts, { headers }));
    j = await r.json();
  } catch (e) {
    return { ok: false, __status: 0, error: 'Sem conexão. Verifique a internet.' };
  }
  j.__status = r.status;
  return j;
}

/* ===== roteador ===== */
const TELAS = ['votar', 'apuracao', 'radar', 'meuvoto', 'menu', 'ajuda', 'sobre'];
function route() {
  const h = (location.hash || '#votar').replace('#', '');
  const tela = TELAS.includes(h) ? h : 'votar';
  TELAS.forEach(t => $('#s-' + t).classList.toggle('active', t === tela));
  /* ajuda/sobre abrem a partir do menu — mantém a aba Menu acesa na navegação */
  const navTela = (tela === 'ajuda' || tela === 'sobre') ? 'menu' : tela;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.go === navTela));
  if (tela === 'votar') renderVotar();
  if (tela === 'apuracao') refreshApuracao();
  if (tela === 'radar') carregarRadar();
  if (tela === 'meuvoto') renderMeuVoto();
  if (tela === 'menu') renderMenu();
  if (tela === 'ajuda') renderAjuda();
}
function go(tela) { location.hash = '#' + tela; }
window.addEventListener('hashchange', route);
document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ===== sessão anônima automática (sem tela de login) ===== */
let sessaoPromise = null;
function garantirSessao() {
  if (state.token) return Promise.resolve(true);
  if (!sessaoPromise) {
    sessaoPromise = (async () => {
      /* apelido salvo = mesmo histórico de votos; senão nasce um convidado novo */
      const apelido = store.get('mb_app_name') || ('Convidado-' + Math.floor(1000 + Math.random() * 9000));
      const r = await api('/api/auth/apelido', { method: 'POST', body: JSON.stringify({ apelido }) });
      if (r.ok) {
        state.token = r.sessionToken;
        state.name = r.voter.name;
        store.set('mb_app_token', state.token);
        store.set('mb_app_name', state.name);
        $('#whoName').textContent = state.name;
        if (window.__mblog) window.__mblog('sessão anônima ativa: ' + state.name);
        return true;
      }
      if (window.__mblog) window.__mblog('sessão automática falhou: status=' + r.__status + ' ' + (r.error || 'sem conexão'));
      return false;
    })();
    sessaoPromise.catch(() => { }).finally(() => { sessaoPromise = null; });
  }
  return sessaoPromise;
}

/* ===== meus votos ===== */
async function loadMeusVotos(tentouReautenticar) {
  if (!state.token) {
    if (!(await garantirSessao())) return;
  }
  const r = await api('/api/voto/cargo/meus');
  if (r.__status === 401) {
    /* sessão caiu (deploy recriou o banco): reautentica em silêncio e tenta de novo */
    state.token = ''; store.del('mb_app_token');
    if (!tentouReautenticar && await garantirSessao()) return loadMeusVotos(true);
    return;
  }
  if (!r.ok) return;
  state.myVotes = {};
  (r.votos || []).forEach(v => { state.myVotes[v.cargo] = v; });
  $('#whoName').textContent = state.name;
  if ($('#s-votar').classList.contains('active')) renderVotar();
  if ($('#s-meuvoto').classList.contains('active')) renderMeuVoto();
  updateProgress();
}
function countVotos() { return CARGOS.filter(c => state.myVotes[c.id]).length; }
function updateProgress() {
  const n = countVotos();
  $('#progTxt').textContent = n + ' de 5 cargos';
  $('#progBar').style.width = (n / 5 * 100) + '%';
}

/* ===== VOTAR ===== */
function renderChips() {
  $('#chips').innerHTML = CARGOS.map(c =>
    `<button class="chip${c.id === state.cargo ? ' active' : ''}" data-cargo="${c.id}">${c.nome}${state.myVotes[c.id] ? ' <span class="ok">✓</span>' : ''}</button>`
  ).join('');
  document.querySelectorAll('#chips .chip').forEach(ch =>
    ch.addEventListener('click', () => { state.cargo = ch.dataset.cargo; listState.pagina = 1; renderVotar(); }));
}
function cargoCfg(id) { return CARGOS.find(c => c.id === id); }
function tseCodeAtual() {
  const cfg = cargoCfg(state.cargo);
  if (!cfg.uf) return cfg.tse[0];
  if (cfg.id === 'dep-estadual') return state.uf === 'DF' ? 8 : 7;
  return cfg.tse[0];
}
function renderUfArea() {
  const cfg = cargoCfg(state.cargo);
  const area = $('#ufArea');
  if (!cfg.uf) { area.innerHTML = ''; return; }
  area.innerHTML = `<select class="ufer" id="selUf" aria-label="Escolha seu estado">
    <option value="" disabled ${state.uf ? '' : 'selected'}>Escolha seu estado</option>
    ${UFS.map(u => `<option value="${u}" ${u === state.uf ? 'selected' : ''}>${u}</option>`).join('')}
  </select>`;
  const sel = $('#selUf');
  sel.addEventListener('change', () => {
    state.uf = sel.value;
    store.set('mb_app_uf', state.uf);
    listState.pagina = 1;
    renderVotar();
  });
}
/* bloco de links "conferir em várias fontes" — o app registra opinião;
   a conferência de verdade fica no site completo e no TSE */
function linksConferir() {
  const a = (h, t) => `<a href="${h}" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600;white-space:nowrap">${t}</a>`;
  return `<div style="display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12.5px;margin-top:9px">
    ${a(SITE_URL + '/#conferir-voto', 'Conferir voto no site ↗')}
    ${a(SITE_URL + '/#revogar-voto', 'Revogar no site ↗')}
    ${a('https://divulgacandcontas.tse.jus.br/', 'Candidaturas no TSE ↗')}
  </div>`;
}
function renderVotadoBanner() {
  const box = $('#votadoBanner');
  const v = state.myVotes[state.cargo];
  const cfg = cargoCfg(state.cargo);
  if (!v) { box.innerHTML = ''; return; }
  const nome = v.candidato ? v.candidato.nome : 'candidato registrado';
  box.innerHTML = `<div class="aviso-site" style="padding:10px 13px;margin-bottom:10px">
    <span style="font-size:12.5px">✅ Você já votou para <b>${esc(cfg.nome)}</b>: <b>${esc(nome)}</b>.<br>
    <span class="muted">Alteração e revogação apenas no site completo.</span></span>
    ${linksConferir()}
  </div>`;
}
function skRows(n) {
  let h = '';
  for (let i = 0; i < n; i++) h += `<div class="cand"><span class="sk" style="width:44px;height:44px;border-radius:50%"></span><div style="flex:1"><span class="sk" style="display:block;width:60%;height:14px;margin-bottom:6px"></span><span class="sk" style="display:block;width:40%;height:11px"></span></div></div>`;
  return h;
}
function renderCandList(append, novos) {
  const box = $('#listaCand');
  const cfg = cargoCfg(state.cargo);
  const items = listState.items;
  /* no append, insere só a página nova — senão duplica tudo */
  const paraRender = (append && novos && novos.length) ? novos : items;
  if (!items.length) {
    const cfgUf = cfg.uf;
    box.innerHTML = `<div class="vazio"><div class="ico">🗳️</div>${
      cfgUf && !state.uf
        ? 'Escolha seu estado para ver os candidatos.'
        : (listState.q
          ? `Nada encontrado para “${esc(listState.q)}”.`
          : `Nenhum candidato publicado para ${esc(cfg.nome)}${state.uf ? ' em ' + esc(state.uf) : ''}.<br><span style="font-size:12px">Quando o TSE publicar, aparece aqui.</span>`)
    }</div>`;
    return;
  }
  const html = paraRender.map(c => {
    const votado = state.myVotes[state.cargo];
    const ehMeu = votado && votado.politicianId === ('tse-' + c.sq);
    const btn = votado
      ? `<button class="btn voted" data-votado="1">${ehMeu ? 'Meu voto ✓' : 'Votado ✓'}</button>`
      : `<button class="btn btn-green" data-vote="${esc('tse-' + c.sq)}">VOTAR</button>`;
    return `<div class="cand">
      ${avatarHTML(c.nomeUrna, c.foto, 44)}
      <div class="info">
        <div class="nome">${esc(c.nomeUrna)}</div>
        <div class="sub">${esc(c.partido)} · ${esc(c.uf)}${c.situacao && c.situacao !== 'AGUARDANDO JULGAMENTO' ? ' · ' + esc(c.situacao) : ''}</div>
      </div>
      <span class="num">${esc(c.numero || '—')}</span>
      ${btn}
    </div>`;
  }).join('');
  if (append) box.insertAdjacentHTML('beforeend', html);
  else box.innerHTML = html;
  box.querySelectorAll('[data-vote]').forEach(b =>
    b.addEventListener('click', () => {
      const c = listState.items.find(x => 'tse-' + x.sq === b.dataset.vote);
      if (c) abrirConfirmacao(c);
    }));
  box.querySelectorAll('[data-votado]').forEach(b =>
    b.addEventListener('click', () => toast('Você já votou neste cargo — altere no site completo', 'err')));
}
let buscaTimer = null;
let carregandoPagina = false;
async function carregarCandidatos(append) {
  if (carregandoPagina) return;
  carregandoPagina = true;
  try {
    const cfg = cargoCfg(state.cargo);
    const cargoPedido = state.cargo;
    if (cfg.uf && !state.uf) { listState.items = []; listState.total = 0; renderCandList(false); $('#btnMais').style.display = 'none'; atualizarCandInfo(); return; }
    if (!append) $('#listaCand').innerHTML = skRows(5);
    const params = new URLSearchParams({ cargo: String(tseCodeAtual()), pagina: String(listState.pagina), porPagina: '100' });
    if (cfg.uf && state.uf) params.set('uf', state.uf);
    if (listState.q) params.set('busca', listState.q);
    const r = await api('/api/candidatos-tse?' + params.toString());
    if (cargoPedido !== state.cargo) return;
    if (!r.ok) {
      $('#listaCand').innerHTML = `<div class="vazio"><div class="ico">📡</div>${esc(r.error || 'Não foi possível carregar.')}</div>`;
      return;
    }
    listState.totalPages = r.totalPaginas || 1;
    listState.total = r.total || 0;
    listState.items = append ? listState.items.concat(r.candidatos || []) : (r.candidatos || []);
    renderCandList(append, r.candidatos || []);
    $('#btnMais').style.display = (listState.pagina < listState.totalPages) ? 'flex' : 'none';
    atualizarCandInfo();
  } finally {
    carregandoPagina = false;
  }
}
function atualizarCandInfo() {
  const cfg = cargoCfg(state.cargo);
  const el = $('#candInfo');
  if (!listState.total) { el.textContent = ''; return; }
  el.textContent = `${listState.total.toLocaleString('pt-BR')} candidatos de ${cfg.nome.toLowerCase()}${state.uf ? ' — ' + state.uf : ''} · mostrando ${listState.items.length.toLocaleString('pt-BR')} (página ${listState.pagina} de ${listState.totalPages})`;
}
/* rolagem infinita: perto do fim, busca a próxima página sozinho */
function carregarProximaPagina() {
  if (listState.pagina >= listState.totalPages || carregandoPagina || !listState.items.length) return;
  listState.pagina++;
  carregarCandidatos(true);
}
$('#s-votar').addEventListener('scroll', () => {
  const scr = $('#s-votar');
  if (scr.scrollTop + scr.clientHeight < scr.scrollHeight - 350) return;
  carregarProximaPagina();
});
/* sentinela + IntersectionObserver: cobre rolagem por toque, teclado e leitores de tela */
(function configurarSentinela() {
  const scr = $('#s-votar');
  if (!scr || !('IntersectionObserver' in window)) return;
  const sent = document.createElement('div');
  sent.id = 'sentinelaMais';
  sent.style.height = '1px';
  $('#btnMais').before(sent);
  new IntersectionObserver(entradas => {
    if (entradas.some(e => e.isIntersecting)) carregarProximaPagina();
  }, { root: scr, rootMargin: '400px' }).observe(sent);
})();
/* rede extra: alguns webviews não disparam scroll/IntersectionObserver — checa posição periodicamente */
setInterval(() => {
  const scr = $('#s-votar');
  if (!scr.classList.contains('active')) return;
  if (scr.scrollTop + scr.clientHeight >= scr.scrollHeight - 350) carregarProximaPagina();
}, 700);
function renderVotar() {
  renderChips();
  renderUfArea();
  renderVotadoBanner();
  updateProgress();
  carregarCandidatos(false);
}
$('#buscaCand').addEventListener('input', e => {
  clearTimeout(buscaTimer);
  buscaTimer = setTimeout(() => { listState.q = e.target.value.trim(); listState.pagina = 1; carregarCandidatos(false); }, 350);
});
$('#btnMais').addEventListener('click', () => { listState.pagina++; carregarCandidatos(true); });

/* ===== confirmar voto ===== */
function abrirConfirmacao(c) {
  const cfg = cargoCfg(state.cargo);
  openSheet(`
    <h3 class="titles" style="text-align:center">Confirmar voto</h3>
    <div class="confirm-cand">
      ${avatarHTML(c.nomeUrna, c.foto, 46)}
      <div style="flex:1;min-width:0">
        <b style="display:block">${esc(c.nomeUrna)}</b>
        <span class="muted" style="font-size:12.5px">${esc(c.partido)} · ${esc(c.uf)} · nº ${esc(c.numero || '—')}</span>
        <div style="font-size:12px;color:var(--blueL);font-weight:800;margin-top:2px">${esc(cfg.nome)}</div>
      </div>
    </div>
    <p class="muted" style="font-size:12.5px;text-align:center">Um voto por cargo. Depois de confirmar, alterar apenas no site completo.</p>
    <div style="text-align:center;font-size:12px;margin-top:-4px"><a href="https://divulgacandcontas.tse.jus.br/" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600">Conferir candidatura no TSE ↗</a></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="shCancel">CANCELAR</button>
      <button class="btn btn-green" id="shConfirm">CONFIRMAR</button>
    </div>`);
  $('#shCancel').addEventListener('click', closeSheet);
  $('#shConfirm').addEventListener('click', async () => {
    const btn = $('#shConfirm');
    btn.disabled = true; btn.textContent = 'REGISTRANDO…';
    const corpo = JSON.stringify({ cargo: state.cargo, politicianId: 'tse-' + c.sq });
    let r = await api('/api/voto/cargo', { method: 'POST', body: corpo });
    if (!r.ok && r.__status === 401) {
      /* sessão caiu: reautentica em silêncio e repete o voto */
      state.token = ''; store.del('mb_app_token');
      if (await garantirSessao()) r = await api('/api/voto/cargo', { method: 'POST', body: corpo });
    }
    if (r.ok) {
      vibrate([50, 30, 50]);
      closeSheet();
      toast('Voto registrado ✓', 'ok');
      await loadMeusVotos();
      renderVotar();
    } else if (r.__status === 409) {
      closeSheet();
      const prev = r.previous && r.previous.nome ? ' (' + r.previous.nome + ')' : '';
      toast('Você já votou para ' + cfg.nome + prev, 'err');
      vibrate(120);
      await loadMeusVotos();
      renderVotar();
    } else {
      btn.disabled = false; btn.textContent = 'CONFIRMAR';
      toast(r.error || 'Não foi possível registrar o voto', 'err');
    }
  });
}

/* ===== APURAÇÃO ===== */
function donutSVG(parts) {
  const C = 2 * Math.PI * 55;
  let off = 0, segs = '';
  parts.forEach(p => {
    const len = Math.max(0, Math.min(C, C * p.pct / 100));
    if (len <= 0) return;
    segs += `<circle cx="70" cy="70" r="55" stroke="${p.cor}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    off += len;
  });
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="Resultado"><circle class="track" cx="70" cy="70" r="55"/>${segs}</svg>`;
}
function apuCard(cg) {
  if (!cg.totalVotos) {
    return `<div class="apu"><div class="topo"><h3>${esc(cg.nome)}</h3><span class="total">0 votos</span></div>
      <p class="muted" style="font-size:12.5px">Nenhum voto registrado para este cargo ainda.</p></div>`;
  }
  const parts = cg.top3.map((t, i) => ({ pct: t.pct, cor: DK_CORES[i] }));
  if (cg.outros.votos) parts.push({ pct: cg.outros.pct, cor: COR_OUTROS });
  const linha = (t, i) => `<div class="pline${i === 0 ? ' lider' : ''}"><span class="pos">${i + 1}º</span><span class="nm">${esc(t.nome)} <span class="vt">· ${esc(t.partido)}-${esc(t.uf)}</span></span><span class="pc">${t.pct}% <span class="vt">(${t.votos})</span></span></div>`;
  const outrosLinha = cg.outros.votos
    ? `<div class="pline"><span class="pos">+</span><span class="nm">Outros <span class="vt">(${cg.outros.quantidade} candidatos)</span></span><span class="pc">${cg.outros.pct}% <span class="vt">(${cg.outros.votos})</span></span></div>`
    : '';
  return `<div class="apu">
    <div class="topo"><h3>${esc(cg.nome)}</h3><span class="total">${cg.totalVotos} votos</span></div>
    <div class="grid">
      ${donutSVG(parts)}
      <div class="placer">
        ${cg.top3.map(linha).join('')}
        ${outrosLinha}
      </div>
    </div>
  </div>`;
}
function renderApuracao(data, offline) {
  $('#apuLista').innerHTML = data.cargos.map(apuCard).join('');
  const ts = data.__ts || Date.now();
  $('#apuTs').textContent = offline
    ? 'última atualização ' + hora(ts) + ' (offline)'
    : 'atualizado às ' + hora(ts);
}
async function refreshApuracao() {
  $('#apuLista').innerHTML = Array(3).fill('<div class="apu"><span class="sk" style="display:block;height:80px"></span></div>').join('');
  const r = await api('/api/apuracao');
  if (r.ok) {
    const payload = Object.assign({}, r, { __ts: Date.now() });
    store.set('mb_apuracao', JSON.stringify(payload));
    renderApuracao(payload, false);
  } else {
    const cache = store.get('mb_apuracao');
    if (cache) { try { renderApuracao(JSON.parse(cache), true); return; } catch (_) { } }
    $('#apuLista').innerHTML = `<div class="vazio"><div class="ico">📡</div>Sem conexão e ainda sem apuração salva.<br><span style="font-size:12px">Puxe para atualizar quando voltar.</span></div>`;
    $('#apuTs').textContent = '';
  }
}
$('#btnShare').addEventListener('click', async () => {
  const cache = store.get('mb_apuracao');
  if (!cache) { toast('Apuração ainda não carregada', 'err'); return; }
  try {
    const d = JSON.parse(cache);
    const lideres = d.cargos.filter(c => c.lider).map(c => `${c.nome}: ${c.lider.nome} (${c.lider.pct}%)`).join('\n');
    const txt = 'Apuração MudaBrasil 🇧🇷\n' + lideres + '\n\nVote também: ' + SITE_URL + '/app/';
    await compartilharTexto(txt);
  } catch (e) { if (!e || e.name !== 'AbortError') toast('Não foi possível compartilhar', 'err'); }
});
/* auto-refresh 30s enquanto a tela está visível */
state.apuTimer = setInterval(() => {
  if ($('#s-apuracao').classList.contains('active') && document.visibilityState === 'visible') refreshApuracao();
}, 30000);
/* pull-to-refresh */
(function () {
  const sec = $('#s-apuracao'), hint = $('#pullHint');
  let y0 = 0, puxando = false;
  sec.addEventListener('touchstart', e => { if (sec.scrollTop <= 0) { y0 = e.touches[0].clientY; puxando = true; } }, { passive: true });
  sec.addEventListener('touchmove', e => {
    if (!puxando) return;
    const dy = e.touches[0].clientY - y0;
    hint.style.height = (dy > 0 && sec.scrollTop <= 0) ? Math.min(42, dy * 0.35) + 'px' : '0px';
  }, { passive: true });
  sec.addEventListener('touchend', () => {
    if (!puxando) return;
    puxando = false;
    const puxou = (parseFloat(hint.style.height) || 0) > 18;
    hint.style.height = '0px';
    if (puxou) refreshApuracao();
  });
})();

/* ===== RADAR ===== */
let radarTimer = null;
$('#buscaRadar').addEventListener('input', e => {
  clearTimeout(radarTimer);
  radarTimer = setTimeout(() => carregarRadar(), 350);
});
async function carregarRadar() {
  const box = $('#listaRadar');
  const q = $('#buscaRadar').value.trim();
  box.innerHTML = Array(5).fill('<div class="radar-card"><span class="sk" style="width:44px;height:44px;border-radius:50%"></span><div style="flex:1"><span class="sk" style="display:block;width:55%;height:14px;margin-bottom:6px"></span><span class="sk" style="display:block;width:35%;height:11px"></span></div></div>').join('');
  const params = new URLSearchParams({ porPagina: '50' });
  if (/^(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/i.test(q)) params.set('uf', q.toUpperCase());
  else if (q) params.set('busca', q);
  const r = await api('/api/candidatos?' + params.toString());
  if (r.__status !== 200) { box.innerHTML = `<div class="vazio"><div class="ico">📡</div>${esc(r.error || 'Não foi possível carregar o radar.')}</div>`; return; }
  const lista = r.candidatos || [];
  if (!lista.length) { box.innerHTML = `<div class="vazio"><div class="ico">🔍</div>${q ? 'Nada encontrado para “' + esc(q) + '”.' : 'Nenhum parlamentar carregado agora.'}</div>`; return; }
  box.innerHTML = lista.map(p => `
    <button class="radar-card" data-pid="${esc(p.id)}">
      ${avatarHTML(p.name, p.photo, 44)}
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}</div>
        <div class="muted" style="font-size:12px">${esc(p.party)} · ${esc(p.state || '—')} <span class="cargo-tag">· ${esc(p.position)}</span></div>
      </div>
      <span class="muted" style="font-size:16px">›</span>
    </button>`).join('');
  box.querySelectorAll('[data-pid]').forEach(b =>
    b.addEventListener('click', () => abrirMiniPerfil(lista.find(p => p.id === b.dataset.pid))));
}
function numTxt(v) { return v == null ? '—' : String(v); }
async function abrirMiniPerfil(p) {
  if (!p) return;
  openSheet(`
    <div style="display:flex;align-items:center;gap:12px">
      ${avatarHTML(p.name, p.photo, 52)}
      <div style="flex:1;min-width:0">
        <b style="display:block;font-size:16px">${esc(p.name)}</b>
        <span class="muted" style="font-size:12.5px">${esc(p.party)} · ${esc(p.state || '—')} · ${esc(p.position)}</span>
      </div>
    </div>
    <div class="nums">
      <div class="num-box"><b id="mpProj">…</b><span>projetos<br>apresentados</span></div>
      <div class="num-box"><b id="mpVot">…</b><span>votações<br>registradas</span></div>
      <a class="num-box" id="mpDesp" style="text-decoration:none;color:inherit"><b>💰</b><span>despesas<br>(site oficial)</span></a>
    </div>
    <div id="mpNota" class="muted" style="font-size:11.5px"></div>
    <div class="links-off" id="mpLinks"></div>
    <p class="muted" style="font-size:11px;margin-top:12px;text-align:center">Resumo do app — ficha completa no site.</p>`);
  const camara = /^camara-(\d+)$/.exec(p.id);
  const senado = /^senado-(\d+)$/.exec(p.id);
  const links = [];
  if (camara) {
    const num = camara[1];
    links.push({ t: 'Ficha na Câmara ↗', u: 'https://www.camara.leg.br/deputados/quem-sao/resultado?search=' + encodeURIComponent(p.name) });
    $('#mpDesp').href = 'https://www.camara.leg.br/cota-parlamentar/';
    api('/api/camara/proposicoes?idDeputadoAutor=' + num + '&itens=1')
      .then(j => { $('#mpProj').textContent = (j && j._meta && j._meta.total != null) ? j._meta.total : '—'; })
      .catch(() => { $('#mpProj').textContent = '—'; });
    const v = await api('/api/camara/votacoes?itens=10&ordem=DESC&ordenarPor=dataHoraRegistro').catch(() => null);
    const ids = (v && v.dados ? v.dados : []).map(x => x.id).slice(0, 10);
    if (ids.length) {
      const res = await Promise.all(ids.map(id =>
        api('/api/camara/votacoes/' + id + '/votos')
          .then(j => (j && j.dados ? j.dados : []).some(d => d.deputado_ && String(d.deputado_.id) === String(num)))
          .catch(() => null)));
      const feitas = res.filter(x => x !== null);
      $('#mpVot').textContent = feitas.length ? (feitas.filter(Boolean).length + ' de ' + feitas.length) : '—';
      $('#mpNota').textContent = 'Votações: presença nas últimas votações nominais do Plenário.';
    } else { $('#mpVot').textContent = '—'; }
  } else if (senado) {
    $('#mpDesp').outerHTML = '<div class="num-box"><b>—</b><span>Senado não publica<br>despesas por senador</span></div>';
    links.push({ t: 'Perfil no Senado ↗', u: 'https://www25.senado.leg.br/web/senadores/senador/-/perfil/' + senado[1] });
    $('#mpProj').textContent = '—';
    $('#mpNota').textContent = 'Consulta de projetos por autor no Senado não está disponível no app.';
    try {
      const j = await fetch('https://legis.senado.leg.br/dadosabertos/senador/' + senado[1] + '/votacoes.json', { headers: { Accept: 'application/json' } }).then(x => x.json());
      let n = 0;
      (function walk(o) {
        if (Array.isArray(o)) return o.forEach(walk);
        if (o && typeof o === 'object') { if (o.DescricaoVotacao !== undefined) n++; Object.values(o).forEach(walk); }
      })(j);
      $('#mpVot').textContent = n ? String(n) : '—';
    } catch (_) { $('#mpVot').textContent = '—'; }
  } else {
    $('#mpProj').textContent = '—'; $('#mpVot').textContent = '—';
    $('#mpDesp').outerHTML = '<div class="num-box"><b>—</b><span>sem dados<br>oficiais</span></div>';
  }
  $('#mpLinks').innerHTML = links.slice(0, 2).map(l => `<a href="${esc(l.u)}" target="_blank" rel="noopener">${esc(l.t)}</a>`).join('');
}

/* ===== MEU VOTO ===== */
function renderMeuVoto() {
  const feitos = CARGOS.filter(c => state.myVotes[c.id]).length;
  const faltam = CARGOS.length - feitos;
  let resumo = '';
  if (feitos === CARGOS.length) {
    resumo = `<div class="aviso-site" style="border-color:var(--gold)">
      <b>🏆 Você votou em todos os ${CARGOS.length} cargos!</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 10px">Sua opinião está registrada — e pode ser revogada a qualquer momento no site. Chame mais gente para pesar a mão:</p>
      <button class="btn btn-gold" id="btnCompartilharApp" style="width:100%">Compartilhar o MudaBrasil ↗</button>
    </div>`;
  } else if (feitos > 0) {
    resumo = `<div class="aviso-site"><b>Faltam ${faltam} cargo${faltam > 1 ? 's' : ''} para completar sua votação</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">Toque num cargo abaixo para votar.</p></div>`;
  }
  $('#meusLista').innerHTML = resumo + CARGOS.map(cfg => {
    const v = state.myVotes[cfg.id];
    const cand = v && v.candidato;
    return `<div class="meu-item" data-cargo="${cfg.id}" style="cursor:pointer">
      <div class="cg">
        <b>${esc(cfg.nome)}</b>
        ${v
          ? `<span>✓ ${esc(cand ? cand.nome : 'voto registrado')}${cand ? ' · ' + esc(cand.partido) + '-' + esc(cand.uf) + ' · nº ' + esc(cand.numero) : ''}</span>`
          : '<span class="muted">Você ainda não votou neste cargo</span>'}
      </div>
      <span class="st" style="color:${v ? 'var(--green)' : 'var(--muted)'}">${v ? '✓' : '—'}</span>
    </div>`;
  }).join('') + (feitos < CARGOS.length ? `<p class="muted" style="text-align:center;font-size:11.5px;margin-top:6px">Toque num cargo para votar</p>` : '') + linksConferir();
  document.querySelectorAll('#meusLista [data-cargo]').forEach(el =>
    el.addEventListener('click', () => { state.cargo = el.dataset.cargo; listState.pagina = 1; go('votar'); }));
  $('#btnCompartilharApp')?.addEventListener('click', compartilharApp);
}

/* compartilhar: no celular usa o menu nativo; no desktop copia para a área
   de transferência — o diálogo nativo do sistema em webview embutida
   (navegador dentro de outro app) pode congelar a página */
async function copiarTexto(txt) {
  try { await navigator.clipboard.writeText(txt); return true; } catch (_) { }
  /* fallback universal (webviews sem permissão de clipboard) */
  try {
    const ta = document.createElement('textarea');
    ta.value = txt;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) { return false; }
}
async function compartilharTexto(txt) {
  const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (touch && typeof navigator.share === 'function') {
    try { await navigator.share({ title: 'MudaBrasil', text: txt, url: SITE_URL + '/app/' }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const ok = await copiarTexto(txt);
  toast(ok ? 'Copiado! Cole para compartilhar 📋' : 'Não foi possível compartilhar', ok ? 'ok' : 'err');
}

/* convite ao app — aparece quando o usuário completa os 5 cargos */
async function compartilharApp() {
  await compartilharTexto('Estou pesando a mão no MudaBrasil 🇧🇷 — voto contínuo e revogável nos candidatos. "Seu voto coloca, seu voto tira." Vote também: ' + SITE_URL + '/app/');
}
$('#btnAbrirSite').addEventListener('click', () => window.open(SITE_URL + '/', '_blank'));

/* ===== AJUDA (FAQ — espelho das perguntas do site) ===== */
const FAQ = [
  ['O que é simulação?', 'A votação/revogação não tem valor jurídico hoje. Notícias, políticos e PLs são reais.'],
  ['Como revogo meu voto?', 'No site completo, com código + login, só após a posse. No app você registra o voto; a alteração é feita no site.'],
  ['Como vejo os candidatos do meu estado?', 'Em Governador, Senador ou Deputado, escolha seu estado no seletor acima da lista. Pode também buscar pelo nome ou número.'],
  ['Por que a lista de deputado é tão grande?', 'Porque todos os candidatos oficiais do TSE aparecem. Role que o app carrega mais sozinho, ou use a busca para achar pelo nome/número.'],
  ['Quem pode responder reclamações?', 'Só o político/candidato com identidade verificada (selo), no site completo.'],
  ['O que é a regra dos 70%?', 'Proposta: 70% dos votos que elegeram = cassação.'],
];
function renderAjuda() {
  const box = $('#faqLista');
  if (box.dataset.preenchido) return;
  box.innerHTML = FAQ.map(f => `<div class="aviso-site" style="margin-bottom:10px"><b>${esc(f[0])}</b><p class="muted" style="margin:6px 0 0;font-size:13px">${esc(f[1])}</p></div>`).join('');
  box.dataset.preenchido = '1';
}
$('#btnAjuda').addEventListener('click', () => go('ajuda'));
$('#btnSobre').addEventListener('click', () => go('sobre'));
$('#btnSobreSite').addEventListener('click', () => window.open(SITE_URL + '/', '_blank'));
$('#lnkTermos').addEventListener('click', e => { e.preventDefault(); window.open(SITE_URL + '/termos.html', '_blank'); });
$('#lnkPriv').addEventListener('click', e => { e.preventDefault(); window.open(SITE_URL + '/privacidade.html', '_blank'); });

/* ===== MODO DIA DA ELEIÇÃO (1º turno 04/10, 2º turno 25/10/2026) =====
   Honestidade em dia de eleição: o voto de verdade é na urna; o app é
   simulação de opinião e a apuração oficial fica no TSE. */
const DIAS_ELEICAO = { '2026-10-04': '1º turno', '2026-10-25': '2º turno' };
function hojeBR() {
  try { return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
function atualizarBannerEleicao() {
  const turno = DIAS_ELEICAO[hojeBR()];
  const html = turno
    ? `🗳️ <b>Hoje é dia de votar na urna (${turno})!</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 8px">O voto de verdade é na urna oficial. Aqui no MudaBrasil é simulação de opinião pública — a apuração oficial fica com o TSE.</p>
      <a href="https://resultados.tse.jus.br/" target="_blank" rel="noopener" style="color:var(--gold);font-weight:700">Acompanhar apuração oficial no TSE ↗</a>`
    : '';
  ['bannerEleicao', 'bannerEleicaoApu'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !turno;
    el.innerHTML = html;
  });
}

/* ===== MENU ===== */
function renderMenu() {
  $('#menuNome').textContent = state.name || '—';
  $('#menuAvatar').textContent = initials(state.name);
  $('#appVer').textContent = 'v' + APP_V;
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  $('#btnInstalar').style.display = standalone ? 'none' : 'flex';
}
$('#btnSite').addEventListener('click', () => window.open(SITE_URL + '/', '_blank'));

/* ===== PWA: service worker + instalar ===== */
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('/app/sw.js', { updateViaCache: 'none' }).catch(() => { });
}
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if ($('#s-menu').classList.contains('active')) $('#installBanner').hidden = false;
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  $('#installBanner').hidden = true;
  toast('App instalado! 🎉', 'ok');
});
$('#btnBannerX').addEventListener('click', () => { $('#installBanner').hidden = true; });
$('#btnBannerInstall').addEventListener('click', instalar);
$('#btnInstalar').addEventListener('click', instalar);
function instalar() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(() => { deferredPrompt = null; $('#installBanner').hidden = true; });
  } else {
    openSheet(`
      <h3 class="titles" style="text-align:center">Instalar o app</h3>
      <p class="muted" style="font-size:13.5px;margin:10px 0 4px"><b style="color:var(--ink)">Android (Chrome):</b> menu ⋮ → “Instalar app” / “Adicionar à tela inicial”.</p>
      <p class="muted" style="font-size:13.5px;margin:6px 0 4px"><b style="color:var(--ink)">iPhone (Safari):</b> botão Compartilhar ⬆️ → “Adicionar à Tela de Início”.</p>
      <div class="sheet-actions"><button class="btn btn-ghost" id="shOk">ENTENDI</button></div>`);
    $('#shOk').addEventListener('click', closeSheet);
  }
}

/* ===== boot: sem login — abre direto no app; sessão anônima nasce sozinha ===== */
$('#whoName').textContent = state.name;
(async () => {
  if (state.token) {
    /* valida a sessão salva — token velho (deploy que recriou o banco) é descartado */
    if (window.__mblog) window.__mblog('boot: validando sessão /me…');
    const me = await api('/api/auth/me');
    if (window.__mblog) window.__mblog('boot: /me status=' + me.__status);
    if (me.__status === 401) {
      state.token = ''; state.name = ''; state.myVotes = {};
      store.del('mb_app_token'); store.del('mb_app_name');
      $('#whoName').textContent = '';
    }
  }
  await garantirSessao();
  route();
  atualizarBannerEleicao();
  loadMeusVotos();
  window.__appReady = true; /* rede de segurança no index.html confere esta flag */
})();
