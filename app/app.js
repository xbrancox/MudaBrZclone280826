/* ============================================================
   MudaBrasil APP — lógica (vanilla, sem build)
   Telas: votar · apuração · radar · meu voto · menu (sem login — sessão anônima automática)
   Regras fixas: sem PLs no app; conferir só no site;
   radar resumido; dados ausentes = vazio honesto.
   ============================================================ */
'use strict';

const API = (window.MudaBrasil && window.MudaBrasil.API_BASE) || '';
const APP_V = '2.1.0';
const SITE_URL = (window.MudaBrasil && window.MudaBrasil.SERVIDO_PELO_BACKEND)
  ? location.origin
  : 'https://mudabrasil-redesign-production.up.railway.app';

/* cargos do app → códigos TSE (7=Dep.Estadual, 8=Dep.Distrital).
   A lista visível passa por cargosVisiveis(): no DF, Estadual vira Distrital. */
const CARGOS = [
  { id: 'presidente',   nome: 'Presidente',       tse: [1], uf: false },
  { id: 'governador',   nome: 'Governador',       tse: [3], uf: true  },
  { id: 'senador',      nome: 'Senador',          tse: [5], uf: true  },
  { id: 'dep-federal',  nome: 'Deputado Federal', tse: [6], uf: true  },
  { id: 'dep-estadual', nome: 'Deputado Estadual',tse: [7], uf: true  },
  { id: 'dep-distrital',nome: 'Deputado Distrital',tse: [8], uf: true }
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
  myVotes: {},                 // cargo → { politicianId, candidato } (votos registrados no servidor)
  rascunho: {},                // v21 — cargo → { politicianId, nome, partido, uf, numero } montado no aparelho, ainda não enviado
  comprovante: null,           // v21 — { codigo, data, cargos } do último registro (espelho local do recibo)
  cargo: 'presidente',
  uf: store.get('mb_app_uf') || '',
  page: 1,
  totalPages: 1,
  apuTimer: null,
  apuHist: {},                 // id do cargo → [{ts, totalVotos}] das últimas cargas (tendência)
  radarFiltro: ''              // texto atual dos chips de filtro do radar ('' | 'camara' | 'senado' | UF)
};
/* v21 — estado persistido do fluxo da cédula */
try { state.rascunho = JSON.parse(store.get('mb_rascunho') || '{}') || {}; } catch (_) { state.rascunho = {}; }
try { state.comprovante = JSON.parse(store.get('mb_comprovante') || 'null'); } catch (_) { state.comprovante = null; }
function salvarRascunho() { store.set('mb_rascunho', JSON.stringify(state.rascunho)); }
function setComprovante(c) {
  state.comprovante = c;
  if (c) store.set('mb_comprovante', JSON.stringify(c)); else store.del('mb_comprovante');
}
function formatarCodigo(code) { return String(code || '').replace(/(.{4})/g, '$1 ').trim(); }
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
const TELAS = ['home', 'votar', 'apuracao', 'noticias', 'radar', 'meuvoto', 'menu', 'ajuda', 'sobre'];
function route() {
  const h = (location.hash || '#home').replace('#', '');
  const tela = TELAS.includes(h) ? h : 'home';
  TELAS.forEach(t => $('#s-' + t).classList.toggle('active', t === tela));
  /* ajuda/sobre abrem a partir do menu — mantém a aba Menu acesa na navegação */
  const navTela = (tela === 'ajuda' || tela === 'sobre') ? 'menu' : tela;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('active', b.dataset.go === navTela));
  if (tela === 'home') renderHome();
  if (tela === 'votar') renderVotar();
  if (tela === 'apuracao') { refreshApuracao(); atualizarApuPrazo(); }
  if (tela === 'noticias') carregarNoticias();
  if (tela === 'radar') carregarRadar();
  if (tela === 'meuvoto') renderMeuVoto();
  if (tela === 'menu') { renderMenu(); if (deferredPrompt) mostrarBannerInstall(); }
  if (tela === 'ajuda') renderAjuda();
}
function go(tela) { location.hash = '#' + tela; }
window.addEventListener('hashchange', route);
document.querySelectorAll('#nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

/* ===== HOME (página inicial) ===== */
function renderHome() {
  $('#homeNome').textContent = state.name || '—';
  const el = document.getElementById('homePrazo');
  if (el) {
    const d1 = diasAte('2026-10-04'), d2 = diasAte('2026-10-25');
    let txt;
    if (d1 > 1) txt = `⏳ Faltam <b>${d1} dias</b> para o 1º turno — 04/10. 2º turno: 25/10.`;
    else if (d1 === 1) txt = `⏳ O 1º turno é <b>amanhã</b> (04/10)!`;
    else if (d1 === 0) txt = `🗳️ Hoje é o <b>1º turno</b> da eleição real!`;
    else if (d2 > 1) txt = `⏳ Faltam <b>${d2} dias</b> para o 2º turno — 25/10.`;
    else if (d2 === 1) txt = `⏳ O 2º turno é <b>amanhã</b> (25/10)!`;
    else if (d2 === 0) txt = `🗳️ Hoje é o <b>2º turno</b> da eleição real!`;
    else txt = `✅ A eleição de 2026 terminou — acompanhe os resultados no TSE.`;
    el.innerHTML = txt;
  }
}
$('#btnHomeVotar').addEventListener('click', () => go('votar'));
document.querySelectorAll('#s-home [data-go]').forEach(b => b.addEventListener('click', () => go(b.dataset.go)));

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
  /* comprovante salvo no aparelho: se o servidor divergir (votos zerados na
     demonstração ou código trocado), sincroniza o espelho local */
  const nRegistrados = Object.keys(state.myVotes).length;
  if (state.comprovante && !nRegistrados) setComprovante(null);
  else if (state.comprovante && r.codigo && state.comprovante.codigo.replace(/\s/g, '') !== r.codigo.replace(/\s/g, '')) {
    setComprovante(Object.assign({}, state.comprovante, { codigo: r.codigo }));
  }
  $('#whoName').textContent = state.name;
  if ($('#s-votar').classList.contains('active')) renderVotar();
  if ($('#s-meuvoto').classList.contains('active')) renderMeuVoto();
  updateProgress();
}
function countVotos() { return cargosVisiveis().filter(c => state.myVotes[c.id]).length; }
function countRascunho() { return cargosVisiveis().filter(c => state.rascunho[c.id]).length; }
function updateProgress() {
  const el = $('#progTxt');
  if (!el) return;
  const n = countVotos(), total = cargosVisiveis().length;
  el.textContent = n + ' de ' + total + ' cargos';
  $('#progBar').style.width = (n / total * 100) + '%';
}
/* v21 — barra fixa da cédula na tela votar: mostra escolhas do rascunho e
   leva à revisão. Some quando não há nada pendente. */
