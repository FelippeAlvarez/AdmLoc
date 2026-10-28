'use strict';
/*
  Cálculo do débito de um contrato (cobrança extrajudicial ou judicial), com o motor de motor.js.

  Arquivo calculos/<contrato>.json:
  - amortizacoes: pagamentos de débitos em atraso do contrato (valem para todos os cálculos dele e para a Inadimplência);
    cada um pode ser lançado na prestação de contas do locador na data em que o valor fica disponível
    (ex.: depósito judicial, só após o levantamento);
  - calculos: { id: cálculo } — critérios (os do contrato, editáveis), meses incluídos, outros débitos, custas,
    honorários, multas processuais e art. 523 do CPC; reabertos e atualizados para qualquer data.

  Os meses em aberto vêm do extrato (valor devido do mês, desde o vencimento). Pagamento em parte lançado no mês entra
  como amortização na data do pagamento, imputada primeiro nos juros e na multa (CC, art. 354); pago até o vencimento,
  no principal.
*/

/* ================= Dados ================= */
const calcsVazio = cid => ({ contratoId: cid, rev: 0, amortizacoes: [], calculos: {}, acordos: {} });

// validade (ms): reaproveita o que foi lido há menos tempo que isso (painel e relatórios leem todos os contratos);
// as telas de cálculo e de acordos sempre releem (validade 0)
const calcsLidosEm = {};
let listaCalculos = null; // { em, nomes: Promise<Set> } — lista da pasta "calculos" no Dropbox (vale 2 minutos)
function calculosExistentes() {
  if (!listaCalculos || Date.now() - listaCalculos.em > 120000) {
    listaCalculos = { em: Date.now(), nomes: NuvemDropbox.listar('calculos').then(l => new Set(l)).catch(e => { listaCalculos = null; throw e; }) };
  }
  return listaCalculos.nomes;
}
async function carregarCalculos(cid, validade = 0) {
  if (validade && D.calcs[cid] && Date.now() - (calcsLidosEm[cid] || 0) < validade) return D.calcs[cid];
  // No Dropbox, uma consulta à pasta "calculos" evita um pedido por contrato sem cálculo (a maioria)
  let a = null;
  if (Armaz.modo === 'dropbox' && validade) {
    const existentes = await calculosExistentes();
    if (existentes.has(`${cid}.json`)) a = await lerJSON(`calculos/${cid}.json`, null);
  } else a = await lerJSON(`calculos/${cid}.json`, null);
  D.calcs[cid] = { ...calcsVazio(cid), ...(a || {}) };
  calcsLidosEm[cid] = Date.now();
  return D.calcs[cid];
}

// Gravação relendo o arquivo (outro computador pode ter alterado): "mudar" recebe o arquivo atual e o altera
async function gravarCalculos(cid, mudar) {
  await backupDiario();
  return comTrava(async () => {
    const atual = { ...calcsVazio(cid), ...((await lerJSON(`calculos/${cid}.json`, null)) || {}) };
    if ((atual.rev || 0) !== (D.calcs[cid]?.rev || 0)) {
      D.calcs[cid] = atual;
      throw new ErroConflito('Os cálculos deste contrato foram alterados em outro computador. Eles foram recarregados: confira e refaça a alteração.');
    }
    mudar(atual);
    atual.rev = (atual.rev || 0) + 1;
    atual.atualizadoEm = new Date().toISOString();
    atual.atualizadoPor = usuario();
    await Armaz.gravar(`calculos/${cid}.json`, JSON.stringify(atual, null, 1));
    D.calcs[cid] = atual;
    calcsLidosEm[cid] = Date.now();
    listaCalculos = null; // a pasta "calculos" pode ter ganhado um arquivo
  });
}

// Critérios do contrato no formato do motor (índice, juros ao mês pro rata die e multa)
function critDoContrato(ct) {
  const p = paramsMora(ct);
  return { indice: p.indice, juros: 'mensal', taxa: p.juros, capitalizar: false, lei14905: false, multa: p.multa };
}

function novoCalculo(ct, tipo = 'extrajudicial') {
  return {
    id: novoId(), nome: tipo === 'judicial' ? 'Cobrança judicial' : 'Cobrança extrajudicial', tipo, dataCalc: hoje(),
    processo: { numero: '', juizo: '', ajuizamento: '', citacao: '' },
    crit: critDoContrato(ct), fora: [], extras: [], custas: [], honContr: paramsMora(ct).honorarios,
    honorarios: [], multas: [], valorCausa: { valor: '', data: '' },
    art523: { aplicar: false, multa: 10, honorarios: 10, baseHonorarios: false, baseCustas: true, baseMultas: false },
  };
}

