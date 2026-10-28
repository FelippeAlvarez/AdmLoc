'use strict';
/* Controle de Locações — telas, cadastros e cálculo do extrato mensal */

/* ================= Utilidades ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const novoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const p2 = n => String(n).padStart(2, '0');
const cent = v => Math.round((Number(v) || 0) * 100);
const r2 = v => cent(v) / 100;
const fmtNum = v => (Number(v) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoeda = v => 'R$ ' + fmtNum(v);
const fmtPct = v => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const comparar = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR', { numeric: true, sensitivity: 'base' });

function parseValor(s) {
  if (typeof s === 'number') return s;
  s = String(s ?? '').replace(/R\$|\s/g, '');
  if (!s) return 0;
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (!/^\d+\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : (neg ? -n : n);
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const nomeMes = ym => { if (!ym) return ''; const [a, m] = ym.split('-'); return MESES[+m - 1] + '/' + a; };
const nomeMesCurto = ym => { const [a, m] = ym.split('-'); return MESES[+m - 1].slice(0, 3) + '/' + a.slice(2); };
function addMes(ym, n) {
  let [a, m] = ym.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; a++; }
  while (m < 1) { m += 12; a--; }
  return a + '-' + p2(m);
}
function mesesEntre(de, ate) { let n = 0; for (let x = de; x <= ate; x = addMes(x, 1)) n++; return n; }
const hoje = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };
const mesAtual = () => hoje().slice(0, 7);
const fmtData = iso => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '';
const ehMes = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');

function aviso(msg, tipo = 'ok') {
  const a = $('#aviso');
  a.textContent = msg;
  a.className = 'aviso mostrar ' + tipo;
  clearTimeout(a._t);
  a._t = setTimeout(() => { a.className = 'aviso'; }, tipo === 'erro' ? 8000 : 3500);
}

class ErroConflito extends Error {
  constructor(m) {
    super(m || 'Este registro foi alterado em outro computador enquanto você editava. Os dados foram recarregados: confira e refaça a alteração.');
    this.conflito = true;
  }
}

async function executar(fn) {
  try { return await fn(); }
  catch (e) {
    console.error(e);
    aviso(e.message || String(e), 'erro');
    if (e.conflito) { sujo = false; rotear(true); }
    if (e.sessao) { sujo = false; Auth.sair(); telaLogin(); }
  }
}

function baixar(blob, nome) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function abrirModal(html, classe = '') {
  $('#modalCaixa').className = 'modal-caixa ' + classe;
  $('#modalCaixa').innerHTML = html;
  $('#modal').hidden = false;
}
function fecharModal() { $('#modal').hidden = true; $('#modalCaixa').innerHTML = ''; }

const usuario = () => Auth.usuario?.nome || '';

/* ================= Dados ================= */
const COLECOES = ['locadores', 'locatarios', 'imoveis', 'contratos'];
const D = { config: null, locadores: {}, locatarios: {}, imoveis: {}, contratos: {}, extratos: {}, calcs: {}, carregadoEm: 0 };

const RUBRICAS_PADRAO = [
  ['Aluguel', true], ['Condomínio', false], ['IPTU', false], ['Seguro incêndio', false], ['Taxa de lixo', false],
  ['Fundo de reserva', false], ['Água', false], ['Energia elétrica', false], ['Gás', false],
  ['Multa por atraso', false], ['Juros', false], ['Desconto', false], ['Reparos / manutenção', false],
  ['Tarifa bancária', false], ['Outros', false],
].map(([nome, locacao]) => ({ nome, locacao }));

function normalizarConfig(c) {
  c = c || {};
  return {
    rev: c.rev || 0,
    administradora: { nome: '', documento: '', endereco: '', cidade: '', telefone: '', email: '', logo: null, logoL: 0, logoA: 0, ...(c.administradora || {}) },
    rubricas: Array.isArray(c.rubricas) && c.rubricas.length ? c.rubricas : RUBRICAS_PADRAO.map(r => ({ ...r })),
    // Padrões dos encargos moratórios (cada contrato pode ter os seus)
    moratorios: { multa: 10, juros: 1, honorarios: 10, indice: 'IGP-M', ignorarNegativos: false, ...(c.moratorios || {}) },
    // Pagamentos em atraso feitos a partir desta data entram na prestação de contas do mês do pagamento ('' = nunca)
    atrasoNoMesDoPagamento: c.atrasoNoMesDoPagamento === undefined ? '2026-11-01' : c.atrasoNoMesDoPagamento,
  };
}

async function lerJSON(caminho, padrao) {
  const t = await Armaz.ler(caminho);
  if (t == null || t.trim() === '') return padrao;
  try { return JSON.parse(t); }
  catch { throw new Error('O arquivo ' + caminho + ' está danificado. Restaure-o a partir da pasta _backups.'); }
}

async function carregarColecoes() {
  const res = await Promise.all([lerJSON('config.json', null), lerJSON('indices.json', null), ...COLECOES.map(c => lerJSON(c + '.json', { itens: {} }))]);
  D.config = normalizarConfig(res[0]);
  D.indices = { rev: 0, series: {}, ...(res[1] || {}) };
  COLECOES.forEach((c, i) => { D[c] = res[i + 2].itens || {}; });
  D.carregadoEm = Date.now();
  atualizarDatalist();
}

function atualizarDatalist() {
  $('#dlRubricas').innerHTML = D.config.rubricas.map(r => `<option value="${esc(r.nome)}">`).join('');
}
const rubricaCatalogo = nome => D.config.rubricas.find(r => r.nome.trim().toLowerCase() === String(nome || '').trim().toLowerCase());

const arquivosDeDados = () => ['config.json', 'indices.json', ...COLECOES.map(c => c + '.json'), ...Object.keys(D.contratos).flatMap(id => [`extratos/${id}.json`, `calculos/${id}.json`])];

// Cópia diária de segurança de todos os arquivos, feita antes da primeira gravação do dia
let backupDoDia = null;
async function copiaDeSeguranca(pasta) {
  // No modo servidor, a cópia dos usuários é feita pelo próprio servidor
  for (const a of [...arquivosDeDados(), ...(Armaz.modo === 'servidor' ? [] : ['usuarios.json'])]) {
    const t = await Armaz.ler(a);
    if (t != null) await Armaz.gravar(`_backups/${pasta}/${a}`, t);
  }
  await Armaz.gravar(`_backups/${pasta}/ok.txt`, new Date().toISOString() + ' ' + usuario());
}
async function backupDiario() {
  if (Armaz.modo === 'local') return;
  const dia = hoje();
  if (backupDoDia === dia) return;
  backupDoDia = dia;
  try {
    if (await Armaz.ler(`_backups/${dia}/ok.txt`) != null) return;
    await copiaDeSeguranca(dia);
  } catch (e) { console.warn('Falha na cópia de segurança', e); }
}

function carimbo(reg) {
  return { ...reg, rev: (reg.rev || 0) + 1, atualizadoEm: new Date().toISOString(), atualizadoPor: usuario() };
}

// Grava um registro relendo o arquivo antes, para não apagar alterações feitas em outro computador
async function salvarRegistro(col, reg) {
  await backupDiario();
  return comTrava(async () => {
  const arq = await lerJSON(col + '.json', { itens: {} });
  arq.itens = arq.itens || {};
  const atual = arq.itens[reg.id];
  if ((atual && (atual.rev || 0) !== (reg.rev || 0)) || (!atual && reg.rev)) {
    D[col] = arq.itens;
    throw new ErroConflito(!atual ? 'Este registro foi excluído em outro computador.' : undefined);
  }
  const novo = carimbo(reg);
  arq.itens[reg.id] = novo;
  await Armaz.gravar(col + '.json', JSON.stringify(arq, null, 1));
  D[col] = arq.itens;
  return novo;
  });
}

async function excluirRegistro(col, id) {
  await backupDiario();
  await comTrava(async () => {
    const arq = await lerJSON(col + '.json', { itens: {} });
    delete arq.itens[id];
    await Armaz.gravar(col + '.json', JSON.stringify(arq, null, 1));
    D[col] = arq.itens;
  });
}

async function salvarConfig(novo) {
  if (!Auth.ehAdmin()) throw new Error('Somente o administrador pode alterar as configurações.');
  await backupDiario();
  return comTrava(async () => {
  const atual = await lerJSON('config.json', null);
  if ((atual?.rev || 0) !== (D.config.rev || 0)) {
    D.config = normalizarConfig(atual);
    throw new ErroConflito('As configurações foram alteradas em outro computador. Elas foram recarregadas: refaça a alteração.');
  }
  const c = carimbo(novo);
  await Armaz.gravar('config.json', JSON.stringify(c, null, 1));
  D.config = normalizarConfig(c);
  atualizarDatalist();
  });
}

async function carregarExtrato(cid) {
  // Os cálculos de débito do contrato vêm junto: pagamentos lançados neles podem entrar na prestação de contas
  const [e] = await Promise.all([lerJSON(`extratos/${cid}.json`, { contratoId: cid, meses: {} }), carregarCalculos(cid, 120000)]);
  e.meses = e.meses || {};
  D.extratos[cid] = e;
  return e;
}

// mapa = { 'AAAA-MM': mes | null (null exclui) }. Cada mês leva o "rev" com que foi aberto.
async function salvarMeses(cid, mapa) {
  await backupDiario();
  return comTrava(async () => {
  const arq = await lerJSON(`extratos/${cid}.json`, { contratoId: cid, meses: {} });
  arq.meses = arq.meses || {};
  for (const [ym, mes] of Object.entries(mapa)) {
    const atual = arq.meses[ym];
    const revBase = mes ? (mes.rev || 0) : (mapa[ym] === null ? (atual?.rev || 0) : 0);
    if ((atual?.rev || 0) !== revBase) {
      D.extratos[cid] = arq;
      throw new ErroConflito(`${nomeMes(ym)} foi alterado em outro computador. Os dados foram recarregados: confira e refaça a alteração.`);
    }
  }
  for (const [ym, mes] of Object.entries(mapa)) {
    if (mes === null) delete arq.meses[ym];
    else arq.meses[ym] = carimbo(mes);
  }
  await Armaz.gravar(`extratos/${cid}.json`, JSON.stringify(arq, null, 1));
  D.extratos[cid] = arq;
  return arq;
  });
}

/* ================= Cálculo do extrato ================= */
// Repasse ao cliente: "programado" (data prevista) ou efetuado (os antigos, sem situação, são efetuados)
const repasseEfetuado = r => r.status !== 'programado';
const repassesEfetuados = mes => (mes?.repasses || []).filter(repasseEfetuado);
// Beneficiários do repasse do contrato: os informados (clientes cadastrados, com %) ou 100% para o locador
const beneficiariosDe = ct => (ct.beneficiarios || []).filter(b => b.locadorId && Number(b.pct) > 0).length
  ? ct.beneficiarios.filter(b => b.locadorId && Number(b.pct) > 0) : [{ locadorId: ct.locadorId, pct: 100 }];
// Situação do pagamento do locatário no mês. Meses lançados antes deste controle contam como pagos.
const situacaoPagto = mes => mes.pagamento || 'pago';

// Vencimento do mês: o informado no mês ou o dia de vencimento do contrato (no próprio mês ou no seguinte)
function vencimentoMes(ct, ym, mes) {
  if (mes?.vencimento) return mes.vencimento;
  const ref = ct.vencMesSeguinte === 'sim' ? addMes(ym, 1) : ym;
  const [a, m] = ref.split('-').map(Number);
  const ultimo = new Date(a, m, 0).getDate();
  return `${ref}-${p2(Math.min(Number(ct.diaVencimento) || 10, ultimo))}`;
}

/*
  Pagamento em atraso: registrado no mês de referência, mas lançado (saldo, taxa) na prestação de contas
  do mês em que foi pago, a partir da data configurada pelo administrador (pagamentos anteriores ficam
  no mês de referência, como sempre foram). Pagamento no próprio mês ou antecipado: mês de referência.
*/
const inicioAtrasoNoPagamento = () => D.config?.atrasoNoMesDoPagamento || '';
function mesDoLancamento(mes, ym) {
  const desde = inicioAtrasoNoPagamento(), data = mes.recebidoEm || '';
  if (!desde || !ym || situacaoPagto(mes) === 'aberto' || !data || data < desde) return ym;
  return data.slice(0, 7) > ym ? data.slice(0, 7) : ym;
}

// Valores recebidos do locatário no mês (em centavos), sem saldo
function recebimentoMes(mes) {
  let cob = 0, loc = 0;
  for (const l of mes.linhas || []) { const c = cent(l.cobrado); cob += c; if (l.locacao) loc += c; }
  let desc = 0, reemb = 0;
  for (const a of mes.ajustes || []) { if (a.tipo === 'reembolso') reemb += cent(a.valor); else desc += cent(a.valor); }
  const devido = cob - desc - reemb, locLiq = Math.max(0, loc - desc);
  const sit = situacaoPagto(mes);
  const principal = sit === 'pago' ? devido : sit === 'parcial' ? Math.max(0, Math.min(cent(mes.valorRecebido), devido)) : 0;
  const encargos = sit === 'aberto' ? 0 : cent(mes.encargosRecebidos);
  const recebido = principal + encargos;
  // Parte do recebido que é locação (rubricas marcadas como Locação, menos descontos), proporcional ao que foi pago
  const locacao = devido > 0 ? Math.round(locLiq * Math.min(1, principal / devido)) : 0;
  const base = mes.baseTaxa === 'total' ? recebido : locacao;
  const taxa = base > 0 ? Math.round(base * (Number(mes.taxaAdm) || 0) / 100) : 0;
  return { principal, encargos, recebido, locacao, base, taxa };
}

// ctx: { ym: mês de referência, vindos: recebimentos de meses anteriores lançados neste mês }
function calcMes(mes, saldoAnterior, ctx = {}) {
  let cob = 0, pag = 0;
  for (const l of mes.linhas || []) { cob += cent(l.cobrado); pag += cent(l.pago); }
  // Descontos e reembolsos concedidos ao locatário reduzem o valor devido.
  // O desconto também reduz a base da taxa sobre a locação; o reembolso (de despesa) não.
  let desc = 0, reemb = 0;
  for (const a of mes.ajustes || []) { if (a.tipo === 'reembolso') reemb += cent(a.valor); else desc += cent(a.valor); }
  const devido = cob - desc - reemb;
  const sit = situacaoPagto(mes);
  // Recebido do locatário: tudo (pago), parte (parcial) ou nada (em aberto), mais multa/juros/correção recebidos.
  // Taxa sobre todo o valor recebido, ou só sobre a parte de locação do que foi recebido.
  const r = recebimentoMes(mes);
  const f = v => v / 100;
  // Pago em atraso, num mês posterior: entra na prestação de contas daquele mês, não nesta
  const lanc = mesDoLancamento(mes, ctx.ym);
  const diferido = lanc !== ctx.ym;
  const proprio = diferido ? { principal: 0, encargos: 0, recebido: 0, base: 0, taxa: 0 } : r;
  const vindos = (ctx.vindos || []).map(v => ({ ...v, principal: f(v.r.principal), encargos: f(v.r.encargos), recebido: f(v.r.recebido), base: f(v.r.base), taxa: f(v.r.taxa) }));
  const recAnt = (ctx.vindos || []).reduce((s, v) => s + v.r.recebido, 0), taxaAnt = (ctx.vindos || []).reduce((s, v) => s + v.r.taxa, 0);
  const recebido = proprio.recebido + recAnt, taxa = proprio.taxa + taxaAnt;
  const liq = recebido - pag, doMes = liq - taxa, ant = cent(saldoAnterior), disp = ant + doMes;
  // Só o repasse efetuado baixa o saldo em conta; o programado fica reservado (não pode ser programado de novo)
  let rep = 0, prog = 0;
  for (const x of mes.repasses || []) { if (repasseEfetuado(x)) rep += cent(x.valor); else prog += cent(x.valor); }
  return {
    programado: f(prog),
    situacao: sit, saldoAnterior: f(ant), cobrado: f(cob), descontos: f(desc), reembolsos: f(reemb), devido: f(devido),
    // Recebido referente a este mês e lançado nele
    principalRecebido: f(proprio.principal), encargosRecebidos: f(proprio.encargos), baseTaxa: f(proprio.base), taxaMes: f(proprio.taxa),
    // Pagamento deste mês lançado num mês posterior
    diferido: diferido ? { ym: lanc, recebidoEm: mes.recebidoEm, principal: f(r.principal), encargos: f(r.encargos), recebido: f(r.recebido), base: f(r.base), taxa: f(r.taxa) } : null,
    // Recebimentos de meses anteriores lançados neste mês
    anteriores: vindos, recebidoAnteriores: f(recAnt), taxaAnteriores: f(taxaAnt),
    // Totais lançados no mês (o que entra no saldo)
    recebido: f(recebido), taxa: f(taxa),
    emAberto: f(Math.max(0, devido - r.principal)), pago: f(pag), liquido: f(liq),
    saldoMes: f(doMes), disponivel: f(disp), repassado: f(rep), saldoConta: f(disp - rep),
  };
}

// Recebimentos de meses anteriores que são lançados em cada mês: { 'AAAA-MM': [{ ym, recebidoEm, r }] }
function recebimentosDiferidos(ext, exceto) {
  const mapa = {};
  for (const [ym, mes] of Object.entries(ext.meses || {})) {
    if (ym === exceto) continue;
    const lanc = mesDoLancamento(mes, ym);
    if (lanc !== ym) (mapa[lanc] = mapa[lanc] || []).push({ ym, recebidoEm: mes.recebidoEm, r: recebimentoMes(mes) });
  }
  Object.values(mapa).forEach(l => l.sort((a, b) => comparar(a.ym, b.ym)));
  return mapa;
}

/*
  Recebimentos lançados em cada mês da prestação de contas: os pagamentos em atraso (acima) e os pagamentos de débitos
  registrados no Cálculo do débito com a opção "lançar na prestação de contas", na data em que o valor fica disponível
  (ex.: depósito judicial, só depois do levantamento). A taxa de administração do contrato incide se assim indicado.
*/
function recebimentosLancados(ct, ext, exceto) {
  const mapa = recebimentosDiferidos(ext, exceto);
  for (const a of D.calcs?.[ct.id]?.amortizacoes || []) {
    const p = a.prestacao;
    if (!p?.lancar || !ehData(p.data)) continue;
    const v = cent(p.valor === undefined || p.valor === null || p.valor === '' ? a.valor : p.valor);
    if (!v) continue;
    const taxa = p.taxa === false ? 0 : Math.round(v * (Number(ct.taxaAdm) || 0) / 100);
    const lanc = p.data.slice(0, 7);
    (mapa[lanc] = mapa[lanc] || []).push({ ym: lanc, cobranca: true, recebidoEm: a.data, disponivelEm: p.data,
      desc: `Recebido de débito em atraso${a.obs ? ' (' + a.obs + ')' : ''}: pago em ${fmtData(a.data)}${p.data !== a.data ? ', disponível em ' + fmtData(p.data) : ''}`,
      r: { principal: v, encargos: 0, recebido: v, locacao: v, base: taxa ? v : 0, taxa } });
  }
  // Pagamentos de acordos, na data indicada pelo usuário
  for (const x of recebimentosDeAcordos(ct)) {
    const v = cent(x.valor);
    if (!v) continue;
    const taxa = x.taxa ? Math.round(v * (Number(ct.taxaAdm) || 0) / 100) : 0;
    const lanc = x.data.slice(0, 7);
    (mapa[lanc] = mapa[lanc] || []).push({ ym: lanc, cobranca: true, recebidoEm: x.e.data, disponivelEm: x.data,
      desc: `Recebido de acordo (${x.a.nome || 'acordo'}, ${descEvento(x.e).toLowerCase()}): pago em ${fmtData(x.e.data)}${x.data !== x.e.data ? ', disponível em ' + fmtData(x.data) : ''}`,
      r: { principal: v, encargos: 0, recebido: v, locacao: v, base: taxa ? v : 0, taxa } });
  }
  return mapa;
}

