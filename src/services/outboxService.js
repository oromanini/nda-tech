const crypto = require('crypto');
const pool = require('../db/connection');
const { assinar } = require('../lib/integracaoAuth');

// Outbox dos eventos nda-form → Deal (contracts/README §4.2). Grava antes de enviar.
// 2xx = ok · 4xx = não retenta (erro de contrato) · 5xx/timeout/rede = retenta (1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h), até 24 h.
// Nunca logar corpo, headers, token ou assinatura.

const BACKOFF_MINUTOS = [1, 5, 15, 60, 180, 360, 720];
const LIMITE_MS = 24 * 3600 * 1000;
const TIMEOUT_MS = 10000;

/** Próxima tentativa após `tentativas` falhas; null = esgotado. */
function proximaTentativa(tentativas, criadoEm, agora) {
  const espera = BACKOFF_MINUTOS[tentativas - 1];
  if (espera === undefined) return null;
  const quando = new Date(agora.getTime() + espera * 60000);
  return quando.getTime() - new Date(criadoEm).getTime() <= LIMITE_MS ? quando : null;
}

/** Monta o envelope (contracts/eventos/envelope.schema.json). */
function montarEnvelope({ tipo, projeto_uuid, cliente_uuid, dados, ocorrido_em = new Date() }) {
  return {
    versao: 1,
    evento_id: crypto.randomUUID(),
    tipo,
    projeto_uuid,
    cliente_uuid,
    ocorrido_em: ocorrido_em.toISOString(),
    origem: 'nda-form',
    dados,
  };
}

/** Grava o evento. `dedupeKey` único: repetir a mesma chave não cria outro evento (devolve null). */
async function enfileirar(envelope, dedupeKey) {
  const [r] = await pool.query(
    `INSERT IGNORE INTO outbox_eventos (evento_id, dedupe_key, tipo, projeto_uuid, payload, status, tentativas, proxima_tentativa_em, criado_em)
     VALUES (?, ?, ?, ?, ?, 'pendente', 0, NOW(3), NOW(3))`,
    [envelope.evento_id, dedupeKey, envelope.tipo, envelope.projeto_uuid, JSON.stringify(envelope)]
  );
  return r.affectedRows === 1 ? r.insertId : null;
}

const destino = () => ({
  url: (process.env.DEAL_URL || '').replace(/\/+$/, ''),
  token: (process.env.INTEGRATION_NDA_FORM_TOKEN || '').trim(),
  hmac: (process.env.INTEGRATION_NDA_FORM_HMAC || '').trim(),
});

async function reagendar(linha, motivo, agora) {
  const tentativas = linha.tentativas + 1;
  const quando = proximaTentativa(tentativas, linha.criado_em, agora);
  if (!quando) return falhar(linha, `esgotado: ${motivo}`);
  await pool.query(`UPDATE outbox_eventos SET tentativas = ?, ultimo_erro = ?, proxima_tentativa_em = ? WHERE id = ?`, [tentativas, motivo.slice(0, 255), quando, linha.id]);
  return { status: 'pendente', motivo };
}

async function falhar(linha, motivo) {
  await pool.query(`UPDATE outbox_eventos SET status = 'falhou', tentativas = tentativas + 1, ultimo_erro = ? WHERE id = ?`, [motivo.slice(0, 255), linha.id]);
  console.error(`outbox: evento ${linha.evento_id} (${linha.tipo}) falhou: ${motivo}`);
  return { status: 'falhou', motivo };
}

/** Tenta enviar uma linha. Reivindica antes (dois processos não enviam o mesmo evento ao mesmo tempo). */
async function tentarEnvio(id, agora = new Date()) {
  const [claim] = await pool.query(
    `UPDATE outbox_eventos SET proxima_tentativa_em = DATE_ADD(NOW(3), INTERVAL 2 MINUTE)
      WHERE id = ? AND status = 'pendente' AND proxima_tentativa_em <= NOW(3)`,
    [id]
  );
  if (!claim.affectedRows) return { status: 'pendente', motivo: 'em_andamento' };

  const [rows] = await pool.query('SELECT * FROM outbox_eventos WHERE id = ?', [id]);
  const linha = rows[0];
  const d = destino();
  if (!d.url || !d.token || !d.hmac) return reagendar(linha, 'destino não configurado', agora);

  const corpo = typeof linha.payload === 'string' ? linha.payload : JSON.stringify(linha.payload);
  const ts = String(Math.floor(agora.getTime() / 1000));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let status;
  try {
    const res = await fetch(`${d.url}/api/integracoes/eventos`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${d.token}`,
        'X-Alluz-Origem': 'nda-form',
        'X-Alluz-Timestamp': ts,
        'X-Alluz-Assinatura': assinar(d.hmac, ts, corpo),
      },
      body: corpo,
    });
    status = res.status;
  } catch (err) {
    return reagendar(linha, err && err.name === 'AbortError' ? 'timeout' : 'erro de rede', agora);
  } finally {
    clearTimeout(timer);
  }

  if (status >= 200 && status < 300) {
    await pool.query(`UPDATE outbox_eventos SET status = 'enviado', tentativas = tentativas + 1, enviado_em = NOW(3), ultimo_erro = NULL WHERE id = ?`, [id]);
    return { status: 'enviado' };
  }
  if (status >= 400 && status < 500) return falhar(linha, `HTTP ${status}`);
  return reagendar(linha, `HTTP ${status}`, agora);
}

/** Cloud Scheduler (POST /api/jobs/outbox): retenta o que venceu. */
async function processarOutbox(limite = 50) {
  const [rows] = await pool.query(
    `SELECT id FROM outbox_eventos WHERE status = 'pendente' AND proxima_tentativa_em <= NOW(3) ORDER BY id LIMIT ?`,
    [limite]
  );
  let enviados = 0;
  let falhos = 0;
  for (const r of rows) {
    const res = await tentarEnvio(r.id);
    if (res.status === 'enviado') enviados++;
    if (res.status === 'falhou') falhos++;
  }
  return { analisados: rows.length, enviados, falhos };
}

/** Eventos que esgotaram as tentativas: o Deal lista (GET /api/integracoes/eventos/falhas). Sem payload (dados pessoais). */
async function listarFalhas() {
  const [rows] = await pool.query(
    `SELECT evento_id, tipo, projeto_uuid, tentativas, ultimo_erro, criado_em FROM outbox_eventos WHERE status = 'falhou' ORDER BY id DESC LIMIT 200`
  );
  return rows;
}

module.exports = { BACKOFF_MINUTOS, proximaTentativa, montarEnvelope, enfileirar, tentarEnvio, processarOutbox, listarFalhas };