function atualizarBarraCedula() {
  const bar = $('#barraCedula');
  if (!bar) return;
  const nr = countRascunho(), nv = countVotos();
  if (!nr) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  $('#cedulaTxt').innerHTML = `🗳️ Sua cédula: <b>${nr} de ${cargosVisiveis().length}${nv ? ' · ' + nv + ' já registrados' : ''}</b>`;
}

/* ===== VOTAR ===== */
/* v22 — a cédula é sempre de 5 cargos: no DF, Deputado Estadual é substituído
   por Deputado Distrital (o DF não tem deputação estadual). Toda contagem e
   toda lista de cargos passa por aqui. */
const CARGO_ESTADUAL_DF = 'dep-estadual';
function cargosVisiveis() {
  return CARGOS.filter(c => {
    if (state.uf === 'DF' && c.id === 'dep-estadual') return false;   // DF não tem estadual
    if (state.uf !== 'DF' && c.id === 'dep-distrital') return false;  // distrital só existe no DF
    return true;
  });
}
/* cargo guardado pode ter sumido da cédula (usuário mudou para DF) → realoca */
function cargoAtualValido() {
  if (!cargosVisiveis().some(c => c.id === state.cargo)) state.cargo = 'presidente';
  return state.cargo;
}
function renderChips() {
  $('#chips').innerHTML = cargosVisiveis().map(c => {
    const reg = state.myVotes[c.id], ras = state.rascunho[c.id];
    const marca = reg ? ' <span class="ok">✓</span>' : (ras ? ' <span class="dot-ras"></span>' : '');
    return `<button class="chip${c.id === state.cargo ? ' active' : ''}" data-cargo="${c.id}">${c.nome}${marca}</button>`;
  }).join('');
  document.querySelectorAll('#chips .chip').forEach(ch =>
    ch.addEventListener('click', () => { state.cargo = ch.dataset.cargo; listState.pagina = 1; renderVotar(); }));
}
function cargoCfg(id) { return CARGOS.find(c => c.id === id); }
function tseCodeAtual() {
  return cargoCfg(state.cargo).tse[0];
}
/* v22 — após escolher um candidato, salta sozinho para o próximo cargo vazio
   da cédula (ordem dos chips). Se todos já têm escolha, vai para a revisão. */