function chipPagto(c, venc) {
  if (c.situacao === 'pago') return '<span class="chip fechado">Pago</span>';
  const atraso = venc < hoje();
  if (c.situacao === 'parcial') return `<span class="chip ${atraso ? 'pendente' : 'aberto'}">Parcial</span>`;
  if (c.devido <= 0) return '<span class="chip neutro">Sem cobrança</span>';
  return atraso ? '<span class="chip pendente">Em atraso</span>' : '<span class="chip aberto">A vencer</span>';
}

// Encadeia os meses: o saldo em conta de um mês é o saldo anterior do mês seguinte
function calcularExtrato(ct, ext) {
  let saldo = r2(ct.saldoInicial);
  const vindos = recebimentosLancados(ct, ext);
  return Object.keys(ext.meses).sort().map(ym => {
    const mes = ext.meses[ym];
    const c = calcMes(mes, saldo, { ym, vindos: vindos[ym] });
    saldo = c.saldoConta;
    return { ym, mes, c };
  });
}

const inicioControle = ct => ct.inicioControle || (ct.inicio || '').slice(0, 7) || mesAtual();

function linhasDoContrato(ct) {
  const L = [{ id: novoId(), rubrica: 'Aluguel', obs: '', cobrado: r2(ct.valorAluguel), pago: 0, locacao: true, recorrente: true }];
  for (const e of ct.encargos || []) {
    L.push({ id: novoId(), rubrica: e.rubrica, obs: '', cobrado: r2(e.cobrado), pago: r2(e.pago), locacao: !!rubricaCatalogo(e.rubrica)?.locacao, recorrente: true });
  }
  return L;
}
const linhasRepetidas = mes => (mes?.linhas || []).filter(l => l.recorrente).map(l => ({ ...l, id: novoId() }));

function novoMes(ct, anterior, ym) {
  return {
    linhas: anterior ? linhasRepetidas(anterior) : linhasDoContrato(ct),
    taxaAdm: Number(ct.taxaAdm) || 0,
    baseTaxa: ct.baseTaxa || 'locacao',
    vencimento: vencimentoMes(ct, ym, null),
    pagamento: 'aberto', recebidoEm: '', valorRecebido: 0, encargosRecebidos: 0,
    ajustes: (anterior?.ajustes || []).filter(a => a.recorrente).map(a => ({ ...a, id: novoId() })),
    repasses: [], fechado: false, obs: '',
  };
}

// Gera todos os meses que faltam, do último lançado até "alvo"
async function gerarAte(ct, alvo) {
  const ext = await carregarExtrato(ct.id);
  const yms = Object.keys(ext.meses).sort();
  const ultimo = yms[yms.length - 1];
  if (ext.meses[alvo]) return 0;
  if (!ultimo && alvo < inicioControle(ct)) throw new Error(`O controle do ${rotuloContrato(ct)} começa em ${nomeMes(inicioControle(ct))}.`);
  if (ultimo && alvo < ultimo) throw new Error('Não é possível gerar um mês anterior ao primeiro mês lançado.');
  const novos = {};
  let anterior = ultimo ? ext.meses[ultimo] : null;
  for (let ym = ultimo ? addMes(ultimo, 1) : inicioControle(ct); ym <= alvo; ym = addMes(ym, 1)) {
    anterior = novoMes(ct, anterior, ym);
    novos[ym] = anterior;
  }
  await salvarMeses(ct.id, novos);
  return Object.keys(novos).length;
}

/* ================= Descrições ================= */
const nomeDe = (col, id) => D[col][id]?.nome || '—';
function descImovel(im) {
  if (!im) return '—';
  return [[im.logradouro, im.numero].filter(Boolean).join(', '), im.complemento, im.bairro, [im.cidade, im.uf].filter(Boolean).join('/')]
    .filter(Boolean).join(' - ');
}
// Versão curta para tabelas: código, rua e número (e complemento)
const imovelCurto = im => im ? [im.codigo, [im.logradouro, im.numero].filter(Boolean).join(', ') + (im.complemento ? ' - ' + im.complemento : '')].filter(Boolean).join(' · ') : '—';
const rotuloImovel = im => im ? (im.codigo ? im.codigo + ' · ' : '') + descImovel(im) : '—';
const rotuloContrato = ct => 'Contrato ' + (ct?.codigo || 's/nº');
const descBase = base => base === 'total' ? 'sobre todos os valores recebidos' : 'sobre os valores de locação';
const ordemContrato = (a, b) => comparar(a.codigo, b.codigo);
const contratosAtivos = () => Object.values(D.contratos).filter(c => c.status !== 'encerrado').sort(ordemContrato);

function opcoes(col) {
  const itens = Object.values(D[col]);
  if (col === 'imoveis') return itens.map(i => [i.id, rotuloImovel(i)]).sort((a, b) => comparar(a[1], b[1]));
  if (col === 'contratos') return itens.sort(ordemContrato).map(c => [c.id, rotuloContrato(c) + ' · ' + descImovel(D.imoveis[c.imovelId])]);
  return itens.map(i => [i.id, i.nome]).sort((a, b) => comparar(a[1], b[1]));
}

/* ================= Formulários ================= */
const GARANTIAS = [['fianca', 'Fiança (fiador)'], ['seguro', 'Seguro fiança'], ['caucao', 'Caução em dinheiro'], ['titulo', 'Título de capitalização'], ['outra', 'Outra (descrever nas observações)'], ['nenhuma', 'Sem garantia']];
// Descrição da garantia do contrato, para telas e documentos
function descGarantia(ct) {
  const t = ct.tipoGarantia, j = (...p) => p.filter(Boolean).join(', ');
  let d = '';
  if (t === 'fianca') d = 'Fiança: ' + [j(ct.fiadorNome, ct.fiadorDocumento && 'CPF/CNPJ ' + ct.fiadorDocumento), j(ct.fiador2Nome, ct.fiador2Documento && 'CPF/CNPJ ' + ct.fiador2Documento)].filter(Boolean).join(' e ');
  else if (t === 'seguro') d = 'Seguro fiança: ' + j(ct.seguradora, ct.seguradoraCnpj && 'CNPJ ' + ct.seguradoraCnpj, ct.apolice && 'apólice ' + ct.apolice,
    (ct.apoliceInicio || ct.apoliceFim) && 'vigência ' + [fmtData(ct.apoliceInicio), fmtData(ct.apoliceFim)].filter(Boolean).join(' a '));
  else if (t === 'caucao') d = 'Caução' + (ct.caucaoValor ? ' de ' + fmtMoeda(ct.caucaoValor) : '') + (ct.caucaoDeposito ? ', depositada em ' + ct.caucaoDeposito : '');
  else if (t === 'titulo') d = 'Título de capitalização: ' + j(ct.tituloEmissora, ct.tituloCnpj && 'CNPJ ' + ct.tituloCnpj, ct.tituloNumero && 'nº ' + ct.tituloNumero, ct.tituloValor && fmtMoeda(ct.tituloValor));
  else if (t === 'nenhuma') d = 'Sem garantia';
  else if (t === 'outra') d = 'Outra';
  return [d.replace(/: $/, ''), ct.garantia].filter(Boolean).join(' · ');
}
const TIPOS_IMOVEL = ['Apartamento', 'Casa', 'Sala comercial', 'Loja', 'Galpão', 'Terreno', 'Vaga de garagem', 'Outro'];
const CAMPOS_PESSOA = [
  { k: 'nome', l: 'Nome / razão social', req: true, w: 2 },
  { k: 'documento', l: 'CPF / CNPJ' },
  { k: 'rg', l: 'RG / inscrição estadual' },
  { k: 'telefone', l: 'Telefone', t: 'tel' },
  { k: 'email', l: 'E-mail', t: 'email' },
  { k: 'endereco', l: 'Endereço', w: 2 },
];
const CAMPOS = {
  locadores: [
    ...CAMPOS_PESSOA,
    { sec: 'Dados bancários para repasse' },
    { k: 'banco', l: 'Banco' }, { k: 'agencia', l: 'Agência' }, { k: 'conta', l: 'Conta' }, { k: 'pix', l: 'Chave PIX' },
    { k: 'favorecido', l: 'Favorecido (se for outra pessoa)', w: 2 },
    { k: 'obs', l: 'Observações', t: 'area', w: 'full' },
  ],
  locatarios: [...CAMPOS_PESSOA, { k: 'obs', l: 'Observações', t: 'area', w: 'full' }],
  imoveis: [
    { k: 'codigo', l: 'Código' },
    { k: 'tipo', l: 'Tipo', t: 'select', op: () => TIPOS_IMOVEL.map(t => [t, t]) },
    { k: 'locadorId', l: 'Cliente (locador / proprietário)', t: 'select', op: () => opcoes('locadores'), req: true, w: 2 },
    { sec: 'Endereço' },
    { k: 'logradouro', l: 'Rua / avenida', req: true, w: 2 }, { k: 'numero', l: 'Número' }, { k: 'complemento', l: 'Complemento' },
    { k: 'bairro', l: 'Bairro' }, { k: 'cidade', l: 'Cidade' }, { k: 'uf', l: 'UF', max: 2 }, { k: 'cep', l: 'CEP' },
    { sec: 'Outros dados' },
    { k: 'inscricaoIptu', l: 'Inscrição do IPTU' }, { k: 'matricula', l: 'Matrícula' },
    { k: 'obs', l: 'Observações', t: 'area', w: 'full' },
  ],
  contratos: [
    { k: 'codigo', l: 'Número do contrato', req: true },
    { k: 'status', l: 'Situação', t: 'select', op: [['ativo', 'Ativo'], ['encerrado', 'Encerrado']], semVazio: true },
    { k: 'imovelId', l: 'Imóvel', t: 'select', op: () => opcoes('imoveis'), req: true, w: 2 },
    { k: 'locadorId', l: 'Cliente (locador)', t: 'select', op: () => opcoes('locadores'), req: true, w: 2 },
    { k: 'locatarioId', l: 'Locatário', t: 'select', op: () => opcoes('locatarios'), req: true, w: 2 },
    { sec: 'Prazo e valores' },
    { k: 'inicio', l: 'Início', t: 'date', req: true }, { k: 'fim', l: 'Término', t: 'date' },
    { k: 'valorAluguel', l: 'Valor do aluguel (R$)', t: 'money', req: true },
    { k: 'diaVencimento', l: 'Dia do vencimento', t: 'number', min: 1, max: 31 },
    { k: 'vencMesSeguinte', l: 'O aluguel do mês vence', t: 'select', semVazio: true, w: 2,
      op: [['nao', 'No próprio mês de referência'], ['sim', 'No mês seguinte ao de referência']] },
    { k: 'indiceReajuste', l: 'Índice de reajuste do aluguel', t: 'select', op: () => [...INDICES_REAJUSTE, 'Nenhum'].map(i => [i, i]),
      dica: 'Aplicado uma vez por ano, no mês de reajuste.' },
    { k: 'mesCorrecao', l: 'Mês de aplicação do reajuste', t: 'select', op: () => MESES.map((m, i) => [String(i + 1), m]),
      dica: 'Em branco: o mês de início do contrato.' },
    { sec: 'Garantia' },
    { k: 'tipoGarantia', l: 'Tipo de garantia', t: 'select', op: GARANTIAS, w: 2 },
    { k: 'fiadorNome', l: 'Fiador: nome', w: 2, g: 'fianca' }, { k: 'fiadorDocumento', l: 'Fiador: CPF / CNPJ', g: 'fianca' }, { k: 'fiadorTelefone', l: 'Fiador: telefone', t: 'tel', g: 'fianca' },
    { k: 'fiadorEndereco', l: 'Fiador: endereço', w: 2, g: 'fianca' },
    { k: 'fiador2Nome', l: '2º fiador ou cônjuge: nome', w: 2, g: 'fianca' }, { k: 'fiador2Documento', l: '2º fiador ou cônjuge: CPF / CNPJ', g: 'fianca' },
    { k: 'seguradora', l: 'Seguradora', w: 2, g: 'seguro' }, { k: 'seguradoraCnpj', l: 'CNPJ da seguradora', g: 'seguro' }, { k: 'apolice', l: 'Número da apólice', g: 'seguro' },
    { k: 'apoliceInicio', l: 'Vigência da apólice: início', t: 'date', g: 'seguro' }, { k: 'apoliceFim', l: 'Vigência da apólice: término', t: 'date', g: 'seguro' },
    { k: 'caucaoValor', l: 'Valor da caução (R$)', t: 'money', g: 'caucao' }, { k: 'caucaoDeposito', l: 'Depositada em (banco, conta ou poupança)', w: 2, g: 'caucao' },
    { k: 'tituloEmissora', l: 'Emissora do título', w: 2, g: 'titulo' }, { k: 'tituloCnpj', l: 'CNPJ da emissora', g: 'titulo' }, { k: 'tituloNumero', l: 'Número do título', g: 'titulo' },
    { k: 'tituloValor', l: 'Valor do título (R$)', t: 'money', g: 'titulo' },
    { k: 'garantia', l: 'Observações sobre a garantia', w: 2 },
    { sec: 'Taxa de administração' },
    { k: 'taxaAdm', l: 'Percentual (%)', t: 'pct', req: true },
    { k: 'baseTaxa', l: 'Incide sobre', t: 'select', semVazio: true, w: 2,
      op: [['locacao', 'Somente os valores recebidos de locação (aluguel)'], ['total', 'Todos os valores recebidos']] },
    { enc: true },
    { sec: 'Beneficiários do repasse' },
    { ben: true },
    { sec: 'Encargos moratórios (cálculo de débitos)' },
    { k: 'multaMora', l: 'Multa (%)', t: 'pct', dica: 'Em branco: usa o padrão das Configurações.' },
    { k: 'jurosMora', l: 'Juros de mora (% ao mês)', t: 'pct', dica: 'Calculados pro rata die.' },
    { k: 'honorarios', l: 'Honorários advocatícios (%)', t: 'pct' },
    { k: 'indiceCorrecao', l: 'Índice de correção dos valores em atraso', t: 'select', op: () => [...INDICES_CORRECAO, 'Nenhum'].map(i => [i, i]) },
    { sec: 'Controle mensal' },
    { k: 'inicioControle', l: 'Primeiro mês do controle', t: 'month' },
    { k: 'saldoInicial', l: 'Saldo inicial em conta (R$)', t: 'money', dica: 'Valor já em conta e não repassado ao cliente antes do primeiro mês.' },
    { k: 'obs', l: 'Observações', t: 'area', w: 'full' },
  ],
};
const NOMES = {
  locadores: ['cliente', 'Clientes (locadores)', 'Novo cliente'],
  locatarios: ['locatário', 'Locatários', 'Novo locatário'],
  imoveis: ['imóvel', 'Imóveis', 'Novo imóvel'],
  contratos: ['contrato', 'Contratos', 'Novo contrato'],
};

function campoHTML(f, reg) {
  if (f.sec) return `<h3 class="sec">${esc(f.sec)}</h3>`;
  if (f.enc) return encargosHTML(reg.encargos || []);
  if (f.ben) return beneficiariosHTML(reg);
  const v = reg[f.k];
  const cls = 'campo' + (f.w ? ' w' + f.w : '');
  const a = `id="f_${f.k}" name="${f.k}"${f.req ? ' required' : ''}`;
  let inp;
  switch (f.t) {
    case 'select': {
      let ops = typeof f.op === 'function' ? f.op() : f.op;
      // Valor gravado que não está na lista (ex.: texto livre de versões anteriores) continua visível
      if (v && !ops.some(o => o[0] === v)) ops = [...ops, [v, v]];
      inp = `<select ${a}>${f.semVazio ? '' : '<option value="">— selecione —</option>'}${ops.map(([val, rot]) => `<option value="${esc(val)}"${val === v ? ' selected' : ''}>${esc(rot)}</option>`).join('')}</select>`;
      break;
    }
    case 'area': inp = `<textarea ${a} rows="3">${esc(v)}</textarea>`; break;
    case 'money': inp = `<input ${a} class="num" inputmode="decimal" data-tipo="money" value="${v === undefined || v === null || v === '' ? '' : fmtNum(v)}">`; break;
    case 'pct': inp = `<input ${a} class="num" inputmode="decimal" value="${v === undefined || v === null || v === '' ? '' : fmtPct(v)}">`; break;
    default:
      inp = `<input ${a} type="${f.t || 'text'}" value="${esc(v)}"${f.min != null ? ` min="${f.min}"` : ''}${f.max != null && f.t === 'number' ? ` max="${f.max}"` : ''}${f.max && f.t !== 'number' ? ` maxlength="${f.max}"` : ''}>`;
  }
  return `<div class="${cls}"${f.g ? ` data-gar="${f.g}"` : ''}><label for="f_${f.k}">${esc(f.l)}${f.req ? ' *' : ''}</label>${inp}${f.dica ? `<small>${esc(f.dica)}</small>` : ''}</div>`;
}

function lerCampos(form, campos, reg) {
  const out = { ...reg };
  for (const f of campos) {
    if (!f.k) continue;
    const e = form.elements.namedItem(f.k);
    if (!e) continue;
    const s = e.value.trim();
    if (f.t === 'money' || f.t === 'pct') out[f.k] = s === '' ? (f.t === 'pct' ? null : 0) : r2(parseValor(s));
    else if (f.t === 'number') out[f.k] = s === '' ? null : Number(s);
    else out[f.k] = s;
    if (f.req && (s === '' || out[f.k] === null)) throw new Error(`Preencha o campo "${f.l}".`);
  }
  return out;
}