/*
  Meses vencidos e não pagos (ou pagos em parte) do contrato até a data, com o valor devido do mês.
  inclusive: também os que vencem na própria data e, se ainda não lançados no extrato, os meses seguintes que vencem
  até ela, pelo aluguel e encargos do contrato (emenda da mora: "aluguéis que vencerem até a sua efetivação").
*/
function mesesEmAberto(ct, data, inclusive = false) {
  const ext = D.extratos[ct.id];
  if (!ext) return [];
  const lista = calcularExtrato(ct, ext).map(x => {
    const venc = vencimentoMes(ct, x.ym, x.mes), r = recebimentoMes(x.mes);
    return { ym: x.ym, mes: x.mes, venc, devido: x.c.devido, sit: x.c.situacao, pagoParcial: r.principal + r.encargos };
  }).filter(m => m.sit !== 'pago' && m.devido > 0 && (inclusive ? m.venc <= data : m.venc < data));
  if (inclusive) {
    const yms = Object.keys(ext.meses).sort();
    const devido = r2(linhasDoContrato(ct).reduce((s, l) => s + (Number(l.cobrado) || 0), 0));
    for (let ym = yms.length ? addMes(yms[yms.length - 1], 1) : inicioControle(ct); ; ym = addMes(ym, 1)) {
      const venc = vencimentoMes(ct, ym, null);
      if (venc > data || ym > addMes(data.slice(0, 7), 1)) break;
      if (devido > 0) lista.push({ ym, mes: {}, venc, devido, sit: 'projetado', pagoParcial: 0 });
    }
  }
  return lista;
}

// Finalidade do cálculo judicial
const FINALIDADES = {
  geral: 'Cálculo judicial',
  inicial: 'Petição inicial: despejo cumulado com cobrança (Lei 8.245/91, art. 62, I)',
  purga: 'Emenda (purga) da mora (Lei 8.245/91, art. 62, II)',
};
const ehPurga = calc => calc.tipo === 'judicial' && calc.finalidade === 'purga';

/*
  Rubricas cobradas do locatário num mês (centavos), somadas por nome. Os descontos abatem as rubricas de locação;
  os reembolsos, as demais; o total confere com o devido do mês. Meses ainda não lançados: rubricas do contrato.
*/
function rubricasDoMes(m, ct) {
  const linhas = (m.mes?.linhas?.length ? m.mes.linhas : linhasDoContrato(ct)).filter(l => cent(l.cobrado) > 0);
  const mapa = new Map();
  for (const l of linhas) {
    const nome = String(l.rubrica || 'Outros').trim() || 'Outros';
    const chave = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'outros';
    const x = mapa.get(chave) || { chave, nome, locacao: false, v: 0 };
    x.v += cent(l.cobrado);
    x.locacao = x.locacao || !!l.locacao;
    mapa.set(chave, x);
  }
  const lista = [...mapa.values()];
  let desc = 0, reemb = 0;
  for (const a of m.mes?.ajustes || []) { if (a.tipo === 'reembolso') reemb += cent(a.valor); else desc += cent(a.valor); }
  const abater = (alvo, x) => { for (const r of alvo) { const t = Math.min(r.v, x); r.v -= t; x -= t; } return x; };
  let sobra = abater(lista.filter(r => r.locacao), desc);
  sobra = abater(lista.filter(r => !r.locacao), sobra + reemb);
  abater(lista, sobra);
  return lista.filter(r => r.v > 0);
}

// Totais por rubrica (cálculo com as rubricas em separado)
function resumoRubricas(r) {
  const series = (r.c.series || []).filter(s => String(s.id).startsWith('rub:'));
  return series.map(s => {
    const its = r.itens.filter(it => it.serie === s.id);
    const soma = k => its.reduce((t, it) => t + cent(it[k]), 0) / 100;
    return { nome: s.descricao, locacao: s.locacao, meses: its.length, original: soma('original'), principal: soma('principal'), juros: soma('juros'), multa: soma('multa'), total: soma('total') };
  }).filter(x => x.meses);
}

const nomeFormaAmort = { pagamento: 'Pagamento', deposito: 'Depósito judicial', levantamento: 'Levantamento (alvará)', acordo: 'Parcela de acordo', outro: 'Outro' };

