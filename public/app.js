'use strict';

// Steps: 0=Privacidade, 1=Tipo, 2=Dados, 3=Representante(PJ), 4=Testemunhas, 5=Email, 6=Revisão

const state = {
  tipoPessoa: 'PJ',
  currentStep: 0,
  totalSteps: 7,
  dados: {},
};

const steps = document.querySelectorAll('.step');
const progressFill = document.getElementById('progressFill');
const progressLabel = document.getElementById('progressLabel');
const stepDots = document.querySelectorAll('.step-dot');

// ── Máscaras ───────────────────────────────────────────────────────────────
function mask(el, pattern) {
  el.addEventListener('input', () => {
    let v = el.value.replace(/\D/g, '');
    let result = '';
    let vi = 0;
    for (let i = 0; i < pattern.length && vi < v.length; i++) {
      if (pattern[i] === '9') { result += v[vi++]; }
      else { result += pattern[i]; if (v[vi] === pattern[i]) vi++; }
    }
    el.value = result;
  });
}

mask(document.getElementById('cnpj'), '99.999.999/9999-99');
mask(document.getElementById('cpf_pf'), '999.999.999-99');
mask(document.getElementById('cep'), '99999-999');
mask(document.getElementById('cpf_representante'), '999.999.999-99');
mask(document.getElementById('test1_cpf'), '999.999.999-99');
mask(document.getElementById('test2_cpf'), '999.999.999-99');

// ── Validadores ────────────────────────────────────────────────────────────
function validarCPF(cpf) {
  cpf = cpf.replace(/\D/g, '');
  if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(cpf[i]) * (10 - i);
  let d1 = (sum * 10) % 11; if (d1 === 10 || d1 === 11) d1 = 0;
  if (d1 !== parseInt(cpf[9])) return false;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(cpf[i]) * (11 - i);
  let d2 = (sum * 10) % 11; if (d2 === 10 || d2 === 11) d2 = 0;
  return d2 === parseInt(cpf[10]);
}

function validarCNPJ(cnpj) {
  cnpj = cnpj.replace(/\D/g, '');
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const calc = (n, weights) => {
    let s = 0;
    for (let i = 0; i < weights.length; i++) s += parseInt(n[i]) * weights[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(cnpj, [5,4,3,2,9,8,7,6,5,4,3,2]) === parseInt(cnpj[12]) &&
         calc(cnpj, [6,5,4,3,2,9,8,7,6,5,4,3,2]) === parseInt(cnpj[13]);
}

function showError(fieldId, msg) {
  const el = document.getElementById(fieldId);
  if (!el) return;
  el.classList.add('error');
  const err = el.parentElement.querySelector('.field-error');
  if (err) { err.textContent = msg; err.classList.add('visible'); }
}
function clearAllErrors(stepEl) {
  stepEl.querySelectorAll('.error').forEach(e => e.classList.remove('error'));
  stepEl.querySelectorAll('.field-error.visible').forEach(e => e.classList.remove('visible'));
}

// ── CEP ViaCEP ─────────────────────────────────────────────────────────────
async function buscarCEP(cep, enderecoId) {
  const num = cep.replace(/\D/g, '');
  if (num.length !== 8) return;
  try {
    const r = await fetch(`https://viacep.com.br/ws/${num}/json/`);
    const d = await r.json();
    if (!d.erro) {
      const endEl = document.getElementById(enderecoId);
      if (endEl && !endEl.value) {
        endEl.value = `${d.logradouro}, ${d.bairro}, ${d.localidade} – ${d.uf}`;
      }
    }
  } catch (_) {}
}

document.getElementById('cep').addEventListener('blur', (e) => {
  const endId = state.tipoPessoa === 'PJ' ? 'endereco_pj' : 'endereco_pf';
  buscarCEP(e.target.value, endId);
});

// ── Tipo Pessoa ────────────────────────────────────────────────────────────
document.querySelectorAll('.radio-card').forEach(card => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const radio = card.querySelector('input[type="radio"]');
    radio.checked = true;
    state.tipoPessoa = radio.value;
  });
});

// ── Progress ───────────────────────────────────────────────────────────────
function updateProgress() {
  const s = state.currentStep;
  const total = state.totalSteps - 1;
  const pct = Math.round((s / total) * 100);
  progressFill.style.width = pct + '%';
  progressLabel.textContent = `Etapa ${s + 1} de ${state.totalSteps}`;

  stepDots.forEach((dot, i) => {
    dot.classList.remove('active', 'done');
    if (i < s) dot.classList.add('done');
    else if (i === s) dot.classList.add('active');
  });
}

// ── Navigate ───────────────────────────────────────────────────────────────
function applyTipoPessoa() {
  const isPJ = state.tipoPessoa === 'PJ';
  document.getElementById('fields-pj').style.display = isPJ ? '' : 'none';
  document.getElementById('fields-pf').style.display = isPJ ? 'none' : '';
}

