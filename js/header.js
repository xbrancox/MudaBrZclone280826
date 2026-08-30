/* ============================================================
   MUDABRASIL — HEADER COMPARTILHADO
   Injeta navbar oficial em todas as páginas.
   Deve ser incluido no <head> de cada pagina antes de
   qualquer outro script.
   ============================================================ */

(function () {
  'use strict';

  // ---- CSS do navbar (inline para funcionar em todas as paginas) ----
  const CSS = `
    .mb-header {
      position: sticky; top: 0; z-index: 100;
      background: rgba(14,23,38,0.92);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid rgba(90,107,126,0.28);
    }
    .mb-nav-inner {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 24px; gap: 16px; max-width: 1480px; margin: 0 auto;
    }
    .mb-logo {
      display: flex; align-items: center; gap: 10px;
      font-family: 'Montserrat', sans-serif; font-weight: 800; font-size: 1.15rem;
      color: #fff; text-decoration: none;
    }
    .mb-logo:hover { opacity: 0.9; }
    .mb-nav-links {
      display: flex; align-items: center; gap: 2px;
      list-style: none; margin: 0; padding: 0; flex-wrap: wrap;
    }
    .mb-nav-links a {
      padding: 7px 13px; border-radius: 9999px;
      color: #C6D0DD; font-weight: 600; font-size: 0.82rem;
      transition: all 0.25s; white-space: nowrap; text-decoration: none;
    }
    .mb-nav-links a:hover {
      background: rgba(52,101,164,0.22); color: #fff;
    }
    .mb-nav-links a.mb-active {
      background: linear-gradient(135deg, #3465A4, #2a5090); color: #fff;
    }
    .mb-nav-cta { display: flex; gap: 8px; align-items: center; }
    .mb-btn-entrar {
      background: #3465A4; color: #fff; border: none;
      padding: 9px 22px; border-radius: 9999px;
      font-weight: 700; font-size: 0.82rem; cursor: pointer;
      transition: background 0.2s;
    }
    .mb-btn-entrar:hover { background: #4a7bc2; }
    .mb-btn-cadastrar {
      background: #AECF00; color: #0E1726; border: none;
      padding: 9px 22px; border-radius: 9999px;
      font-weight: 800; font-size: 0.82rem; cursor: pointer;
      transition: filter 0.2s;
    }
    .mb-btn-cadastrar:hover { filter: brightness(1.1); }
    .mb-mobile-toggle { display: none; font-size: 1.6rem; color: #fff; cursor: pointer; }
    @media (max-width: 900px) {
      .mb-nav-links { display: none; }
      .mb-nav-links.mb-open {
        display: flex; flex-direction: column;
        position: absolute; top: 100%; left: 0; right: 0;
        background: #0E1726; padding: 16px;
        border-bottom: 1px solid rgba(90,107,126,0.28);
        z-index: 99;
      }
      .mb-mobile-toggle { display: block; }
      .mb-nav-cta { display: none; }
    }
    @media (max-width: 560px) {
      .mb-btn-entrar, .mb-btn-cadastrar { padding: 7px 14px; font-size: 0.75rem; }
    }
  `;

  // ---- Menu de 7 itens ----
  const NAV_LINKS = [
    { href: 'index.html',         label: 'Início' },
    { href: 'pages/pesquisar.html', label: 'Pesquisar Políticos' },
    { href: 'pages/congresso.html', label: 'Congresso' },
    { href: 'pages/meu-voto.html',  label: 'Meu Voto' },
    { href: 'pages/revogados.html', label: 'Revogados' },
    { href: 'pages/ajuda.html',      label: 'Ajuda' },
    { href: 'pages/quem-somos.html',label: 'Quem Somos' },
  ];

  // ---- Detectar pagina ativa ----
  function getCurrentPage() {
    const path = window.location.pathname;
    const file = path.split('/').pop() || 'index.html';
    // index.html no root
    if (file === 'index.html' && !path.includes('pages/')) return 'index.html';
    // pages/
    const page = file;
    if (page === 'pesquisar.html') return 'pages/pesquisar.html';
    if (page === 'congresso.html') return 'pages/congresso.html';
    if (page === 'meu-voto.html')  return 'pages/meu-voto.html';
    if (page === 'revogados.html')  return 'pages/revogados.html';
    if (page === 'ajuda.html')     return 'pages/ajuda.html';
    if (page === 'quem-somos.html')return 'pages/quem-somos.html';
    return null;
  }

  // ---- Abrir modal de auth ----
  function mbOpenAuth(type) {
    // Tenta via MBAuth (se incluido na pagina)
    if (window.MBAuth && window.MBAuth.openModal) {
      window.MBAuth.openModal();
      return;
    }
    // Tenta via auth-modal no DOM
    const modal = document.getElementById('auth-modal') || document.getElementById('authModal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.hidden = false;
      document.body.style.overflow = 'hidden';
      return;
    }
    // Tenta via MBAuth na pagina
    if (window.MBAuth) { window.MBAuth.openModal(); return; }
    alert('Funcionalidade de login disponível na página principal.');
  }

  // ---- Toggle menu mobile ----
  function mbToggleMenu() {
    const ul = document.getElementById('mb-nav-links');
    if (ul) ul.classList.toggle('mb-open');
  }

  // ---- Injetar CSS ----
  function injectCSS() {
    if (document.getElementById('mb-header-css')) return;
    const style = document.createElement('style');
    style.id = 'mb-header-css';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // ---- Construir HTML do header ----
  function buildHeaderHTML() {
    const current = getCurrentPage();
    const linksHTML = NAV_LINKS.map(link => {
      const isActive = (link.href === current) ||
        (link.href === 'index.html' && current === 'index.html');
      const cls = isActive ? ' class="mb-active"' : '';
      return `<li><a href="${link.href}"${cls}>${link.label}</a></li>`;
    }).join('\n');

    return `
<header class="mb-header">
  <div class="mb-nav-inner">
    <a href="index.html" class="mb-logo" aria-label="MudaBrasil">
      <svg width="36" height="36" viewBox="0 0 40 40" fill="none">
        <defs>
          <linearGradient id="gLHeader" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stop-color="#3465A4"/>
            <stop offset="100%" stop-color="#AECF00"/>
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="18" stroke="url(#gLHeader)" stroke-width="4" fill="none"/>
        <path d="M12 20 L20 12 L28 20 L20 28 Z" fill="url(#gLHeader)"/>
      </svg>
      <span style="background:linear-gradient(135deg,#4a7bc2,#AECF00);-webkit-background-clip:text;-webkit-text-fill-color:transparent">MudaBrasil</span>
    </a>
    <nav>
      <ul class="mb-nav-links" id="mb-nav-links">
        ${linksHTML}
      </ul>
    </nav>
    <div class="mb-nav-cta">
      <button class="mb-btn-entrar" id="mb-entrar-btn">Entrar</button>
      <button class="mb-btn-cadastrar" id="mb-cadastrar-btn">Cadastrar</button>
    </div>
    <span class="mb-mobile-toggle" id="mb-mobile-toggle" role="button" aria-label="Menu">☰</span>
  </div>
</header>`;
  }

  // ---- Injetar no DOM ----
  function mount() {
    // Ja montamos?
    if (document.getElementById('mb-shared-header')) return;

    injectCSS();

    const container = document.createElement('div');
    container.id = 'mb-shared-header';
    container.innerHTML = buildHeaderHTML();

    // Tentar inserir antes do primeiro elemento significativo
    const body = document.body;
    const first = body.firstChild;
    if (first && first.tagName !== 'SCRIPT' && first.tagName !== 'STYLE') {
      body.insertBefore(container, first);
    } else {
      body.insertBefore(container, body.querySelector('main') || body.firstChild);
    }

    // Eventos dos botoes
    const entrarBtn = document.getElementById('mb-entrar-btn');
    const cadastrarBtn = document.getElementById('mb-cadastrar-btn');
    const mobileToggle = document.getElementById('mb-mobile-toggle');

    if (entrarBtn)  entrarBtn.addEventListener('click', () => mbOpenAuth('login'));
    if (cadastrarBtn) cadastrarBtn.addEventListener('click', () => mbOpenAuth('cadastro'));
    if (mobileToggle) mobileToggle.addEventListener('click', mbToggleMenu);

    // Expor funcao para paginas que precisam abrir o modal de fora
    window.mbAbrirModal = mbOpenAuth;
  }

  // ---- Executar ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.mbAbrirModal = mbOpenAuth;
})();