/*
  Entrada do motor para um contrato e um cálculo: os meses em aberto viram uma série mensal (correção e juros desde
  cada vencimento, multa contratual), os outros débitos viram rubricas e os pagamentos (parciais dos meses e os
  registrados no cálculo) viram amortizações.
*/
function entradaMotor(ct, calc, data, acordoId) {
  const crit = calc.crit || critDoContrato(ct), fora = new Set(calc.fora || []);
  const purga = ehPurga(calc);
  // Meses incluídos em acordos (em andamento ou quitados) ficam de fora, salvo os do próprio acordo em análise
  const emAcordo = mesesEmAcordo(ct.id), doAcordo = new Set(D.calcs?.[ct.id]?.acordos?.[acordoId]?.meses || []);
  const meses = mesesEmAberto(ct, data, purga).filter(m => !fora.has(m.ym) && (!emAcordo.has(m.ym) || doAcordo.has(m.ym)));
  const amort = [];
  for (const m of meses) {
    if (m.sit !== 'parcial' || !m.pagoParcial) continue;
    const dt = m.mes.recebidoEm || m.venc;
    amort.push({ id: 'mes-' + m.ym, auto: true, data: dt, valor: r2(m.pagoParcial / 100), imputacao: dt <= m.venc ? 'principal' : 'juros',
      destino: m.ym, forma: 'pagamento', obs: `pagamento em parte de ${mesNum(m.ym)}, lançado no mês` });
  }
  for (const a of D.calcs?.[ct.id]?.amortizacoes || []) {
    if (!(Number(a.valor) > 0) || !ehData(a.data)) continue;
    const dest = String(a.destino || 'antigas');
    amort.push({ ...a, destino: dest.startsWith('mes:') ? dest.slice(4) : dest });
  }
  const judicial = calc.tipo === 'judicial', multa = Number(crit.multa) || 0;
  const vencidos = meses.filter(m => m.venc < data);
  // Rubricas em separado (aluguel, condomínio, IPTU…): uma série por rubrica; ou tudo aglutinado, uma linha por mês
  let series;
  if (calc.porRubrica !== false) {
    const porChave = new Map();
    for (const m of vencidos) {
      for (const rb of rubricasDoMes(m, ct)) {
        let s = porChave.get(rb.chave);
        if (!s) porChave.set(rb.chave, s = { id: 'rub:' + rb.chave, descricao: rb.nome, locacao: rb.locacao, crit, multa, juros: 'vencimento', meses: [] });
        s.meses.push({ id: `${m.ym}|${rb.chave}`, competencia: m.ym, vencimento: m.venc, valor: rb.v / 100 });
      }
    }
    series = [...porChave.values()].sort((a, b) => Number(b.locacao) - Number(a.locacao));
  } else series = [{ id: 'alugueis', descricao: 'Aluguel e encargos', crit, multa, juros: 'vencimento',
    meses: vencidos.map(m => ({ id: m.ym, competencia: m.ym, vencimento: m.venc, valor: m.devido })) }];
  return {
    tipo: judicial ? 'judicial' : 'extrajudicial', crit, series,
    rubricas: [
      // Emenda da mora: aluguel que vence na data do depósito entra pelo valor, sem multa nem juros (ainda não está em mora)
      ...meses.filter(m => m.venc >= data).map(m => ({ id: m.ym, descricao: `Aluguel e encargos ${mesNum(m.ym)} (vence em ${fmtData(m.venc)})`,
        valor: m.devido, data: m.venc, corrDesde: '', jurosDesde: '', multa: 0 })),
      ...(calc.extras || []).filter(x => Number(x.valor) > 0 && ehData(x.vencimento)).map(x => ({ id: x.id, descricao: x.descricao || 'Outro débito',
        valor: Number(x.valor), corrDesde: x.vencimento, jurosDesde: x.juros === false ? '' : x.vencimento, multa: x.multa === false ? 0 : Number(crit.multa) || 0 })),
    ],
    custas: (calc.custas || []).filter(x => Number(x.valor) > 0 && ehData(x.data)),
    // Emenda da mora: só aluguéis e acessórios, multa, juros, custas e honorários de 10% (ou os do contrato)
    honorarios: judicial && !purga ? calc.honorarios || [] : [],
    multas: judicial && !purga ? calc.multas || [] : [],
    valorCausa: calc.valorCausa || {},
    art523: judicial && !purga ? calc.art523 : null,
    honContr: judicial ? 0 : Number(calc.honContr) || 0,
    amortizacoes: amort,
  };
}

