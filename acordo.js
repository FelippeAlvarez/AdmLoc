'use strict';
/*
  Acordos de pagamento do débito de um contrato (motor e lançamentos; telas em acordo-tela.js).
  Mesmo motor do aplicativo Cobrança Condominial:
  - débito na data do acordo (de um cálculo salvo ou pelos critérios do contrato), desconto total ou por componente,
    sinal e parcelamento pela Tabela Price com a 1ª parcela em data livre:
    f1 = (1+i)^(dias/30) se incidem juros até a 1ª parcela (1 se não incidem);
    parcela = saldo × f1 × i ÷ [(1 − (1+i)^−n) × (1+i)]; os centavos vão para a última parcela;
  - acompanhamento: pagamentos, amortização antecipada (reduz o prazo ou a parcela), quitação, descumprimento
    (vencimento antecipado do saldo ou perda do desconto) e desfazer o último lançamento.
  Os acordos ficam em calculos/<contrato>.json (acordos: { id: acordo }). Os meses incluídos num acordo em andamento
  ou quitado saem da Inadimplência e dos novos cálculos. Cada pagamento pode entrar na prestação de contas do
  locador, na data indicada pelo usuário (ex.: depósito judicial, só após o levantamento).
*/

const COMPONENTES_ACORDO = [
  ['principal', 'Aluguéis, encargos e outros débitos (valor corrigido)'],
  ['juros', 'Juros de mora'],
  ['multa', 'Multa'],
  ['custas', 'Custas e despesas'],
  ['multasProc', 'Multas processuais'],
  ['honorarios', 'Honorários advocatícios'],
  ['a523', 'Multa do art. 523 do CPC'],
];
const COMP_HONORARIOS = ['honorarios'];
const SITUACOES_ACORDO = { proposta: 'Proposta', aceito: 'Em andamento', quitado: 'Quitado', descumprido: 'Descumprido', descartado: 'Descartado' };
const chipAcordo = s => `<span class="chip ${s === 'aceito' ? 'aberto' : s === 'quitado' ? 'fechado' : s === 'descumprido' ? 'pendente' : 'neutro'}">${SITUACOES_ACORDO[s] || s}</span>`;

const somar = (l, f) => l.reduce((s, x) => s + cent(f(x)), 0) / 100;
const diaDoMes = (ym, d) => `${ym}-${p2(Math.min(Math.max(1, +d || 1), ultimoDia(ym)))}`;
const acordosDoContrato = cid => Object.values(D.calcs?.[cid]?.acordos || {});

// Meses (AAAA-MM) incluídos em acordos em andamento ou quitados: saem da Inadimplência e dos novos cálculos
function mesesEmAcordo(cid) {
  const s = new Set();
  for (const a of acordosDoContrato(cid)) if (a.situacao === 'aceito' || a.situacao === 'quitado') (a.meses || []).forEach(m => s.add(m));
  return s;
}

/* ================= Débito na data do acordo ================= */
// Cálculo-base: um cálculo salvo do contrato ou, sem ele, o débito pelos critérios do contrato
function calculoBaseAcordo(ct, a) {
  const salvo = a.calcId && D.calcs[ct.id]?.calculos?.[a.calcId];
  return salvo ? JSON.parse(JSON.stringify(salvo)) : { ...novoCalculo(ct), honContr: 0 };
}

function debitoAcordo(ct, a, data = a.data) {
  const calc = calculoBaseAcordo(ct, a);
  // Os meses do próprio acordo entram mesmo que já estejam num acordo (ex.: reabrir o cálculo da proposta)
  const r = calcularContrato(ct, calc, data, a.id);
  const comp = Object.fromEntries(COMPONENTES_ACORDO.map(([k]) => [k, 0]));
  for (const g of r.grupos) {
    if (g.grupo === 'rubrica') { comp.principal += g.principal; comp.juros += g.juros; comp.multa += g.multa; }
    else if (g.grupo === 'custas') comp.custas += g.total;
    else if (g.grupo === 'multa') comp.multasProc += g.total;
    else if (g.grupo === 'honorarios') comp.honorarios += g.total;
    else if (g.grupo === 'art523') for (const it of g.itens) comp[it.itemId === 'art523-hon' ? 'honorarios' : 'a523'] += it.total;
  }
  comp.honorarios += r.honContr || 0;
  for (const k in comp) comp[k] = r2(comp[k]);
  const meses = r.itens.filter(it => it.serie === 'alugueis' || /^\d{4}-\d{2}$/.test(it.itemId)).map(it => it.itemId);
  return { data, comp, total: r2(Object.values(comp).reduce((s, v) => s + v, 0)), meses, calcNome: calc.nome || 'Débito pelos critérios do contrato', indice: calc.crit?.indice || paramsMora(ct).indice, r };
}

