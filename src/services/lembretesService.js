const pool = require('../db/connection');
const { enviarLembreteConvite } = require('./emailService');

// Lembretes de convite (A6): pendente há 3 dias → um lembrete, depois a cada 3 dias, no máximo 3.
// Não é marco no Deal: fica só no log do nda-form. O token não é guardado (só o hash), então o lembrete
// remete ao link do e-mail original em vez de reenviá-lo.

const INTERVALO_DIAS = 3;
const MAXIMO = 3;

async function enviarLembretes() {
  const [rows] = await pool.query(
    `SELECT id, email, empresa, responsavel, lembretes_enviados FROM convites
      WHERE status = 'pendente' AND expira_em > NOW() AND lembretes_enviados < ?
        AND COALESCE(ultimo_lembrete_em, criado_em) <= DATE_SUB(NOW(), INTERVAL ? DAY)
      ORDER BY criado_em LIMIT 100`,
    [MAXIMO, INTERVALO_DIAS]
  );
  let enviados = 0;
  for (const c of rows) {
    // Reivindica antes de enviar: dois disparos do job não mandam o mesmo lembrete duas vezes.
    const [r] = await pool.query(
      `UPDATE convites SET lembretes_enviados = lembretes_enviados + 1, ultimo_lembrete_em = NOW()
        WHERE id = ? AND status = 'pendente' AND lembretes_enviados = ?`,
      [c.id, c.lembretes_enviados]
    );
    if (r.affectedRows !== 1) continue;
    try {
      await enviarLembreteConvite(c.responsavel, c.email, c.empresa);
      enviados++;
      console.log(`lembrete: convite ${c.id} (${c.lembretes_enviados + 1}/${MAXIMO}) enviado`);
    } catch (err) {
      console.error(`lembrete: falha no convite ${c.id}:`, err.message);
    }
  }
  return { analisados: rows.length, enviados };
}

module.exports = { INTERVALO_DIAS, MAXIMO, enviarLembretes };