function calcularContrato(ct, calc, data, acordoId) {
  const r = calcular(entradaMotor(ct, calc, data, acordoId), data);
  r.finalidade = calc.tipo === 'judicial' ? calc.finalidade || 'geral' : '';
  if (ehPurga(calc)) {
    // Art. 62, II, "d": honorários do advogado do locador sobre o montante devido (aluguéis, acessórios, multa e juros)
    const pct = calc.honPurga === undefined || calc.honPurga === '' ? 10 : Number(calc.honPurga) || 0;
    const base = r.grupos.find(g => g.grupo === 'rubrica')?.total || 0;
    r.pctContr = pct;
    r.baseHon = base;
    r.honContr = r2(base * pct / 100);
    r.total = r2(r.subtotal + r.honContr);
    r.projetados = mesesEmAberto(ct, data, true).filter(m => m.sit === 'projetado' && !(calc.fora || []).includes(m.ym)).map(m => m.ym);
  }
  // Ação de despejo cumulada com cobrança: valor da causa = débito + 12 × a última locação com encargos
  // (Lei 8.245/91, art. 58, III: doze meses de aluguel; CPC, art. 292, VI: soma dos pedidos cumulados)
  if (calc.tipo === 'judicial' && calc.finalidade === 'inicial') {
    const u = ultimaLocacao(ct, data);
    r.valorCausaDespejo = { debito: r.total, mensal: u.valor, ref: u.ym, doze: r2(u.valor * 12), total: r2(r.total + u.valor * 12) };
  }
  r.porRubrica = calc.porRubrica !== false;
  return r;
}

// Última locação com encargos: valor cobrado no último mês lançado até a data (ou, sem meses, o do contrato)
function ultimaLocacao(ct, data) {
  const ext = D.extratos[ct.id];
  const cad = ext ? calcularExtrato(ct, ext).filter(x => x.ym <= data.slice(0, 7) && x.c.cobrado > 0) : [];
  const ult = cad[cad.length - 1];
  if (ult) return { ym: ult.ym, valor: r2(ult.c.cobrado) };
  return { ym: '', valor: r2(linhasDoContrato(ct).reduce((s, l) => s + (Number(l.cobrado) || 0), 0)) };
}

const rotuloHon = r => r.finalidade === 'purga' ? 'Honorários do advogado do locador (art. 62, II, d)' : 'Honorários advocatícios contratuais';
const tituloDebito = calc => calc.tipo !== 'judicial' ? 'Demonstrativo de débito'
  : calc.finalidade === 'purga' ? 'Valor para emenda da mora (Lei 8.245/91, art. 62, II)'
  : calc.finalidade === 'inicial' ? 'Cálculo discriminado do débito (Lei 8.245/91, art. 62, I)'
  : 'Demonstrativo discriminado e atualizado do crédito';

// Notas do resultado (motor + emenda da mora)
function notasDebito(r) {
  const n = notasCalculo(r);
  if (r.finalidade === 'purga') {
    n.unshift('Valor para depósito judicial em ' + fmtData(r.dataCalc) + ', nos termos do art. 62, II, da Lei 8.245/91: aluguéis e acessórios vencidos e os que vencem até o depósito, multa contratual, juros de mora, custas e honorários do advogado do locador (' + fmtPct(r.pctContr) + '% sobre o montante devido).');
    if (r.projetados?.length) n.push('Incluído(s) pelo valor do contrato, por ainda não estar(em) lançado(s) no aplicativo: ' + r.projetados.map(mesNum).join(', ') + '.');
    n.push('A emenda da mora não é admitida se o locatário já a utilizou nos 24 meses anteriores à propositura da ação (art. 62, parágrafo único).');
  }
  return n;
}

// Débito de cada mês em aberto, atualizado pelos critérios do contrato e já abatidos os pagamentos (Inadimplência)
function debitoPorMes(ct, data) {
  const r = calcularContrato(ct, { ...novoCalculo(ct), honContr: 0, porRubrica: false }, data);
  return r.itens.filter(it => it.serie === 'alugueis' && it.total > 0.004).map(it => {
    const m = mesesEmAberto(ct, data).find(x => x.ym === it.itemId);
    const aberto = r2(it.parcelas.reduce((s, u) => s + u.Pb, 0));
    return { ct, ym: it.itemId, mes: m?.mes, venc: m?.venc || it.data, sit: m?.sit, valor: aberto, dias: it.dias, total: it.total, faltando: r.faltando };
  });
}
