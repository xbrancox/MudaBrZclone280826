/* ============================================================
   MUDABRASIL — VERIFICAÇÃO DE POLÍTICOS (SELO)
   ------------------------------------------------------------
   Verificação automática via domínio de e-mail institucional:
   - @camara.leg.br  (deputados federais)
   - @senado.leg.br  (senadores)
   - @senador.leg.br (senadores - alias)
   - @tse.jus.br     (Tribunal Superior Eleitoral)

   SEM GOV.BR (regra do fundador).
   Fluxo:
   1. Político (ou assessor) informa e-mail institucional
   2. Sistema gera token de confirmação
   3. E-mail é enviado com link de confirmação
   4. Ao confirmar, o selo é ativado
   ============================================================ */

const crypto = require('crypto');
const db = require('./db');

const AUTHORIZED_DOMAINS = [
  'camara.leg.br',
  'senado.leg.br',
  'senador.leg.br',
  'tse.jus.br'
];

// Tokens de confirmação em memória (em prod usar DB)
const pendingVerifications = new Map(); // token -> { politicianId, email, expiresAt }

function isAuthorizedDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const lower = email.toLowerCase().trim();
  const atIdx = lower.lastIndexOf('@');
  if (atIdx === -1) return null;
  const domain = lower.slice(atIdx + 1);
  for (const auth of AUTHORIZED_DOMAINS) {
    if (domain === auth) return auth;
  }
  return null;
}

function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

/**
 * Inicia processo de verificação de um político.
 * Retorna token de confirmação (que deve ser enviado por e-mail).
 */
function startVerification(politicianId, email) {
  const politician = db.getPolitician(politicianId);
  if (!politician) throw new Error('Político não encontrado: ' + politicianId);

  const normalized = normalizeEmail(email);
  const authDomain = isAuthorizedDomain(normalized);
  if (!authDomain) {
    throw new Error('Domínio não autorizado. Use: ' + AUTHORIZED_DOMAINS.join(', '));
  }

  // Gera token único
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h

  pendingVerifications.set(token, {
    politicianId,
    email: normalized,
    domain: authDomain,
    expiresAt,
    politicianName: politician.name
  });

  return {
    ok: true,
    token,
    domain: authDomain,
    email: normalized,
    confirmationLink: `/api/verificacao/confirmar?token=${token}`,
    politicianName: politician.name,
    expiresAt,
    message: 'Token gerado. Em produção, um e-mail seria enviado. Em dev, use o link diretamente.'
  };
}

/**
 * Confirma a verificação de um político via token.
 */
function confirmVerification(token) {
  const entry = pendingVerifications.get(token);
  if (!entry) throw new Error('Token inválido ou expirado.');
  if (Date.now() > entry.expiresAt) {
    pendingVerifications.delete(token);
    throw new Error('Token expirado. Solicite uma nova verificação.');
  }

  // Ativa selo
  db.setVerification({
    politicianId: entry.politicianId,
    verified: true,
    method: 'domain',
    domain: entry.domain,
    email: entry.email
  });

  pendingVerifications.delete(token);

  return {
    ok: true,
    politicianId: entry.politicianId,
    email: entry.email,
    domain: entry.domain,
    verifiedAt: Date.now(),
    message: '✅ Selo de verificação ativado com sucesso!'
  };
}

/**
 * Auto-verifica políticos com base em dados públicos que contenham
 * e-mail institucional. Chamado durante a ingestão de dados.
 */
function autoVerifyFromPublicData(politician) {
  if (!politician) return null;
  // Procura e-mail em campos conhecidos
  const emailFields = ['email', 'email_institucional', 'emailOficial', 'contact_email'];
  for (const field of emailFields) {
    const email = politician[field];
    if (email) {
      const domain = isAuthorizedDomain(email);
      if (domain) {
        db.setVerification({
          politicianId: politician.id,
          verified: true,
          method: 'public_data',
          domain,
          email
        });
        return { domain, email };
      }
    }
  }
  return null;
}

/**
 * Lista domínios autorizados (para a UI).
 */
function getAuthorizedDomains() {
  return [...AUTHORIZED_DOMAINS];
}

/**
 * Verifica se um político está verificado.
 */
function isVerified(politicianId) {
  const v = db.getVerification(politicianId);
  return !!(v && v.verified);
}

/**
 * Retorna detalhes completos da verificação de um político.
 */
function getVerificationDetails(politicianId) {
  return db.getVerification(politicianId);
}

/**
 * Lista todos os políticos verificados (com seus dados).
 */
function getAllVerified() {
  return db.getVerifiedPoliticians();
}

/**
 * Estatísticas de verificação.
 */
function getStats() {
  const all = db.getAllPoliticians();
  const verifications = db.getAllVerifications();
  const total = Object.keys(all).length;
  let verified = 0;
  const byDomain = {};
  for (const v of Object.values(verifications)) {
    if (v.verified) {
      verified++;
      const d = v.domain || 'unknown';
      byDomain[d] = (byDomain[d] || 0) + 1;
    }
  }
  return {
    total,
    verified,
    pending: total - verified,
    byDomain
  };
}

module.exports = {
  AUTHORIZED_DOMAINS,
  isAuthorizedDomain,
  startVerification,
  confirmVerification,
  autoVerifyFromPublicData,
  getAuthorizedDomains,
  isVerified,
  getVerificationDetails,
  getAllVerified,
  getStats
};
