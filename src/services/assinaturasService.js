const pool = require('../db/connection');
const { montarEnvelope, enfileirar, tentarEnvio } = require('./outboxService');
const { validarEnvelope } = require('../lib/contratos');

// Andamento das assinaturas (webhook do DocuSeal → eventos ao Deal).

const TOTAL = 4;
const PAPEL_POR_ROLE = {
  DIVULGANTE: 'cliente',
  RECEPTORA: 'alluz',
  'TESTEMUNHA 1': 'testemunha1',
  'TESTEMUNHA 2': 'testemunha2',
};

/** Vigência de 1 ano a partir da assinatura (YYYY-MM-DD). */
function vigenteAte(assinadoEm) {
  const d = new Date(assinadoEm);
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

/** Cópia exata do que foi assinado (contracts/comum.schema.json#dados_juridicos). */
function dadosJuridicos(c) {
  const dj = {
    tipo_pessoa: c.tipo_pessoa,
    razao_social: c.razao_social,
    documento: c.cnpj_cpf,
    endereco: c.endereco,
    cep: c.cep,
    email: c.email,
    testemunhas: [1, 2].map((n) => ({ nome: c[`testemunha${n}_nome`], cpf: c[`testemunha${n}_cpf`], email: c[`testemunha${n}_email`] })),
  };
  if (c.tipo_pessoa === 'PJ') dj.representante = { nome: c.representante, cpf: c.cpf_representante, cargo: c.cargo };
  return dj;
}

async function gravarEvento(envelope, dedupeKey) {
  const erros = validarEnvelope(envelope);
  if (erros.length) {
    // Bug nosso, não do destinatário: não enfileira lixo; fica no log (sem valores) para correção.
    console.error(`assinaturas: evento ${envelope.tipo} não passa no schema`, JSON.stringify(erros));
    return null;
  }
  return enfileirar(envelope, dedupeKey);
}

/**
 * Processa uma assinatura concluída. Idempotente: (nda, papel) é único, então a reentrega do mesmo webhook não gera evento.
 * Devolve { efeito: 'ignorado' | 'duplicado' | 'parcial' | 'assinado', ... }.
 */
async function registrarAssinatura({ submissionId, role, nome, assinadoEm }) {
  const papel = PAPEL_POR_ROLE[role];
  if (!submissionId || !papel) return { efeito: 'ignorado', motivo: 'dados insuficientes' };

  const [rows] = await pool.query(
    `SELECT cl.*, cv.status AS convite_status
       FROM clientes cl LEFT JOIN convites cv ON cv.id = cl.convite_id
      WHERE cl.docuseal_submission_id = ? LIMIT 1`,
    [String(submissionId)]
  );
  const nda = rows[0];
  // NDA sem convite (formulário legado) não gera eventos; convite cancelado (reenvio) foi arquivado e não vale mais.
  if (!nda || !nda.convite_id || !nda.projeto_uuid || !nda.cliente_uuid) return { efeito: 'ignorado', motivo: 'sem convite' };
  if (nda.convite_status === 'cancelado') return { efeito: 'ignorado', motivo: 'convite cancelado' };

  const quando = new Date(assinadoEm || Date.now());
  const [ins] = await pool.query(
    'INSERT IGNORE INTO assinaturas_nda (nda_id, papel, nome, assinado_em) VALUES (?, ?, ?, ?)',
    [nda.id, papel, String(nome || papel).slice(0, 255), quando]
  );
  if (ins.affectedRows === 0) return { efeito: 'duplicado' };

  const [cont] = await pool.query('SELECT COUNT(*) AS n, MAX(assinado_em) AS ultimo FROM assinaturas_nda WHERE nda_id = ?', [nda.id]);
  const concluidas = Math.min(Number(cont[0].n), TOTAL);
  await pool.query('UPDATE clientes SET assinaturas_concluidas = ? WHERE id = ?', [concluidas, nda.id]);

  const ndaId = String(nda.id);
  const idParcial = await gravarEvento(
    montarEnvelope({
      tipo: 'nda.assinatura.parcial', projeto_uuid: nda.projeto_uuid, cliente_uuid: nda.cliente_uuid, ocorrido_em: quando,
      dados: { nda_id: ndaId, papel, nome: String(nome || papel).slice(0, 255), assinado_em: quando.toISOString(), assinaturas_concluidas: concluidas, assinaturas_total: TOTAL },
    }),
    `parcial:${ndaId}:${papel}`
  );
  const ids = [idParcial];

  let efeito = 'parcial';
  if (concluidas >= TOTAL) {
    efeito = 'assinado';
    // A data do NDA é a da última assinatura, mesmo que os webhooks cheguem fora de ordem.
    const assinadoFinal = cont[0].ultimo ? new Date(cont[0].ultimo) : quando;
    const vigente = vigenteAte(assinadoFinal);
    await pool.query(`UPDATE clientes SET assinado_em = ?, vigente_ate = ? WHERE id = ?`, [assinadoFinal, vigente, nda.id]);
    await pool.query(`UPDATE convites SET status = 'assinado', nda_id = ? WHERE id = ?`, [ndaId, nda.convite_id]);
    ids.push(await gravarEvento(
      montarEnvelope({
        tipo: 'nda.assinado', projeto_uuid: nda.projeto_uuid, cliente_uuid: nda.cliente_uuid, ocorrido_em: assinadoFinal,
        dados: { nda_id: ndaId, assinado_em: assinadoFinal.toISOString(), vigente_ate: vigente, documento_id: `docuseal_${submissionId}`, dados_juridicos: dadosJuridicos(nda) },
      }),
      `assinado:${ndaId}`
    ));
  }

  // Envio imediato (melhor esforço); o que falhar fica na outbox para o job de retentativa.
  for (const id of ids.filter(Boolean)) {
    try { await tentarEnvio(id); } catch (err) { console.error('outbox: envio imediato falhou:', err.message); }
  }
  return { efeito, papel, concluidas };
}

module.exports = { TOTAL, PAPEL_POR_ROLE, vigenteAte, dadosJuridicos, registrarAssinatura };