const valorOuPct = (base, tipo, v) => Math.min(base, Math.max(0, tipo === 'valor' ? r2(Number(v) || 0) : r2(base * (Number(v) || 0) / 100)));

// Desconto, sinal e saldo a parcelar
function negociacao(a, deb) {
  const d = a.desconto || { modo: 'total', tipo: 'pct', valor: 0 };
  const descItens = {};
  let desconto;
  if (d.modo === 'itens') {
    for (const [k] of COMPONENTES_ACORDO) { const it = d.itens?.[k] || {}; descItens[k] = valorOuPct(deb.comp[k] || 0, it.tipo, it.valor); }
    desconto = somar(Object.values(descItens), v => v);
  } else desconto = valorOuPct(deb.total, d.tipo, d.valor);
  const negociado = r2(deb.total - desconto);
  const sinal = valorOuPct(negociado, a.sinal?.tipo, a.sinal?.valor);
  return { desconto, descItens, negociado, sinal, saldo: r2(negociado - sinal) };
}

const fatorPeriodo = (i, de, ate) => Math.pow(1 + i, Math.max(0, diasEntre(de, ate)) / 30);

// Plano Price: saldo na data-base; f1 = fator de juros até a 1ª parcela; modo 'prazo' (n) ou 'parcela' (valor)
function planoPrice({ saldo, taxa, f1, primeiroVenc, modo, prazo, parcela, numeroInicial = 1 }) {
  const i = (Number(taxa) || 0) / 100;
  if (!(saldo > 0)) return { pmt: 0, n: 0, parcelas: [] };
  if (!ehData(primeiroVenc)) throw new Error('Informe a data de vencimento da 1ª parcela.');
  let n, pmt;
  if (modo === 'parcela') {
    pmt = r2(Number(parcela) || 0);
    if (!(pmt > 0)) throw new Error('Informe o valor da parcela.');
    if (i === 0) n = Math.ceil(saldo / pmt - 1e-9);
    else {
      const x = saldo * f1 * i / (pmt * (1 + i));
      if (x >= 1) throw new Error(`A parcela de ${fmtMoeda(pmt)} não cobre nem os juros do saldo: o acordo nunca seria quitado. Informe uma parcela maior que ${fmtMoeda(r2(saldo * f1 * i / (1 + i)) + 0.01)}.`);
      n = Math.ceil(-Math.log(1 - x) / Math.log(1 + i) - 1e-9);
    }
  } else {
    n = Math.floor(Number(prazo) || 0);
    if (n < 1) throw new Error('Informe o número de parcelas.');
    pmt = r2(i === 0 ? saldo / n : saldo * f1 * i / ((1 - Math.pow(1 + i, -n)) * (1 + i)));
  }
  if (n > 600) throw new Error('O parcelamento passaria de 600 parcelas. Confira os valores.');
  const dia = +primeiroVenc.slice(8), mes0 = primeiroVenc.slice(0, 7);
  const parcelas = [];
  let B = saldo;
  for (let k = 1; k <= n && B > 0.004; k++) {
    const venc = k === 1 ? primeiroVenc : diaDoMes(addMes(mes0, k - 1), dia);
    const f = k === 1 ? f1 : 1 + i;
    const juros = r2(B * (f - 1)), devido = r2(B + juros);
    const valor = k === n ? devido : Math.min(pmt, devido);
    B = r2(devido - valor);
    parcelas.push({ n: numeroInicial + k - 1, venc, valor, juros, amort: r2(valor - juros), saldo: B, pago: 0 });
  }
  return { pmt, n: parcelas.length, parcelas };
}

