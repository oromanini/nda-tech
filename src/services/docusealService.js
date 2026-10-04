const https = require('https');

const DOCUSEAL_TEMPLATE_ID = 4380107;

function apiRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'api.docuseal.com',
      path,
      method,
      headers: {
        'X-Auth-Token': process.env.DOCUSEAL_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          if (res.statusCode >= 400) {
            reject(new Error(`DocuSeal ${res.statusCode}: ${JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch (e) {
          reject(new Error(`DocuSeal parse error: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Campos de assinatura na página própria de assinaturas (a última do PDF).
// Coordenadas normalizadas (0–1) medidas no PDF real: A4, margens de 2,5 cm, blocos de altura fixa em templates/nda.html
// (linha "Assinatura:" ancorada no rodapé do bloco, então não muda com nomes longos). Se o layout da página de
// assinaturas mudar, regerar o PDF e reconferir estes valores (tests/docusealService.test.js ancora o formato).
const COLUNA_ESQ = { x: 0.193, w: 0.266 };
const COLUNA_DIR = { x: 0.602, w: 0.266 };
const LINHA_1 = { y: 0.286, h: 0.036 }; // cliente (PJ: representante) e Alluz
const LINHA_2 = { y: 0.494, h: 0.036 }; // testemunhas
const SIGNATURE_FIELDS = [
  { name: 'ASSINATURA DIVULGANTE', role: 'DIVULGANTE',   ...COLUNA_ESQ, ...LINHA_1 },
  { name: 'ASSINATURA RECEPTORA',  role: 'RECEPTORA',    ...COLUNA_DIR, ...LINHA_1 },
  { name: 'ASSINATURA T1',         role: 'TESTEMUNHA 1', ...COLUNA_ESQ, ...LINHA_2 },
  { name: 'ASSINATURA T2',         role: 'TESTEMUNHA 2', ...COLUNA_DIR, ...LINHA_2 },
];

// Busca os campos do template base. Só os que NÃO são assinatura são reaproveitados (ex.: rubricas);
// as assinaturas vêm de SIGNATURE_FIELDS, calibradas para o layout atual.
async function buscarCamposTemplate() {
  const template = await apiRequest('GET', `/templates/${DOCUSEAL_TEMPLATE_ID}`, {});
  return template.fields || [];
}

// Conta páginas no PDF gerado pelo Chromium/Puppeteer (0-indexed: retorna índice da última página)
function ultimaPaginaPDF(pdfBuffer) {
  const str = pdfBuffer.toString('binary');
  const matches = str.match(/\/Type\s*\/Page[^s]/g);
  return matches ? matches.length - 1 : 0;
}

// Infere o role do DocuSeal a partir do nome do campo (a API não retorna role nos fields)
function inferirRole(nomeField) {
  if (nomeField.includes('DIVULGANTE')) return 'DIVULGANTE';
  if (nomeField.includes('RECEPTORA'))  return 'RECEPTORA';
  if (nomeField.includes('T1'))         return 'TESTEMUNHA 1';
  if (nomeField.includes('T2'))         return 'TESTEMUNHA 2';
  return null;
}

async function criarSubmission(dados, pdfBuffer) {
  // PJ assina pelo representante legal; PF assina em nome próprio (razao_social guarda o nome).
  const nomeCliente = (dados.tipo_pessoa === 'PJ' && dados.representante) || dados.razao_social || 'Cliente';

  const submitters = [
    { role: 'DIVULGANTE',   name: nomeCliente,            email: dados.email },
    { role: 'RECEPTORA',    name: 'Alluz Tech',           email: 'nda@alluz.tech' },
    { role: 'TESTEMUNHA 1', name: dados.testemunha1_nome, email: dados.testemunha1_email },
    { role: 'TESTEMUNHA 2', name: dados.testemunha2_nome, email: dados.testemunha2_email },
  ];

  if (pdfBuffer) {
    // POST /submissions/pdf — cria a submission diretamente do PDF preenchido.
    // Conforme documentação oficial:
    //   - x/y/w/h: frações normalizadas (0–1)
    //   - page: 1-indexed (começa em 1)
    //   - resposta: objeto único { id, submitters: [{email, slug, embed_src, ...}] }
    // Mesmas quatro assinaturas para PF e PJ (o signatário DIVULGANTE é o representante na PJ e a própria pessoa na PF).
    const novaUltimaPagina = ultimaPaginaPDF(pdfBuffer); // 0-indexed
    const campos = await buscarCamposTemplate().catch((err) => {
      console.error('docuseal: não foi possível ler o template base; só as assinaturas serão enviadas:', err.message);
      return [];
    });
    const ultimaPaginaOriginal = Math.max(-1, ...campos.flatMap((f) => (f.areas || []).map((a) => a.page)));
    const outros = campos.filter((f) => f.type !== 'signature').map((f) => ({
      name: f.name,
      type: f.type,
      role: inferirRole(f.name),
      required: f.required !== false,
      areas: (f.areas || []).map(({ attachment_uuid, ...a }) => ({
        ...a,
        // Template retorna 0-indexed; submissions/pdf exige 1-indexed. A última página do template vira a do novo PDF.
        page: (a.page === ultimaPaginaOriginal ? novaUltimaPagina : a.page) + 1,
      })),
    }));
    const assinaturas = SIGNATURE_FIELDS.map(({ name, role, x, y, w, h }) => ({
      name, type: 'signature', role, required: true, areas: [{ x, y, w, h, page: novaUltimaPagina + 1 }],
    }));
    const fields = [...outros, ...assinaturas];

    const submission = await apiRequest('POST', '/submissions/pdf', {
      send_email: false,
      documents: [{ name: 'nda.pdf', file: pdfBuffer.toString('base64'), fields }],
      submitters,
    });

    // A resposta não inclui nomes — cruzamos pelo email com os dados que enviamos
    const linkPorEmail = Object.fromEntries(
      (submission.submitters || []).map(s => [
        s.email,
        s.embed_src || `https://docuseal.com/s/${s.slug}`,
      ])
    );

    return {
      submissionId: submission.id ?? null,
      signatarios: submitters.map(s => ({
        nome:  s.name,
        email: s.email,
        link:  linkPorEmail[s.email] ?? null,
      })),
    };
  }

  // Fallback: usa o template estático (sem PDF preenchido).
  // Resposta: array de submitters com { submission_id, name, email, slug }
  const lista = await apiRequest('POST', '/submissions', {
    template_id: DOCUSEAL_TEMPLATE_ID,
    send_email: false,
    submitters,
  });

  const arr = Array.isArray(lista) ? lista : [lista];
  return {
    submissionId: arr[0]?.submission_id ?? null,
    signatarios: arr.map(s => ({
      nome:  s.name,
      email: s.email,
      link:  `https://docuseal.com/s/${s.slug}`,
    })),
  };
}

// Reenvio de convite com assinatura em andamento: arquiva a submissão antiga para ninguém assinar o NDA invalidado.
async function arquivarSubmission(submissionId) {
  if (!process.env.DOCUSEAL_API_KEY || !submissionId) return;
  await apiRequest('DELETE', `/submissions/${encodeURIComponent(submissionId)}`, {});
}

module.exports = { criarSubmission, arquivarSubmission, ultimaPaginaPDF, SIGNATURE_FIELDS };
