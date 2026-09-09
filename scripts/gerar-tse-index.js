/* ============================================================
   Gera data/tse-index.json — índice leve (nome de urna + UF →
   candidaturas 2026: nº na urna, cargo e situação) a partir do
   snapshot candidatos-2026. Usado pelo Radar Político para o
   "Nº do candidato" sem carregar os ~4,5MB do snapshot no
   navegador. Regerar após atualizar o snapshot:
   node scripts/gerar-tse-index.js
   ============================================================ */
const fs = require('fs');
const path = require('path');

const SNAP = path.join(__dirname, '..', 'data', 'candidatos-2026.json');
const OUT = path.join(__dirname, '..', 'data', 'tse-index.json');

const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

const snap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
const idx = {};
let multi = 0;

(snap.candidatos || []).forEach(c => {
  const key = norm(c.nomeUrna) + '|' + String(c.uf || '').toUpperCase();
  const e = { n: String(c.numero || ''), s: c.situacao || '', c: Number(c.cargo) || 0 };
  if (!idx[key]) { idx[key] = [e]; return; }
  /* mesma pessoa (mesmo nome de urna + UF) com candidatura já registrada */
  if (idx[key].some(x => x.n === e.n && x.c === e.c)) return;
  idx[key].push(e);
  if (idx[key].length === 2) multi++;
});

/* ordena candidaturas: primeiro o mesmo cargo do mandato (sen=5, dep=6),
   depois os demais — evita que um senador candidato a governador apareça
   primeiro com o nº de governador na ficha de senador */
function ordena(arr) {
  return arr.slice().sort((a, b) => peso(a) - peso(b));
  function peso(e) { return (e.c === 5 || e.c === 6) ? 0 : 1; }
}
Object.keys(idx).forEach(k => { idx[k] = ordena(idx[k]); });

const out = {
  fonte: 'TSE · DivulgaCand — snapshot candidatos-2026.json',
  extraidoEm: snap.extraidoEm || null,
  total: Object.keys(idx).length,
  idx
};
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('tse-index.json gerado:', out.total, 'nomes,', multi, 'com +1 candidatura');