// Proposta completa (tela, PDF e gravação). Depois de aceito, o débito fica congelado no acordo.
function calcularAcordo(ct, a) {
  const deb = a.situacao === 'proposta' || !a.debito ? debitoAcordo(ct, a) : a.debito;
  const neg = negociacao(a, deb);
  const p = a.parcelamento || {};
  const i = (Number(p.taxa) || 0) / 100;
  const f1 = p.jurosAte1 === false ? 1 : fatorPeriodo(i, a.data, p.primeiroVenc);
  const plano = neg.saldo > 0 ? planoPrice({ saldo: neg.saldo, taxa: p.taxa, f1, primeiroVenc: p.primeiroVenc, modo: p.modo, prazo: p.prazo, parcela: p.parcela }) : { pmt: 0, n: 0, parcelas: [] };
  const totalParcelas = somar(plano.parcelas, x => x.valor), totalJuros = somar(plano.parcelas, x => x.juros);
  // Rateio: parte dos honorários advocatícios no valor negociado, depois do desconto
  const descDe = k => a.desconto?.modo === 'itens' ? neg.descItens[k] || 0 : deb.total ? neg.desconto * (deb.comp[k] || 0) / deb.total : 0;
  const honNeg = r2(COMP_HONORARIOS.reduce((s, k) => s + (deb.comp[k] || 0) - descDe(k), 0));
  const propHon = neg.negociado > 0 ? Math.max(0, Math.min(1, honNeg / neg.negociado)) : 0;
  return { deb, ...neg, plano, f1, totalParcelas, totalJuros, totalAcordo: r2(neg.sinal + totalParcelas), honNeg, propHon };
}

// Divide um valor entre o locador e os honorários advocatícios, na proporção do débito negociado
function rateio(valor, propHon) {
  const hon = r2(valor * propHon);
  return { hon, locador: r2(valor - hon) };
}

/* ================= Acompanhamento ================= */
const parcelasDoAcordo = a => [...(a.sinalParcela ? [a.sinalParcela] : []), ...(a.plano || [])];
const restanteNominal = p => r2(Math.max(0, p.valor - (p.pago || 0)));
const indiceAcordo = a => a.parcelamento?.indice || 'Nenhum';
const fatorAcordo = (a, ate) => fatorCorrecao(indiceAcordo(a), a.data.slice(0, 7), ate.slice(0, 7), !!D.config?.moratorios?.ignorarNegativos);

// Valor devido de uma parcela (ou do restante dela) numa data: correção desde o acordo e, se em atraso, juros e multa
function devidoParcela(a, p, data) {
  const base = restanteNominal(p);
  const { fator, faltando } = fatorAcordo(a, data);
  const corrigido = r2(base * fator);
  const dias = Math.max(0, diasEntre(p.venc, data));
  const enc = a.encargos || {};
  const juros = dias ? r2(corrigido * (Number(enc.juros) || 0) / 100 / 30 * dias) : 0;
  const multa = dias ? r2(corrigido * (Number(enc.multa) || 0) / 100) : 0;
  return { base, fator, corrigido, dias, juros, multa, total: r2(corrigido + juros + multa), faltando };
}

// Saldo das parcelas futuras numa data (principal da Price + juros do período corrido)
function saldoFuturo(a, data) {
  const plano = a.plano || [];
  const vencidas = plano.filter(p => p.venc <= data);
  const futurasTodas = plano.filter(p => p.venc > data);
  const futuras = futurasTodas.filter(p => restanteNominal(p) > 0);
  if (!futuras.length) return { saldo: 0, ref: data, futuras };
  const ult = vencidas[vencidas.length - 1];
  const i = (Number(a.parcelamento?.taxa) || 0) / 100;
  const B = ult ? ult.saldo : a.saldoInicial;
  const ref = ult ? ult.venc : a.data;
  const f = !ult && a.parcelamento?.jurosAte1 === false ? 1 : fatorPeriodo(i, ref, data);
  const pagoFuturo = somar(futurasTodas, p => p.pago || 0);
  return { saldo: r2(Math.max(0, B * f - pagoFuturo)), ref, futuras, B };
}

