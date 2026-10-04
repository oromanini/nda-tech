const crypto = require('crypto');
const pool = require('../db/connection');

// Convites de NDA (comando nda.convite.criar). O token é opaco (≥ 32 bytes) e só o hash fica no banco:
// o link existe apenas na resposta ao Deal e no e-mail ao cliente. Nunca logar token nem link.

const VALIDADE_DIAS = 30;

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const novoToken = () => crypto.randomBytes(32).toString('base64url');
const baseUrl = () => (process.env.NDA_PUBLIC_URL || '').replace(/\/+$/, '');

/** Cria o convite e invalida os anteriores do mesmo projeto (reenvio). */
async function criarConvite(dados) {
  const id = crypto.randomUUID();
  const token = novoToken();
  const expiraEm = new Date(Date.now() + VALIDADE_DIAS * 24 * 3600 * 1000);

  // Convites anteriores ainda abertos deixam de valer. Se já havia assinatura em andamento, o chamador arquiva no DocuSeal.
  const [abertos] = await pool.query(
    `SELECT c.id, cl.docuseal_submission_id
       FROM convites c LEFT JOIN clientes cl ON cl.convite_id = c.id
      WHERE c.projeto_uuid = ? AND c.status IN ('pendente', 'em_assinatura')`,
    [dados.projeto_uuid]
  );
  if (abertos.length) {
    await pool.query(
      `UPDATE convites SET status = 'cancelado' WHERE projeto_uuid = ? AND status IN ('pendente', 'em_assinatura')`,
      [dados.projeto_uuid]
    );
  }

  await pool.query(
    `INSERT INTO convites (id, token_hash, projeto_uuid, cliente_uuid, email, empresa, responsavel, tipo_projeto, status, expira_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?)`,
    [id, hashToken(token), dados.projeto_uuid, dados.cliente_uuid, dados.email, dados.empresa, dados.responsavel, dados.tipo_projeto, expiraEm]
  );

  const submissoesParaArquivar = abertos.map((a) => a.docuseal_submission_id).filter(Boolean);
  return { convite_id: id, link: `${baseUrl()}/c/${token}`, submissoesParaArquivar };
}

/** Convite utilizável (pendente e dentro da validade) ou null. Mesmo resultado para inexistente, expirado, usado e cancelado. */
async function buscarConviteAberto(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  const [rows] = await pool.query(
    `SELECT id, projeto_uuid, cliente_uuid, email, empresa, responsavel, tipo_projeto
       FROM convites WHERE token_hash = ? AND status = 'pendente' AND expira_em > NOW() LIMIT 1`,
    [hashToken(token)]
  );
  return rows[0] || null;
}

/** Reivindica o convite para uma única submissão (evita envio duplo). */
async function reivindicar(id) {
  const [r] = await pool.query(`UPDATE convites SET status = 'em_assinatura' WHERE id = ? AND status = 'pendente'`, [id]);
  return r.affectedRows === 1;
}

/** Falha antes de criar a assinatura: devolve o convite ao estado pendente para o cliente tentar de novo. */
async function liberar(id) {
  await pool.query(`UPDATE convites SET status = 'pendente' WHERE id = ? AND status = 'em_assinatura'`, [id]);
}

module.exports = { VALIDADE_DIAS, hashToken, criarConvite, buscarConviteAberto, reivindicar, liberar };
