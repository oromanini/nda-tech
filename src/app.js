require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const path = require('path');

const ndaRoutes = require('./routes/nda');
const authRoutes = require('./routes/auth');
const clientesRoutes = require('./routes/clientes');
const integracoesRoutes = require('./routes/integracoes');
const convitesRoutes = require('./routes/convites');

const app = express();
app.set('trust proxy', 1); // Cloud Run / load balancer
// rawBody: o HMAC das rotas de integração cobre os bytes exatos do corpo recebido.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Formulário sem convite só enquanto LEGACY_NDA_FORM_ENABLED=true (padrão). Depois, só /c/<token>.
const legadoLigado = () => (process.env.LEGACY_NDA_FORM_ENABLED ?? 'true') === 'true';
app.get(['/', '/index.html'], (req, res, next) => {
  if (legadoLigado()) return next();
  res.status(404).sendFile(path.join(__dirname, '..', 'public', 'convite-invalido.html'));
});
app.use(convitesRoutes);
app.use(express.static(path.join(__dirname, '..', 'public')));

const ndaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente novamente em 1 hora.' },
  // Os testes de integração fazem muitos POSTs do mesmo IP; o limite é testado à parte (tests/rateLimit.test.js).
  skip: () => process.env.NODE_ENV === 'test',
});

app.use('/api/gerar-nda', ndaLimiter);
app.use('/api', integracoesRoutes);
app.use('/api', ndaRoutes);
app.use('/api/admin', authRoutes);
app.use('/api/admin/clientes', clientesRoutes);

app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'login.html'));
});
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'dashboard.html'));
});

// Corpo JSON malformado: resposta limpa em vez da página de erro padrão.
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Corpo não é um JSON válido' });
  next(err);
});

module.exports = app;