function goTo(n) {
  steps[state.currentStep].classList.remove('active');
  state.currentStep = n;
  steps[state.currentStep].classList.add('active');
  if (n === 2) applyTipoPessoa();
  updateProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function nextStep() {
  if (!validateCurrentStep()) return;
  collectCurrentStep();

  let next = state.currentStep + 1;
  // Pular step 3 (representante) se PF
  if (next === 3 && state.tipoPessoa === 'PF') next = 4;

  if (next === 6) buildReview();
  goTo(next);
}

function prevStep() {
  let prev = state.currentStep - 1;
  if (prev === 3 && state.tipoPessoa === 'PF') prev = 2;
  if (prev < 0) prev = 0;
  goTo(prev);
}

// ── Validação por step ─────────────────────────────────────────────────────
function validateCurrentStep() {
  const step = steps[state.currentStep];
  clearAllErrors(step);
  let ok = true;

  switch (state.currentStep) {
    case 0: {
      if (!document.getElementById('privacyAccept').checked) {
        alert('Você precisa aceitar os termos de privacidade para continuar.');
        ok = false;
      }
      break;
    }
    case 1: {
      if (!document.querySelector('input[name="tipoPessoa"]:checked')) {
        alert('Selecione o tipo de pessoa.');
        ok = false;
      }
      break;
    }
    case 2: {
      if (state.tipoPessoa === 'PJ') {
        if (!document.getElementById('razao_social').value.trim()) {
          showError('razao_social', 'Campo obrigatório.'); ok = false;
        }
        if (!validarCNPJ(document.getElementById('cnpj').value)) {
          showError('cnpj', 'CNPJ inválido.'); ok = false;
        }
        if (!document.getElementById('endereco_pj').value.trim()) {
          showError('endereco_pj', 'Campo obrigatório.'); ok = false;
        }
      } else {
        if (!document.getElementById('nome_pf').value.trim()) {
          showError('nome_pf', 'Campo obrigatório.'); ok = false;
        }
        if (!validarCPF(document.getElementById('cpf_pf').value)) {
          showError('cpf_pf', 'CPF inválido.'); ok = false;
        }
        if (!document.getElementById('endereco_pf').value.trim()) {
          showError('endereco_pf', 'Campo obrigatório.'); ok = false;
        }
      }
      if (document.getElementById('cep').value.replace(/\D/g,'').length !== 8) {
        showError('cep', 'CEP inválido.'); ok = false;
      }
      break;
    }
    case 3: {
      if (!document.getElementById('representante').value.trim()) {
        showError('representante', 'Campo obrigatório.'); ok = false;
      }
      if (!validarCPF(document.getElementById('cpf_representante').value)) {
        showError('cpf_representante', 'CPF inválido.'); ok = false;
      }
      if (!document.getElementById('cargo').value.trim()) {
        showError('cargo', 'Campo obrigatório.'); ok = false;
      }
      break;
    }
    case 4: {
      const emailRe4 = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      ['test1_nome','test2_nome'].forEach(id => {
        if (!document.getElementById(id).value.trim()) {
          showError(id, 'Campo obrigatório.'); ok = false;
        }
      });
      ['test1_cpf','test2_cpf'].forEach(id => {
        if (!validarCPF(document.getElementById(id).value)) {
          showError(id, 'CPF inválido.'); ok = false;
        }
      });
      ['test1_email','test2_email'].forEach(id => {
        if (!emailRe4.test(document.getElementById(id).value)) {
          showError(id, 'E-mail inválido.'); ok = false;
        }
      });
      break;
    }
    case 5: {
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const email = document.getElementById('email');
      const emailConf = document.getElementById('email_confirm');
      if (!emailRe.test(email.value)) {
        showError('email', 'E-mail inválido.'); ok = false;
      }
      if (email.value !== emailConf.value) {
        showError('email_confirm', 'Os e-mails não coincidem.'); ok = false;
      }
      break;
    }
  }
  return ok;
}

// ── Coleta dados por step ──────────────────────────────────────────────────
function collectCurrentStep() {
  switch (state.currentStep) {
    case 1:
      state.tipoPessoa = document.querySelector('input[name="tipoPessoa"]:checked').value;
      state.dados.tipo_pessoa = state.tipoPessoa;
      break;
    case 2:
      if (state.tipoPessoa === 'PJ') {
        state.dados.razao_social = document.getElementById('razao_social').value.trim();
        state.dados.cnpj_cpf = document.getElementById('cnpj').value;
        state.dados.endereco = document.getElementById('endereco_pj').value.trim();
      } else {
        state.dados.razao_social = document.getElementById('nome_pf').value.trim();
        state.dados.cnpj_cpf = document.getElementById('cpf_pf').value;
        state.dados.endereco = document.getElementById('endereco_pf').value.trim();
      }
      state.dados.cep = document.getElementById('cep').value;
      break;
    case 3:
      state.dados.representante = document.getElementById('representante').value.trim();
      state.dados.cpf_representante = document.getElementById('cpf_representante').value;
      state.dados.cargo = document.getElementById('cargo').value.trim();
      break;
    case 4:
      state.dados.testemunha1_nome = document.getElementById('test1_nome').value.trim();
      state.dados.testemunha1_cpf = document.getElementById('test1_cpf').value;
      state.dados.testemunha1_email = document.getElementById('test1_email').value.trim();
      state.dados.testemunha2_nome = document.getElementById('test2_nome').value.trim();
      state.dados.testemunha2_cpf = document.getElementById('test2_cpf').value;
      state.dados.testemunha2_email = document.getElementById('test2_email').value.trim();
      break;
    case 5:
      state.dados.email = document.getElementById('email').value.trim();
      break;
  }
}

// ── Review ─────────────────────────────────────────────────────────────────
function rv(label, value) {
  if (!value) return '';
  return `<div class="review-row"><span class="r-label">${label}</span><span class="r-value">${value}</span></div>`;
}

function buildReview() {
  const d = state.dados;

  document.getElementById('review-empresa').innerHTML = `
    ${rv('Tipo', d.tipo_pessoa === 'PJ' ? 'Pessoa Jurídica' : 'Pessoa Física')}
    ${rv(d.tipo_pessoa === 'PJ' ? 'Razão Social' : 'Nome', d.razao_social)}
    ${rv(d.tipo_pessoa === 'PJ' ? 'CNPJ' : 'CPF', d.cnpj_cpf)}
    ${rv('Endereço', d.endereco)}
    ${rv('CEP', d.cep)}
  `;

  const secRep = document.getElementById('review-section-representante');
  if (d.tipo_pessoa === 'PJ') {
    secRep.style.display = '';
    document.getElementById('review-representante').innerHTML = `
      ${rv('Representante', d.representante)}
      ${rv('CPF', d.cpf_representante)}
      ${rv('Cargo', d.cargo)}
    `;
  } else {
    secRep.style.display = 'none';
  }

  document.getElementById('review-testemunhas').innerHTML = `
    ${rv('Testemunha 1', d.testemunha1_nome + ' — ' + d.testemunha1_cpf)}
    ${rv('E-mail Test. 1', d.testemunha1_email)}
    ${rv('Testemunha 2', d.testemunha2_nome + ' — ' + d.testemunha2_cpf)}
    ${rv('E-mail Test. 2', d.testemunha2_email)}
  `;

  document.getElementById('review-email').innerHTML = rv('E-mail', d.email);
}

// ── Submit ─────────────────────────────────────────────────────────────────
document.getElementById('btnSubmit').addEventListener('click', async () => {
  const loading = document.getElementById('loading');
  const inlineError = document.getElementById('inlineError');

  loading.classList.add('visible');
  inlineError.classList.remove('visible');

  try {
    const res = await fetch('/api/gerar-nda', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(conviteToken ? { ...state.dados, convite_token: conviteToken } : state.dados),
    });
    const data = await res.json();

    if (res.ok && data.success) {
      loading.classList.remove('visible');
      document.getElementById('formCard').style.display = 'none';
      document.querySelector('.progress-wrap').style.display = 'none';
      document.getElementById('emailDisplay').textContent = state.dados.email;
      document.getElementById('successScreen').classList.add('visible');
      lucide.createIcons();
    } else {
      throw new Error(data.error || 'Erro desconhecido.');
    }
  } catch (err) {
    loading.classList.remove('visible');
    inlineError.textContent = err.message || 'Ocorreu um erro. Tente novamente.';
    inlineError.classList.add('visible');
  }
});

