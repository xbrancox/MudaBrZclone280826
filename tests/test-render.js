const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 8099;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(req.url.split('?')[0]);
      if (urlPath === '/') urlPath = '/index.html';
      let filePath = path.join(ROOT, urlPath);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.writeHead(404); return res.end('Not Found');
      }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(PORT, () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message));

  const base = `http://localhost:${PORT}`;
  const pages = ['/index.html', '/pages/candidatos.html', '/pages/proposta.html',
                 '/pages/status.html', '/pages/revogar.html', '/pages/comunidade.html'];
  const results = {};

  for (const p of pages) {
    try {
      await page.goto(base + p, { waitUntil: 'networkidle', timeout: 15000 });
      const title = await page.title();
      results[p] = { title, status: 'ok' };
    } catch (e) {
      results[p] = { status: 'FAIL', error: e.message };
    }
  }

  // ===== Testes funcionais na página de Candidatos =====
  await page.goto(base + '/pages/candidatos.html', { waitUntil: 'networkidle' });

  // 1) Cards renderizados
  const cardCount = await page.locator('.candidate-card').count();
  results['cards-renderizados'] = cardCount;

  // 2) Contagem de resultados
  const resultText = await page.locator('#result-count').textContent();
  results['result-count'] = resultText.trim();

  // 3) Busca por "Saúde"
  await page.fill('#search-input', 'Saúde');
  await page.waitForTimeout(200);
  const searchResults = await page.locator('.candidate-card .candidate-name').allTextContents();
  results['busca-saude'] = searchResults;

  // 4) Limpa busca, filtra por estado SP
  await page.fill('#search-input', '');
  await page.selectOption('#filter-state', 'SP');
  await page.waitForTimeout(200);
  const spNames = await page.locator('.candidate-card .candidate-name').allTextContents();
  results['filtro-SP'] = spNames;
  await page.selectOption('#filter-state', 'all');
  await page.waitForTimeout(150);

  // 5) Ordenar por processos (menor)
  await page.selectOption('#sort-select', 'lawsuits:asc');
  await page.waitForTimeout(200);
  const sortedFirst = await page.locator('.candidate-card .candidate-name').first().textContent();
  results['ord-processos-menor-top1'] = sortedFirst.trim();

  // 6) Abrir detalhes do primeiro candidato
  await page.locator('[data-detail]').first().click();
  await page.waitForTimeout(300);
  const detailVisible = await page.locator('#detail-modal').isVisible();
  const detailHasTable = await page.locator('#detail-body .data-table').count();
  results['modal-detalhes'] = { visible: detailVisible, hasTable: detailHasTable > 0 };
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 7) Selecionar 2 candidatos para comparar
  await page.locator('input[data-compare]').nth(0).check();
  await page.locator('input[data-compare]').nth(1).check();
  await page.waitForTimeout(200);
  await page.locator('#compare-open').click();
  await page.waitForTimeout(300);
  const compareVisible = await page.locator('#compare-modal').isVisible();
  const compareRows = await page.locator('#compare-body .compare-table tbody tr').count();
  const bestMarks = await page.locator('#compare-body td.best').count();
  results['modal-comparacao'] = { visible: compareVisible, rows: compareRows, bestMarks };
  await page.screenshot({ path: 'test-compare.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // 8) Screenshot da home
  await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-home.png', fullPage: true });

  // 9) Screenshot da página de candidatos
  await page.goto(base + '/pages/candidatos.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-candidatos.png', fullPage: true });

  await browser.close();
  server.close();

  console.log('========== RESULTADOS DO TESTE ==========');
  console.log(JSON.stringify(results, null, 2));
  console.log('\n========== ERROS DE CONSOLE/PAGE ==========');
  if (errors.length === 0) console.log('✅ Nenhum erro de console.');
  else errors.forEach(e => console.log(e));
  console.log('\n========== FIM ==========');
})().catch(e => { console.error('TESTE FALHOU:', e); process.exit(1); });
