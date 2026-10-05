jest.mock('nodemailer');

const nodemailer = require('nodemailer');
const sendMailMock = jest.fn().mockResolvedValue({ messageId: 'x' });
nodemailer.createTransport.mockReturnValue({ sendMail: sendMailMock });

process.env.NDA_PUBLIC_URL = 'https://nda.alluz.tech';
process.env.EMAIL_FROM = 'Alluz Tech <nda@alluz.tech>';

const { enviarLembreteConvite } = require('../src/services/emailService');

beforeEach(() => sendMailMock.mockClear());

describe('e-mail de lembrete (template real, sem mock de fs)', () => {
  it('é só texto: sem NDA_PUBLIC_URL, sem href, sem botão e sem placeholder pendente', async () => {
    await enviarLembreteConvite('Maria', 'maria@x.co', 'BPO Exemplo');
    const { html, to, subject } = sendMailMock.mock.calls[0][0];
    expect(to).toBe('maria@x.co');
    expect(subject).toMatch(/Lembrete/);
    expect(html).not.toContain(process.env.NDA_PUBLIC_URL);
    expect(html).not.toContain('nda.alluz.tech/');
    expect(html).not.toMatch(/href/i);
    expect(html).not.toMatch(/<a\b/i);
    expect(html).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(html).toContain('BPO Exemplo');
    expect(html).toMatch(/e-mail de convite/);
  });

  it('nome e empresa são escapados', async () => {
    await enviarLembreteConvite('<b>Ana</b>', 'a@x.co', 'E & "F" <i>');
    const { html } = sendMailMock.mock.calls[0][0];
    expect(html).not.toContain('<b>Ana</b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('E &amp;');
  });

  it('o e-mail de assinatura (com link) continua usando o template com botão', async () => {
    const { enviarLinkAssinatura } = require('../src/services/emailService');
    await enviarLinkAssinatura('Maria', 'm@x.co', 'https://docuseal.com/s/abc', 'BPO', 'cliente');
    expect(sendMailMock.mock.calls[0][0].html).toContain('href="https://docuseal.com/s/abc"');
  });
});