function encargoLinhaHTML(e) {
  return `<div class="enc-linha">
    <input list="dlRubricas" class="enc-rub" placeholder="Rubrica (ex.: Condomínio)" value="${esc(e.rubrica)}">
    <label><span class="rot-m">Cobrado do locatário</span><input class="num enc-cob" inputmode="decimal" data-tipo="money" placeholder="Cobrado do locatário" value="${e.cobrado ? fmtNum(e.cobrado) : ''}"></label>
    <label><span class="rot-m">Pago pela administradora</span><input class="num enc-pag" inputmode="decimal" data-tipo="money" placeholder="Pago pela administradora" value="${e.pago ? fmtNum(e.pago) : ''}"></label>
    <button type="button" class="bt-x" data-acao="del-enc" title="Remover">&times;</button>
  </div>`;
}
function encargosHTML(lista) {
  return `<h3 class="sec">Encargos mensais (além do aluguel)</h3>
  <p class="dica campo wfull">Rubricas que se repetem todo mês, como condomínio, IPTU e seguro. <b>Cobrado</b> é o valor cobrado do locatário; <b>pago</b> é o valor pago pela administradora (ao condomínio, à prefeitura, à seguradora…). Os valores podem ser ajustados depois, mês a mês.</p>
  <div class="campo wfull"><div class="enc-cab"><span>Rubrica</span><span class="num">Cobrado do locatário</span><span class="num">Pago pela administradora</span><span></span></div>
  <div id="encargos">${lista.map(encargoLinhaHTML).join('')}</div>
  <button type="button" class="bt pequeno" id="btAddEnc">+ Adicionar encargo</button></div>`;
}
function lerEncargos() {
  return $$('#encargos .enc-linha').map(d => ({
    rubrica: $('.enc-rub', d).value.trim(),
    cobrado: r2(parseValor($('.enc-cob', d).value)),
    pago: r2(parseValor($('.enc-pag', d).value)),
  })).filter(e => e.rubrica || e.cobrado || e.pago);
}

/* ================= Navegação ================= */
let sujo = false, hashAnterior = location.hash, ignorarHash = false;

window.addEventListener('hashchange', () => {
  if (ignorarHash) { ignorarHash = false; return; }
  if (dropboxFixo() && Convite.extrair(location.hash)) { location.reload(); return; } // link de convite colado nesta aba
  if (sujo && !confirm('Há alterações não salvas. Sair sem salvar?')) {
    ignorarHash = true;
    location.hash = hashAnterior;
    return;
  }
  sujo = false;
  rotear();
});
window.addEventListener('beforeunload', e => { if (sujo) { e.preventDefault(); e.returnValue = ''; } });

function destacarMenu(h) {
  $$('#menu a').forEach(a => a.classList.toggle('ativo', h.startsWith('#/' + a.dataset.rota)));
}