// Quitação numa data: parcelas vencidas em aberto, com encargos, mais o saldo futuro corrigido
function valorQuitacao(a, data) {
  const vencidas = parcelasDoAcordo(a).filter(p => p.venc <= data && restanteNominal(p) > 0).map(p => ({ p, d: devidoParcela(a, p, data) }));
  const sf = saldoFuturo(a, data);
  const { fator } = fatorAcordo(a, data);
  const futuroCorrigido = r2(sf.saldo * fator);
  return { vencidas, totalVencidas: somar(vencidas, x => x.d.total), saldoFuturo: sf.saldo, fator, futuroCorrigido, total: r2(somar(vencidas, x => x.d.total) + futuroCorrigido) };
}

// Descumprimento: vencimento antecipado do saldo do acordo ou perda do desconto (débito original menos pagamentos)
function valorDescumprimento(ct, a, data, modo, multaPct) {
  const pagamentos = (a.eventos || []).filter(e => e.valor > 0 && ['pagamento', 'amortizacao'].includes(e.tipo));
  if (modo === 'original') {
    const deb = debitoAcordo(ct, a, data);
    const pags = pagamentos.map(e => { const { fator } = fatorCorrecao(deb.indice, e.data.slice(0, 7), data.slice(0, 7), !!D.config?.moratorios?.ignorarNegativos); return { e, fator, corrigido: r2(e.valor * fator) }; });
    const abatido = somar(pags, x => x.corrigido);
    const base = r2(Math.max(0, deb.total - abatido));
    const multa = r2(base * (Number(multaPct) || 0) / 100);
    return { modo, deb, pags, abatido, base, multa, total: r2(base + multa) };
  }
  const q = valorQuitacao(a, data);
  const multa = r2(q.total * (Number(multaPct) || 0) / 100);
  return { modo: 'saldo', q, base: q.total, multa, total: r2(q.total + multa) };
}

/* ---------- Lançamentos (cada um guarda o estado anterior para poder desfazer) ---------- */
function novoEvento(a, ev) {
  a.eventos = a.eventos || [];
  ev.id = novoId(); ev.em = new Date().toISOString(); ev.por = usuario();
  ev.antes = JSON.stringify({ plano: a.plano, sinalParcela: a.sinalParcela, situacao: a.situacao });
  a.eventos.push(ev);
  return ev;
}

// prestacao: { lancar, data, valor, taxa } — lançamento na prestação de contas do locador
function lancarPagamento(a, { n, data, valor, obs, prestacao }) {
  const p = parcelasDoAcordo(a).find(x => x.n === n);
  if (!p) throw new Error('Parcela não encontrada.');
  if (!ehData(data)) throw new Error('Informe a data do pagamento.');
  valor = r2(Number(valor) || 0);
  if (!(valor > 0)) throw new Error('Informe o valor pago.');
  const d = devidoParcela(a, p, data);
  if (valor > d.total + 0.009) throw new Error(`O valor pago é maior que o devido nesta parcela (${fmtMoeda(d.total)}). Lance a diferença como amortização antecipada.`);
  const ev = novoEvento(a, { tipo: 'pagamento', parcela: n, data, valor, obs, devido: d.total, prestacao });
  const nominal = valor >= d.total - 0.009 ? d.base : r2(valor * d.base / d.total);
  p.pago = r2((p.pago || 0) + nominal);
  ev.nominal = nominal;
  atualizarSituacao(a);
}

