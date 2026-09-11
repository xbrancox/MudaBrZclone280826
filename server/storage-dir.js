/* ============================================================
   MUDABRASIL - DIRETÓRIO DE DADOS (sobrevive a deploys)
   ------------------------------------------------------------
   No Railway com Volume anexado, a plataforma injeta a variável
   RAILWAY_VOLUME_MOUNT_PATH (ex.: "/data") apontando para um disco
   que PERSISTE entre deploys: votos.db, .salt, caches etc.
   Sem volume (dev/local), tudo fica em server/data como sempre.
   ============================================================ */
const fs = require('fs');
const path = require('path');

const dir = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.MB_DATA_DIR
  || path.join(__dirname, 'data');

/* Arquivos-seed commitados (server/data) servem de ponto de partida
   quando o disco persistente ainda está vazio no primeiro boot —
   evita depender de API externa (Câmara/Senado) na inicialização. */
function seedIfMissing(nome) {
  try {
    const destino = path.join(dir, nome);
    if (fs.existsSync(destino)) return;
    const origem = path.join(__dirname, 'data', nome);
    if (fs.existsSync(origem)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(origem, destino);
    }
  } catch (_) { }
}

module.exports = { dir, seedIfMissing };