async function rotear(recarregar) {
  hashAnterior = location.hash;
  if (!Armaz.modo) return telaConexao();
  if (!Auth.usuario) return telaLogin();
  const h = location.hash || '#/painel';
  destacarMenu(h);
  document.body.classList.remove('menu-aberto');
  const c = $('#conteudo');
  try {
    if (recarregar || Date.now() - D.carregadoEm > 8000) await carregarColecoes();
    let m;
    if ((m = h.match(/^#\/painel(?:\/(\d{4}-\d{2}))?$/))) return await telaPainel(m[1] || mesAtual());
    if ((m = h.match(/^#\/(locadores|locatarios|imoveis|contratos)$/))) return telaLista(m[1]);
    if ((m = h.match(/^#\/(locadores|locatarios|imoveis|contratos)\/([\w-]+)$/))) return telaForm(m[1], m[2]);
    if ((m = h.match(/^#\/contrato\/([\w-]+)$/))) return await telaContrato(m[1]);
    if ((m = h.match(/^#\/contrato\/([\w-]+)\/debito(?:\?c=([\w-]+))?$/))) return await telaDebito(m[1], m[2]);
    if ((m = h.match(/^#\/contrato\/([\w-]+)\/acordos$/))) return await telaAcordos(m[1]);
    if ((m = h.match(/^#\/contrato\/([\w-]+)\/acordo\/([\w-]+)(?:\?calc=([\w-]+))?$/))) return await telaAcordo(m[1], m[2], m[3]);
    if (h === '#/vigentes') return telaVigentes();
    if (h.startsWith('#/inadimplencia')) return await telaInadimplencia(h);
    if ((m = h.match(/^#\/contrato\/([\w-]+)\/(\d{4}-\d{2})$/))) return await telaMes(m[1], m[2]);
    if (h.startsWith('#/relatorios')) return telaRelatorios(h);
    if (h.startsWith('#/repasses')) return await telaRepasses(h);
    if (h === '#/conta') return telaConta();
    if (h.startsWith('#/boletos')) return await telaBoletos(h);
    if (h === '#/sobre') return telaSobre();
    if (h === '#/termos') return telaTermos(false);
    if (h === '#/admin' || h === '#/config') {
      if (!Auth.ehAdmin()) { aviso('A área de administração é exclusiva do administrador.', 'erro'); location.hash = '#/painel'; return; }
      return telaConfig();
    }
    location.hash = '#/painel';
  } catch (e) {
    console.error(e);
    if (e.sessao) { Auth.sair(); return telaLogin(e.message); }
    c.innerHTML = `<section class="cartao erro"><h2>${e.conexao ? 'Sem conexão com os dados' : 'Não foi possível abrir esta tela'}</h2><p>${esc(e.message)}</p>
      <div class="acoes-linha"><button class="bt primario" id="btTentarDeNovo">Tentar novamente</button><button class="bt" id="btVoltarPainel">Voltar ao painel</button></div></section>`;
    $('#btTentarDeNovo').addEventListener('click', () => rotear(true));
    $('#btVoltarPainel').addEventListener('click', () => { if (location.hash === '#/painel') rotear(true); else location.hash = '#/painel'; });
  }
}

function cabecalho(titulo, sub, acoes = '', voltar = '') {
  return `<div class="cab-pagina"><div>${voltar}<h1>${titulo}</h1>${sub ? `<div class="sub">${sub}</div>` : ''}</div><div class="acoes">${acoes}</div></div>`;
}

/* ================= Painel do mês ================= */
async function telaPainel(ym) {
  const ativos = contratosAtivos();
  const exts = await Promise.all(ativos.map(c => carregarExtrato(c.id)));
  let naoGerados = 0, abertos = 0, naoPagos = 0, reajustes = 0, totalConta = 0, totalCob = 0, totalRec = 0, totalAberto = 0, totalTaxa = 0;
  const linhas = ativos.map((ct, i) => {
    const cad = calcularExtrato(ct, exts[i]);
    const x = cad.find(z => z.ym === ym);
    const antes = !x && ym < (cad[0]?.ym || inicioControle(ct));
    let sit, pagto = '';
    if (x) {
      sit = x.mes.fechado ? '<span class="chip fechado">Fechado</span>' : '<span class="chip aberto">Em aberto</span>';
      pagto = chipPagto(x.c, vencimentoMes(ct, ym, x.mes));
      if (!x.mes.fechado) abertos++;
      if (x.c.emAberto > 0) { naoPagos++; totalAberto += x.c.emAberto; }
      totalConta += x.c.saldoConta; totalCob += x.c.devido; totalRec += x.c.recebido; totalTaxa += x.c.taxa;
    }
    else if (antes) sit = '<span class="chip neutro">Antes do início</span>';
    else { sit = '<span class="chip pendente">Não gerado</span>'; naoGerados++; }
    const reaj = !antes && reajustePendente(ct, ym);
    if (reaj) reajustes++;
    // Dados da linha (para buscar, filtrar e ordenar na própria tela)
    const estMes = !x ? (antes ? 'antes' : 'naoGerado') : x.mes.fechado ? 'fechado' : 'aberto';
    const estPag = !x ? '' : x.c.situacao === 'pago' ? 'pago' : x.c.situacao === 'parcial' ? 'parcial' : x.c.devido > 0 ? 'naoPago' : '';
    return { ct, x, reaj, sit, pagto, estMes, estPag, contrato: ct.codigo, imovel: imovelCurto(D.imoveis[ct.imovelId]), cliente: nomeDe('locadores', ct.locadorId), locatario: nomeDe('locatarios', ct.locatarioId),
      venc: x ? vencimentoMes(ct, ym, x.mes) : '', devido: x?.c.devido ?? -1, recebido: x?.c.recebido ?? -1, taxa: x?.c.taxa ?? -1, repassado: x?.c.repassado ?? -1, saldoConta: x?.c.saldoConta ?? -1,
      busca: [ct.codigo, descImovel(D.imoveis[ct.imovelId]), nomeDe('locadores', ct.locadorId), nomeDe('locatarios', ct.locatarioId)].join(' ').toLowerCase() };
  });
  const linhaHTML = l => { const v = k => l.x ? fmtNum(l.x.c[k]) : ''; return `<tr data-link="#/contrato/${l.ct.id}/${ym}">
      <td><b>${esc(l.contrato)}</b>${l.reaj ? ` <span class="chip reajuste" title="Reajuste anual de ${mesNum(l.reaj)} a confirmar">Reajuste</span>` : ''}</td><td title="${esc(descImovel(D.imoveis[l.ct.imovelId]))}">${esc(l.imovel)}</td>
      <td>${esc(l.cliente)}</td><td>${esc(l.locatario)}</td><td>${l.venc ? fmtData(l.venc) : ''}</td>
      <td>${l.sit}</td><td>${l.pagto}</td><td class="num">${v('devido')}</td><td class="num">${v('recebido')}</td><td class="num">${v('taxa')}</td><td class="num">${v('repassado')}</td>
      <td class="num"><b>${v('saldoConta')}</b></td></tr>`; };
  const COLS_PAINEL = [['contrato', 'Contrato'], ['imovel', 'Imóvel'], ['cliente', 'Cliente'], ['locatario', 'Locatário'], ['venc', 'Vencimento'], ['estMes', 'Mês'], ['estPag', 'Pagamento'],
    ['devido', 'Devido', 'n'], ['recebido', 'Recebido', 'n'], ['taxa', 'Taxa adm.', 'n'], ['repassado', 'Repassado', 'n'], ['saldoConta', 'Saldo em conta', 'n']];
  const FILTROS_PAINEL = [['', 'Todas as situações'], ['naoPago', 'Não pago pelo locatário'], ['parcial', 'Pago em parte'], ['pago', 'Pago'], ['aberto', 'Mês em aberto'], ['fechado', 'Mês fechado'],
    ['naoGerado', 'Mês não gerado'], ['reajuste', 'Com reajuste a confirmar'], ['saldo', 'Com saldo em conta']];
  let ordP = { k: 'locatario', d: 1, f: '' };
  try { Object.assign(ordP, JSON.parse(sessionStorage.getItem('cl-painel') || '{}')); } catch { /* usa o padrão */ }
  const filtroOk = l => !ordP.f || (ordP.f === 'reajuste' ? !!l.reaj : ordP.f === 'saldo' ? l.saldoConta > 0.004 : l.estMes === ordP.f || l.estPag === ordP.f);

  $('#conteudo').innerHTML = cabecalho(`Painel de ${nomeMes(ym)}`, 'Situação do mês em cada contrato ativo',
    `<a class="bt" href="#/painel/${addMes(ym, -1)}" title="Mês anterior">&#9664;</a>
     <input type="month" id="mesPainel" value="${ym}">
     <a class="bt" href="#/painel/${addMes(ym, 1)}" title="Próximo mês">&#9654;</a>`) + `
  <div class="kpis">
    <div class="kpi"><span>Contratos ativos</span><b>${ativos.length}</b></div>
    <div class="kpi"><span>Meses não gerados</span><b>${naoGerados}</b></div>
    <div class="kpi"><span>Meses em aberto</span><b>${abertos}</b></div>
    <div class="kpi"><span>Devido pelos locatários</span><b>${fmtMoeda(totalCob)}</b></div>
    <div class="kpi"><span>Recebido no mês</span><b>${fmtMoeda(totalRec)}</b></div>
    <div class="kpi"><span>Não pago pelo locatário</span><b class="${totalAberto > 0 ? 'neg' : ''}">${fmtMoeda(totalAberto)}</b><small>${naoPagos} contrato${naoPagos === 1 ? '' : 's'}</small></div>
    <div class="kpi"><span>Taxas de administração</span><b>${fmtMoeda(totalTaxa)}</b></div>
    <div class="kpi"><span>Saldo em conta (a repassar)</span><b>${fmtMoeda(totalConta)}</b></div>
  </div>
  ${reajustes ? `<p class="alerta">${reajustes} contrato${reajustes > 1 ? 's têm' : ' tem'} reajuste anual do aluguel a confirmar neste mês (marcados com <span class="chip reajuste">Reajuste</span>). Abra o mês do contrato para conferir o cálculo e aplicar ou não.</p>` : ''}
  <section class="cartao">
    <div class="cartao-cab"><h2>Contratos</h2><div class="acoes">
      <select id="painelFiltro" aria-label="Filtrar por situação">${FILTROS_PAINEL.map(([v, r]) => `<option value="${v}"${v === ordP.f ? ' selected' : ''}>${r}</option>`).join('')}</select>
      <label class="inline">Ordenar por <select id="painelOrd">${COLS_PAINEL.map(([k, r]) => `<option value="${k}"${k === ordP.k ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      <select id="painelDir" aria-label="Ordem"><option value="1"${ordP.d > 0 ? ' selected' : ''}>Crescente</option><option value="-1"${ordP.d < 0 ? ' selected' : ''}>Decrescente</option></select>
      <input type="search" id="busca" placeholder="Buscar cliente, locatário, imóvel…">
      ${naoGerados ? `<button class="bt primario" id="btGerarTodos">Gerar ${nomeMes(ym)} em ${naoGerados} contrato${naoGerados > 1 ? 's' : ''}</button>` : ''}
    </div></div>
    ${ativos.length ? '<div class="rolagem" id="painelTab"></div><p class="dica" id="painelQtd"></p>' : `<p class="vazio">Nenhum contrato ativo. <a href="#/contratos/novo">Cadastrar contrato</a></p>`}
  </section>`;

  // Tabela com ordenação (clique no título da coluna ou escolha acima), filtro de situação e busca
  const desenharTabela = () => {
    if (!$('#painelTab')) return;
    const [, , tipo] = COLS_PAINEL.find(c => c[0] === ordP.k) || [];
    const t = ($('#busca')?.value || '').trim().toLowerCase();
    const lista = linhas.filter(l => filtroOk(l) && (!t || l.busca.includes(t)))
      .sort((a, b) => (tipo === 'n' ? a[ordP.k] - b[ordP.k] : comparar(String(a[ordP.k] || ''), String(b[ordP.k] || ''))) * ordP.d || comparar(a.locatario, b.locatario));
    const th = ([k, r, n]) => `<th class="ordenavel${n ? ' num' : ''}" data-ord="${k}">${r}${ordP.k === k ? (ordP.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
    $('#painelTab').innerHTML = `<table class="tabela clicavel"><thead><tr>${COLS_PAINEL.map(th).join('')}</tr></thead><tbody>${lista.map(linhaHTML).join('')}</tbody></table>`;
    $('#painelQtd').textContent = lista.length === linhas.length ? '' : `${lista.length} de ${linhas.length} contratos.`;
    $$('#painelTab tr[data-link]').forEach(tr => tr.addEventListener('click', () => { location.hash = tr.dataset.link; }));
    $$('#painelTab [data-ord]').forEach(h => h.addEventListener('click', () => { ordP.d = ordP.k === h.dataset.ord ? -ordP.d : 1; ordP.k = h.dataset.ord; guardar(); }));
  };
  const guardar = () => { try { sessionStorage.setItem('cl-painel', JSON.stringify(ordP)); } catch { /* sem armazenamento */ } $('#painelOrd').value = ordP.k; $('#painelDir').value = String(ordP.d); desenharTabela(); };
  $('#painelFiltro').addEventListener('change', e => { ordP.f = e.target.value; guardar(); });
  $('#painelOrd').addEventListener('change', e => { ordP.k = e.target.value; guardar(); });
  $('#painelDir').addEventListener('change', e => { ordP.d = +e.target.value; guardar(); });
  $('#busca').addEventListener('input', desenharTabela);
  desenharTabela();

  $('#mesPainel').addEventListener('change', e => { if (ehMes(e.target.value)) location.hash = '#/painel/' + e.target.value; });
  $('#btGerarTodos')?.addEventListener('click', () => executar(async () => {
    const alvos = ativos.filter((ct, i) => !exts[i].meses[ym] && ym >= (Object.keys(exts[i].meses).sort()[0] || inicioControle(ct)));
    const faltando = alvos.reduce((n, ct) => {
      const u = Object.keys(D.extratos[ct.id].meses).sort().pop();
      return n + mesesEntre(u ? addMes(u, 1) : inicioControle(ct), ym);
    }, 0);
    if (!confirm(`Gerar ${nomeMes(ym)} em ${alvos.length} contrato(s)?\n\nSerão criados ${faltando} mês(es) no total, importando as rubricas, os valores e o saldo não repassado do mês anterior.`)) return;
    for (const ct of alvos) await gerarAte(ct, ym);
    const comReajuste = alvos.filter(ct => reajustePendente(ct, ym)).length;
    aviso(comReajuste ? `Meses gerados. Atenção: ${comReajuste} contrato(s) com reajuste anual a confirmar.` : 'Meses gerados.');
    rotear();
  }));
}

function ligarBusca() {
  $$('tr[data-link]').forEach(tr => tr.addEventListener('click', () => { location.hash = tr.dataset.link; }));
  const b = $('#busca');
  if (!b) return;
  b.addEventListener('input', () => {
    const t = b.value.trim().toLowerCase();
    $$('tr[data-busca]').forEach(tr => { tr.hidden = t && !tr.dataset.busca.includes(t); });
  });
}

/* ================= Listas ================= */
const LISTAS = {
  locadores: {
    cols: [['Nome', r => r.nome], ['CPF / CNPJ', r => r.documento], ['Telefone', r => r.telefone], ['E-mail', r => r.email],
      ['Imóveis', r => String(Object.values(D.imoveis).filter(i => i.locadorId === r.id).length), 'num']],
    ordem: (a, b) => comparar(a.nome, b.nome),
  },
  locatarios: {
    cols: [['Nome', r => r.nome], ['CPF / CNPJ', r => r.documento], ['Telefone', r => r.telefone],
      ['Contrato ativo', r => Object.values(D.contratos).filter(c => c.locatarioId === r.id && c.status !== 'encerrado').map(c => c.codigo).join(', ')]],
    ordem: (a, b) => comparar(a.nome, b.nome),
  },
  imoveis: {
    cols: [['Código', r => r.codigo], ['Endereço', r => descImovel(r)], ['Tipo', r => r.tipo], ['Cliente', r => nomeDe('locadores', r.locadorId)],
      ['Situação', r => { const c = Object.values(D.contratos).find(x => x.imovelId === r.id && x.status !== 'encerrado'); return c ? 'Locado · ' + rotuloContrato(c) : 'Disponível'; }]],
    ordem: (a, b) => comparar((a.codigo || '') + descImovel(a), (b.codigo || '') + descImovel(b)),
  },
  contratos: {
    cols: [['Contrato', r => r.codigo], ['Imóvel', r => imovelCurto(D.imoveis[r.imovelId])], ['Cliente', r => nomeDe('locadores', r.locadorId)],
      ['Locatário', r => nomeDe('locatarios', r.locatarioId)], ['Aluguel', r => fmtNum(r.valorAluguel), 'num'],
      ['Taxa adm.', r => fmtPct(r.taxaAdm) + '%', 'num'], ['Situação', r => r.status === 'encerrado' ? 'Encerrado' : 'Ativo']],
    ordem: ordemContrato,
    link: r => '#/contrato/' + r.id,
  },
};

function telaLista(col) {
  const L = LISTAS[col], [, titulo, novo] = NOMES[col];
  const verTodos = col === 'contratos' && sessionStorage.getItem('cl-todos') === '1';
  const itens = Object.values(D[col]).filter(r => col !== 'contratos' || verTodos || r.status !== 'encerrado').sort(L.ordem);
  const linhas = itens.map(r => {
    const vals = L.cols.map(c => c[1](r) ?? '');
    return `<tr data-link="${L.link ? L.link(r) : `#/${col}/${r.id}`}" data-busca="${esc(vals.join(' ').toLowerCase())}">${vals.map((v, i) => `<td class="${L.cols[i][2] || ''}">${esc(v)}</td>`).join('')}</tr>`;
  }).join('');
  $('#conteudo').innerHTML = cabecalho(titulo, `${itens.length} registro${itens.length === 1 ? '' : 's'}`, `<a class="bt primario" href="#/${col}/novo">+ ${novo}</a>`) + `
  <section class="cartao">
    <div class="cartao-cab"><input type="search" id="busca" placeholder="Buscar…">
      ${col === 'contratos' ? `<label class="inline"><input type="checkbox" id="verTodos" ${verTodos ? 'checked' : ''}> Mostrar encerrados</label>` : ''}</div>
    ${itens.length ? `<div class="rolagem"><table class="tabela clicavel"><thead><tr>${L.cols.map(c => `<th class="${c[2] || ''}">${c[0]}</th>`).join('')}</tr></thead><tbody>${linhas}</tbody></table></div>`
      : `<p class="vazio">Nenhum registro. <a href="#/${col}/novo">${novo}</a></p>`}
  </section>`;
  ligarBusca();
  $('#verTodos')?.addEventListener('change', e => { sessionStorage.setItem('cl-todos', e.target.checked ? '1' : '0'); telaLista(col); });
}

/* ================= Cadastro (formulário) ================= */
function proximoCodigo() {
  const n = Object.values(D.contratos).map(c => parseInt(c.codigo, 10)).filter(x => !isNaN(x));
  return String((n.length ? Math.max(...n) : 0) + 1).padStart(3, '0');
}

function referencias(col, id) {
  const cts = Object.values(D.contratos);
  if (col === 'locadores') {
    const n = Object.values(D.imoveis).filter(i => i.locadorId === id).length + cts.filter(c => c.locadorId === id).length;
    return n ? 'Este cliente está vinculado a imóveis ou contratos.' : '';
  }
  if (col === 'locatarios') return cts.some(c => c.locatarioId === id) ? 'Este locatário está vinculado a contratos.' : '';
  if (col === 'imoveis') return cts.some(c => c.imovelId === id) ? 'Este imóvel está vinculado a contratos.' : '';
  return '';
}

function telaForm(col, id) {
  const novo = id === 'novo';
  const [nomeSing, titulo] = NOMES[col];
  let reg = novo ? { id: novoId() } : D[col][id];
  if (!reg) throw new Error('Registro não encontrado. Ele pode ter sido excluído em outro computador.');
  if (novo && col === 'contratos') reg = { ...reg, status: 'ativo', baseTaxa: 'locacao', taxaAdm: 10, encargos: [], codigo: proximoCodigo(), diaVencimento: 10, vencMesSeguinte: 'nao' };
  if (col === 'contratos' && !reg.mesCorrecao && mesCorrecaoDe(reg)) reg = { ...reg, mesCorrecao: String(mesCorrecaoDe(reg)) };
  if (col === 'contratos' && !reg.indiceCorrecao) reg = { ...reg, indiceCorrecao: D.config.moratorios.indice };
  if (col === 'contratos' && novo) reg = { ...reg, indiceReajuste: 'IGP-M' };
  const campos = CAMPOS[col];
  const voltar = col === 'contratos' && !novo ? `#/contrato/${id}` : `#/${col}`;

  $('#conteudo').innerHTML = cabecalho(novo ? `Novo ${nomeSing}` : `Editar ${nomeSing}`,
    novo ? '' : esc(reg.atualizadoEm ? `Última alteração em ${fmtData(reg.atualizadoEm)}${reg.atualizadoPor ? ' por ' + reg.atualizadoPor : ''}` : ''),
    '', `<a class="voltar" href="${voltar}">&larr; ${col === 'contratos' && !novo ? rotuloContrato(reg) : titulo}</a>`) + `
  <form id="form" class="cartao form" novalidate>
    <div class="grade-form">${campos.map(f => campoHTML(f, reg)).join('')}</div>
    <div class="barra-form">
      ${novo ? '' : '<button type="button" class="bt perigo" id="btExcluir">Excluir</button>'}
      <span class="espaco"></span>
      <a class="bt" href="${voltar}">Cancelar</a>
      <button class="bt primario" type="submit">Salvar</button>
    </div>
  </form>`;

  const form = $('#form');
  if (col === 'contratos') {
    form.elements.imovelId.addEventListener('change', e => {
      const im = D.imoveis[e.target.value];
      if (im?.locadorId) form.elements.locadorId.value = im.locadorId;
    });
    $('#btAddEnc').addEventListener('click', () => {
      $('#encargos').insertAdjacentHTML('beforeend', encargoLinhaHTML({ rubrica: '' }));
      $('#encargos .enc-linha:last-child .enc-rub').focus();
    });
    $('#encargos').addEventListener('click', e => { if (e.target.dataset.acao === 'del-enc') e.target.closest('.enc-linha').remove(); });
    ligarBeneficiarios();
    // Campos da garantia conforme o tipo escolhido
    const verGarantia = () => { const t = form.elements.tipoGarantia.value; $$('[data-gar]').forEach(d => { d.hidden = d.dataset.gar !== t; }); };
    form.elements.tipoGarantia.addEventListener('change', verGarantia);
    verGarantia();
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    executar(async () => {
      let dados = lerCampos(form, campos, reg);
      if (col === 'contratos') {
        dados.encargos = lerEncargos();
        dados.beneficiarios = lerBeneficiarios(dados);
        if (dados.encargos.some(x => !x.rubrica)) throw new Error('Informe a rubrica de todos os encargos.');
        if (dados.taxaAdm < 0 || dados.taxaAdm > 100) throw new Error('O percentual da taxa de administração deve ficar entre 0 e 100.');
        if (dados.inicioControle && !ehMes(dados.inicioControle)) throw new Error('Informe o primeiro mês do controle no formato AAAA-MM.');
        if (!dados.inicioControle && dados.inicio) dados.inicioControle = dados.inicio.slice(0, 7);
        if (!dados.mesCorrecao && dados.inicio) dados.mesCorrecao = String(+dados.inicio.slice(5, 7));
        for (const k of ['multaMora', 'jurosMora', 'honorarios']) if (dados[k] != null && (dados[k] < 0 || dados[k] > 100)) throw new Error('Os percentuais dos encargos moratórios devem ficar entre 0 e 100.');
        const pm = paramsMora(dados);
        if (pm.juros > pm.multa && !confirm(`Juros de mora de ${fmtPct(pm.juros)}% ao mês e multa de ${fmtPct(pm.multa)}%: os valores não estão invertidos? Salvar mesmo assim?`)) return;
        const dup = Object.values(D.contratos).find(c => c.id !== dados.id && String(c.codigo).trim() === String(dados.codigo).trim());
        if (dup && !confirm(`Já existe outro contrato com o número ${dados.codigo}. Salvar mesmo assim?`)) return;
      }
      if (col === 'imoveis' && dados.uf) dados.uf = dados.uf.toUpperCase();
      await salvarRegistro(col, dados);
      aviso('Salvo.');
      location.hash = col === 'contratos' ? `#/contrato/${dados.id}` : `#/${col}`;
    });
  });

  $('#btExcluir')?.addEventListener('click', () => executar(async () => {
    let ref = referencias(col, id);
    if (col === 'contratos') {
      const ext = await carregarExtrato(id);
      if (Object.keys(ext.meses).length) ref = 'Este contrato já tem meses lançados. Para deixar de acompanhá-lo, altere a situação para "Encerrado".';
    }
    if (ref) throw new Error(ref + ' Não é possível excluir.');
    if (!confirm(`Excluir este ${nomeSing}? Esta ação não pode ser desfeita.`)) return;
    await excluirRegistro(col, id);
    aviso('Excluído.');
    location.hash = `#/${col}`;
  }));
}

/* ================= Contrato: visão geral dos meses ================= */
async function telaContrato(cid) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  const ext = await carregarExtrato(cid);
  const cad = calcularExtrato(ct, ext);
  const ultimo = cad[cad.length - 1];
  const proximo = ultimo ? addMes(ultimo.ym, 1) : inicioControle(ct);
  const atual = mesAtual();
  const loc = D.locadores[ct.locadorId];
  const dl = (r, v) => v ? `<div><dt>${r}</dt><dd>${esc(v)}</dd></div>` : '';
  const vencidos = cad.filter(x => x.c.emAberto > 0 && vencimentoMes(ct, x.ym, x.mes) < hoje());
  const vencido = vencidos.reduce((s, x) => s + cent(x.c.emAberto), 0) / 100, qtdVencidos = vencidos.length;
  const mc = mesCorrecaoDe(ct);

  $('#conteudo').innerHTML = cabecalho(esc(rotuloContrato(ct)) + (ct.status === 'encerrado' ? ' <span class="chip neutro">Encerrado</span>' : ''),
    esc(descImovel(D.imoveis[ct.imovelId])),
    `<a class="bt" href="#/contratos/${cid}">Editar contrato</a>
     <a class="bt" href="#/contrato/${cid}/debito">Cálculo do débito</a><a class="bt" href="#/contrato/${cid}/acordos">Acordos</a>
     <a class="bt" href="#/relatorios?tipo=contrato&id=${cid}&de=${cad[0]?.ym || atual}&ate=${ultimo?.ym || atual}">Relatório PDF</a>`,
    '<a class="voltar" href="#/contratos">&larr; Contratos</a>') + `
  <div class="kpis">
    <div class="kpi"><span>Saldo em conta${ultimo ? ' (' + nomeMes(ultimo.ym) + ')' : ''}</span><b>${fmtMoeda(ultimo ? ultimo.c.saldoConta : ct.saldoInicial)}</b></div>
    <div class="kpi"><span>Débito do locatário (vencido)</span><b class="${vencido > 0 ? 'neg' : ''}">${fmtMoeda(vencido)}</b><small>${qtdVencidos ? qtdVencidos + ' mês(es) em atraso · valores sem encargos' : 'Nenhum mês em atraso'}</small></div>
    <div class="kpi"><span>Aluguel (cadastro)</span><b>${fmtMoeda(ct.valorAluguel)}</b></div>
    <div class="kpi"><span>Taxa de administração</span><b>${fmtPct(ct.taxaAdm)}%</b><small>${descBase(ct.baseTaxa)}</small></div>
    <div class="kpi"><span>Meses lançados</span><b>${cad.length}</b></div>
  </div>
  <section class="cartao">
    <h2>Dados do contrato</h2>
    <dl class="dados">
      ${dl('Cliente (locador)', loc?.nome)}${dl('Locatário', nomeDe('locatarios', ct.locatarioId))}
      ${dl('Vigência', [fmtData(ct.inicio), fmtData(ct.fim)].filter(Boolean).join(' a '))}${dl('Vencimento', ct.diaVencimento ? 'Dia ' + ct.diaVencimento + (ct.vencMesSeguinte === 'sim' ? ' do mês seguinte' : '') : '')}
      ${dl('Reajuste', [ct.indiceReajuste, mc ? 'em ' + MESES[mc - 1].toLowerCase() + ' (próximo: ' + nomeMes(proximoReajuste(ct)) + ')' : ''].filter(Boolean).join(' · '))}
      ${dl('Encargos moratórios', (p => `multa ${fmtPct(p.multa)}% · juros ${fmtPct(p.juros)}% a.m. · honorários ${fmtPct(p.honorarios)}% · correção: ${p.indice}`)(paramsMora(ct)))}${dl('Garantia', descGarantia(ct))}
      ${dl('Repasse', loc ? [loc.banco && 'Banco ' + loc.banco, loc.agencia && 'Ag. ' + loc.agencia, loc.conta && 'Conta ' + loc.conta, loc.pix && 'PIX ' + loc.pix].filter(Boolean).join(' · ') : '')}
      ${dl('Encargos mensais', (ct.encargos || []).map(e => e.rubrica).join(', '))}
    </dl>
  </section>
  <section class="cartao">
    <div class="cartao-cab"><h2>Extrato mês a mês</h2><div class="acoes">
      <button class="bt primario" id="btGerarProx">Gerar ${nomeMes(proximo)}</button>
      ${proximo < atual ? `<button class="bt" id="btGerarAtual">Gerar até ${nomeMes(atual)}</button>` : ''}
    </div></div>
    ${cad.length ? `<div class="rolagem"><table class="tabela clicavel"><thead><tr><th>Mês</th><th>Pagamento</th><th class="num">Saldo anterior</th><th class="num">Devido</th><th class="num">Recebido</th><th class="num">Pago</th><th class="num">Taxa adm.</th><th class="num">Saldo do mês</th><th class="num">Repassado</th><th class="num">Saldo em conta</th><th>Situação</th></tr></thead><tbody>
      ${cad.slice().reverse().map(x => `<tr data-link="#/contrato/${cid}/${x.ym}"><td><b>${nomeMes(x.ym)}</b></td><td>${chipPagto(x.c, vencimentoMes(ct, x.ym, x.mes))}</td><td class="num">${fmtNum(x.c.saldoAnterior)}</td><td class="num">${fmtNum(x.c.devido)}</td><td class="num">${fmtNum(x.c.recebido)}</td><td class="num">${fmtNum(x.c.pago)}</td><td class="num">${fmtNum(x.c.taxa)}</td><td class="num">${fmtNum(x.c.saldoMes)}</td><td class="num">${fmtNum(x.c.repassado)}</td><td class="num"><b>${fmtNum(x.c.saldoConta)}</b></td><td>${x.mes.fechado ? '<span class="chip fechado">Fechado</span>' : '<span class="chip aberto">Em aberto</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : `<p class="vazio">Nenhum mês lançado. O controle começa em <b>${nomeMes(inicioControle(ct))}</b>, com as rubricas do cadastro do contrato.</p>`}
  </section>`;
  ligarBusca();
  const gerar = alvo => executar(async () => {
    const n = await gerarAte(ct, alvo);
    aviso(n > 1 ? `${n} meses gerados.` : 'Mês gerado.');
    location.hash = `#/contrato/${cid}/${alvo}`;
  });
  $('#btGerarProx').addEventListener('click', () => gerar(proximo));
  $('#btGerarAtual')?.addEventListener('click', () => gerar(atual));
}

/* ================= Mês do contrato (extrato mensal) ================= */
async function telaMes(cid, ym) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  const ext = await carregarExtrato(cid);
  const yms = Object.keys(ext.meses).sort();
  const mes = ext.meses[ym];
  const c = $('#conteudo');
  const sub = `${esc(descImovel(D.imoveis[ct.imovelId]))}<br>Cliente: <b>${esc(nomeDe('locadores', ct.locadorId))}</b> · Locatário: <b>${esc(nomeDe('locatarios', ct.locatarioId))}</b>`;
  const nav = `<a class="bt" href="#/contrato/${cid}/${addMes(ym, -1)}" title="Mês anterior">&#9664; ${nomeMesCurto(addMes(ym, -1))}</a>
               <a class="bt" href="#/contrato/${cid}/${addMes(ym, 1)}" title="Próximo mês">${nomeMesCurto(addMes(ym, 1))} &#9654;</a>`;
  const voltar = `<a class="voltar" href="#/contrato/${cid}">&larr; ${esc(rotuloContrato(ct))}</a>`;

  if (!mes) {
    const ini = yms[0] || inicioControle(ct);
    const ultimo = yms[yms.length - 1];
    let corpo;
    if (ym < ini) {
      corpo = `<p>${nomeMes(ym)} é anterior ao início do controle deste contrato (${nomeMes(ini)}).</p>
        ${yms.length ? '' : '<p>Para começar o controle antes, altere o “Primeiro mês do controle” no cadastro do contrato.</p>'}`;
    } else {
      const de = ultimo ? addMes(ultimo, 1) : ini, qtd = mesesEntre(de, ym);
      corpo = `<p><b>${nomeMes(ym)}</b> ainda não foi gerado.</p>
        <p>${ultimo ? `Ao gerar, serão importadas as rubricas e os valores de ${nomeMes(ultimo)} (as marcadas para repetir) e o saldo não repassado será levado como saldo anterior.` : 'Ao gerar, as rubricas e os valores serão importados do cadastro do contrato.'}</p>
        ${qtd > 1 ? `<p>Serão gerados ${qtd} meses: de ${nomeMes(de)} a ${nomeMes(ym)}.</p>` : ''}
        <button class="bt primario" id="btGerar">Gerar ${qtd > 1 ? qtd + ' meses' : nomeMes(ym)}</button>`;
    }
    c.innerHTML = cabecalho(nomeMes(ym), sub, nav, voltar) + `<section class="cartao">${corpo}</section>`;
    $('#btGerar')?.addEventListener('click', () => executar(async () => { await gerarAte(ct, ym); aviso('Mês gerado.'); rotear(); }));
    return;
  }

  const ed = JSON.parse(JSON.stringify(mes));
  ed.linhas = ed.linhas || []; ed.repasses = ed.repasses || [];
  ed.pagamento = situacaoPagto(ed);
  ed.vencimento = vencimentoMes(ct, ym, ed);
  const cad = calcularExtrato(ct, ext);
  const idx = cad.findIndex(x => x.ym === ym);
  const saldoAnterior = idx > 0 ? cad[idx - 1].c.saldoConta : r2(ct.saldoInicial);
  const ctxMes = { ym, vindos: recebimentosLancados(ct, ext, ym)[ym] };
  const ehUltimo = ym === yms[yms.length - 1];
  const anterior = idx > 0 ? cad[idx - 1].mes : null;
  const loc = D.locadores[ct.locadorId];
  const dadosRepasse = loc ? [loc.favorecido, loc.banco && 'Banco ' + loc.banco, loc.agencia && 'Ag. ' + loc.agencia, loc.conta && 'Conta ' + loc.conta, loc.pix && 'PIX ' + loc.pix].filter(Boolean).join(' · ') : '';
  ed.ajustes = ed.ajustes || [];
  // Reajuste anual pendente (do mês ou de um mês anterior ainda não decidido)
  let ciclo = !ed.fechado && !ed.reajuste ? reajustePendente(ct, ym) : null;
  if (ciclo) await aguardarIndices();

  c.innerHTML = cabecalho(nomeMes(ym) + (ed.fechado ? ' <span class="chip fechado">Mês fechado</span>' : ''), sub,
    nav + `<button class="bt" id="btBoletoMes">Prévia do boleto</button>` + (situacaoPagto(mes) === 'aberto' ? '' : '<button class="bt" id="btReciboMes" title="Recibo do pagamento para o locatário">Recibo</button>') + botoesPDF('pdfMes'), voltar) + `
  <div id="editorMes">
  <section class="cartao aviso-reajuste" id="secReajuste" hidden></section>
  <section class="cartao">
    <div class="cartao-cab"><h2>Pagamento do locatário</h2><div class="acoes">
      ${ehUltimo && !ed.fechado ? '<button class="bt perigo pequeno" id="btExcluirMes">Excluir mês</button>' : ''}
      <button class="bt livre" id="btFechar">${ed.fechado ? 'Reabrir mês' : 'Fechar mês'}</button>
    </div></div>
    <div class="grade-pagto">
      <div class="campo"><label for="vencMes">Vencimento</label><input type="date" id="vencMes" value="${esc(ed.vencimento)}"></div>
      <div class="campo"><label>Situação</label><div class="segmentado" id="sitPagto">
        <label><input type="radio" name="sitPagto" value="aberto"${ed.pagamento === 'aberto' ? ' checked' : ''}> Não pago</label>
        <label><input type="radio" name="sitPagto" value="pago"${ed.pagamento === 'pago' ? ' checked' : ''}> Pago</label>
        <label><input type="radio" name="sitPagto" value="parcial"${ed.pagamento === 'parcial' ? ' checked' : ''}> Pago em parte</label>
      </div></div>
      <div class="campo" data-vis="pago parcial"><label for="recebidoEm">Data do pagamento</label><input type="date" id="recebidoEm" value="${esc(ed.recebidoEm || '')}"></div>
      <div class="campo" data-vis="parcial"><label for="valorRecebido">Valor recebido (sem multa/juros)</label><input id="valorRecebido" class="num" inputmode="decimal" data-tipo="money" value="${ed.valorRecebido ? fmtNum(ed.valorRecebido) : ''}"></div>
      <div class="campo" data-vis="pago parcial"><label for="encRecebidos">Multa, juros e correção recebidos</label>
        <div class="campo-bt"><input id="encRecebidos" class="num" inputmode="decimal" data-tipo="money" value="${ed.encargosRecebidos ? fmtNum(ed.encargosRecebidos) : ''}">
        <button class="bt pequeno" id="btCalcEnc" title="Calcula correção, juros e multa entre o vencimento e a data do pagamento">Calcular</button></div></div>
      <div class="campo" data-vis="pago parcial"><label for="pagadorTipo">Pago por</label><select id="pagadorTipo">
        <option value="locatario">Locatário: ${esc(nomeDe('locatarios', ct.locatarioId))}</option>
        ${ct.fiadorNome ? `<option value="fiador">Fiador: ${esc(ct.fiadorNome)}</option>` : ''}
        ${ct.fiador2Nome ? `<option value="fiador2">Fiador: ${esc(ct.fiador2Nome)}</option>` : ''}
        <option value="outro">Outra pessoa</option></select></div>
      <div class="campo" id="pagOutroNome" hidden><label for="pagadorNome">Nome de quem pagou</label><input id="pagadorNome" value="${esc(ed.pagador?.nome || '')}"></div>
      <div class="campo" id="pagOutroDoc" hidden><label for="pagadorDoc">CPF / CNPJ de quem pagou</label><input id="pagadorDoc" value="${esc(ed.pagador?.documento || '')}"></div>
    </div>
    <p class="dica" id="infoPagto"></p>
  </section>
  <section class="cartao">
    <div class="cartao-cab"><h2>Rubricas do mês</h2><div class="acoes">
      ${anterior ? '<button class="bt pequeno" id="btImpAnt">Importar do mês anterior</button>' : ''}
      <button class="bt pequeno" id="btRecarregar">Recarregar do contrato</button>
    </div></div>
    <div id="lancamentos" class="lancamentos"></div>
    <button class="bt pequeno" id="btAddLinha">+ Adicionar rubrica</button>
    <p class="dica">Marque <b>Locação</b> nas rubricas que são valor de locação (base da taxa quando ela incide só sobre a locação). Marque <b>Repetir</b> nas rubricas que devem ser importadas no mês seguinte.</p>
  </section>
  <section class="cartao">
    <h2>Descontos e reembolsos ao locatário</h2>
    <div id="ajustes"></div>
    <div class="acoes-linha">
      <button class="bt pequeno" id="btAddDesc">+ Desconto</button>
      <button class="bt pequeno" id="btAddReemb">+ Reembolso</button>
    </div>
    <p class="dica">Abatem o valor devido pelo locatário neste mês. O <b>desconto</b> também reduz a base da taxa de administração sobre a locação; o <b>reembolso</b> (de uma despesa paga pelo locatário, por exemplo) não reduz. Marque <b>Repetir</b> para levar ao mês seguinte.</p>
  </section>
  <div class="colunas2">
    <section class="cartao">
      <h2>Resumo e saldo</h2>
      <div class="resumo">
        <div class="res-l"><span>Saldo anterior (não repassado)</span><b id="rAnt"></b></div>
        <div class="res-l info"><span>Rubricas cobradas do locatário no mês</span><b id="rCob"></b></div>
        <div class="res-l info" id="linhaAj"><span>(−) Descontos e reembolsos ao locatário</span><b id="rAj"></b></div>
        <div class="res-l info"><span>Total devido pelo locatário</span><b id="rDev"></b></div>
        <div class="res-l"><span>(+) Recebido do locatário</span><b id="rRec"></b></div>
        <div class="res-l" id="linhaEnc"><span>(+) Multa, juros e correção recebidos</span><b id="rEnc"></b></div>
        <div class="res-l" id="linhaRecAnt"><span>(+) Recebimentos de meses anteriores e de débitos em atraso<small id="rRecAntDet"></small></span><b id="rRecAnt"></b></div>
        <div class="res-l"><span>(−) Total pago pela administradora</span><b id="rPag"></b></div>
        <div class="res-l dest"><span>(=) Saldo líquido do mês</span><b id="rLiq"></b></div>
        <div class="res-l taxa"><span>(−) Taxa de administração
          <span class="taxa-ctl"><input id="taxaPct" class="num" inputmode="decimal" value="${fmtPct(ed.taxaAdm)}"> %
          <select id="taxaBase"><option value="locacao"${ed.baseTaxa !== 'total' ? ' selected' : ''}>sobre locação</option><option value="total"${ed.baseTaxa === 'total' ? ' selected' : ''}>sobre todos os valores recebidos</option></select></span>
          <small id="rBase"></small></span><b id="rTaxa"></b></div>
        <div class="res-l" id="linhaTaxaAnt"><span>(−) Taxa de administração sobre os recebimentos de meses anteriores e de débitos em atraso</span><b id="rTaxaAnt"></b></div>
        <div class="res-l dest"><span>(=) Saldo do mês</span><b id="rMes"></b></div>
        <div class="res-l"><span>Disponível para repasse (saldo anterior + saldo do mês)</span><b id="rDisp"></b></div>
        <div class="res-l"><span>(−) Repassado ao cliente</span><b id="rRep"></b></div>
        <div class="res-l info" id="linhaProg"><span>Repasse programado (ainda não efetuado; reservado no saldo)</span><b id="rProg"></b></div>
        <div class="res-l final"><span>(=) Saldo em conta</span><b id="rConta"></b></div>
        <div class="res-l alerta-l" id="linhaAberto"><span>Não pago pelo locatário (em aberto)</span><b id="rAberto"></b></div>
      </div>
      <p class="dica">O saldo em conta passa automaticamente para o mês seguinte como saldo anterior.</p>
    </section>
    <section class="cartao">
      <h2>Repasses ao cliente</h2>
      ${dadosRepasse ? `<p class="dica">${esc(loc.nome)}: ${esc(dadosRepasse)}</p>` : ''}
      <div id="repasses"></div>
      <div class="acoes-linha">
        <button class="bt pequeno" id="btAddRep">+ Adicionar repasse</button>
        <button class="bt pequeno" id="btRepTotal">Repassar todo o saldo disponível</button>
      </div>
    </section>
  </div>
  <section class="cartao"><h2>Observações do mês</h2><textarea id="obsMes" rows="2">${esc(ed.obs || '')}</textarea></section>
  </div>
  <div class="barra-salvar"><span id="estadoSalvar" class="dica"></span><button class="bt primario" id="btSalvar">Salvar</button></div>`;

  const marcarSujo = () => { sujo = true; $('#estadoSalvar').textContent = 'Alterações não salvas'; };

  function renderLinhas() {
    $('#lancamentos').innerHTML = `<div class="lanc cab"><div>Rubrica</div><div>Observação</div><div class="num">Cobrado do locatário</div><div class="num">Pago pela administradora</div><div class="cen">Locação</div><div class="cen">Repetir</div><div></div></div>` +
      ed.linhas.map((l, i) => `<div class="lanc" data-i="${i}">
        <div class="c-rub"><input list="dlRubricas" data-campo="rubrica" value="${esc(l.rubrica)}" placeholder="Rubrica"></div>
        <div class="c-obs"><input data-campo="obs" value="${esc(l.obs || '')}" placeholder="Observação"></div>
        <div class="c-cob"><span class="rot-m">Cobrado do locatário</span><input class="num" inputmode="decimal" data-tipo="money" data-campo="cobrado" value="${l.cobrado ? fmtNum(l.cobrado) : ''}"></div>
        <div class="c-pag"><span class="rot-m">Pago pela administradora</span><input class="num" inputmode="decimal" data-tipo="money" data-campo="pago" value="${l.pago ? fmtNum(l.pago) : ''}"></div>
        <label class="c-loc cen"><input type="checkbox" data-campo="locacao"${l.locacao ? ' checked' : ''}><span class="rot-m">Locação</span></label>
        <label class="c-rep cen"><input type="checkbox" data-campo="recorrente"${l.recorrente ? ' checked' : ''}><span class="rot-m">Repetir</span></label>
        <div class="c-del"><button class="bt-x" data-acao="del" title="Remover rubrica">&times;</button></div>
      </div>`).join('') +
      `<div class="lanc tot"><div class="c-rub">Totais</div><div class="c-obs"></div><div class="c-cob num" id="totCob"></div><div class="c-pag num" id="totPag"></div></div>`;
    travar();
  }

  function renderRepasses() {
    $('#repasses').innerHTML = ed.repasses.length ? ed.repasses.map((r, i) => `<div class="rep" data-i="${i}">
        <input type="date" data-campo="data" value="${esc(r.data || '')}">
        <input class="num" inputmode="decimal" data-tipo="money" data-campo="valor" placeholder="Valor" value="${r.valor ? fmtNum(r.valor) : ''}">
        <input data-campo="obs" placeholder="Observação (ex.: PIX)" value="${esc(r.obs || '')}">
        ${beneficiariosDe(ct).length > 1 ? `<select data-campo="beneficiarioId" aria-label="Beneficiário">${beneficiariosDe(ct).map(b => `<option value="${b.locadorId}"${b.locadorId === (r.beneficiarioId || ct.locadorId) ? ' selected' : ''}>${esc(nomeDe('locadores', b.locadorId))} (${fmtPct(b.pct)}%)</option>`).join('')}</select>` : ''}
        <select data-campo="status" aria-label="Situação do repasse"><option value="efetuado"${repasseEfetuado(r) ? ' selected' : ''}>Efetuado</option><option value="programado"${repasseEfetuado(r) ? '' : ' selected'}>Programado</option></select>
        <button class="bt-x" data-acao="del" title="Remover repasse">&times;</button></div>`).join('')
      : '<p class="vazio">Nenhum repasse neste mês.</p>';
    travar();
  }

  function renderAjustes() {
    $('#ajustes').innerHTML = ed.ajustes.length ? ed.ajustes.map((a, i) => `<div class="ajuste" data-i="${i}">
        <select data-campo="tipo"><option value="desconto"${a.tipo !== 'reembolso' ? ' selected' : ''}>Desconto</option><option value="reembolso"${a.tipo === 'reembolso' ? ' selected' : ''}>Reembolso</option></select>
        <input data-campo="descricao" placeholder="Motivo (ex.: pintura feita pelo locatário)" value="${esc(a.descricao || '')}">
        <input class="num" inputmode="decimal" data-tipo="money" data-campo="valor" placeholder="Valor" value="${a.valor ? fmtNum(a.valor) : ''}">
        <label class="inline"><input type="checkbox" data-campo="recorrente"${a.recorrente ? ' checked' : ''}> Repetir</label>
        <button class="bt-x" data-acao="del" title="Remover">&times;</button></div>`).join('')
      : '<p class="vazio">Nenhum desconto ou reembolso neste mês.</p>';
    travar();
  }

  // Aviso do reajuste anual: calcula pelo índice do contrato, mas só aplica quando o usuário confirmar
  function renderReajuste() {
    const s = $('#secReajuste');
    if (ed.reajuste?.pct !== undefined) {
      s.hidden = false;
      s.innerHTML = `<h2>Reajuste anual aplicado neste mês</h2>
        <p>${fmtPct(ed.reajuste.pct)}% (${esc(ed.reajuste.indice)}${ed.reajuste.de ? ` acumulado de ${mesNum(ed.reajuste.de)} a ${mesNum(ed.reajuste.ate)}` : ''}).
        ${ed._reajusteNovo ? `Aluguel do contrato: ${fmtMoeda(ed._reajusteNovo.valorAnterior)} → <b>${fmtMoeda(ed._reajusteNovo.valorNovo)}</b>. Salve o mês para confirmar.` : 'O novo valor foi registrado no cadastro do contrato e segue para os meses seguintes.'}</p>
        ${ed._reajusteNovo ? '<div class="acoes-linha"><button class="bt pequeno" id="btDesfazerReaj">Desfazer</button></div>' : ''}`;
      $('#btDesfazerReaj')?.addEventListener('click', () => {
        for (const l of ed.linhas) if (ed._reajusteNovo.antes[l.id] !== undefined) l.cobrado = ed._reajusteNovo.antes[l.id];
        delete ed.reajuste; delete ed._reajusteNovo;
        marcarSujo(); renderLinhas(); atualizarResumo(); renderReajuste();
      });
      return;
    }
    if (!ciclo || ed.fechado) { s.hidden = true; return; }
    const indice = ct.indiceReajuste;
    const ac = SERIES_BCB[indice] ? acumuladoIndice(indice, addMes(ciclo, -1)) : null;
    const linhasLoc = ed.linhas.filter(l => l.locacao && l.cobrado);
    s.hidden = false;
    s.innerHTML = `<h2>Reajuste anual do aluguel ${ciclo === ym ? 'neste mês' : 'pendente desde ' + mesNum(ciclo)}</h2>
      <p>${ciclo === ym ? `Este é o mês de aplicação do reajuste do contrato.` : `O reajuste de ${nomeMes(ciclo)} ainda não foi aplicado nem dispensado.`}
      ${ac ? `<b>${esc(indice)}</b> acumulado de ${mesNum(ac.de)} a ${mesNum(ac.ate)}: <b>${fmtPct(ac.pct)}%</b>.${ac.atrasado ? ` O índice de ${mesNum(addMes(ciclo, -1))} ainda não foi divulgado; foram usados os 12 últimos meses disponíveis.` : ''}${ac.faltando.length ? ` Faltam os índices de ${ac.faltando.map(mesNum).join(', ')}.` : ''}`
        : SERIES_BCB[indice] ? `Os índices do ${esc(indice)} ainda não estão disponíveis: informe o percentual.` : 'O contrato não tem índice de reajuste definido: informe o percentual.'}
      ${ac && ac.pct < 0 ? ' <b>O índice acumulado é negativo</b>; confira o que o contrato prevê.' : ''}</p>
      <div class="reaj-grade">
        <label class="inline">Percentual do reajuste <input id="reajPct" class="num" inputmode="decimal" value="${ac ? fmtPct(ac.pct) : ''}"> %</label>
        <div id="reajPrevia" class="dica"></div>
      </div>
      <div class="acoes-linha">
        <button class="bt primario pequeno" id="btAplicarReaj">Aplicar neste mês</button>
        <button class="bt pequeno" id="btReajJa">Já está aplicado</button>
        <button class="bt pequeno" id="btReajNao">Não aplicar (negociado)</button>
      </div>
      <p class="dica">Nada é alterado sem a sua confirmação. Se o reajuste for aplicado mais tarde, deixe o aviso pendente: ele continua aparecendo nos meses seguintes até ser decidido.</p>`;
    const previa = () => {
      const pct = parseValor($('#reajPct').value);
      $('#reajPrevia').innerHTML = linhasLoc.length
        ? linhasLoc.map(l => `${esc(l.rubrica)}: ${fmtMoeda(l.cobrado)} → <b>${fmtMoeda(r2(l.cobrado * (1 + pct / 100)))}</b>`).join(' · ')
        : 'Nenhuma rubrica marcada como “Locação” neste mês.';
    };
    previa();
    $('#reajPct').addEventListener('input', previa);
    $('#btAplicarReaj').addEventListener('click', () => {
      const txt = $('#reajPct').value.trim();
      if (!txt) return aviso('Informe o percentual do reajuste.', 'erro');
      if (!linhasLoc.length) return aviso('Marque como “Locação” a rubrica do aluguel antes de aplicar o reajuste.', 'erro');
      const pct = parseValor(txt);
      const antes = {};
      for (const l of linhasLoc) { antes[l.id] = l.cobrado; l.cobrado = r2(l.cobrado * (1 + pct / 100)); }
      const atual = D.contratos[cid];
      ed.reajuste = { ciclo, indice: indice || 'informado', pct, de: ac?.de || '', ate: ac?.ate || '' };
      ed._reajusteNovo = { antes, valorAnterior: r2(atual.valorAluguel), valorNovo: r2(r2(atual.valorAluguel) * (1 + pct / 100)) };
      marcarSujo(); renderLinhas(); atualizarResumo(); renderReajuste();
    });
    const decidir = (status, pergunta) => executar(async () => {
      const obs = prompt(pergunta + '\n\nObservação (opcional):', '');
      if (obs === null) return;
      const atual = D.contratos[cid];
      await salvarRegistro('contratos', { ...atual, reajustes: [...(atual.reajustes || []), { ciclo, status, obs, mes: ym, em: hoje(), por: usuario() }] });
      ciclo = null;
      renderReajuste();
      aviso(status === 'dispensado' ? 'Registrado: o reajuste deste ciclo não será aplicado.' : 'Registrado: o reajuste deste ciclo já estava aplicado.');
    });
    $('#btReajJa').addEventListener('click', () => decidir('ja-aplicado', `Registrar que o reajuste de ${mesNum(ciclo)} já está aplicado no valor do aluguel?`));
    $('#btReajNao').addEventListener('click', () => decidir('dispensado', `Registrar que o reajuste de ${mesNum(ciclo)} não será aplicado (ex.: negociado com o cliente)?`));
  }

  function atualizarResumo() {
    const k = calcMes(ed, saldoAnterior, ctxMes);
    const put = (id, v) => { const e = $('#' + id); e.textContent = fmtMoeda(v); e.classList.toggle('neg', v < 0); };
    $('#totCob').textContent = fmtNum(k.cobrado);
    $('#totPag').textContent = fmtNum(k.pago);
    put('rAnt', k.saldoAnterior); put('rCob', k.cobrado); put('rRec', k.principalRecebido); put('rEnc', k.encargosRecebidos);
    put('rAj', k.descontos + k.reembolsos); put('rDev', k.devido);
    $('#linhaAj').hidden = !(k.descontos + k.reembolsos);
    put('rPag', k.pago); put('rLiq', k.liquido); put('rTaxa', k.taxaMes);
    put('rRecAnt', k.recebidoAnteriores); put('rTaxaAnt', k.taxaAnteriores);
    $('#linhaRecAnt').hidden = $('#linhaTaxaAnt').hidden = !k.anteriores.length;
    $('#rRecAntDet').textContent = k.anteriores.length ? ' ' + k.anteriores.map(v => v.cobranca ? `${v.desc}: ${fmtMoeda(v.recebido)}` : `${mesNum(v.ym)}: ${fmtMoeda(v.recebido)} em ${fmtData(v.recebidoEm)}`).join(' · ') : '';
    put('rMes', k.saldoMes); put('rDisp', k.disponivel); put('rRep', k.repassado); put('rConta', k.saldoConta); put('rAberto', k.emAberto);
    put('rProg', k.programado); $('#linhaProg').hidden = !k.programado;
    $('#linhaEnc').hidden = !k.encargosRecebidos;
    $('#linhaAberto').hidden = !k.emAberto;
    $('#rBase').textContent = 'Base de cálculo: ' + fmtMoeda(k.baseTaxa);
    // Situação do pagamento: campos visíveis e débito atualizado
    $$('[data-vis]').forEach(d => { d.hidden = !d.dataset.vis.split(' ').includes(ed.pagamento); });
    const info = $('#infoPagto');
    if (k.emAberto > 0 && ed.vencimento && ed.vencimento < hoje()) {
      const e = encargosMoratorios(k.emAberto, ed.vencimento, hoje(), paramsMora(ct));
      info.innerHTML = `<span class="neg">Vencido há ${e.dias} dia${e.dias === 1 ? '' : 's'}.</span> Em aberto: <b>${fmtMoeda(k.emAberto)}</b> · atualizado hoje com correção, juros e multa: <b>${fmtMoeda(e.total)}</b> · <a href="#/contrato/${cid}/debito">cálculo do débito</a>`;
    } else if (k.emAberto > 0) info.textContent = `A vencer em ${fmtData(ed.vencimento)}.`;
    else info.textContent = ed.pagamento === 'pago' && ed.recebidoEm ? `Pago em ${fmtData(ed.recebidoEm)}.` : '';
    if (k.diferido) info.innerHTML += ` <b>Pagamento em atraso: ${fmtMoeda(k.diferido.recebido)} (taxa ${fmtMoeda(k.diferido.taxa)}) entram na prestação de contas de ${mesNum(k.diferido.ym)}, mês do pagamento; não somam no saldo deste mês.</b>`;
    return k;
  }

  function travar() {
    if (!ed.fechado) return;
    $$('#editorMes input, #editorMes select, #editorMes textarea, #editorMes button:not(.livre)').forEach(e => { e.disabled = true; });
    // Pagamento em atraso (lançado no mês do pagamento) pode ser registrado sem reabrir o mês: não altera esta prestação de contas
    if (inicioAtrasoNoPagamento()) $$('input[name=sitPagto], #recebidoEm, #valorRecebido, #encRecebidos, #btCalcEnc, #btSalvar').forEach(e => { e.disabled = false; });
    // Quem pagou não altera a prestação de contas: pode ser corrigido no mês fechado (sai no recibo)
    $$('#pagadorTipo, #pagadorNome, #pagadorDoc, #btSalvar').forEach(e => { e.disabled = false; });
  }

  renderLinhas();
  renderRepasses();
  renderAjustes();
  renderReajuste();
  atualizarResumo();
  if (ed.fechado) $('#estadoSalvar').textContent = 'Mês fechado: reabra para alterar.' + (inicioAtrasoNoPagamento() ? ' O pagamento em atraso do locatário pode ser registrado sem reabrir.' : '');

  const aoEditarLinha = e => {
    const row = e.target.closest('.lanc[data-i]');
    const k = e.target.dataset.campo;
    if (!row || !k) return;
    const l = ed.linhas[+row.dataset.i];
    if (e.target.type === 'checkbox') l[k] = e.target.checked;
    else if (k === 'cobrado' || k === 'pago') l[k] = r2(parseValor(e.target.value));
    else l[k] = e.target.value;
    if (k === 'rubrica') {
      const cat = rubricaCatalogo(l.rubrica);
      if (cat) { l.locacao = !!cat.locacao; $('[data-campo=locacao]', row).checked = l.locacao; }
    }
    marcarSujo();
    atualizarResumo();
  };
  $('#lancamentos').addEventListener('input', aoEditarLinha);
  $('#lancamentos').addEventListener('change', aoEditarLinha);
  $('#lancamentos').addEventListener('click', e => {
    if (e.target.dataset.acao !== 'del') return;
    ed.linhas.splice(+e.target.closest('.lanc').dataset.i, 1);
    marcarSujo(); renderLinhas(); atualizarResumo();
  });
  $('#btAddLinha').addEventListener('click', () => {
    ed.linhas.push({ id: novoId(), rubrica: '', obs: '', cobrado: 0, pago: 0, locacao: false, recorrente: false });
    marcarSujo(); renderLinhas(); atualizarResumo();
    $('#lancamentos .lanc[data-i]:last-of-type [data-campo=rubrica]').focus();
  });
  $('#btRecarregar').addEventListener('click', () => {
    if (!confirm('Substituir as rubricas deste mês pelas do cadastro do contrato (aluguel e encargos mensais)?')) return;
    ed.linhas = linhasDoContrato(ct);
    ed.taxaAdm = Number(ct.taxaAdm) || 0; ed.baseTaxa = ct.baseTaxa || 'locacao';
    $('#taxaPct').value = fmtPct(ed.taxaAdm); $('#taxaBase').value = ed.baseTaxa;
    marcarSujo(); renderLinhas(); atualizarResumo();
  });
  $('#btImpAnt')?.addEventListener('click', () => {
    if (!confirm(`Substituir as rubricas deste mês pelas de ${nomeMes(cad[idx - 1].ym)} marcadas para repetir?`)) return;
    ed.linhas = linhasRepetidas(anterior);
    marcarSujo(); renderLinhas(); atualizarResumo();
  });

  $('#taxaPct').addEventListener('input', e => { ed.taxaAdm = r2(parseValor(e.target.value)); marcarSujo(); atualizarResumo(); });
  $('#taxaBase').addEventListener('change', e => { ed.baseTaxa = e.target.value; marcarSujo(); atualizarResumo(); });
  $('#recebidoEm').addEventListener('change', e => { ed.recebidoEm = e.target.value; marcarSujo(); atualizarResumo(); });
  $('#vencMes').addEventListener('change', e => { ed.vencimento = e.target.value; marcarSujo(); atualizarResumo(); });
  $('#sitPagto').addEventListener('change', e => {
    ed.pagamento = e.target.value;
    if (ed.pagamento !== 'aberto' && !ed.recebidoEm) { ed.recebidoEm = hoje(); $('#recebidoEm').value = ed.recebidoEm; }
    marcarSujo(); atualizarResumo();
  });
  $('#valorRecebido').addEventListener('input', e => { ed.valorRecebido = r2(parseValor(e.target.value)); marcarSujo(); atualizarResumo(); });
  $('#encRecebidos').addEventListener('input', e => { ed.encargosRecebidos = r2(parseValor(e.target.value)); ed.encargosDetalhe = null; marcarSujo(); atualizarResumo(); });
  // Quem pagou (aparece no recibo): locatário, fiador ou outra pessoa
  const verPagador = () => { const outro = $('#pagadorTipo').value === 'outro' && ed.pagamento !== 'aberto'; $('#pagOutroNome').hidden = $('#pagOutroDoc').hidden = !outro; };
  $('#pagadorTipo').value = [...$('#pagadorTipo').options].some(o => o.value === ed.pagador?.tipo) ? ed.pagador.tipo : 'locatario';
  const lerPagador = () => { const tipo = $('#pagadorTipo').value; ed.pagador = tipo === 'outro' ? { tipo, nome: $('#pagadorNome').value.trim(), documento: $('#pagadorDoc').value.trim() } : { tipo }; };
  $('#pagadorTipo').addEventListener('change', () => { lerPagador(); verPagador(); marcarSujo(); });
  $$('#pagadorNome, #pagadorDoc').forEach(i => i.addEventListener('input', () => { lerPagador(); marcarSujo(); }));
  $('#sitPagto').addEventListener('change', verPagador);
  verPagador();
  $('#btCalcEnc').addEventListener('click', () => {
    if (!ed.recebidoEm || !ed.vencimento) return aviso('Informe o vencimento e a data do pagamento.', 'erro');
    const k = calcMes(ed, saldoAnterior, ctxMes);
    const e = encargosMoratorios(k.diferido ? k.diferido.principal : k.principalRecebido, ed.vencimento, ed.recebidoEm, paramsMora(ct));
    ed.encargosRecebidos = r2(e.total - (k.diferido ? k.diferido.principal : k.principalRecebido));
    // Partes dos encargos, para o recibo discriminar multa, juros e correção
    ed.encargosDetalhe = ed.encargosRecebidos ? { correcao: e.correcao, juros: e.juros, multa: e.multa } : null;
    $('#encRecebidos').value = ed.encargosRecebidos ? fmtNum(ed.encargosRecebidos) : '';
    marcarSujo(); atualizarResumo();
    aviso(e.dias ? `Pagamento com ${e.dias} dia(s) de atraso: correção ${fmtMoeda(e.correcao)}, juros ${fmtMoeda(e.juros)}, multa ${fmtMoeda(e.multa)}.` : 'Pagamento em dia: sem encargos.');
  });
  $('#obsMes').addEventListener('input', e => { ed.obs = e.target.value; marcarSujo(); });

  const aoEditarRep = e => {
    const row = e.target.closest('.rep');
    const k = e.target.dataset.campo;
    if (!row || !k) return;
    const r = ed.repasses[+row.dataset.i];
    r[k] = k === 'valor' ? r2(parseValor(e.target.value)) : e.target.value;
    marcarSujo(); atualizarResumo();
  };
  $('#repasses').addEventListener('input', aoEditarRep);
  $('#repasses').addEventListener('change', aoEditarRep);
  $('#repasses').addEventListener('click', e => {
    if (e.target.dataset.acao !== 'del') return;
    ed.repasses.splice(+e.target.closest('.rep').dataset.i, 1);
    marcarSujo(); renderRepasses(); atualizarResumo();
  });
  $('#btAddRep').addEventListener('click', () => {
    ed.repasses.push({ id: novoId(), data: hoje(), valor: 0, obs: '', status: 'efetuado', beneficiarioId: ct.locadorId });
    marcarSujo(); renderRepasses(); atualizarResumo();
    $('#repasses .rep:last-child [data-campo=valor]').focus();
  });
  $('#btRepTotal').addEventListener('click', () => {
    const k = calcMes(ed, saldoAnterior, ctxMes);
    const livre = r2(k.saldoConta - k.programado);
    if (livre <= 0) return aviso('Não há saldo disponível para repassar (descontados os repasses programados).', 'erro');
    ed.repasses.push({ id: novoId(), data: hoje(), valor: livre, obs: '', status: 'efetuado', beneficiarioId: ct.locadorId });
    marcarSujo(); renderRepasses(); atualizarResumo();
  });

  const aoEditarAjuste = e => {
    const row = e.target.closest('.ajuste');
    const k = e.target.dataset.campo;
    if (!row || !k) return;
    const a = ed.ajustes[+row.dataset.i];
    a[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'valor' ? r2(parseValor(e.target.value)) : e.target.value;
    marcarSujo(); atualizarResumo();
  };
  $('#ajustes').addEventListener('input', aoEditarAjuste);
  $('#ajustes').addEventListener('change', aoEditarAjuste);
  $('#ajustes').addEventListener('click', e => {
    if (e.target.dataset.acao !== 'del') return;
    ed.ajustes.splice(+e.target.closest('.ajuste').dataset.i, 1);
    marcarSujo(); renderAjustes(); atualizarResumo();
  });
  const novoAjuste = tipo => {
    ed.ajustes.push({ id: novoId(), tipo, descricao: '', valor: 0, recorrente: false });
    marcarSujo(); renderAjustes(); atualizarResumo();
    $('#ajustes .ajuste:last-child [data-campo=descricao]').focus();
  };
  $('#btAddDesc').addEventListener('click', () => novoAjuste('desconto'));
  $('#btAddReemb').addEventListener('click', () => novoAjuste('reembolso'));

  const salvar = async (conferirFechado = true) => {
    // Mês fechado: só aceita o registro de pagamento que entra na prestação de contas de um mês posterior
    if (ed.fechado && conferirFechado) {
      const a = calcMes(mes, saldoAnterior, ctxMes), b = calcMes(ed, saldoAnterior, ctxMes);
      if (a.principalRecebido !== b.principalRecebido || a.encargosRecebidos !== b.encargosRecebidos || a.taxaMes !== b.taxaMes) {
        throw new Error(`${nomeMes(ym)} está fechado e este pagamento entraria na prestação de contas dele. Reabra o mês para isso. Sem reabrir, só é possível registrar pagamento feito num mês posterior, a partir de ${fmtData(inicioAtrasoNoPagamento())}.`);
      }
    }
    ed.linhas = ed.linhas.filter(l => l.rubrica.trim() || l.cobrado || l.pago);
    if (ed.linhas.some(l => !l.rubrica.trim())) throw new Error('Informe a rubrica de todas as linhas com valor.');
    ed.repasses = ed.repasses.filter(r => r.valor);
    if (ed.repasses.some(r => !r.data)) throw new Error('Informe a data de todos os repasses.');
    if (ed.pagamento !== 'aberto' && !ed.recebidoEm) throw new Error('Informe a data do pagamento do locatário.');
    if (ed.pagamento === 'parcial' && !ed.valorRecebido) throw new Error('Informe o valor recebido do locatário.');
    if (ed.pagamento === 'aberto') { ed.recebidoEm = ''; ed.valorRecebido = 0; ed.encargosRecebidos = 0; ed.encargosDetalhe = null; ed.pagador = null; }
    if (ed.pagamento !== 'aberto' && ed.pagador?.tipo === 'outro' && !ed.pagador.nome) throw new Error('Informe o nome de quem pagou.');
    if (ed.pagamento === 'pago') ed.valorRecebido = 0;
    ed.ajustes = ed.ajustes.filter(a => a.valor);
    if (ed.ajustes.some(a => a.valor < 0)) throw new Error('Informe os descontos e reembolsos como valores positivos.');
    const reajusteNovo = ed._reajusteNovo;
    delete ed._reajusteNovo;
    try { await salvarMeses(cid, { [ym]: ed }); }
    catch (e) { if (reajusteNovo) ed._reajusteNovo = reajusteNovo; throw e; }
    // Reajuste confirmado: atualiza o aluguel do contrato e registra o histórico
    if (reajusteNovo) {
      const atual = D.contratos[cid];
      await salvarRegistro('contratos', {
        ...atual, valorAluguel: reajusteNovo.valorNovo,
        reajustes: [...(atual.reajustes || []), { ciclo: ed.reajuste.ciclo, status: 'aplicado', mes: ym, indice: ed.reajuste.indice, pct: ed.reajuste.pct, valorAnterior: reajusteNovo.valorAnterior, valorNovo: reajusteNovo.valorNovo, em: hoje(), por: usuario() }],
      });
    }
    sujo = false;
  };
  $('#btSalvar').addEventListener('click', () => executar(async () => { await salvar(); aviso('Mês salvo.'); rotear(); }));
  $('#btFechar').addEventListener('click', () => executar(async () => {
    if (!ed.fechado && !confirm(`Fechar ${nomeMes(ym)}? As alterações serão salvas e o mês ficará bloqueado para edição (é possível reabrir depois).`)) return;
    ed.fechado = !ed.fechado;
    try { await salvar(false); } catch (e) { ed.fechado = !ed.fechado; throw e; }
    aviso(ed.fechado ? 'Mês fechado.' : 'Mês reaberto.');
    rotear();
  }));
  $('#btExcluirMes')?.addEventListener('click', () => executar(async () => {
    if (!confirm(`Excluir ${nomeMes(ym)} deste contrato? Todas as rubricas e repasses do mês serão apagados.`)) return;
    await salvarMeses(cid, { [ym]: null });
    sujo = false;
    aviso('Mês excluído.');
    location.hash = `#/contrato/${cid}`;
  }));
  $('#btReciboMes')?.addEventListener('click', () => executar(async () => {
    if (sujo) throw new Error('Salve as alterações antes de emitir o recibo.');
    await visualizarPDF(gerarRecibos([{ ct: D.contratos[cid], ym, mes: ed }]));
  }));
  $('#btBoletoMes').addEventListener('click', () => {
    if (sujo) return aviso('Salve as alterações antes de ver a prévia do boleto.', 'erro');
    mostrarBoleto(D.contratos[cid], ym, ed, calcMes(ed, saldoAnterior, ctxMes));
  });
  ligarBotoesPDF('pdfMes', async () => {
    if (sujo) throw new Error('Salve as alterações antes de gerar o PDF.');
    return gerarRelatorio({ tipo: 'contrato', id: cid, de: ym, ate: ym, detalhado: true });
  });
}

/* ================= Relatórios ================= */
function telaRelatorios(h) {
  const q = new URLSearchParams(h.split('?')[1] || '');
  const rel = q.get('rel') || 'demonstrativo';
  if (GERENCIAIS[rel]) return telaRelatorioGerencial(rel);
  const atual = mesAtual();
  const st = { tipo: q.get('tipo') || 'contrato', id: q.get('id') || '', de: q.get('de') || atual, ate: q.get('ate') || q.get('de') || atual };
  const colDe = { contrato: 'contratos', imovel: 'imoveis', locador: 'locadores' };

  $('#conteudo').innerHTML = cabecalho('Relatórios', 'Demonstrativo mês a mês por contrato, imóvel ou cliente, de um mês ou de um período') + seletorRelatorioHTML('demonstrativo') + `
  <section class="cartao form">
    <div class="grade-form">
      <div class="campo wfull"><label>Relatório por</label><div class="segmentado" id="tipoRel">
        <label><input type="radio" name="tipo" value="contrato"${st.tipo === 'contrato' ? ' checked' : ''}> Contrato</label>
        <label><input type="radio" name="tipo" value="imovel"${st.tipo === 'imovel' ? ' checked' : ''}> Imóvel</label>
        <label><input type="radio" name="tipo" value="locador"${st.tipo === 'locador' ? ' checked' : ''}> Cliente (locador)</label>
      </div></div>
      <div class="campo wfull"><label for="alvoRel" id="rotAlvo"></label><select id="alvoRel"></select></div>
      <div class="campo"><label for="deRel">De (mês)</label><input type="month" id="deRel" value="${st.de}"></div>
      <div class="campo"><label for="ateRel">Até (mês)</label><input type="month" id="ateRel" value="${st.ate}"></div>
      <div class="campo w2"><label>Atalhos</label><div class="acoes-linha">
        <button type="button" class="bt pequeno" data-per="mes">Mês atual</button>
        <button type="button" class="bt pequeno" data-per="ant">Mês anterior</button>
        <button type="button" class="bt pequeno" data-per="tri">Últimos 3 meses</button>
        <button type="button" class="bt pequeno" data-per="ano">Ano atual</button>
      </div></div>
      <div class="campo wfull"><label>Formato</label><div class="segmentado">
        <label><input type="radio" name="formato" value="det" checked> Detalhado (rubricas de cada mês)</label>
        <label><input type="radio" name="formato" value="res"> Resumido (uma linha por mês)</label>
      </div></div>
    </div>
    <div class="barra-form"><span class="dica">${D.config.administradora?.nome ? '' : 'Os dados e o logotipo da administradora, que formam o cabeçalho dos relatórios, ainda não foram preenchidos (Administração).'}</span><span class="espaco"></span>${botoesPDF('relPdf')}</div>
  </section>`;

  const preencher = () => {
    const tipo = $('input[name=tipo]:checked').value;
    $('#rotAlvo').textContent = { contrato: 'Contrato', imovel: 'Imóvel', locador: 'Cliente (locador)' }[tipo];
    $('#alvoRel').innerHTML = '<option value="">— selecione —</option>' + opcoes(colDe[tipo]).map(([v, r]) => `<option value="${esc(v)}"${v === st.id ? ' selected' : ''}>${esc(r)}</option>`).join('');
  };
  preencher();
  ligarSeletorRelatorio();
  $('#tipoRel').addEventListener('change', () => { st.id = ''; preencher(); });
  $$('[data-per]').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.per;
    const [de, ate] = p === 'mes' ? [atual, atual] : p === 'ant' ? [addMes(atual, -1), addMes(atual, -1)] : p === 'tri' ? [addMes(atual, -2), atual] : [atual.slice(0, 4) + '-01', atual];
    $('#deRel').value = de; $('#ateRel').value = ate;
  }));
  ligarBotoesPDF('relPdf', async () => {
    const op = { tipo: $('input[name=tipo]:checked').value, id: $('#alvoRel').value, de: $('#deRel').value, ate: $('#ateRel').value, detalhado: $('input[name=formato]:checked').value === 'det' };
    if (!op.id) throw new Error('Selecione o ' + $('#rotAlvo').textContent.toLowerCase() + '.');
    if (!ehMes(op.de) || !ehMes(op.ate)) throw new Error('Informe o período (mês inicial e final).');
    return gerarRelatorio(op);
  });
}

/* ================= Configurações ================= */
function telaConfig() {
  const cfg = JSON.parse(JSON.stringify(D.config));
  const a = cfg.administradora;
  const campoA = (k, l, w) => `<div class="campo${w ? ' w' + w : ''}"><label for="a_${k}">${l}</label><input id="a_${k}" data-adm="${k}" value="${esc(a[k])}"></div>`;

  $('#conteudo').innerHTML = cabecalho('Administração', 'Área exclusiva do administrador') + `
  <nav class="atalhos-admin">
    <a href="#" data-ir="secUsuarios">Usuários</a><a href="#" data-ir="cfgForm">Administradora, rubricas e encargos</a>
    ${Armaz.modo === 'servidor' ? '<a href="#" data-ir="secServidor">Servidor</a>' : ''}<a href="#" data-ir="secArmaz">Armazenamento e backup</a><a href="#" data-ir="secIndices">Índices</a>
  </nav>
  ${secaoUsuariosHTML()}
  <div id="cfgForm">
  <section class="cartao form">
    <h2>Dados da administradora</h2>
    <p class="dica">Formam o cabeçalho de todos os relatórios em PDF. Depois de preencher, clique em <b>Salvar configurações</b>, no pé da tela.</p>
    <div class="grade-form">
      ${campoA('nome', 'Nome / razão social', 2)}${campoA('documento', 'CNPJ / CPF')}${campoA('creci', 'CRECI')}
      ${campoA('endereco', 'Endereço completo', 2)}${campoA('telefone', 'Telefone')}${campoA('email', 'E-mail')}
      ${campoA('site', 'Site', 2)}${campoA('cidade', 'Cidade (local dos recibos)')}
      <div class="campo w2"><label>Logotipo</label><div class="logo-ctl">
        <img id="logoPrev" alt="" ${a.logo ? `src="${a.logo}"` : 'hidden'}>
        <input type="file" id="logoArq" accept="image/png,image/jpeg">
        <button type="button" class="bt pequeno" id="btSemLogo"${a.logo ? '' : ' hidden'}>Remover</button>
      </div></div>
    </div>
  </section>
  <section class="cartao form">
    <h2>Rubricas</h2>
    <p class="dica">Lista de rubricas sugeridas nos contratos e nos meses. Marque <b>Locação</b> nas que são valor de locação: elas formam a base da taxa de administração nos contratos em que a taxa incide somente sobre a locação.</p>
    <div id="listaRub"></div>
    <button type="button" class="bt pequeno" id="btAddRub">+ Adicionar rubrica</button>
  </section>
  <section class="cartao form">
    <h2>Encargos moratórios (padrão)</h2>
    <p class="dica">Usados no cálculo de débitos dos contratos que não tiverem percentuais próprios. Juros calculados pro rata die (taxa mensal ÷ 30 × dias de atraso); multa sobre o valor corrigido; honorários sobre o total do débito (corrigido + juros + multa).</p>
    <div class="grade-form">
      <div class="campo"><label for="m_multa">Multa (%)</label><input id="m_multa" class="num" inputmode="decimal" value="${fmtPct(cfg.moratorios.multa)}"></div>
      <div class="campo"><label for="m_juros">Juros de mora (% ao mês)</label><input id="m_juros" class="num" inputmode="decimal" value="${fmtPct(cfg.moratorios.juros)}"></div>
      <div class="campo"><label for="m_honorarios">Honorários advocatícios (%)</label><input id="m_honorarios" class="num" inputmode="decimal" value="${fmtPct(cfg.moratorios.honorarios)}"></div>
      <div class="campo"><label for="m_indice">Índice de correção</label><select id="m_indice">${[...INDICES_CORRECAO, 'Nenhum'].map(i => `<option${i === cfg.moratorios.indice ? ' selected' : ''}>${i}</option>`).join('')}</select></div>
      <div class="campo wfull"><label class="inline"><input type="checkbox" id="m_neg"${cfg.moratorios.ignorarNegativos ? ' checked' : ''}> Desconsiderar índices negativos (deflação) na correção</label></div>
    </div>
  </section>
  <section class="cartao form">
    <h2>Pagamentos em atraso na prestação de contas</h2>
    <p class="dica">O aluguel pago em atraso, num mês posterior ao de referência, é registrado no mês de referência, mas o valor recebido e a taxa de administração entram na prestação de contas <b>do mês em que foi pago</b>, num bloco “Recebimentos de meses anteriores”. A prestação de contas do mês de referência não muda e informa em que mês o pagamento foi lançado. Vale para pagamentos feitos a partir da data abaixo; os anteriores continuam no mês de referência. Deixe em branco para lançar sempre no mês de referência.</p>
    <div class="grade-form">
      <div class="campo"><label for="m_atraso">Pagamentos feitos a partir de</label><input type="date" id="m_atraso" value="${esc(cfg.atrasoNoMesDoPagamento || '')}"></div>
    </div>
  </section>
  </div>
  <div class="barra-salvar"><span id="estadoSalvar" class="dica"></span><button class="bt primario" id="btSalvarCfg">Salvar configurações</button></div>
  ${Armaz.modo === 'servidor' ? secaoServidorHTML() : ''}
  <section class="cartao" id="secArmaz">
    <h2>Armazenamento dos dados</h2>
    <p>${esc(Armaz.descricao())}${Armaz.modo === 'servidor' && Armaz.infoServidor?.pasta ? `<br><span class="dica">Pasta no servidor: ${esc(Armaz.infoServidor.pasta)}</span>` : ''}</p>
    ${Armaz.modo === 'local' ? '<p class="alerta">Os dados estão guardados somente neste navegador. Para compartilhar com outros computadores, exporte um backup e importe-o na pasta da rede ou no servidor.</p>' : ''}
    <p class="dica">Uma cópia de segurança de todos os arquivos é feita automaticamente, uma vez por dia, na subpasta <b>_backups</b> da pasta de dados.</p>
    <p class="dica"><b>Importar</b> aceita o arquivo gerado por Exportar backup ou os arquivos .json da pasta de dados de outra instalação, ou de uma subpasta de _backups (contratos.json, imoveis.json, locadores.json, locatarios.json…): selecione vários de uma vez.</p>
    <div class="acoes-linha">
      <button class="bt" id="btExportar">Exportar backup (arquivo)</button>
      <label class="bt">Importar backup ou arquivos de dados<input type="file" id="arqImportar" accept=".json,application/json" multiple hidden></label>
      ${Armaz.modo === 'servidor' ? '' : dropboxFixo() ? '<button class="bt primario" id="btConvite">Gerar convite para outro aparelho</button><button class="bt perigo" id="btDesconectarDbx">Desconectar este aparelho do Dropbox</button>' : '<button class="bt" id="btTrocar">Trocar local de armazenamento</button>'}
    </div>
    ${dropboxFixo() ? `<p id="contaDbx"></p><p class="dica">Este aparelho está conectado à pasta <b>${esc(pastaDropboxFixa())}</b> do Dropbox da administradora. Todos os aparelhos usam essa mesma pasta. Para incluir o aparelho de alguém da equipe: crie o usuário (acima) e use <b>Gerar convite para outro aparelho</b>; a pessoa abre o link, digita o código e entra com o login dela. Aparelho perdido ou de alguém que saiu da equipe: no site do Dropbox (conta da administradora) → Configurações → Aplicativos conectados, remova o aplicativo; todos os aparelhos precisarão ser conectados de novo.</p>` : ''}
    ${Armaz.modo !== 'servidor' ? '<p class="dica">Neste modo, os usuários e as permissões são controlados pelo aplicativo. Quem tiver acesso direto à pasta (fora do aplicativo) consegue alterar os arquivos; compartilhe a pasta somente com quem deve ter acesso.</p>' : ''}
  </section>
  ${secaoIndicesHTML()}`;
  $$('[data-ir]').forEach(l => l.addEventListener('click', e => { e.preventDefault(); $('#' + l.dataset.ir)?.scrollIntoView({ behavior: 'smooth' }); }));
  ligarUsuarios();
  if (Armaz.modo === 'servidor') ligarServidor();

  const renderRub = () => {
    $('#listaRub').innerHTML = cfg.rubricas.map((r, i) => `<div class="rub-linha" data-i="${i}">
      <input data-campo="nome" value="${esc(r.nome)}" placeholder="Nome da rubrica">
      <label class="inline"><input type="checkbox" data-campo="locacao"${r.locacao ? ' checked' : ''}> Locação</label>
      <button type="button" class="bt-x" data-acao="del" title="Remover">&times;</button></div>`).join('');
  };
  renderRub();
  $('#listaRub').addEventListener('input', e => {
    const i = +e.target.closest('.rub-linha').dataset.i, k = e.target.dataset.campo;
    cfg.rubricas[i][k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  });
  $('#listaRub').addEventListener('click', e => {
    if (e.target.dataset.acao !== 'del') return;
    cfg.rubricas.splice(+e.target.closest('.rub-linha').dataset.i, 1);
    renderRub();
  });
  $('#btAddRub').addEventListener('click', () => { cfg.rubricas.push({ nome: '', locacao: false }); renderRub(); $('#listaRub .rub-linha:last-child input').focus(); });
  $$('[data-adm]').forEach(i => i.addEventListener('input', () => { a[i.dataset.adm] = i.value.trim(); }));
  // Avisa se sair da tela sem salvar
  const marcar = () => { sujo = true; $('#estadoSalvar').textContent = 'Alterações não salvas'; };
  $('#cfgForm').addEventListener('input', marcar);
  $('#cfgForm').addEventListener('change', marcar);
  $('#cfgForm').addEventListener('click', e => { if (e.target.closest('[data-acao=del], #btAddRub, #btSemLogo')) marcar(); });

  $('#logoArq').addEventListener('change', e => executar(async () => {
    const f = e.target.files[0];
    if (!f) return;
    const img = await new Promise((ok, falha) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => falha(new Error('Imagem inválida.')); im.src = URL.createObjectURL(f); });
    const esc2 = Math.min(1, 600 / img.width, 240 / img.height);
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.width * esc2); cv.height = Math.round(img.height * esc2);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    a.logo = cv.toDataURL('image/png'); a.logoL = cv.width; a.logoA = cv.height;
    $('#logoPrev').src = a.logo; $('#logoPrev').hidden = false; $('#btSemLogo').hidden = false;
  }));
  $('#btSemLogo').addEventListener('click', () => { a.logo = null; $('#logoPrev').hidden = true; $('#btSemLogo').hidden = true; });

  $('#btSalvarCfg').addEventListener('click', () => executar(async () => {
    cfg.rubricas = cfg.rubricas.map(r => ({ nome: r.nome.trim(), locacao: !!r.locacao })).filter(r => r.nome);
    const nomes = cfg.rubricas.map(r => r.nome.toLowerCase());
    if (new Set(nomes).size !== nomes.length) throw new Error('Há rubricas com o mesmo nome.');
    cfg.moratorios = {
      multa: r2(parseValor($('#m_multa').value)), juros: r2(parseValor($('#m_juros').value)),
      honorarios: r2(parseValor($('#m_honorarios').value)), indice: $('#m_indice').value, ignorarNegativos: $('#m_neg').checked,
    };
    cfg.atrasoNoMesDoPagamento = $('#m_atraso').value;
    await salvarConfig(cfg);
    sujo = false;
    aviso('Configurações salvas.');
    telaConfig();
  }));
  ligarIndices();
  $('#btExportar').addEventListener('click', () => executar(exportarBackup));
  $('#arqImportar').addEventListener('change', e => executar(async () => { if (e.target.files.length) await importarBackup(e.target.files); e.target.value = ''; }));
  if ($('#contaDbx')) NuvemDropbox.conta().then(c => { if (c && $('#contaDbx')) $('#contaDbx').innerHTML = `Conta do Dropbox conectada: <b>${esc(c.nome)}</b>${c.email ? ' (' + esc(c.email) + ')' : ''}${c.equipe ? ' · equipe ' + esc(c.equipe) : ''}`; }).catch(() => {});
  $('#btConvite')?.addEventListener('click', () => executar(gerarConvite));
  $('#btDesconectarDbx')?.addEventListener('click', () => {
    if (!confirm('Desconectar este aparelho do Dropbox? Para voltar a usar o app nele, o administrador terá de conectá-lo de novo com a conta do Dropbox da administradora.')) return;
    sujo = false;
    NuvemDropbox.sair();
    Armaz.desconectar();
    Auth.sair();
    location.hash = '';
    location.reload();
  });
  $('#btTrocar')?.addEventListener('click', () => {
    if (!confirm('Trocar o local de armazenamento? Os dados atuais continuam onde estão; você escolherá outro local na próxima tela.')) return;
    Armaz.desconectar();
    location.hash = '';
    location.reload();
  });
}

async function exportarBackup() {
  const arquivos = {};
  for (const a of arquivosDeDados()) {
    const t = await Armaz.ler(a);
    if (t != null) arquivos[a] = JSON.parse(t);
  }
  const blob = new Blob([JSON.stringify({ app: 'controle-locacoes', versao: 1, geradoEm: new Date().toISOString(), arquivos })], { type: 'application/json' });
  baixar(blob, `backup-locacoes-${hoje()}.json`);
}

// Arquivos soltos da pasta de dados (de outra instalação ou de _backups): contratos.json, imoveis.json, extratos etc.
async function importarArquivosDeDados(lista) {
  const achados = {}, ignorados = [];
  let usuarios = null;
  for (const f of lista) {
    let j;
    try { j = JSON.parse(await f.text()); } catch { ignorados.push(f.name); continue; }
    const nome = (f.name.toLowerCase().match(/^(config|indices|locadores|locatarios|imoveis|contratos|usuarios)(?:\s*\(\d+\))?\.json$/) || [])[1];
    if (nome === 'usuarios' && j && typeof j.usuarios === 'object') usuarios = j;
    else if (COLECOES.includes(nome) && j && typeof j.itens === 'object') achados[nome + '.json'] = j;
    else if ((nome === 'config' || nome === 'indices') && j && typeof j === 'object') achados[nome + '.json'] = j;
    else if (j && typeof j.contratoId === 'string' && /^[\w-]+$/.test(j.contratoId) && j.meses) achados[`extratos/${j.contratoId}.json`] = j;
    else if (j && typeof j.contratoId === 'string' && /^[\w-]+$/.test(j.contratoId) && j.calculos) achados[`calculos/${j.contratoId}.json`] = j;
    else ignorados.push(f.name);
  }
  const nomes = Object.keys(achados);
  if (!nomes.length && !usuarios) throw new Error('Nenhum arquivo de dados do Controle de Locações foi reconhecido. Selecione o arquivo de backup (backup-locacoes-….json) ou os arquivos da pasta de dados (contratos.json, imoveis.json, locadores.json, locatarios.json…).');
  const contagem = c => achados[c + '.json'] ? ` (${Object.keys(achados[c + '.json'].itens).length})` : '';
  const descr = nomes.map(n => '• ' + n + (n.endsWith('.json') && COLECOES.includes(n.slice(0, -5)) ? contagem(n.slice(0, -5)) : '')).join('\n');
  if (nomes.length && !confirm(`Importar estes arquivos?\n\n${descr}${ignorados.length ? `\n\nNão reconhecidos (ignorados): ${ignorados.join(', ')}` : ''}\n\nCada arquivo SUBSTITUI o correspondente atual (os demais ficam como estão). Antes, uma cópia dos dados atuais será guardada em _backups.`)) return;
  const trocarUsuarios = usuarios && Armaz.modo !== 'servidor' && confirm(`Um arquivo de usuários (usuarios.json, ${Object.keys(usuarios.usuarios).length} usuários) também foi selecionado.\n\nSubstituir os usuários e senhas atuais pelos desse arquivo? Se sim, você sairá e entrará de novo com um login desse arquivo.\n\nOK = substituir · Cancelar = manter os usuários atuais`);
  if (!nomes.length && !trocarUsuarios) return;
  if (Armaz.modo !== 'local') await copiaDeSeguranca(hoje() + '-antes-da-importacao');
  for (const [p, v] of Object.entries(achados)) await Armaz.gravar(p, JSON.stringify(v, null, 1));
  if (trocarUsuarios) {
    await Armaz.gravar('usuarios.json', JSON.stringify(usuarios, null, 1));
    aviso('Dados importados. Entre com um login do arquivo importado.');
    Auth.sair();
    return telaLogin();
  }
  aviso(`${nomes.length} arquivo(s) importado(s).`);
  await rotear(true);
}

async function importarBackup(arqs) {
  arqs = [...arqs];
  let j = null;
  if (arqs.length === 1) { try { j = JSON.parse(await arqs[0].text()); } catch { throw new Error('Arquivo inválido.'); } }
  if (!j || j.app !== 'controle-locacoes' || !j.arquivos) return importarArquivosDeDados(arqs);
  const n = Object.keys(j.arquivos.contratos?.itens || {}).length;
  if (!confirm(`Importar o backup de ${fmtData(j.geradoEm)} (${n} contratos)?\n\nTODOS os dados atuais serão substituídos. Antes, uma cópia dos dados atuais será guardada em _backups.`)) return;
  if (Armaz.modo !== 'local') await copiaDeSeguranca(hoje() + '-antes-da-importacao');
  for (const [p, v] of Object.entries(j.arquivos)) {
    if (!/^(config|indices|locadores|locatarios|imoveis|contratos)\.json$|^(extratos|calculos)\/[\w-]+\.json$/.test(p)) continue;
    await Armaz.gravar(p, JSON.stringify(v, null, 1));
  }
  aviso('Backup importado.');
  await rotear(true);
}

/* ================= Conexão ================= */
// Abertura da publicação com Dropbox fixo: só a conexão do aparelho pelo administrador, sem opções técnicas
function telaConexaoDropbox() {
  document.body.classList.remove('conectado', 'admin', 'menu-aberto');
  $('#statusArmaz').textContent = '';
  $('#usuarioTopo').innerHTML = '';
  const pronto = !!chavesNuvem().dropbox && nuvemDisponivel();
  $('#conteudo').innerHTML = `<section class="cartao caixa-login form">
    <h1>Controle de Locações</h1>
    ${pronto ? `
      <p>Este aparelho ainda não está conectado aos dados da administradora.</p>
      <p><b>Recebeu um convite do administrador?</b> Abra o link do convite neste aparelho, ou cole-o abaixo, e digite o código de ativação.</p>
      <form id="formConvite" class="grade-login">
        <div class="campo"><label for="cvLink">Link do convite</label><input id="cvLink" autocapitalize="off" autocomplete="off" placeholder="https://…#convite=…"></div>
        <div class="campo"><label for="cvCodigo">Código de ativação</label><input id="cvCodigo" autocapitalize="characters" autocomplete="off" placeholder="XXXXX-XXXXX"></div>
        <button class="bt primario" type="submit">Ativar este aparelho</button>
      </form>
      <h3 class="sec">Administrador</h3>
      <p class="dica">No primeiro aparelho, o administrador conecta com a conta do Dropbox da administradora. Nos demais, basta enviar um convite (Administração › Armazenamento dos dados).</p>
      <div class="acoes-linha"><button class="bt" id="btConectarDbx">Conectar com a conta do Dropbox (administrador)</button></div>`
      : '<p class="alerta">O aplicativo ainda não foi configurado para acessar os dados. Avise o administrador.</p>'}
    ${dicaInstalarHTML()}
  </section>`;
  ligarInstalar();
  $('#btConectarDbx')?.addEventListener('click', () => executar(async () => {
    if (NuvemDropbox.temAcesso()) return conectarDropbox();
    await NuvemDropbox.entrar();
  }));
  $('#formConvite')?.addEventListener('submit', e => {
    e.preventDefault();
    executar(async () => {
      const pacote = Convite.extrair($('#cvLink').value);
      if (!pacote) throw new Error('Cole o link do convite enviado pelo administrador.');
      await ativarConvite(pacote, $('#cvCodigo').value);
    });
  });
}

// Aberto pelo link do convite (#convite=...): só pede o código de ativação
function telaConvite(pacote) {
  document.body.classList.remove('conectado', 'admin', 'menu-aberto');
  $('#statusArmaz').textContent = '';
  $('#usuarioTopo').innerHTML = '';
  $('#conteudo').innerHTML = `<section class="cartao caixa-login form">
    <h1>Controle de Locações</h1>
    <p>Você recebeu um convite para usar o aplicativo neste aparelho.</p>
    <form id="formConvite" class="grade-login">
      <div class="campo"><label for="cvCodigo">Código de ativação (enviado pelo administrador)</label><input id="cvCodigo" required autocapitalize="characters" autocomplete="off" placeholder="XXXXX-XXXXX"></div>
      <button class="bt primario" type="submit">Ativar este aparelho</button>
    </form>
    <p class="dica">Depois de ativar, entre com o login e a senha que o administrador criou para você.</p>
    ${dicaInstalarHTML()}
  </section>`;
  ligarInstalar();
  $('#cvCodigo').focus();
  $('#formConvite').addEventListener('submit', e => { e.preventDefault(); executar(() => ativarConvite(pacote, $('#cvCodigo').value)); });
}

async function ativarConvite(pacote, codigo) {
  if (!String(codigo).trim()) throw new Error('Digite o código de ativação.');
  await Convite.ativar(pacote, codigo);
  history.replaceState(null, '', location.pathname);
  try { await conectarDropbox(); }
  catch (e) {
    NuvemDropbox.sair();
    throw new Error('O convite foi aceito, mas o acesso ao Dropbox não funcionou (' + e.message + '). Peça um convite novo ao administrador.');
  }
}

/* ---------- Instalar o aplicativo (ícone na área de trabalho / tela inicial) ---------- */
let pedidoInstalar = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); pedidoInstalar = e; $$('.bt-instalar').forEach(b => { b.hidden = false; }); });
window.addEventListener('appinstalled', () => { pedidoInstalar = null; $$('.bt-instalar').forEach(b => { b.hidden = true; }); });
const appInstalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function dicaInstalarHTML() {
  if (appInstalado()) return '';
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  return `<div class="instalar"><button type="button" class="bt bt-instalar"${pedidoInstalar ? '' : ' hidden'}>Instalar o aplicativo neste aparelho</button>
    <p class="dica">${ios
      ? 'Para ter o ícone na tela inicial do iPhone/iPad: no Safari, toque em <b>Compartilhar</b> › <b>Adicionar à Tela de Início</b>. <b>Faça isso antes de ativar o convite</b> e ative-o pelo ícone instalado (o iPhone guarda o acesso do ícone separado do Safari): abra o ícone e cole o link do convite.'
      : 'Para ter o ícone na área de trabalho ou na tela inicial: no Chrome ou no Edge, use o botão acima ou o menu do navegador › <b>Instalar</b> (ou <b>Adicionar à tela inicial</b>, no celular).'}</p></div>`;
}
function ligarInstalar() {
  $$('.bt-instalar').forEach(b => b.addEventListener('click', async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    await pedidoInstalar.userChoice.catch(() => null);
    pedidoInstalar = null;
    b.hidden = true;
  }));
}

// Administrador: gera o link + código para conectar outro aparelho sem a conta do Dropbox
async function gerarConvite() {
  const { link, codigo } = await Convite.gerar();
  abrirModal(`<div class="modal-cab"><h2>Convite para conectar um aparelho</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <p>Envie à pessoa o <b>link</b> e, <b>por outro meio</b>, o <b>código de ativação</b> (ex.: link por e-mail e código por telefone ou mensagem). Ela abre o link no aparelho, digita o código e depois entra com o login e a senha que você criou para ela em Usuários.</p>
    <div class="campo"><label>Link do convite</label><div class="acoes-linha"><input id="cvGerLink" readonly value="${esc(link)}" style="flex:1"><button type="button" class="bt" id="btCopLink">Copiar link</button></div></div>
    <div class="campo"><label>Código de ativação</label><div class="acoes-linha"><input id="cvGerCod" readonly value="${esc(codigo)}" style="font-size:1.3em;letter-spacing:.08em;max-width:12em"><button type="button" class="bt" id="btCopCod">Copiar código</button></div></div>
    <p class="alerta">Link + código dão acesso aos <b>arquivos</b> de dados neste Dropbox (o login e a senha de cada pessoa continuam valendo dentro do app). Não envie os dois juntos nem para quem não é da equipe. Cada convite tem um código diferente; gere um para cada aparelho.</p>
    <p class="dica">Para cortar o acesso de todos os aparelhos (ex.: celular perdido): no site do Dropbox da administradora › Configurações › Aplicativos conectados, remova o aplicativo; depois conecte este aparelho de novo e gere convites novos.</p>
    <div class="acoes-linha"><span class="espaco"></span><button type="button" class="bt primario" data-fechar>Fechar</button></div>`);
  const copiar = async (txt, msg) => { if (await copiarTexto(txt)) aviso(msg); else aviso('Não foi possível copiar; selecione o texto e copie manualmente.', 'erro'); };
  $('#btCopLink').addEventListener('click', () => copiar(link, 'Link copiado.'));
  $('#btCopCod').addEventListener('click', () => copiar(codigo, 'Código copiado.'));
}

async function telaConexao() {
  if (dropboxFixo()) return telaConexaoDropbox();
  document.body.classList.remove('conectado');
  $('#statusArmaz').textContent = '';
  const temFS = 'showDirectoryPicker' in window;
  const h = temFS ? await IDB.get('kv', 'pasta').catch(() => null) : null;
  const ch = chavesNuvem(), nuvem = nuvemDisponivel();
  const nomeGoogle = localStorage.getItem('cl-modo') === 'gdrive' && localStorage.getItem('cl-gdr-nome');
  const semHttps = '<p class="alerta">Disponível quando o aplicativo é aberto por um endereço seguro (https), como a página publicada do aplicativo. Veja o README.</p>';
  $('#conteudo').innerHTML = `
  <section class="boas-vindas"><h1>Controle de Locações</h1><p>Escolha onde os dados serão guardados.</p></section>
  <div class="opcoes-conexao">
    ${h ? `<section class="cartao destaque"><h2>Continuar com a pasta “${esc(h.name)}”</h2><p>O navegador pede sua confirmação a cada vez que o aplicativo é aberto.</p><button class="bt primario" id="btReconectar">Abrir pasta “${esc(h.name)}”</button></section>` : ''}
    ${nomeGoogle && nuvem ? `<section class="cartao destaque"><h2>Continuar no Google Drive</h2><p>Pasta “${esc(nomeGoogle)}”. O Google pede para entrar novamente a cada sessão.</p><button class="bt primario" id="btGoogleVolta">Entrar com Google</button></section>` : ''}
    <section class="cartao"><h2>Dropbox</h2>
      <p>Os dados ficam numa pasta do Dropbox compartilhada pela equipe. Funciona no computador e no celular, de qualquer lugar.</p>
      ${nuvem ? `${ch.dropbox ? '' : '<div class="campo"><label for="dbxChave">Chave do aplicativo (App key)</label><input id="dbxChave"></div>'}
        <div class="campo"><label for="dbxPasta">Pasta no Dropbox</label><input id="dbxPasta" value="${esc(localStorage.getItem('cl-dbx-pasta') || '/Locacoes')}"></div>
        <div class="acoes-linha"><button class="bt" id="btDropbox">Entrar com Dropbox</button></div>` : semHttps}
    </section>
    <section class="cartao"><h2>Google Drive</h2>
      <p>Os dados ficam numa pasta do Google Drive compartilhada pela equipe. Funciona no computador e no celular, de qualquer lugar.</p>
      ${nuvem ? `${ch.google ? '' : '<div class="campo"><label for="gdrCliente">ID do cliente OAuth</label><input id="gdrCliente"></div>'}
        <div class="campo"><label for="gdrPasta">Link da pasta no Google Drive</label><input id="gdrPasta" value="${esc(localStorage.getItem('cl-gdr-link') || '')}" placeholder="https://drive.google.com/drive/folders/…"></div>
        <div class="acoes-linha"><button class="bt" id="btGoogle">Entrar com Google</button></div>` : semHttps}
    </section>
    <section class="cartao"><h2>Pasta da rede ou pasta sincronizada</h2>
      <p>Os dados ficam numa pasta que vários computadores acessam: uma pasta da rede do escritório ou uma pasta do OneDrive, Google Drive ou Dropbox sincronizada.</p>
      ${temFS ? '<button class="bt" id="btPasta">Escolher pasta</button>' : '<p class="alerta">Disponível somente no Chrome ou no Edge do computador. No celular, use o acesso pelo servidor.</p>'}
    </section>
    <section class="cartao"><h2>Servidor do escritório</h2>
      <p>Para usar no celular e em vários computadores ao mesmo tempo, inicie o servidor (<b>Iniciar servidor.bat</b>) no computador principal e abra o endereço exibido na janela do servidor, por exemplo <b>http://192.168.0.10:8080</b>.</p>
    </section>
    <section class="cartao"><h2>Somente neste navegador</h2>
      <p>Para testar o aplicativo. Os dados ficam só neste aparelho.</p>
      <button class="bt" id="btLocal">Usar neste navegador</button>
    </section>
  </div>`;
  $('#btReconectar')?.addEventListener('click', () => executar(async () => {
    if (await Armaz.retomarPasta(true)) { localStorage.setItem('cl-modo', 'pasta'); await conectado(); }
    else aviso('Acesso à pasta não autorizado.', 'erro');
  }));
  $('#btPasta')?.addEventListener('click', () => executar(async () => { await Armaz.conectarPasta(); await conectado(); }));
  $('#btLocal').addEventListener('click', () => executar(async () => { Armaz.usarLocal(); await conectado(); }));
  $('#btDropbox')?.addEventListener('click', () => executar(async () => {
    const chave = $('#dbxChave')?.value.trim();
    if (chave) localStorage.setItem('cl-dbx-chave', chave);
    const pasta = '/' + $('#dbxPasta').value.trim().replace(/^\/+|\/+$/g, '');
    if (pasta === '/') throw new Error('Informe a pasta do Dropbox onde ficarão os dados (ex.: /Locacoes).');
    localStorage.setItem('cl-dbx-pasta', pasta);
    if (NuvemDropbox.temAcesso()) return conectarDropbox();
    await NuvemDropbox.entrar();
  }));
  const entrarGoogle = async link => {
    const id = NuvemGoogle.extrairId(link);
    if (!id) throw new Error('Cole o link da pasta do Google Drive (ex.: https://drive.google.com/drive/folders/…).');
    await NuvemGoogle.entrar();
    const nome = await NuvemGoogle.verificarPasta(id);
    NuvemGoogle.pastaId = id;
    localStorage.setItem('cl-gdr-link', link);
    localStorage.setItem('cl-gdr-nome', nome);
    Armaz.usarNuvem('gdrive');
    await conectado();
  };
  $('#btGoogle')?.addEventListener('click', () => executar(async () => {
    const cliente = $('#gdrCliente')?.value.trim();
    if (cliente) localStorage.setItem('cl-gdr-cliente', cliente);
    await entrarGoogle($('#gdrPasta').value.trim());
  }));
  $('#btGoogleVolta')?.addEventListener('click', () => executar(() => entrarGoogle(localStorage.getItem('cl-gdr-link'))));
}

async function conectarDropbox() {
  NuvemDropbox.pasta = dropboxFixo() ? pastaDropboxFixa() : localStorage.getItem('cl-dbx-pasta') || '';
  const situacao = await NuvemDropbox.verificarPasta(NuvemDropbox.pasta);
  Armaz.usarNuvem('dropbox');
  if (situacao === 'criada') setTimeout(() => aviso(`Pasta ${NuvemDropbox.pasta} criada no Dropbox.`), 800);
  await conectado();
}

async function conectado() {
  // Sem sessão válida neste aparelho: tela de login (ou de criação do primeiro administrador)
  if (!Auth.usuario && !(await Auth.retomar())) return telaLogin();
  // Termos de Uso: aceite de cada usuário, uma vez por aparelho (e de novo quando os Termos mudarem)
  if (!termosAceitos()) return telaTermos(true);
  await carregarColecoes();
  document.body.classList.add('conectado');
  document.body.classList.toggle('admin', Auth.ehAdmin());
  $('#usuarioTopo').innerHTML = `<a href="#/conta" title="Minha conta">${esc(Auth.usuario.nome)}</a>${Auth.ehAdmin() ? ' <span class="chip neutro">Administrador</span>' : ''}<button class="bt-sair" id="btSair">Sair</button>`;
  $('#btSair').onclick = () => {
    if (sujo && !confirm('Há alterações não salvas. Sair mesmo assim?')) return;
    sujo = false;
    Auth.sair();
    telaLogin();
  };
  const st = $('#statusArmaz');
  st.textContent = Armaz.descricao();
  if (Armaz.modo === 'gdrive') {
    st.classList.add('clicavel');
    st.title = 'Clique para renovar o acesso ao Google Drive';
    st.onclick = () => executar(async () => { await NuvemGoogle.entrar(); aviso('Acesso ao Google Drive renovado.'); });
  }
  // Fora do servidor (ex.: Dropbox), a versão vem do arquivo versao.txt publicado junto com o app
  if (!Armaz.infoServidor?.versaoApp && !Armaz.versaoApp) {
    try { const r = await fetch('versao.txt', { cache: 'no-store' }); if (r.ok) Armaz.versaoApp = (await r.text()).trim(); } catch { /* sem versão */ }
  }
  $('#rodapeMenu').innerHTML = rodapeMenuHTML();
  // Aviso depois de uma atualização instalada pelo app
  const atualizado = sessionStorage.getItem('cl-atualizado');
  if (atualizado) { sessionStorage.removeItem('cl-atualizado'); setTimeout(() => aviso(atualizado), 600); }
  garantirIndices(); // em segundo plano: mantém os índices de correção em dia
  await rotear();
}

/* ================= Início ================= */
function eventosGlobais() {
  $('#btMenu').addEventListener('click', () => document.body.classList.toggle('menu-aberto'));
  $('#fundoMenu').addEventListener('click', () => document.body.classList.remove('menu-aberto'));
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-fechar]')) fecharModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) fecharModal(); });
  // Formata valores em reais ao sair do campo
  document.addEventListener('focusout', e => {
    const t = e.target;
    if (t.matches?.('input[data-tipo=money]') && t.value.trim() !== '') t.value = fmtNum(parseValor(t.value));
  });
}

async function iniciar() {
  eventosGlobais();
  try {
    if (await Armaz.detectarServidor()) return await conectado();
    // Volta do login do Dropbox (?code=...&state=dropbox)
    const qs = new URLSearchParams(location.search);
    if (qs.get('state') === 'dropbox') {
      history.replaceState(null, '', location.pathname + location.hash);
      if (qs.get('error')) throw new Error('O acesso ao Dropbox não foi autorizado.');
      await NuvemDropbox.concluirEntrada(qs.get('code'));
      return await conectarDropbox();
    }
    // Publicação com Dropbox fixo: ignora qualquer outro modo guardado neste navegador
    const convite = dropboxFixo() && Convite.extrair(location.hash);
    if (convite) {
      if (!NuvemDropbox.temAcesso()) return telaConvite(convite);
      history.replaceState(null, '', location.pathname); // aparelho já conectado: ignora o convite
    }
    if (dropboxFixo()) return NuvemDropbox.temAcesso() ? await conectarDropbox() : telaConexaoDropbox();
    const modo = localStorage.getItem('cl-modo');
    if (modo === 'local') { Armaz.modo = 'local'; return await conectado(); }
    if (modo === 'pasta' && await Armaz.retomarPasta(false)) return await conectado();
    if (modo === 'dropbox' && NuvemDropbox.temAcesso()) return await conectarDropbox();
    await telaConexao();
  } catch (e) {
    console.error(e);
    const fixo = dropboxFixo();
    $('#conteudo').innerHTML = `<section class="cartao erro"><h2>Não foi possível abrir os dados</h2><p>${esc(e.message)}</p>
      <div class="acoes-linha"><button class="bt" onclick="location.reload()">Tentar novamente</button><button class="bt" id="btOutroLocal">${fixo ? 'Conectar este aparelho de novo (administrador)' : 'Escolher outro local'}</button></div></section>`;
    $('#btOutroLocal').addEventListener('click', () => { if (fixo) NuvemDropbox.sair(); Armaz.desconectar(); Armaz.modo = null; telaConexao(); });
  }
}

document.addEventListener('DOMContentLoaded', iniciar);