function proximoCargoDisponivel(depoisDe) {
  const lista = cargosVisiveis();
  for (let i = 1; i <= lista.length; i++) {
    const cfg = lista[(lista.findIndex(c => c.id === depoisDe) + i) % lista.length];
    if (!state.rascunho[cfg.id] && !state.myVotes[cfg.id]) return cfg.id;
  }
  return null;
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
   a conferência do código fica no site completo e no TSE */
function linksConferir() {
  const a = (h, t) => `<a href="${h}" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600;white-space:nowrap">${t}</a>`;
  return `<div style="display:flex;flex-wrap:wrap;gap:5px 16px;font-size:12.5px;margin-top:9px">
    ${a(SITE_URL + '/#conferir-voto', 'Conferir voto no site ↗')}
    ${a('https://divulgacandcontas.tse.jus.br/', 'Candidaturas no TSE ↗')}
  </div>`;
}
function renderVotadoBanner() {
  const box = $('#votadoBanner');
  const v = state.myVotes[state.cargo];
  const ras = state.rascunho[state.cargo];
  const cfg = cargoCfg(state.cargo);
  if (!v && !ras) { box.innerHTML = ''; return; }
  const nome = (v && v.candidato ? v.candidato.nome : null) || (ras ? ras.nome : 'candidato');
  box.innerHTML = `<div class="aviso-site" style="padding:10px 13px;margin-bottom:10px">
    <span style="font-size:12.5px">${v ? '✅ Voto registrado' : '🟡 Escolhido para a cédula'} para <b>${esc(cfg.nome)}</b>: <b>${esc(nome)}</b>.<br>
    <span class="muted">${v ? 'Você pode trocar até revisar e gerar o código — na votação real, a alteração é pelo site.' : 'Confirme em “Revisar cédula” para registrar com seu código único.'}</span></span>
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
    const pid = 'tse-' + c.sq;
    const votado = state.myVotes[state.cargo];
    const ras = state.rascunho[state.cargo];
    const escolhido = (ras && ras.politicianId === pid) || (votado && votado.politicianId === pid);
    let btn;
    if (escolhido) {
      btn = `<button class="btn voted" data-escolhido="1">${(ras && ras.politicianId === pid) ? 'Na cédula ●' : 'Registrado ✓'}</button>`;
    } else {
      btn = `<button class="btn btn-green" data-vote="${esc(pid)}">VOTAR</button>`;
    }
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
      if (window.__mblog) window.__mblog('clique VOTAR sq=' + b.dataset.vote + (c ? '' : ' SEM-CANDIDATO-na-lista'));
      if (c) abrirConfirmacao(c);
    }));
  box.querySelectorAll('[data-escolhido]').forEach(b =>
    b.addEventListener('click', () => toast('Essa é a sua escolha nesta cédula — toque em “Revisar cédula” para conferir tudo', 'ok')));
}
let buscaTimer = null;
let carregandoPagina = false;
async function carregarCandidatos(append) {
  if (carregandoPagina) return;
  carregandoPagina = true;
  /* lista substituída (troca de cargo/UF, busca, reentrada) = começa do topo */
  if (!append) $('#s-votar').scrollTop = 0;
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
  cargoAtualValido();
  renderChips();
  renderUfArea();
  renderVotadoBanner();
  updateProgress();
  atualizarBarraCedula();
  carregarCandidatos(false);
}
$('#btnRevisarCedula').addEventListener('click', abrirRevisao);
$('#buscaCand').addEventListener('input', e => {
  clearTimeout(buscaTimer);
  buscaTimer = setTimeout(() => { listState.q = e.target.value.trim(); listState.pagina = 1; carregarCandidatos(false); }, 350);
});
$('#btnMais').addEventListener('click', () => { listState.pagina++; carregarCandidatos(true); });

/* ============================================================
   v21 — FLUXO DA CÉDULA (inspirado no protótipo VotaBrasil)
   escolher no aparelho (rascunho, troca livre, avança sozinho para o
   próximo cargo) → REVISE SUA CÉDULA → COMO FUNCIONA O REGISTRO
   → UM código único de 20 dígitos → VOTO REGISTRADO (comprovante salvo
   no aparelho) → "Votar de novo (demonstração)" enquanto o app é simulação.
   Nada vai ao servidor até finalizar a cédula.
   ============================================================ */
function abrirConfirmacao(c) {
  const cfg = cargoCfg(state.cargo);
  const pid = 'tse-' + c.sq;
  const trocando = state.rascunho[state.cargo] || state.myVotes[state.cargo];
  openSheet(`
    <h3 class="titles" style="text-align:center">${trocando ? 'Trocar escolha' : 'Escolher para a cédula'}</h3>
    <div class="confirm-cand">
      ${avatarHTML(c.nomeUrna, c.foto, 46)}
      <div style="flex:1;min-width:0">
        <b style="display:block">${esc(c.nomeUrna)}</b>
        <span class="muted" style="font-size:12.5px">${esc(c.partido)} · ${esc(c.uf)} · nº ${esc(c.numero || '—')}</span>
        <div style="font-size:12px;color:var(--blueL);font-weight:800;margin-top:2px">${esc(cfg.nome)}</div>
      </div>
    </div>
    ${trocando ? `<p class="muted" style="font-size:12.5px;text-align:center">Esta escolha substitui a atual para ${esc(cfg.nome.toLowerCase())} na sua cédula.</p>` : ''}
    <p class="muted" style="font-size:12.5px;text-align:center">Nada é enviado ainda — revise a cédula completa e gere seu código único.</p>
    <div style="text-align:center;font-size:12px;margin-top:-4px"><a href="https://divulgacandcontas.tse.jus.br/" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600">Conferir candidatura no TSE ↗</a></div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="shCancel">CANCELAR</button>
      <button class="btn btn-green" id="shEscolher">ESCOLHER ✓</button>
    </div>`);
  $('#shCancel').addEventListener('click', closeSheet);
  $('#shEscolher').addEventListener('click', () => {
    state.rascunho[state.cargo] = { politicianId: pid, nome: c.nomeUrna, partido: c.partido, uf: c.uf, numero: c.numero || '', foto: c.foto || '' };
    salvarRascunho();
    vibrate([40, 25, 40]);
    closeSheet();
    /* v22 — avança sozinho para o próximo cargo ainda sem escolha */
    const proximo = proximoCargoDisponivel(state.cargo);
    if (proximo) {
      state.cargo = proximo; listState.pagina = 1;
      renderVotar();
      toast('Adicionado à cédula ✓ — agora: ' + cargoCfg(proximo).nome, 'ok');
    } else {
      renderChips(); renderVotadoBanner(); atualizarBarraCedula();
      carregarCandidatos(false);
      toast('Última escolha registrada — revise a cédula completa 🗳️', 'ok');
    }
  });
}

/* ---- passo 1: REVISE SUA CÉDULA ---- */
function abrirRevisao() {
  if (!countRascunho()) { toast('Escolha pelo menos um candidato primeiro', 'err'); return; }
  const linhas = cargosVisiveis().map((cfg, i) => {
    const ras = state.rascunho[cfg.id];
    const reg = state.myVotes[cfg.id];
    const mesmo = ras && reg && ras.politicianId === reg.politicianId;
    return `<div class="rv-row">
      ${ras
        ? avatarHTML(ras.nome, ras.foto, 40, i)
        : '<span class="rv-vazio">—</span>'}
      <div class="rv-info">
        <b>${esc(cfg.nome)}</b>
        <span>${ras ? esc(ras.nome) + ' <i>· ' + esc(ras.partido) + '-' + esc(ras.uf) + ' · nº ' + esc(ras.numero || '—') + '</i>'
          : (reg ? 'sem mudança — registrado: ' + esc(reg.candidato ? reg.candidato.nome : 'candidato') : '<em>não escolhido</em>')}</span>
        ${mesmo ? '<span class="rv-tag">já registrado</span>' : ''}
      </div>
      <button class="rv-btn" data-trocar="${cfg.id}">${ras ? 'trocar' : 'escolher'}</button>
    </div>`;
  }).join('');
  openSheet(`
    <h3 class="titles" style="text-align:center">🗳️ Revise sua cédula</h3>
    <p class="muted" style="font-size:12px;text-align:center;margin-bottom:10px">Confira os candidatos antes de gerar seu código único.<br>Toque em “trocar” para mudar qualquer um.</p>
    ${linhas}
    <div class="aviso-site" style="margin:12px 0 0;padding:9px 12px">
      <span style="font-size:11.5px">⚖️ <b>Simulação de opinião pública</b> — sem valor jurídico. Ao confirmar, você verá como funciona o registro com código único.</span>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="shFecharRev">VOLTAR</button>
      <button class="btn btn-gold" id="shConfirmarCedula">CONFIRMAR CÉDULA →</button>
    </div>`);
  document.querySelectorAll('#sheetBody [data-trocar]').forEach(b =>
    b.addEventListener('click', () => {
      closeSheet();
      state.cargo = b.dataset.trocar; listState.pagina = 1;
      go('votar'); renderVotar();
    }));
  $('#shFecharRev').addEventListener('click', closeSheet);
  $('#shConfirmarCedula').addEventListener('click', abrirExplicacao);
}

/* ---- passo 2: COMO FUNCIONA O REGISTRO ---- */
function abrirExplicacao() {
  openSheet(`
    <h3 class="titles" style="text-align:center">🔑 Como funciona seu registro</h3>
    <div class="rv-texto">
      <p><b>Código único.</b> Ao confirmar, você recebe <b>um único código de 20 dígitos</b> para TODA a sua cédula — ele vale para todos os cargos que você escolheu.</p>
      <p><b>Comprovante no aparelho.</b> O comprovante fica gravado neste celular na aba <b>Meu voto</b>, com data e hora, para você conferir quando quiser. Você também pode copiar, compartilhar ou conferir o código no site completo.</p>
      <p><b>Seus votos contam na Apuração</b> como pesquisa de opinião pública entre os usuários do app.</p>
    </div>
    <div class="aviso-site" style="border-color:var(--gold);margin:12px 0 0">
      <b>⚖️ Hoje vs. votação real</b>
      <p style="font-size:12px;margin:6px 0 0;line-height:1.55">
        <b>Hoje (demonstração):</b> sem login, o comprovante fica só neste aparelho e você pode refazer sua cédula quando quiser com “Votar de novo”.<br>
        <b>Quando for votação real:</b> haverá login por e-mail ou celular e o comprovante será enviado automaticamente para você — e não existirá mais o botão de refazer.
      </p>
    </div>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="shVoltarRev">← VOLTAR</button>
      <button class="btn btn-gold" id="shGerarCodigo">ENTENDI, GERAR MEU CÓDIGO</button>
    </div>`);
  $('#shVoltarRev').addEventListener('click', abrirRevisao);
  $('#shGerarCodigo').addEventListener('click', finalizarVoto);
}

/* ---- passo 3: registrar a cédula inteira com UM código ---- */
async function finalizarVoto() {
  const btn = $('#shGerarCodigo');
  if (btn) { btn.disabled = true; btn.textContent = 'GERANDO CÓDIGO…'; }
  const cargos = {};
  Object.entries(state.rascunho).forEach(([k, v]) => { cargos[k] = v.politicianId; });
  const corpo = JSON.stringify({ cargos });
  let r = await api('/api/voto/cargo-lote', { method: 'POST', body: corpo });
  if (!r.ok && r.__status === 401) {
    /* sessão caiu: reautentica em silêncio e repete o envio */
    state.token = ''; store.del('mb_app_token');
    if (await garantirSessao()) r = await api('/api/voto/cargo-lote', { method: 'POST', body: corpo });
  }
  if (window.__mblog) window.__mblog('cargo-lote -> status=' + r.__status + ' ok=' + !!r.ok);
  if (!r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = 'ENTENDI, GERAR MEU CÓDIGO'; }
    toast(r.error || 'Não foi possível registrar sua cédula', 'err');
    return;
  }
  setComprovante({ codigo: r.codigo || '', data: Date.now(), cargos: JSON.parse(JSON.stringify(state.rascunho)) });
  state.rascunho = {}; salvarRascunho();
  vibrate([50, 30, 50, 30, 80]);
  await loadMeusVotos();
  abrirComprovante(r.codigo, true);
}

/* ---- passo 4: VOTO REGISTRADO (comprovante no aparelho) ---- */
function abrirComprovante(codigo, acabouDeRegistrar) {
  const fmt = formatarCodigo(codigo);
  openSheet(`
    <h3 class="titles" style="text-align:center">✅ Voto registrado</h3>
    <p class="muted" style="font-size:12.5px;text-align:center">Seu código único de verificação (20 dígitos) — vale para todos os cargos da cédula:</p>
    <div class="cd">${esc(fmt || '—')}</div>
    <p class="muted" style="font-size:11.5px;text-align:center;margin-top:2px">📱 Guardado neste aparelho em <b>Meu voto</b> para conferência posterior.${acabouDeRegistrar ? '<br>Com login por e-mail ou celular (votação real), ele também chega enviado para você.' : ''}</p>
    <button class="btn btn-gold" id="shCopiarCod" style="width:100%;margin-top:12px">📋 COPIAR CÓDIGO</button>
    <button class="btn btn-ghost" id="shConferirSite" style="width:100%;margin-top:8px">🔍 CONFERIR NO SITE ↗</button>
    <button class="btn btn-ghost" id="shCompartilharCod" style="width:100%;margin-top:8px">↗ COMPARTILHAR COMPROVANTE</button>
    <button class="btn btn-ghost" id="shDeNovo" style="width:100%;margin-top:8px;color:var(--blueL)">🔄 Votar de novo (demonstração)</button>
    <div class="sheet-actions"><button class="btn btn-green" id="shOkComp">PRONTO</button></div>`);
  $('#shCopiarCod').addEventListener('click', async () => {
    const ok = await copiarTexto(fmt || codigo);
    toast(ok ? 'Código copiado! 📋' : 'Copie manualmente: ' + fmt, ok ? 'ok' : 'err');
  });
  $('#shConferirSite').addEventListener('click', () => {
    window.open(SITE_URL + '/#conferir-voto', '_blank');
  });
  $('#shCompartilharCod').addEventListener('click', () => compartilharTexto(
    'Votei (simulação cívica) no MudaBrasil 🇧🇷 — código único da minha cédula: ' + fmt + '. Confira: ' + SITE_URL + '/#conferir-voto'));
  $('#shDeNovo').addEventListener('click', abrirDemonstracao);
  $('#shOkComp').addEventListener('click', () => { closeSheet(); renderVotar(); });
}

/* ---- modo demonstração: zerar a simulação e recomeçar ---- */
function abrirDemonstracao() {
  const n = countVotos();
  openSheet(`
    <h3 class="titles" style="text-align:center">🔄 Votar de novo</h3>
    <p style="font-size:13px;line-height:1.55">Como o app ainda está em <b>demonstração</b>, você pode desfazer sua cédula (${n} voto${n === 1 ? '' : 's'} nesta sessão) e montar outra — sua primeira resposta continua como base da pesquisa de opinião até você recomeçar.</p>
    <p class="muted" style="font-size:12px;margin-top:8px">⚠️ Isso apaga apenas os SEUS votos desta demonstração. Na votação real este botão não existirá: o voto registrado será permanente.</p>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="shCancelarDemo">MANTER VOTOS</button>
      <button class="btn" id="shZerarDemo" style="background:#c0392b;color:#fff">ZERAR E RECOMEÇAR</button>
    </div>`);
  $('#shCancelarDemo').addEventListener('click', abrirComprovante.bind(null, (state.comprovante && state.comprovante.codigo) || '', false));
  $('#shZerarDemo').addEventListener('click', async () => {
    const btn = $('#shZerarDemo');
    btn.disabled = true; btn.textContent = 'APAGANDO…';
    const cod = (state.comprovante && state.comprovante.codigo) || '';
    let r = await api('/api/voto/demonstracao', { method: 'POST', body: JSON.stringify({ codigo: cod }) });
    if (!r.ok && r.__status === 401) {
      state.token = ''; store.del('mb_app_token');
      if (await garantirSessao()) r = await api('/api/voto/demonstracao', { method: 'POST', body: JSON.stringify({ codigo: cod }) });
    }
    if (!r.ok) {
      btn.disabled = false; btn.textContent = 'ZERAR E RECOMEÇAR';
      toast(r.error || 'Não foi possível zerar agora', 'err');
      return;
    }
    setComprovante(null);
    state.rascunho = {}; salvarRascunho();
    await loadMeusVotos();
    closeSheet();
    go('votar'); renderVotar();
    toast('Simulação zerada — monte sua nova cédula 🗳️', 'ok');
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
/* tendência: compara total de votos do cargo com a amostra anterior (30s) */
function tendenciaDe(id, total) {
  const hist = state.apuHist[id] || [];
  const prev = hist.length >= 2 ? hist[hist.length - 2].totalVotos : null;
  if (prev == null || total === prev) return '';
  return total > prev ? '↑ subindo' : '↓ caindo';
}
function registrarHistorico(data) {
  const ts = Date.now();
  data.cargos.forEach(c => {
    const h = state.apuHist[c.id] || (state.apuHist[c.id] = []);
    const ult = h[h.length - 1];
    if (!ult || ult.totalVotos !== c.totalVotos || ts - ult.ts > 5 * 60 * 1000) {
      h.push({ ts, totalVotos: c.totalVotos });
      if (h.length > 40) h.shift();
    }
  });
}
function apuStats(data) {
  const votantes = countVotos();
  const totalCargos = cargosVisiveis().length;
  const tiles = [
    `<div class="stat"><b>${data.totalVotos}</b><span>votos na simulação</span></div>`,
    `<div class="stat"><b>${votantes}<i>/${totalCargos}</i></b><span>seus cargos votados</span></div>`,
    `<div class="stat"><b>${data.cargos.filter(c => c.totalVotos > 0).length}<i>/${data.cargos.length}</i></b><span>cargos com votos</span></div>`
  ];
  return `<div class="stats">${tiles.join('')}</div>
    <p class="muted" style="font-size:10.5px;margin:-4px 2px 10px">Toque num candidato do ranking para ver a ficha dele no Radar.</p>`;
}
function apuCard(cg) {
  if (!cg.totalVotos) {
    return `<div class="apu"><div class="topo"><h3>${esc(cg.nome)}</h3><span class="total">0 votos</span></div>
      <p class="muted" style="font-size:12.5px">Nenhum voto registrado para este cargo ainda. ${cg.id !== 'presidente' ? '<a href="#votar" style="color:var(--gold);font-weight:600">Seja o primeiro →</a>' : '<a href="#votar" style="color:var(--gold);font-weight:600">Seja o primeiro →</a>'}</p></div>`;
  }
  const parts = cg.top3.map((t, i) => ({ pct: t.pct, cor: DK_CORES[i] }));
  if (cg.outros.votos) parts.push({ pct: cg.outros.pct, cor: COR_OUTROS });
  const tend = tendenciaDe(cg.id, cg.totalVotos);
  const linha = (t, i) => `<button class="pline${i === 0 ? ' lider' : ''}" data-pol="${esc(t.politicianId)}" data-nome="${esc(t.nome)}" data-partido="${esc(t.partido)}" data-uf="${esc(t.uf)}" title="Ver ficha no Radar"><span class="pos">${i + 1}º</span><span class="nm">${esc(t.nome)} <span class="vt">· ${esc(t.partido)}-${esc(t.uf)}</span></span><span class="pc">${t.pct}% <span class="vt">(${t.votos})</span></span></button>`;
  const outrosLinha = cg.outros.votos
    ? `<div class="pline"><span class="pos">+</span><span class="nm">Outros <span class="vt">(${cg.outros.quantidade} candidatos)</span></span><span class="pc">${cg.outros.pct}% <span class="vt">(${cg.outros.votos})</span></span></div>`
    : '';
  return `<div class="apu">
    <div class="topo"><h3>${esc(cg.nome)}${tend ? ` <span class="tend ${tend === '↑ subindo' ? 'up' : 'down'}">${tend}</span>` : ''}</h3><span class="total">${cg.totalVotos} votos</span></div>
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
  $('#apuLista').innerHTML = apuStats(data) + data.cargos.map(apuCard).join('');
  /* toque num candidato da apuração → ficha dele no Radar */
  document.querySelectorAll('#apuLista .pline[data-pol]').forEach(b => {
    const nomeCargo = (b.closest('.apu') || {}).querySelector ? ((b.closest('.apu').querySelector('h3') || {}).textContent || '').replace(/↑ subindo|↓ caindo/, '').trim() : '';
    b.addEventListener('click', () => abrirMiniPerfil({
      id: b.dataset.pol, name: b.dataset.nome, party: b.dataset.partido,
      state: b.dataset.uf, position: nomeCargo, photo: null
    }));
  });
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
    registrarHistorico(payload);
    store.set('mb_apuracao', JSON.stringify(payload));
    renderApuracao(payload, false);
  } else {
    const cache = store.get('mb_apuracao');
    if (cache) { try { renderApuracao(JSON.parse(cache), true); return; } catch (_) { } }
    $('#apuLista').innerHTML = `<div class="vazio"><div class="ico">📡</div>Sem conexão e ainda sem apuração salva.<br><span style="font-size:12px">Toque em Atualizar quando voltar.</span></div>`;
    $('#apuTs').textContent = '';
  }
}
$('#btnApuRefresh').addEventListener('click', async () => {
  const b = $('#btnApuRefresh');
  b.disabled = true;
  try { await refreshApuracao(); } finally { b.disabled = false; }
});
$('#btnShare').addEventListener('click', async () => {
  const cache = store.get('mb_apuracao');
  if (!cache) { toast('Apuração ainda não carregada', 'err'); return; }
  try {
    const d = JSON.parse(cache);
    const lideres = d.cargos.filter(c => c.lider).map(c => `${c.nome}: ${c.lider.nome} (${c.lider.pct}%)`).join('\n');
    const txt = 'Votação no MudaBrasil (simulação cívica, não é resultado oficial) 🇧🇷\n' + lideres + '\n\nVote também: ' + SITE_URL + '/app/';
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
function renderChipsRadar() {
  const box = $('#chipsRadar');
  if (!box) return;
  const chips = [{ id: '', rot: 'Todos' }, { id: 'camara', rot: 'Deputados' }, { id: 'senado', rot: 'Senadores' }];
  if (state.uf) chips.push({ id: 'uf:' + state.uf, rot: 'Meu estado · ' + state.uf });
  box.innerHTML = chips.map(c =>
    `<button class="chip${state.radarFiltro === c.id ? ' active' : ''}" data-rf="${esc(c.id)}">${esc(c.rot)}</button>`).join('');
  box.querySelectorAll('.chip').forEach(ch => ch.addEventListener('click', () => {
    state.radarFiltro = ch.dataset.rf;
    renderChipsRadar();
    carregarRadar();
  }));
}
async function carregarRadar() {
  const box = $('#listaRadar');
  const q = $('#buscaRadar').value.trim();
  renderChipsRadar();
  box.innerHTML = Array(5).fill('<div class="radar-card"><span class="sk" style="width:44px;height:44px;border-radius:50%"></span><div style="flex:1"><span class="sk" style="display:block;width:55%;height:14px;margin-bottom:6px"></span><span class="sk" style="display:block;width:35%;height:11px"></span></div></div>').join('');
  const params = new URLSearchParams({ porPagina: '80' });
  let buscaEfetiva = q;
  if (/^(ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/i.test(q)) { params.set('uf', q.toUpperCase()); buscaEfetiva = ''; }
  else if (state.radarFiltro.startsWith('uf:') && !q) params.set('uf', state.radarFiltro.slice(3));
  if (buscaEfetiva) params.set('busca', buscaEfetiva);
  const r = await api('/api/candidatos?' + params.toString());
  if (r.__status !== 200) { box.innerHTML = `<div class="vazio"><div class="ico">📡</div>${esc(r.error || 'Não foi possível carregar o radar.')}</div>`; return; }
  let lista = r.candidatos || [];
  /* filtro por casa — o servidor não tem esse parâmetro, filtramos aqui */
  if (state.radarFiltro === 'camara') lista = lista.filter(p => /^camara-/.test(p.id));
  else if (state.radarFiltro === 'senado') lista = lista.filter(p => /^senado-/.test(p.id));
  const totalCarregado = lista.length;
  if (!lista.length) { box.innerHTML = `<div class="vazio"><div class="ico">🔍</div>${q || state.radarFiltro ? 'Nada encontrado para esse filtro — tente outro nome, UF ou partido.' : 'Nenhum parlamentar carregado agora.'}</div>`; return; }
  box.innerHTML = `<p class="muted" style="font-size:11.5px;margin:0 2px 8px">${totalCarregado} parlamentar${totalCarregado > 1 ? 'es' : ''} no filtro · toque para ver a ficha</p>` + lista.map(p => `
    <button class="radar-card" data-pid="${esc(p.id)}">
      ${avatarHTML(p.name, p.photo, 44)}
      <div style="flex:1;min-width:0">
        <div style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.name)}${p.verificado ? ' <span class="selo-mini" title="Verificado no MudaBrasil">✔</span>' : ''}</div>
        <div class="muted" style="font-size:12px">${esc(p.party)} · ${esc(p.state || '—')} <span class="cargo-tag">· ${esc(p.position)}</span>${p.billsAuthored != null ? ` <span class="badge-num">${p.billsAuthored} projetos</span>` : ''}${p.attendanceRate != null ? ` <span class="badge-num">${Math.round(p.attendanceRate)}% presença</span>` : ''}</div>
      </div>
      <span class="muted" style="font-size:16px">›</span>
    </button>`).join('');
  box.querySelectorAll('[data-pid]').forEach(b =>
    b.addEventListener('click', () => abrirMiniPerfil(lista.find(p => p.id === b.dataset.pid))));
}
function numTxt(v) { return v == null ? '—' : String(v); }
async function abrirMiniPerfil(p) {
  if (!p) return;
  /* ficha de candidato do TSE (vindo da apuração): sem dados parlamentares,
     mas com atalho para a candidatura oficial — vazio honesto */
  const ehTse = /^tse-/.test(String(p.id || ''));
  if (ehTse) {
    openSheet(`
      <div style="display:flex;align-items:center;gap:12px">
        ${avatarHTML(p.name, null, 52)}
        <div style="flex:1;min-width:0">
          <b style="display:block;font-size:16px">${esc(p.name)}</b>
          <span class="muted" style="font-size:12.5px">${esc(p.party || '')}${p.state ? ' · ' + esc(p.state) : ''}${p.position ? ' · ' + esc(p.position) : ''}</span>
        </div>
      </div>
      <div class="aviso-site" style="margin:14px 0 8px">
        <b>Candidato do snapshot oficial do TSE 2026.</b>
        <p class="muted" style="font-size:12px;margin:6px 0 0">Projetos e votações só existem para quem já está em mandato (Deputados e Senadores). Ficha de campanha completa no site do TSE.</p>
      </div>
      <div class="links-off"><a href="https://divulgacandcontas.tse.jus.br/" target="_blank" rel="noopener">Bens e contas no TSE ↗</a></div>
      <p class="muted" style="font-size:11px;margin-top:12px;text-align:center">Resumo do app — ficha completa no site.</p>`);
    return;
  }
  openSheet(`
    <div style="display:flex;align-items:center;gap:12px">
      ${avatarHTML(p.name, p.photo, 52)}
      <div style="flex:1;min-width:0">
        <b style="display:block;font-size:16px">${esc(p.name)}${p.verificado ? ' <span class="selo-mini" title="Verificado no MudaBrasil">✔</span>' : ''}</b>
        <span class="muted" style="font-size:12.5px">${esc(p.party)} · ${esc(p.state || '—')} · ${esc(p.position)}</span>
      </div>
    </div>
    <div class="nums">
      <div class="num-box"><b id="mpProj">…</b><span>projetos<br>apresentados</span></div>
      <div class="num-box"><b id="mpVot">…</b><span>votações<br>registradas</span></div>
      <a class="num-box" id="mpDesp" style="text-decoration:none;color:inherit"><b>💰</b><span>despesas<br>(site oficial)</span></a>
    </div>
    ${p.email ? `<div class="mini-linha">✉️ <a href="mailto:${esc(p.email)}" style="color:var(--gold);word-break:break-all">${esc(p.email)}</a></div>` : ''}
    ${p.legislatura ? `<div class="mini-linha muted">📅 Legislatura atual: ${esc(p.legislatura)}º</div>` : ''}
    ${p.education ? `<div class="mini-linha muted">🎓 ${esc(p.education)}</div>` : ''}
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

/* ===== NOTÍCIAS (manchetes reais dos feeds do servidor) ===== */
let notFiltro = store.get('mb_not_uf') || '';
async function carregarNoticias() {
  renderChipsNot();
  const box = $('#listaNot');
  box.innerHTML = Array(4).fill('<div class="not-card"><span class="sk" style="display:block;width:30%;height:11px;margin-bottom:8px"></span><span class="sk" style="display:block;width:90%;height:15px;margin-bottom:6px"></span><span class="sk" style="display:block;width:60%;height:11px"></span></div>').join('');
  const r = await api('/api/noticias' + (notFiltro ? '?uf=' + encodeURIComponent(notFiltro) : ''));
  if (!r.ok && r.__status !== 200) { box.innerHTML = `<div class="vazio"><div class="ico">📡</div>${esc(r.error || 'Não foi possível carregar as notícias.')}</div>`; return; }
  const lista = r.noticias || [];
  $('#notTs').textContent = lista.length ? 'última coleta às ' + new Date(r.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  if (!lista.length) { box.innerHTML = '<div class="vazio"><div class="ico">🗞️</div>Nenhuma manchete carregada agora — tente novamente em instantes.</div>'; return; }
  box.innerHTML = lista.slice(0, 40).map(n => `
    <a class="not-card" href="${esc(n.l)}" target="_blank" rel="noopener">
      <div class="not-meta"><b>${esc(n.fonte || '')}</b>${n.uf && n.uf !== 'BR' ? `<span class="badge-num">${esc(n.uf)}</span>` : ''}<span class="muted">${n.dt ? hora(new Date(n.dt).getTime()) : ''}</span></div>
      <h3>${esc(n.t)}</h3>
      ${n.res ? `<p>${esc(n.res)}</p>` : ''}
      <span class="muted" style="font-size:11px">Ler na fonte ↗</span>
    </a>`).join('');
}
function renderChipsNot() {
  const chips = [{ id: '', rot: 'Nacionais' }];
  if (state.uf) chips.push({ id: state.uf, rot: 'Minha UF · ' + state.uf });
  chips.push({ id: 'SP', rot: 'SP' }, { id: 'RJ', rot: 'RJ' }, { id: 'MG', rot: 'MG' }, { id: 'BA', rot: 'BA' }, { id: 'RS', rot: 'RS' }, { id: 'PR', rot: 'PR' });
  $('#chipsNot').innerHTML = chips.map(c =>
    `<button class="chip${notFiltro === c.id ? ' active' : ''}" data-nf="${esc(c.id)}">${esc(c.rot)}</button>`).join('');
  document.querySelectorAll('#chipsNot .chip').forEach(ch => ch.addEventListener('click', () => {
    notFiltro = ch.dataset.nf;
    store.set('mb_not_uf', notFiltro);
    carregarNoticias();
  }));
}

/* ===== MEU VOTO ===== */
function renderMeuVoto() {
  const visiveis = cargosVisiveis();
  const feitos = visiveis.filter(c => state.myVotes[c.id]).length;
  const faltam = visiveis.length - feitos;
  let resumo = '';
  /* v21 — comprovante da cédula completa salvo no aparelho */
  if (state.comprovante && state.comprovante.codigo) {
    const cp = state.comprovante;
    resumo += `<div class="card" style="border-color:var(--gold)">
      <b style="font-size:13.5px">🧾 Comprovante guardado neste aparelho</b>
      <p class="muted" style="font-size:11.5px;margin:4px 0 8px">Código único de ${Object.keys(cp.cargos || {}).length || feitos} cargo(s) · registrado em ${new Date(cp.data).toLocaleDateString('pt-BR')} ${hora(cp.data)}</p>
      <div class="cd" style="font-size:15px">${esc(formatarCodigo(cp.codigo))}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn btn-gold" id="mvCopiar" style="flex:1;min-height:40px;font-size:12.5px">📋 Copiar</button>
        <button class="btn btn-ghost" id="mvConferir" style="flex:1;min-height:40px;font-size:12.5px">🔍 Conferir ↗</button>
        <button class="btn btn-ghost" id="mvCompartilhar" style="flex:1;min-height:40px;font-size:12.5px">↗ Compartilhar</button>
      </div>
      <button class="btn btn-ghost" id="mvDeNovo" style="width:100%;min-height:38px;font-size:12px;margin-top:8px;color:var(--blueL)">🔄 Votar de novo (demonstração)</button>
    </div>`;
  } else if (countRascunho()) {
    resumo += `<div class="aviso-site"><b>🗳️ Cédula em montagem: ${countRascunho()} de ${visiveis.length} cargos escolhidos</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">Abra a aba Votar e toque em “Revisar cédula” para gerar seu código.</p></div>`;
  }
  if (feitos === visiveis.length) {
    resumo += `<div class="aviso-site" style="border-color:var(--gold);margin-bottom:10px">
      <b>🏆 Você votou em todos os ${visiveis.length} cargos!</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 10px">Sua opinião está registrada na simulação. Chame mais gente para votar também:</p>
      <button class="btn btn-gold" id="btnCompartilharApp" style="width:100%">Compartilhar o MudaBrasil ↗</button>
    </div>`;
  } else if (feitos > 0) {
    resumo += `<div class="aviso-site"><b>Faltam ${faltam} cargo${faltam > 1 ? 's' : ''} para completar sua votação</b>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">Toque num cargo abaixo para votar.</p></div>`;
  }
  $('#meusLista').innerHTML = resumo + visiveis.map(cfg => {
    const v = state.myVotes[cfg.id];
    const ras = state.rascunho[cfg.id];
    const cand = v && v.candidato;
    return `<div class="meu-item" data-cargo="${cfg.id}" style="cursor:pointer">
      <div class="cg">
        <b>${esc(cfg.nome)}</b>
        ${v
          ? `<span>✓ ${esc(cand ? cand.nome : 'voto registrado')}${cand ? ' · ' + esc(cand.partido) + '-' + esc(cand.uf) + ' · nº ' + esc(cand.numero) : ''}</span>`
          : ras
            ? `<span style="color:var(--gold)">● na cédula: ${esc(ras.nome)} <i class="muted">(ainda não registrado)</i></span>`
            : '<span class="muted">Você ainda não votou neste cargo</span>'}
      </div>
      <span class="st" style="color:${v ? 'var(--green)' : (ras ? 'var(--gold)' : 'var(--muted)')}">${v ? '✓' : (ras ? '●' : '—')}</span>
    </div>`;
  }).join('') + (feitos < visiveis.length ? `<p class="muted" style="text-align:center;font-size:11.5px;margin-top:6px">Toque num cargo para votar</p>` : '') + linksConferir();
  document.querySelectorAll('#meusLista [data-cargo]').forEach(el =>
    el.addEventListener('click', () => { state.cargo = el.dataset.cargo; listState.pagina = 1; go('votar'); }));
  $('#btnCompartilharApp')?.addEventListener('click', compartilharApp);
  $('#mvCopiar')?.addEventListener('click', async () => {
    const ok = await copiarTexto(formatarCodigo(state.comprovante.codigo));
    toast(ok ? 'Código copiado! 📋' : 'Selecione e copie o código na tela', ok ? 'ok' : 'err');
  });
  $('#mvConferir')?.addEventListener('click', () => window.open(SITE_URL + '/#conferir-voto', '_blank'));
  $('#mvCompartilhar')?.addEventListener('click', () => compartilharTexto(
    'Votei (simulação cívica) no MudaBrasil 🇧🇷 — código único da minha cédula: ' + formatarCodigo(state.comprovante.codigo) + '. Confira: ' + SITE_URL + '/#conferir-voto'));
  $('#mvDeNovo')?.addEventListener('click', abrirDemonstracao);
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
  if (ok) { toast('Copiado! Cole para compartilhar 📋', 'ok'); return; }
  /* nem clipboard nem execCommand: mostra o texto na tela para copiar à mão */
  openSheet(`
    <h3 class="titles" style="text-align:center">Compartilhar</h3>
    <p class="muted" style="font-size:12.5px;text-align:center">Seu navegador bloqueou a cópia automática. Toque no texto, selecione e copie:</p>
    <textarea readonly id="shTxt" style="width:100%;min-height:110px;background:var(--bg);border:1px solid var(--line);border-radius:10px;color:#e8f0fe;padding:10px;font-size:13px;resize:none;line-height:1.5">${esc(txt)}</textarea>
    <div class="sheet-actions"><button class="btn btn-ghost" id="shFechar">FECHAR</button></div>`);
  const ta = $('#shTxt');
  ta.focus();
  ta.select();
  $('#shFechar').addEventListener('click', closeSheet);
}

/* convite ao app — aparece quando o usuário completa a cédula */
async function compartilharApp() {
  await compartilharTexto('Estou votando na simulação do MudaBrasil 🇧🇷 — candidatos reais do TSE e apuração aberta. Vote também: ' + SITE_URL + '/app/');
}
$('#btnAbrirSite').addEventListener('click', () => window.open(SITE_URL + '/', '_blank'));

/* ===== AJUDA (FAQ) ===== */
const FAQ = [
  ['O que é simulação?', 'A votação não tem valor jurídico hoje. Notícias, políticos e PLs são reais.'],
  ['Posso mudar meu voto?', 'No app você troca livremente a cédula até gerar o código; depois use “Votar de novo (demonstração)” enquanto for simulação.'],
  ['Como vejo os candidatos do meu estado?', 'Em Governador, Senador ou Deputado, escolha seu estado no seletor acima da lista. Pode também buscar pelo nome ou número.'],
  ['Por que a lista de deputado é tão grande?', 'Porque todos os candidatos oficiais do TSE aparecem. Role que o app carrega mais sozinho, ou use a busca para achar pelo nome/número.'],
  ['Quem pode responder reclamações?', 'Só o político/candidato com identidade verificada (selo), no site completo.'],
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

/* contagem regressiva da eleição real — a Apuração do app é a simulação,
   os resultados oficiais são do TSE e só existem no dia da votação */
function diasAte(iso) {
  return Math.round((new Date(iso + 'T00:00:00-03:00') - new Date(hojeBR() + 'T00:00:00-03:00')) / 86400000);
}
function atualizarApuPrazo() {
  const el = document.getElementById('apuPrazo');
  if (!el) return;
  const d1 = diasAte('2026-10-04'), d2 = diasAte('2026-10-25');
  const link = '<a href="https://resultados.tse.jus.br/" target="_blank" rel="noopener" style="color:var(--gold);font-weight:600">resultados oficiais no TSE ↗</a>';
  const sim = 'Abaixo, os votos da <b>simulação do MudaBrasil</b>.';
  let txt;
  if (d1 > 1) txt = `⏳ A eleição real começa em <b>${d1} dias</b> — 1º turno em 04/10, 2º turno em 25/10. ${sim} ${link} saem no dia da votação.`;
  else if (d1 === 1) txt = `⏳ A eleição real é <b>amanhã</b> (1º turno, 04/10). ${sim} ${link} saem no dia da votação.`;
  else if (d1 === 0) txt = `🗳️ Hoje é o 1º turno da eleição real! Acompanhe os ${link} ${sim}`;
  else if (d2 > 0) txt = `⏳ 2º turno da eleição real em <b>${d2} dias</b> (25/10). ${link} ${sim}`;
  else if (d2 === 0) txt = `🗳️ Hoje é o 2º turno da eleição real! Acompanhe os ${link} ${sim}`;
  else txt = `✅ Eleição encerrada — veja os ${link} ${sim}`;
  el.innerHTML = txt;
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
/* banner de instalar: some ao fechar e não volta mais (flag persistente) */
function mostrarBannerInstall() {
  if (store.get('mb_install_dismissed')) return;
  $('#installBanner').classList.add('on');
}
function esconderBannerInstall() { $('#installBanner').classList.remove('on'); }
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  if ($('#s-menu').classList.contains('active')) mostrarBannerInstall();
});
window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  store.set('mb_install_dismissed', '1');
  esconderBannerInstall();
  toast('App instalado! 🎉', 'ok');
});
$('#btnBannerX').addEventListener('click', () => { store.set('mb_install_dismissed', '1'); esconderBannerInstall(); });
$('#btnBannerInstall').addEventListener('click', instalar);
$('#btnInstalar').addEventListener('click', instalar);
function instalar() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.finally(() => { deferredPrompt = null; esconderBannerInstall(); });
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
  atualizarApuPrazo();
  loadMeusVotos();
  window.__appReady = true; /* rede de segurança no index.html confere esta flag */
})();
