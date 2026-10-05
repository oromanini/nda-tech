// Banco falso em memória para os testes de integração: responde só às consultas que o código do NDA faz (por regex).
const crypto = require('crypto');

function criarFakeDb() {
  const st = { convites: [], idem: {}, clientes: [], assinaturas: [], outbox: [], docuseal: [] };
  let seq = 0;
  const agora = () => new Date();

  const query = jest.fn(async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // ── convites ────────────────────────────────────────────────────────────
    if (/^SELECT c\.id, cl\.docuseal_submission_id FROM convites c/.test(s)) {
      return [st.convites.filter((c) => c.projeto_uuid === p[0] && ['pendente', 'em_assinatura'].includes(c.status))
        .map((c) => ({ id: c.id, docuseal_submission_id: (st.clientes.find((x) => x.convite_id === c.id) || {}).docuseal_submission_id || null }))];
    }
    if (/^UPDATE convites SET status = 'cancelado' WHERE projeto_uuid/.test(s)) {
      st.convites.filter((c) => c.projeto_uuid === p[0] && ['pendente', 'em_assinatura'].includes(c.status)).forEach((c) => { c.status = 'cancelado'; });
      return [{}];
    }
    if (/^UPDATE convites SET status = 'cancelado' WHERE id/.test(s)) {
      st.convites.find((c) => c.id === p[0]).status = 'cancelado';
      return [{}];
    }
    if (/^INSERT INTO convites/.test(s)) {
      st.convites.push({ id: p[0], token_hash: p[1], projeto_uuid: p[2], cliente_uuid: p[3], email: p[4], empresa: p[5], responsavel: p[6], tipo_projeto: p[7], status: 'pendente', expira_em: p[8], lembretes_enviados: 0, ultimo_lembrete_em: null, criado_em: agora() });
      return [{}];
    }
    if (/FROM convites WHERE token_hash = \? AND status = 'pendente'/.test(s)) {
      const c = st.convites.find((x) => x.token_hash === p[0] && x.status === 'pendente' && new Date(x.expira_em) > agora());
      return [c ? [c] : []];
    }
    if (/^UPDATE convites SET status = 'em_assinatura' WHERE id = \? AND status = 'pendente'/.test(s)) {
      const c = st.convites.find((x) => x.id === p[0] && x.status === 'pendente');
      if (c) c.status = 'em_assinatura';
      return [{ affectedRows: c ? 1 : 0 }];
    }
    if (/^UPDATE convites SET status = 'pendente' WHERE id = \? AND status = 'em_assinatura'/.test(s)) {
      const c = st.convites.find((x) => x.id === p[0] && x.status === 'em_assinatura');
      if (c) c.status = 'pendente';
      return [{}];
    }
    if (/^UPDATE convites SET status = 'assinado', nda_id = \? WHERE id = \?/.test(s)) {
      const c = st.convites.find((x) => x.id === p[1]); c.status = 'assinado'; c.nda_id = p[0];
      return [{}];
    }

    if (/^UPDATE convites SET falha_email = 1 WHERE id/.test(s)) { st.convites.find((c) => c.id === p[0]).falha_email = 1; return [{}]; }

    // ── idempotência ────────────────────────────────────────────────────────
    if (/^SELECT status, resposta FROM idempotencia_comandos/.test(s)) return [st.idem[p[0]] ? [st.idem[p[0]]] : []];
    if (/^INSERT IGNORE INTO idempotencia_comandos/.test(s)) {
      if (st.idem[p[0]]) return [{ affectedRows: 0 }];
      st.idem[p[0]] = { status: 0, resposta: p[1] };
      return [{ affectedRows: 1 }];
    }
    if (/^UPDATE idempotencia_comandos SET status = 201/.test(s)) { st.idem[p[1]] = { status: 201, resposta: p[0] }; return [{}]; }
    if (/^DELETE FROM idempotencia_comandos/.test(s)) { if (st.idem[p[0]] && st.idem[p[0]].status === 0) delete st.idem[p[0]]; return [{}]; }

    // ── clientes (NDAs) ─────────────────────────────────────────────────────
    if (/^INSERT INTO clientes/.test(s)) {
      const id = ++seq;
      const c = { id, tipo_pessoa: p[0], razao_social: p[1], cnpj_cpf: p[2], endereco: p[3], cep: p[4], representante: p[5], cpf_representante: p[6], cargo: p[7],
        testemunha1_nome: p[12], testemunha1_cpf: p[13], testemunha1_email: p[14], testemunha2_nome: p[15], testemunha2_cpf: p[16], testemunha2_email: p[17],
        email: p[19], convite_id: p[20], projeto_uuid: p[21], cliente_uuid: p[22], assinaturas_concluidas: 0 };
      st.clientes.push(c);
      return [{ insertId: id }];
    }
    if (/^UPDATE clientes SET docuseal_submission_id/.test(s)) { st.clientes.find((c) => c.id === p[1]).docuseal_submission_id = p[0]; return [{}]; }
    if (/^DELETE FROM clientes/.test(s)) { st.clientes = st.clientes.filter((c) => c.id !== p[0]); return [{}]; }
    if (/FROM clientes cl LEFT JOIN convites cv/.test(s)) {
      const c = st.clientes.find((x) => x.docuseal_submission_id === p[0]);
      return [c ? [{ ...c, convite_status: (st.convites.find((v) => v.id === c.convite_id) || {}).status }] : []];
    }
    if (/^UPDATE clientes SET assinaturas_concluidas/.test(s)) { st.clientes.find((c) => c.id === p[1]).assinaturas_concluidas = p[0]; return [{}]; }
    if (/^UPDATE clientes SET assinado_em/.test(s)) { const c = st.clientes.find((x) => x.id === p[2]); c.assinado_em = p[0]; c.vigente_ate = p[1]; return [{}]; }

    // ── assinaturas ─────────────────────────────────────────────────────────
    if (/^INSERT IGNORE INTO assinaturas_nda/.test(s)) {
      if (st.assinaturas.some((a) => a.nda_id === p[0] && a.papel === p[1])) return [{ affectedRows: 0 }];
      st.assinaturas.push({ nda_id: p[0], papel: p[1], nome: p[2], assinado_em: p[3] });
      return [{ affectedRows: 1 }];
    }
    if (/^SELECT COUNT\(\*\) AS n, MAX\(assinado_em\) AS ultimo FROM assinaturas_nda/.test(s)) {
      const l = st.assinaturas.filter((a) => a.nda_id === p[0]);
      return [[{ n: l.length, ultimo: l.length ? new Date(Math.max(...l.map((a) => +new Date(a.assinado_em)))) : null }]];
    }

    // ── outbox ──────────────────────────────────────────────────────────────
    if (/^INSERT IGNORE INTO outbox_eventos/.test(s)) {
      if (st.outbox.some((o) => o.dedupe_key === p[1] || o.evento_id === p[0])) return [{ affectedRows: 0 }];
      const id = ++seq;
      st.outbox.push({ id, evento_id: p[0], dedupe_key: p[1], tipo: p[2], projeto_uuid: p[3], payload: p[4], status: 'pendente', tentativas: 0, criado_em: agora() });
      return [{ affectedRows: 1, insertId: id }];
    }
    if (/^UPDATE outbox_eventos SET proxima_tentativa_em = DATE_ADD/.test(s)) {
      const o = st.outbox.find((x) => x.id === p[0]);
      return [{ affectedRows: o && o.status === 'pendente' && !o.emAndamento ? 1 : 0 }];
    }
    if (/^SELECT \* FROM outbox_eventos WHERE id/.test(s)) return [[st.outbox.find((x) => x.id === p[0])]];
    if (/^UPDATE outbox_eventos SET status = 'enviado'/.test(s)) { const o = st.outbox.find((x) => x.id === p[0]); o.status = 'enviado'; o.tentativas++; return [{}]; }
    if (/^UPDATE outbox_eventos SET status = 'falhou'/.test(s)) { const o = st.outbox.find((x) => x.id === p[1]); o.status = 'falhou'; o.tentativas++; o.ultimo_erro = p[0]; return [{}]; }
    if (/^UPDATE outbox_eventos SET tentativas = \?, ultimo_erro/.test(s)) { const o = st.outbox.find((x) => x.id === p[3]); o.tentativas = p[0]; o.ultimo_erro = p[1]; o.proxima = p[2]; return [{}]; }

    return [[]];
  });

  return { st, query, novoToken: () => crypto.randomBytes(32).toString('base64url') };
}

module.exports = { criarFakeDb };
