const bcrypt = require('bcrypt');
const pool = require('./connection');

async function runMigrations() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS clientes (
        id                    INT AUTO_INCREMENT PRIMARY KEY,
        tipo_pessoa           ENUM('PJ', 'PF') NOT NULL,
        razao_social          VARCHAR(255) NOT NULL,
        cnpj_cpf              VARCHAR(20) NOT NULL,
        endereco              TEXT NOT NULL,
        cep                   VARCHAR(10) NOT NULL,
        representante         VARCHAR(255),
        cpf_representante     VARCHAR(14),
        cargo                 VARCHAR(100),
        prazo_vigencia        VARCHAR(100) NOT NULL,
        valor_multa           DECIMAL(15,2) NOT NULL,
        prazo_nao_solicitacao VARCHAR(100) NOT NULL,
        plataforma_assinatura VARCHAR(100),
        testemunha1_nome      VARCHAR(255) NOT NULL,
        testemunha1_cpf       VARCHAR(14) NOT NULL,
        testemunha2_nome      VARCHAR(255) NOT NULL,
        testemunha2_cpf       VARCHAR(14) NOT NULL,
        data_assinatura       DATE NOT NULL,
        email                 VARCHAR(255) NOT NULL,
        created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Colunas adicionadas após criação inicial da tabela
    const [existingCols] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'clientes'`
    );
    const colNames = existingCols.map(r => r.COLUMN_NAME);

    const newCols = [
      ['testemunha1_email',       'VARCHAR(255) NULL'],
      ['testemunha2_email',       'VARCHAR(255) NULL'],
      ['docuseal_submission_id',  'VARCHAR(255) NULL'],
      // Etapa 3 (DRI v2): vínculo com o convite/projeto do Deal e andamento das assinaturas.
      ['convite_id',              'CHAR(36) NULL'],
      ['projeto_uuid',            'CHAR(36) NULL'],
      ['cliente_uuid',            'CHAR(36) NULL'],
      ['assinaturas_concluidas',  'INT NOT NULL DEFAULT 0'],
      ['assinado_em',             'DATETIME NULL'],
      ['vigente_ate',             'DATE NULL'],
    ];
    for (const [name, def] of newCols) {
      if (!colNames.includes(name)) {
        await conn.query(`ALTER TABLE clientes ADD COLUMN ${name} ${def}`);
      }
    }

    // Convites do Deal (comando nda.convite.criar). Só o hash do token fica no banco.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS convites (
        id                 CHAR(36) PRIMARY KEY,
        token_hash         CHAR(64) NOT NULL,
        projeto_uuid       CHAR(36) NOT NULL,
        cliente_uuid       CHAR(36) NOT NULL,
        email              VARCHAR(255) NOT NULL,
        empresa            VARCHAR(255) NOT NULL,
        responsavel        VARCHAR(255) NOT NULL,
        tipo_projeto       ENUM('replica', 'requisitos') NOT NULL,
        status             ENUM('pendente', 'em_assinatura', 'assinado', 'cancelado') NOT NULL DEFAULT 'pendente',
        nda_id             VARCHAR(64) NULL,
        expira_em          DATETIME NOT NULL,
        criado_em          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        lembretes_enviados INT NOT NULL DEFAULT 0,
        ultimo_lembrete_em DATETIME NULL,
        falha_email        TINYINT(1) NOT NULL DEFAULT 0,
        UNIQUE KEY uq_convites_token (token_hash),
        KEY idx_convites_projeto (projeto_uuid, status),
        KEY idx_convites_lembrete (status, criado_em)
      )
    `);

    // Bancos que já tinham a tabela convites (criada antes desta coluna).
    const [colsConvites] = await conn.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'convites'`
    );
    if (!colsConvites.some((r) => r.COLUMN_NAME === 'falha_email')) {
      await conn.query('ALTER TABLE convites ADD COLUMN falha_email TINYINT(1) NOT NULL DEFAULT 0');
    }

    // Idempotência dos comandos (Idempotency-Key): repetição devolve a resposta original.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS idempotencia_comandos (
        chave      VARCHAR(191) PRIMARY KEY,
        status     INT NOT NULL,
        resposta   JSON NOT NULL,
        criado_em  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Uma linha por signatário que assinou: a unicidade (nda, papel) torna o webhook do DocuSeal idempotente.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS assinaturas_nda (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        nda_id      INT NOT NULL,
        papel       ENUM('cliente', 'alluz', 'testemunha1', 'testemunha2') NOT NULL,
        nome        VARCHAR(255) NOT NULL,
        assinado_em DATETIME NOT NULL,
        UNIQUE KEY uq_assinatura_nda_papel (nda_id, papel)
      )
    `);

    // Outbox dos eventos nda-form → Deal: grava antes de enviar; dedupe_key impede evento duplicado (ex.: nda.assinado).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS outbox_eventos (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        evento_id            CHAR(36) NOT NULL,
        dedupe_key           VARCHAR(191) NOT NULL,
        tipo                 VARCHAR(60) NOT NULL,
        projeto_uuid         CHAR(36) NULL,
        payload              JSON NOT NULL,
        status               ENUM('pendente', 'enviado', 'falhou') NOT NULL DEFAULT 'pendente',
        tentativas           INT NOT NULL DEFAULT 0,
        proxima_tentativa_em DATETIME(3) NOT NULL,
        ultimo_erro          VARCHAR(255) NULL,
        criado_em            DATETIME(3) NOT NULL,
        enviado_em           DATETIME(3) NULL,
        UNIQUE KEY uq_outbox_evento (evento_id),
        UNIQUE KEY uq_outbox_dedupe (dedupe_key),
        KEY idx_outbox_pendentes (status, proxima_tentativa_em)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_users (
        id            INT AUTO_INCREMENT PRIMARY KEY,
        username      VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [rows] = await conn.query('SELECT COUNT(*) as count FROM admin_users');
    if (rows[0].count === 0 && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH) {
      await conn.query(
        'INSERT INTO admin_users (username, password_hash) VALUES (?, ?)',
        [process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD_HASH]
      );
      console.log('Admin padrão criado:', process.env.ADMIN_USERNAME);
    }

    console.log('Migrations executadas com sucesso.');
  } finally {
    conn.release();
  }
}

module.exports = runMigrations;
