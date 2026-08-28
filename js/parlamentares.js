/* ============================================================
   MUDABRASIL — PARLAMENTARES
   Página unificada: Candidatos + Radar Político + Rankings
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     ESTADO GLOBAL
     ============================================================ */

  const state = {
    politicians: [],         // Lista bruta
    politiciansFull: {},     // Map id -> objeto completo
    verifications: {},       // Map id -> { verified, domain, ... }
    stats: {},               // Map id -> { complaints, supports, ... }
    rankings: null,          // Rankings cache
    globalStats: null,
    view: 'grid',            // 'grid' | 'list'
    activeTab: 'all',        // 'all' | 'radar' | 'ranking'
    radarFilter: 'all',      // 'all' | 'complaints' | 'supports' | 'responses'
    currentProfile: null,    // ID do político no modal
    session: window.MBSession || null
  };

  /* ============================================================
     UTILITÁRIOS
     ============================================================ */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') e.className = attrs[k];
        else if (k === 'innerHTML') e.innerHTML = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (k === 'dataset') Object.assign(e.dataset, attrs[k]);
        else if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      }
    }
    children.forEach(c => {
      if (c == null) return;
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else e.appendChild(c);
    });
    return e;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function initials(name) {
    if (!name) return '?';
    return name.trim().split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase();
  }

  function timeAgo(timestamp) {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const min = 60 * 1000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return 'agora';
    if (diff < hour) return Math.floor(diff / min) + 'min';
    if (diff < day) return Math.floor(diff / hour) + 'h';
    if (diff < 30 * day) return Math.floor(diff / day) + 'd';
    return new Date(timestamp).toLocaleDateString('pt-BR');
  }

  function getSourceLinks(p) {
    const links = [];
    const position = p.position || '';
    if (position.includes('Senador') || (p.id && p.id.startsWith('senado-'))) {
      links.push({ label: 'Senado Federal', url: 'https://www25.senado.leg.br/web/senadores/senador/-/perfil/' + p.id.replace('senado-', ''), icon: '🏛️' });
    } else {
      links.push({ label: 'Câmara dos Deputados', url: 'https://www.camara.leg.br/deputados/' + (p.id || '').replace('camara-', ''), icon: '🏛️' });
    }
    if (p.id && p.id.startsWith('camara-')) {
      links.push({ label: 'Transparência Câmara', url: 'https://www.camara.leg.br/transparencia/', icon: '📊' });
      links.push({ label: 'Portal da Transparência', url: 'https://portaldatransparencia.gov.br/busca?p_p_id=resultado&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&p_p_col_id=column-2&p_p_col_count=1&_resultado_groupId=10&_resultado_keywords=' + encodeURIComponent(p.name), icon: '🔎' });
    }
    if (p.id && p.id.startsWith('senado-')) {
      links.push({ label: 'Portal da Transparência', url: 'https://portaldatransparencia.gov.br/busca?p_p_id=resultado&p_p_lifecycle=0&p_p_state=normal&p_p_mode=view&p_p_col_id=column-2&p_p_col_count=1&_resultado_groupId=10&_resultado_keywords=' + encodeURIComponent(p.name), icon: '🔎' });
    }
    links.push({ label: 'TSE', url: 'https://www.tse.jus.br/eleicoes/eleicoes-anteriores/eleicoes-2022/candidaturas-2022', icon: '🗳️' });
    return links;
  }

  function getBirthDate(p) {
    return p.dataNascimento || p.nascimento || p.birthDate || null;
  }

  function getEducation(p) {
    return p.escolaridade || p.education || null;
  }

  /* ============================================================
     CARREGAR DADOS
     ============================================================ */

  async function loadAll() {
    try {
      // Carrega candidatos reais
      const res = await fetch('/api/candidatos');
      const data = await res.json();
      if (data.candidatos && data.candidatos.length > 0) {
        state.politicians = data.candidatos;
        state.politiciansFull = {};
        data.candidatos.forEach(c => { state.politiciansFull[c.id] = c; });
      }
    } catch (e) {
      console.warn('[parlamentares] Erro ao buscar /api/candidatos:', e.message);
    }

    // Carrega verificações
    try {
      const res = await fetch('/api/verificacao/stats');
      const data = await res.json();
      // Stats agregados, sem detalhes por político
    } catch (e) { /* sem stats */ }

    // Carrega rankings + stats globais
    try {
      const res = await fetch('/api/rankings');
      const data = await res.json();
      if (data.rankings) state.rankings = data.rankings;
      if (data.stats) state.globalStats = data.stats;
    } catch (e) { /* sem rankings */ }

    // Carrega stats por político
    await loadAllStats();

    // Stats do hero
    updateHeroStats();
  }

  async function loadAllStats() {
    if (state.politicians.length === 0) return;
    state.stats = {};
    const promises = state.politicians.slice(0, 100).map(async (p) => {
      try {
        const res = await fetch('/api/estatisticas/politico/' + encodeURIComponent(p.id));
        const data = await res.json();
        if (data.stats) state.stats[p.id] = data.stats;
      } catch (e) { /* skip */ }
    });
    await Promise.allSettled(promises);
  }

  function updateHeroStats() {
    $('#totalPoliticians').textContent = state.politicians.length || 0;
    if (state.globalStats) {
      $('#totalVerified').textContent = state.globalStats.verifiedPoliticians || 0;
      $('#totalComplaints').textContent = state.globalStats.totalComplaints || 0;
      $('#totalSupports').textContent = state.globalStats.totalSupports || 0;
    } else {
      $('#totalVerified').textContent = '0';
      $('#totalComplaints').textContent = '0';
      $('#totalSupports').textContent = '0';
    }
  }

  /* ============================================================
     POPULAR FILTROS
     ============================================================ */

  function populateFilters() {
    const states = new Set();
    const parties = new Set();
    state.politicians.forEach(p => {
      if (p.state) states.add(p.state);
      if (p.party) parties.add(p.party);
    });

    const stateSelect = $('#filterState');
    const partySelect = $('#filterParty');

    Array.from(states).sort().forEach(s => {
      const opt = el('option', { value: s }, s);
      stateSelect.appendChild(opt);
    });
    Array.from(parties).sort().forEach(p => {
      const opt = el('option', { value: p }, p);
      partySelect.appendChild(opt);
    });
  }

  /* ============================================================
     BUSCA + FILTROS
     ============================================================ */

  function applyFilters() {
    const search = ($('#searchInput').value || '').toLowerCase().trim();
    const stateFilter = $('#filterState').value;
    const partyFilter = $('#filterParty').value;
    const positionFilter = $('#filterPosition').value;
    const verifiedFilter = $('#filterVerified').value;
    const sortBy = $('#sortBy').value;

    let list = state.politicians.slice();

    if (search) {
      list = list.filter(p =>
        (p.name || '').toLowerCase().includes(search) ||
        (p.party || '').toLowerCase().includes(search) ||
        (p.state || '').toLowerCase().includes(search) ||
        (p.focusArea || '').toLowerCase().includes(search)
      );
    }
    if (stateFilter) list = list.filter(p => p.state === stateFilter);
    if (partyFilter) list = list.filter(p => p.party === partyFilter);
    if (positionFilter) list = list.filter(p => p.position === positionFilter);
    if (verifiedFilter === '1') {
      list = list.filter(p => state.stats[p.id] && state.stats[p.id].verified);
    }

    // Ordenação
    const [field, order] = sortBy.split(':');
    const dir = order === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      let va, vb;
      if (field === 'satisfaction' || field === 'complaints' || field === 'supports') {
        va = (state.stats[a.id] && state.stats[a.id][field]) || 0;
        vb = (state.stats[b.id] && state.stats[b.id][field]) || 0;
      } else {
        va = a[field];
        vb = b[field];
      }
      const aNull = va == null, bNull = vb == null;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof va === 'string') return dir * String(va).localeCompare(String(vb), 'pt-BR');
      return dir * (va - vb);
    });

    $('#resultCount').textContent = list.length + ' parlamentar' + (list.length !== 1 ? 'es' : '');
    return list;
  }

  /* ============================================================
     RENDERIZAÇÃO DOS CARDS
     ============================================================ */

  function renderCard(p) {
    const stats = state.stats[p.id] || {};
    const verified = stats.verified || false;
    const complaints = stats.complaints || 0;
    const supports = stats.supports || 0;
    const total = complaints + supports;
    const satPct = total > 0 ? (supports / total) * 100 : 50;

    const isSenador = (p.position || '').includes('Senador') || (p.id && p.id.startsWith('senado-'));

    const card = el('div', {
      className: 'p-card',
      onclick: () => openProfile(p.id)
    });

    const header = el('div', { className: 'p-card__header' });

    const avatar = el('div', { className: 'p-card__avatar' });
    if (p.photo) {
      avatar.appendChild(el('img', { src: p.photo, alt: p.name, loading: 'lazy', onerror: (e) => { e.target.parentNode.innerHTML = initials(p.name); } }));
    } else {
      avatar.textContent = initials(p.name);
    }

    const info = el('div', { className: 'p-card__info' });
    info.appendChild(el('div', { className: 'p-card__name', title: p.name }, p.name || '—'));
    info.appendChild(el('div', { className: 'p-card__role' }, p.position || 'Parlamentar'));

    const badge = el('span', {
      className: 'p-card__badge ' + (isSenador ? 'p-card__badge--senador' : 'p-card__badge--deputy')
    }, isSenador ? 'SEN' : 'DEP');

    header.appendChild(avatar);
    header.appendChild(info);
    header.appendChild(badge);
    card.appendChild(header);

    if (verified) {
      card.appendChild(el('div', { className: 'p-card__verified' }, '✅ Verificado'));
    }

    const meta = el('div', { className: 'p-card__meta' });
    if (p.party) {
      const item = el('div', { className: 'p-card__meta-item' });
      item.appendChild(el('span', { className: 'p-card__meta-label' }, 'Partido'));
      item.appendChild(el('span', { className: 'p-card__meta-value' }, p.party));
      meta.appendChild(item);
    }
    if (p.state) {
      const item = el('div', { className: 'p-card__meta-item' });
      item.appendChild(el('span', { className: 'p-card__meta-label' }, 'UF'));
      item.appendChild(el('span', { className: 'p-card__meta-value' }, p.state));
      meta.appendChild(item);
    }
    card.appendChild(meta);

    // Satisfaction bar
    if (total > 0) {
      const satContainer = el('div', { className: 'p-card__satisfaction' });
      const bar = el('div', { className: 'sat-bar' });
      const supportFill = el('div', { className: 'sat-bar__fill sat-bar__fill--support' });
      supportFill.style.width = satPct + '%';
      bar.appendChild(supportFill);
      if (complaints > 0) {
        const compFill = el('div', { className: 'sat-bar__fill sat-bar__fill--complaint' });
        compFill.style.width = (100 - satPct) + '%';
        bar.appendChild(compFill);
      }
      satContainer.appendChild(bar);
      const counts = el('div', { style: 'display:flex;justify-content:space-between;margin-top:4px;font-size:11px;color:var(--text-muted);' });
      counts.appendChild(el('span', null, '💚 ' + supports));
      counts.appendChild(el('span', null, '⚠️ ' + complaints));
      satContainer.appendChild(counts);
      card.appendChild(satContainer);
    }

    // Action buttons (visíveis no hover)
    if (state.session) {
      const actions = el('div', { className: 'p-card__actions' });
      actions.appendChild(el('button', {
        className: 'btn-card btn-card--danger',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); openProfile(p.id, 'complaint'); }
      }, '⚠️ Reclamar'));
      actions.appendChild(el('button', {
        className: 'btn-card btn-card--success',
        type: 'button',
        onclick: (e) => { e.stopPropagation(); openProfile(p.id, 'support'); }
      }, '💚 Apoiar'));
      card.appendChild(actions);
    }

    return card;
  }

  function renderListItem(p) {
    return renderCard(p); // mesmo componente
  }

  function renderGrid() {
    const list = applyFilters();
    const grid = $('#parliamentaryGrid');
    grid.innerHTML = '';
    grid.className = 'grid ' + (state.view === 'list' ? 'grid--list' : 'grid--cards');

    if (list.length === 0) {
      $('#emptyState').classList.remove('hidden');
      return;
    }
    $('#emptyState').classList.add('hidden');

    const render = state.view === 'list' ? renderListItem : renderCard;
    list.forEach(p => grid.appendChild(render(p)));
  }

  /* ============================================================
     RADAR FEED
     ============================================================ */

  async function loadRadarFeed() {
    const feed = $('#radarFeed');
    feed.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Carregando…</div>';
    try {
      const res = await fetch('/api/reclamacoes?limit=40');
      const data = await res.json();
      const list = data.complaints || [];
      feed.innerHTML = '';
      if (list.length === 0) {
        feed.innerHTML = '<div class="empty"><div class="empty__icon">📡</div><h3>Sem movimentações ainda</h3><p>Quando houver reclamações, apoios e respostas, elas aparecerão aqui em tempo real.</p></div>';
        return;
      }
      list.forEach(c => feed.appendChild(renderFeedItem(c)));
    } catch (e) {
      feed.innerHTML = '<div class="empty"><div class="empty__icon">⚠️</div><h3>Erro ao carregar</h3><p>' + escapeHtml(e.message) + '</p></div>';
    }
  }

  function renderFeedItem(c) {
    const item = el('div', { className: 'feed-item' });
    const av = el('div', { className: 'feed-item__avatar' });
    if (c.politician && c.politician.photo) {
      av.appendChild(el('img', { src: c.politician.photo, alt: c.politician.name, style: 'width:100%;height:100%;object-fit:cover;', onerror: function () { this.parentNode.textContent = initials(c.politician.name); } }));
    } else {
      av.textContent = c.politician ? initials(c.politician.name) : '?';
    }
    item.appendChild(av);

    const body = el('div', { className: 'feed-item__body' });
    const header = el('div', { className: 'feed-item__header' });
    if (c.politician) {
      header.appendChild(el('span', { className: 'feed-item__name' }, c.politician.name));
      if (c.politician.party) header.appendChild(el('span', { className: 'feed-item__party' }, '· ' + c.politician.party));
    }
    const isResponse = !!c.response;
    const typeClass = isResponse ? 'feed-item__type--response' : (c.status === 'responded' ? 'feed-item__type--response' : (c.responded ? 'feed-item__type--response' : 'feed-item__type--complaint'));
    header.appendChild(el('span', { className: 'feed-item__type ' + typeClass }, isResponse ? '💬 Resposta' : '⚠️ Reclamação'));
    header.appendChild(el('span', { className: 'feed-item__time' }, timeAgo(c.createdAt)));
    body.appendChild(header);

    if (!isResponse) {
      body.appendChild(el('div', { className: 'feed-item__content' }, c.content));
    }
    if (c.response) {
      body.appendChild(el('div', { className: 'feed-item__response' }, '💬 ' + c.response.content));
    }
    item.appendChild(body);
    return item;
  }

  /* ============================================================
     RANKINGS
     ============================================================ */

  function renderRankings() {
    if (!state.rankings) return;
    renderRankingList('rankMostComplaints', state.rankings.mostComplaints || [], 'complaints', 'bad');
    renderRankingList('rankMostSupports', state.rankings.mostSupports || [], 'supports', 'good');
    renderRankingList('rankBestSatisfaction', state.rankings.bestSatisfaction || [], 'satisfaction', 'good', true);
    renderRankingList('rankBestResponse', state.rankings.bestResponseRate || [], 'responseRate', 'good', false, true);
  }

  function renderRankingList(id, list, scoreKey, scoreClass, isPercent, isPercent2) {
    const ol = $('#' + id);
    ol.innerHTML = '';
    list.forEach(p => {
      let score = p[scoreKey] || 0;
      let display = score;
      if (isPercent || isPercent2) display = Math.round(score * 100) + '%';
      const li = el('li', {
        onclick: () => openProfile(p.id)
      });
      const info = el('div', { className: 'ranking-item__info' });
      info.appendChild(el('div', { className: 'ranking-item__name' }, p.name));
      info.appendChild(el('div', { className: 'ranking-item__meta' }, (p.party || '') + ' · ' + (p.state || '')));
      li.appendChild(info);
      li.appendChild(el('div', { className: 'ranking-item__score ranking-item__score--' + scoreClass }, display));
      ol.appendChild(li);
    });
    if (list.length === 0) {
      ol.innerHTML = '<li style="cursor:default;border:none;"><span style="color:var(--text-muted);font-size:var(--text-sm);">Sem dados suficientes ainda</span></li>';
    }
  }

  /* ============================================================
     MODAL DE PERFIL
     ============================================================ */

  async function openProfile(politicianId, actionType) {
    const p = state.politiciansFull[politicianId];
    if (!p) return;

    state.currentProfile = politicianId;
    const modal = $('#profileModal');
    const content = $('#profileContent');

    // Renderiza estrutura básica
    content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-muted);">Carregando perfil…</div>';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    // Carrega detalhes + reclamações + apoios
    const [detailRes, complaintsRes, supportsRes] = await Promise.allSettled([
      fetch('/api/estatisticas/politico/' + encodeURIComponent(politicianId)),
      fetch('/api/reclamacoes?politicianId=' + encodeURIComponent(politicianId) + '&limit=20'),
      fetch('/api/apoios?politicianId=' + encodeURIComponent(politicianId) + '&limit=20')
    ]);

    const stats = detailRes.status === 'fulfilled' && detailRes.value.ok ? (await detailRes.value.json()).stats : {};
    const complaints = complaintsRes.status === 'fulfilled' ? (await complaintsRes.value.json()).complaints || [] : [];
    const supports = supportsRes.status === 'fulfilled' ? (await supportsRes.value.json()).supports || [] : [];

    content.innerHTML = '';
    content.appendChild(renderProfileContent(p, stats, complaints, supports));

    if (actionType === 'complaint') selectFormTab('complaint');
    else if (actionType === 'support') selectFormTab('support');
  }

  function renderProfileContent(p, stats, complaints, supports) {
    const wrap = el('div');

    // Header
    const header = el('div', { className: 'profile-header' });
    const av = el('div', { className: 'profile-avatar' });
    if (p.photo) {
      av.appendChild(el('img', { src: p.photo, alt: p.name, style: 'width:100%;height:100%;object-fit:cover;', onerror: function () { this.parentNode.textContent = initials(p.name); } }));
    } else {
      av.textContent = initials(p.name);
    }
    header.appendChild(av);

    const info = el('div', { className: 'profile-info' });
    info.appendChild(el('h2', { className: 'profile-name', id: 'profileName' }, p.name || '—'));
    info.appendChild(el('div', { className: 'profile-role' }, p.position || 'Parlamentar'));
    const meta = el('div', { className: 'profile-meta' });
    if (p.party) {
      const it = el('div', { className: 'profile-meta-item' });
      it.appendChild(el('span', { className: 'profile-meta-label' }, 'Partido'));
      it.appendChild(el('span', { className: 'profile-meta-value' }, p.party));
      meta.appendChild(it);
    }
    if (p.state) {
      const it = el('div', { className: 'profile-meta-item' });
      it.appendChild(el('span', { className: 'profile-meta-label' }, 'UF'));
      it.appendChild(el('span', { className: 'profile-meta-value' }, p.state));
      meta.appendChild(it);
    }
    if (stats.verified && stats.verification) {
      const it = el('div', { className: 'profile-meta-item' });
      it.appendChild(el('span', { className: 'profile-meta-label' }, 'Verificado em'));
      it.appendChild(el('span', { className: 'profile-meta-value' }, stats.verification.domain || '—'));
      meta.appendChild(it);
    }
    info.appendChild(meta);
    header.appendChild(info);
    wrap.appendChild(header);

    // Selo de verificado
    if (stats.verified) {
      const domain = stats.verification && stats.verification.domain ? stats.verification.domain : '—';
      wrap.appendChild(el('div', { className: 'profile-verified' }, '✅ Selo de verificação · ' + domain));
    }

    // Links oficiais
    const links = el('div', { className: 'profile-links' });
    getSourceLinks(p).forEach(l => {
      links.appendChild(el('a', {
        className: 'profile-link',
        href: l.url,
        target: '_blank',
        rel: 'noopener noreferrer'
      }, (l.icon || '🔗') + ' ' + l.label));
    });
    wrap.appendChild(links);

    // Stats
    const statsDiv = el('div', { className: 'profile-stats' });
    statsDiv.appendChild(statBox(stats.complaints || 0, 'Reclamações', 'danger'));
    statsDiv.appendChild(statBox(stats.supports || 0, 'Apoios', 'success'));
    statsDiv.appendChild(statBox(Math.round((stats.satisfaction || 0) * 100) + '%', 'Satisfação', 'accent'));
    statsDiv.appendChild(statBox(Math.round((stats.responseRate || 0) * 100) + '%', 'Responde', 'accent'));
    wrap.appendChild(statsDiv);

    // Formulário
    if (state.session) {
      const formWrap = el('div', { className: 'profile-form' });
      const tabs = el('div', { className: 'profile-form__tabs' });
      const tabC = el('button', { className: 'profile-form__tab profile-form__tab--complaint profile-form__tab--active', type: 'button', onclick: () => selectFormTab('complaint') }, '⚠️ Reclamação');
      const tabS = el('button', { className: 'profile-form__tab profile-form__tab--support', type: 'button', onclick: () => selectFormTab('support') }, '💚 Apoio');
      tabs.appendChild(tabC);
      tabs.appendChild(tabS);
      formWrap.appendChild(tabs);

      const ta = el('textarea', { className: 'profile-form__textarea', placeholder: 'Escreva aqui… (mínimo 10 caracteres)', id: 'formText' });
      formWrap.appendChild(ta);
      const char = el('div', { className: 'profile-form__char', id: 'formChar' }, '0 / 2000');
      formWrap.appendChild(char);
      ta.addEventListener('input', () => { char.textContent = ta.value.length + ' / 2000'; });

      const submitBtn = el('button', { className: 'btn btn--primary btn--block', type: 'button', id: 'formSubmit' }, 'Enviar');
      submitBtn.addEventListener('click', () => submitForm(p));
      formWrap.appendChild(submitBtn);

      const feedback = el('div', { id: 'formFeedback', style: 'margin-top:10px;font-size:var(--text-sm);' });
      formWrap.appendChild(feedback);
      wrap.appendChild(formWrap);
    } else {
      const loginBanner = el('div', {
        className: 'profile-form',
        style: 'text-align:center;',
        onclick: () => { document.getElementById('authModal').classList.remove('hidden'); }
      });
      loginBanner.appendChild(el('p', { style: 'margin:0;color:var(--text-muted);' }, '🔒 Entre para registrar reclamações ou apoios.'));
      const btn = el('button', { className: 'btn btn--accent', type: 'button' }, 'Entrar');
      loginBanner.appendChild(btn);
      wrap.appendChild(loginBanner);
    }

    // Lista de reclamações + apoios + respostas
    if (complaints.length > 0 || supports.length > 0) {
      const section = el('div', { className: 'profile-section' });
      section.appendChild(el('h3', null, '💬 Vozes dos cidadãos'));

      const list = el('div', { className: 'profile-complaints' });
      const all = [];
      complaints.forEach(c => all.push({ ...c, _type: 'complaint' }));
      supports.forEach(s => all.push({ ...s, _type: 'support' }));
      all.sort((a, b) => b.createdAt - a.createdAt);
      all.forEach(item => list.appendChild(renderComplaintItem(item, p)));
      section.appendChild(list);
      wrap.appendChild(section);
    }

    return wrap;
  }

  function statBox(num, label, variant) {
    const d = el('div', { className: 'profile-stat profile-stat--' + (variant || 'default') });
    d.appendChild(el('div', { className: 'profile-stat__num' }, String(num)));
    d.appendChild(el('div', { className: 'profile-stat__label' }, label));
    return d;
  }

  function renderComplaintItem(item, politician) {
    const div = el('div', { className: 'cmp-item' });
    const isComplaint = item._type === 'complaint';
    div.appendChild(el('span', { className: 'cmp-item__type cmp-item__type--' + item._type }, isComplaint ? '⚠️ Reclamação' : '💚 Apoio'));
    div.appendChild(el('div', { className: 'cmp-item__content' }, item.content));
    div.appendChild(el('div', { className: 'cmp-item__time' }, timeAgo(item.createdAt)));

    if (item.response) {
      div.appendChild(el('div', { className: 'cmp-item__response' }, '💬 Resposta: ' + item.response.content));
    }
    return div;
  }

  function selectFormTab(type) {
    $$('.profile-form__tab').forEach(b => b.classList.remove('profile-form__tab--active'));
    if (type === 'complaint') {
      $$('.profile-form__tab--complaint').forEach(b => b.classList.add('profile-form__tab--active'));
      $('#formText').placeholder = 'Reclamação (mínimo 10 caracteres)…';
    } else {
      $$('.profile-form__tab--support').forEach(b => b.classList.add('profile-form__tab--active'));
      $('#formText').placeholder = 'Apoio/elogio (mínimo 3 caracteres)…';
    }
  }

  async function submitForm(politician) {
    if (!state.session || !state.session.sessionToken) {
      document.getElementById('authModal').classList.remove('hidden');
      return;
    }
    const ta = $('#formText');
    const content = (ta.value || '').trim();
    if (content.length < 3) {
      showFormFeedback('Texto muito curto.', 'error');
      return;
    }
    const isComplaint = $$('.profile-form__tab--complaint').some(b => b.classList.contains('profile-form__tab--active'));
    const endpoint = isComplaint ? '/api/reclamacoes' : '/api/apoios';
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken: state.session.sessionToken,
          politicianId: politician.id,
          content
        })
      });
      const data = await res.json();
      if (data.ok) {
        showFormFeedback('✅ Enviado com sucesso!', 'ok');
        ta.value = '';
        $('#formChar').textContent = '0 / 2000';
        // Recarrega o perfil após 1s
        setTimeout(() => openProfile(politician.id), 800);
      } else {
        showFormFeedback('❌ ' + (data.error || 'Erro ao enviar'), 'error');
      }
    } catch (e) {
      showFormFeedback('❌ Erro: ' + e.message, 'error');
    }
  }

  function showFormFeedback(msg, type) {
    const fb = $('#formFeedback');
    fb.textContent = msg;
    fb.style.color = type === 'ok' ? 'var(--success-400)' : 'var(--danger-400)';
  }

  function closeProfile() {
    $('#profileModal').classList.add('hidden');
    document.body.style.overflow = '';
    state.currentProfile = null;
  }

  /* ============================================================
     EVENT LISTENERS
     ============================================================ */

  function attachListeners() {
    // Filtros
    ['#searchInput', '#filterState', '#filterParty', '#filterPosition', '#filterVerified', '#sortBy'].forEach(sel => {
      const e = $(sel);
      if (e) e.addEventListener('input', renderGrid);
      if (e && e.tagName === 'SELECT') e.addEventListener('change', renderGrid);
    });

    // View toggle
    $$('.view-toggle__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.view-toggle__btn').forEach(b => b.classList.remove('view-toggle__btn--active'));
        btn.classList.add('view-toggle__btn--active');
        state.view = btn.dataset.view;
        renderGrid();
      });
    });

    // Tabs principais
    $$('.tabs__btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tabs__btn').forEach(b => b.classList.remove('tabs__btn--active'));
        btn.classList.add('tabs__btn--active');
        $$('.tab-content').forEach(c => c.classList.remove('tab-content--active'));
        $$('.tab-content').forEach(c => c.classList.add('hidden'));
        const tab = btn.dataset.tab;
        state.activeTab = tab;
        const target = $('#tab-' + tab);
        if (target) {
          target.classList.remove('hidden');
          target.classList.add('tab-content--active');
        }
        if (tab === 'radar') loadRadarFeed();
        if (tab === 'ranking') renderRankings();
      });
    });

    // Radar filter chips
    $$('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        $$('.chip').forEach(c => c.classList.remove('chip--active'));
        chip.classList.add('chip--active');
        state.radarFilter = chip.dataset.radar;
        // Filtra a feed
        $$('.feed-item').forEach(it => {
          const type = it.dataset.type;
          if (state.radarFilter === 'all') it.style.display = '';
          else if (state.radarFilter === 'responses' && type === 'response') it.style.display = '';
          else if (state.radarFilter === 'complaints' && type === 'complaint') it.style.display = '';
          else if (state.radarFilter === 'supports' && type === 'support') it.style.display = '';
          else it.style.display = 'none';
        });
      });
    });

    // Modal close
    $$('[data-close-modal]').forEach(el => el.addEventListener('click', closeProfile));
    $$('[data-close-auth]').forEach(el => {
      el.addEventListener('click', () => {
        $('#authModal').classList.add('hidden');
        document.body.style.overflow = '';
      });
    });

    // ESC fecha modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#profileModal').classList.contains('hidden')) closeProfile();
        else if (!$('#authModal').classList.contains('hidden')) {
          $('#authModal').classList.add('hidden');
          document.body.style.overflow = '';
        }
      }
    });
  }

  /* ============================================================
     INICIALIZAÇÃO
     ============================================================ */

  async function init() {
    // Espera o auth.js definir state.session
    document.addEventListener('mb:auth-changed', (e) => {
      state.session = e.detail;
      renderGrid();
    });
    if (window.MBSession) state.session = window.MBSession;

    attachListeners();
    await loadAll();
    populateFilters();
    renderGrid();

    // Atualiza a cada 60s
    setInterval(async () => {
      try {
        const res = await fetch('/api/rankings');
        const data = await res.json();
        if (data.rankings) state.rankings = data.rankings;
        if (data.stats) state.globalStats = data.stats;
        updateHeroStats();
        if (state.activeTab === 'ranking') renderRankings();
        if (state.activeTab === 'radar') loadRadarFeed();
      } catch (e) { /* skip */ }
    }, 60000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