function lancarAmortizacao(a, { data, valor, efeito, obs, prestacao }) {
  if (!ehData(data)) throw new Error('Informe a data da amortização.');
  valor = r2(Number(valor) || 0);
  if (!(valor > 0)) throw new Error('Informe o valor.');
  const atrasadas = parcelasDoAcordo(a).filter(p => p.venc <= data && restanteNominal(p) > 0);
  if (atrasadas.length) throw new Error(`Há parcela(s) vencida(s) em aberto (${atrasadas.map(p => p.n || 'sinal').join(', ')}). Registre esses pagamentos antes da amortização.`);
  const sf = saldoFuturo(a, data);
  if (!sf.futuras.length) throw new Error('Não há parcelas futuras para amortizar.');
  if (sf.futuras[0].pago > 0) throw new Error(`A parcela ${sf.futuras[0].n} foi paga em parte. Complete o pagamento dela antes da amortização.`);
  const { fator } = fatorAcordo(a, data);
  const nominal = r2(valor / fator);
  if (nominal >= sf.saldo - 0.009) throw new Error(`O valor quita o acordo. Use "Quitar o acordo" (valor para quitação: ${fmtMoeda(r2(sf.saldo * fator))}).`);
  const novoSaldo = r2(sf.saldo - nominal);
  const i = (Number(a.parcelamento?.taxa) || 0) / 100;
  const prox = sf.futuras[0];
  const f1 = a.parcelamento?.jurosAte1 === false && !a.plano.some(p => p.venc <= data) ? 1 : fatorPeriodo(i, data, prox.venc);
  const novo = planoPrice({ saldo: novoSaldo, taxa: a.parcelamento?.taxa, f1, primeiroVenc: prox.venc, numeroInicial: prox.n,
    ...(efeito === 'parcela' ? { modo: 'prazo', prazo: sf.futuras.length } : { modo: 'parcela', parcela: prox.valor }) });
  const ev = novoEvento(a, { tipo: 'amortizacao', data, valor, obs, efeito, nominal, saldoAntes: sf.saldo, saldoDepois: novoSaldo, prestacao });
  a.plano = [...a.plano.filter(p => p.venc <= data || (restanteNominal(p) <= 0 && p.n < prox.n)), ...novo.parcelas];
  ev.resumo = efeito === 'parcela' ? `${novo.n} parcela(s) de ${fmtMoeda(novo.pmt)}` : `${novo.n} parcela(s) restante(s)`;
}

function lancarQuitacao(a, { data, valor, obs, prestacao }) {
  if (!ehData(data)) throw new Error('Informe a data da quitação.');
  const q = valorQuitacao(a, data);
  valor = r2(Number(valor) || 0);
  if (valor < q.total - 0.009) throw new Error(`O valor para quitação em ${fmtData(data)} é ${fmtMoeda(q.total)}.`);
  novoEvento(a, { tipo: 'quitacao', data, valor, obs, devido: q.total, prestacao });
  for (const p of parcelasDoAcordo(a)) p.pago = p.valor;
  a.situacao = 'quitado';
}

function lancarDescumprimento(ct, a, { data, modo, multa, obs }) {
  if (!ehData(data)) throw new Error('Informe a data do descumprimento.');
  const r = valorDescumprimento(ct, a, data, modo, multa);
  novoEvento(a, { tipo: 'descumprimento', data, valor: 0, modo, multa: Number(multa) || 0, obs, devido: r.total });
  a.situacao = 'descumprido';
}

function desfazerUltimo(a) {
  const ev = (a.eventos || []).pop();
  if (!ev) throw new Error('Não há lançamentos para desfazer.');
  const antes = JSON.parse(ev.antes);
  a.plano = antes.plano; a.sinalParcela = antes.sinalParcela; a.situacao = antes.situacao;
  return ev;
}

function atualizarSituacao(a) {
  if (a.situacao === 'aceito' && parcelasDoAcordo(a).every(p => restanteNominal(p) <= 0)) a.situacao = 'quitado';
}

const descEvento = e => ({
  pagamento: `Pagamento da ${e.parcela ? 'parcela ' + e.parcela : 'entrada (sinal)'}`,
  amortizacao: `Amortização antecipada (${e.efeito === 'parcela' ? 'reduz a parcela' : 'reduz o prazo'})${e.resumo ? ': ' + e.resumo : ''}`,
  quitacao: 'Quitação do acordo',
  descumprimento: `Descumprimento (${e.modo === 'original' ? 'perda do desconto' : 'vencimento antecipado do saldo'})`,
}[e.tipo] || e.tipo);

// Pagamentos de acordos lançados na prestação de contas do locador (usado por recebimentosLancados)
function recebimentosDeAcordos(ct) {
  const out = [];
  for (const a of acordosDoContrato(ct.id)) {
    for (const e of a.eventos || []) {
      const p = e.prestacao;
      if (!p?.lancar || !ehData(p.data) || !(e.valor > 0)) continue;
      out.push({ a, e, data: p.data, valor: p.valor === '' || p.valor === undefined || p.valor === null ? e.valor : Number(p.valor), taxa: p.taxa !== false });
    }
  }
  return out;
}
