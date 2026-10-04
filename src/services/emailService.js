const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const emailTemplatePath = path.join(__dirname, '../../templates/email.html');

function criarTransporte() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 465,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

function slugify(str) {
  return str
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
}

async function enviarNDA(dados, pdfBuffer) {
  const transporter = criarTransporte();

  let emailHtml = fs.readFileSync(emailTemplatePath, 'utf-8');
  emailHtml = emailHtml.split('{{NOME_CLIENTE}}').join(dados.razao_social);
  emailHtml = emailHtml.split('{{EMAIL_CLIENTE}}').join(dados.email);

  const nomeArquivo = `NDA_${slugify(dados.razao_social)}.pdf`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: dados.email,
    cc: process.env.EMAIL_CC,
    subject: 'Seu NDA — Alluz Tech',
    html: emailHtml,
    attachments: [
      {
        filename: nomeArquivo,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

const emailAssinaturaPath = path.join(__dirname, '../../templates/email_assinatura.html');

async function enviarLinkAssinatura(nome, email, linkAssinatura, nomeCliente, papel) {
  const transporter = criarTransporte();

  const introsPorPapel = {
    cliente:      `O seu Acordo de Não Divulgação (NDA) com a <strong>Alluz Tech</strong> foi gerado e está pronto para assinatura digital.`,
    alluz:        `Um novo Acordo de Não Divulgação (NDA) com <strong>${nomeCliente}</strong> foi gerado e aguarda a sua assinatura.`,
    testemunha:   `Você foi indicado(a) como testemunha no Acordo de Não Divulgação (NDA) entre <strong>${nomeCliente}</strong> e a <strong>Alluz Tech</strong>.`,
  };

  const intro = introsPorPapel[papel] || introsPorPapel.cliente;

  let html = fs.readFileSync(emailAssinaturaPath, 'utf-8');
  html = html.split('{{NOME_SIGNATARIO}}').join(nome);
  html = html.split('{{MENSAGEM_INTRO}}').join(intro);
  html = html.split('{{LINK_ASSINATURA}}').join(linkAssinatura);

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: 'Assinatura de NDA — Alluz Tech',
    html,
  });
}

// Notificação interna: envia o PDF apenas para a equipe (sem copiar o cliente)
async function notificarInterno(dados, pdfBuffer) {
  const transporter = criarTransporte();
  const nomeArquivo = `NDA_${slugify(dados.razao_social)}.pdf`;

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_CC,
    subject: `[Interno] NDA gerado — ${dados.razao_social}`,
    text: `NDA enviado para assinatura via DocuSeal.\nCliente: ${dados.razao_social}\nE-mail: ${dados.email}`,
    attachments: [
      {
        filename: nomeArquivo,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Lembrete de convite pendente (A6). Não leva link: o token só existe no e-mail original (o banco guarda apenas o hash).
async function enviarLembreteConvite(nome, email, empresa) {
  const transporter = criarTransporte();
  let html = fs.readFileSync(emailAssinaturaPath, 'utf-8');
  html = html.split('{{NOME_SIGNATARIO}}').join(esc(nome));
  html = html.split('{{MENSAGEM_INTRO}}').join(
    `Lembrete: o NDA de <strong>${esc(empresa)}</strong> com a <strong>Alluz Tech</strong> ainda aguarda o preenchimento. O link está no e-mail de convite que enviamos antes; se não o encontrar, peça um novo ao seu contato na Alluz.`
  );
  html = html.split('{{LINK_ASSINATURA}}').join(process.env.NDA_PUBLIC_URL || 'https://nda.alluz.tech');
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: email,
    subject: 'Lembrete: NDA pendente — Alluz Tech',
    html,
  });
}

module.exports = { enviarNDA, notificarInterno, enviarLinkAssinatura, enviarLembreteConvite };