// ── Privacy checkbox ───────────────────────────────────────────────────────
document.getElementById('privacyAccept').addEventListener('change', (e) => {
  document.getElementById('btnStart').disabled = !e.target.checked;
});

// ── Wire navigation buttons ────────────────────────────────────────────────
document.querySelectorAll('[data-next]').forEach(btn => {
  btn.addEventListener('click', nextStep);
});
document.querySelectorAll('[data-prev]').forEach(btn => {
  btn.addEventListener('click', prevStep);
});

document.getElementById('editEmpresa').addEventListener('click', () => goTo(2));
document.getElementById('editRepresentante').addEventListener('click', () => goTo(state.tipoPessoa === 'PJ' ? 3 : 2));
document.getElementById('editTestemunhas').addEventListener('click', () => goTo(4));
document.getElementById('editEmail').addEventListener('click', () => goTo(5));

// ── Convite do Deal (/c/<token>) ───────────────────────────────────────────
// O e-mail vem do convite e fica travado; o servidor também ignora qualquer outro valor enviado no POST.
const conviteToken = (location.pathname.match(/^\/c\/([A-Za-z0-9_-]{32,128})$/) || [])[1] || null;

async function carregarConvite() {
  if (!conviteToken) return;
  try {
    const res = await fetch(`/api/convites/${conviteToken}`);
    if (!res.ok) throw new Error('convite indisponível');
    const c = await res.json();
    const set = (id, v) => { const el = document.getElementById(id); if (el && !el.value) el.value = v; };
    set('razao_social', c.empresa);
    set('representante', c.responsavel);
    set('nome_pf', c.responsavel);
    for (const id of ['email', 'email_confirm']) {
      const el = document.getElementById(id);
      el.value = c.email;
      el.readOnly = true;
      el.title = 'E-mail definido pelo convite';
    }
  } catch {
    location.replace(location.pathname); // o servidor responde com a página neutra
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
carregarConvite();
updateProgress();
lucide.createIcons();
