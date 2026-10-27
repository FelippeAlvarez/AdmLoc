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
const calcsVazio = cid => ({ contratoId: cid, rev: 0, amortizacoes: [], calculos: {} });

async function carregarCalculos(cid) {
  const a = await lerJSON(`calculos/${cid}.json`, null);
  D.calcs[cid] = { ...calcsVazio(cid), ...(a || {}) };
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

// Meses vencidos e não pagos (ou pagos em parte) do contrato até a data, com o valor devido do mês
function mesesEmAberto(ct, data) {
  const ext = D.extratos[ct.id];
  if (!ext) return [];
  return calcularExtrato(ct, ext).map(x => {
    const venc = vencimentoMes(ct, x.ym, x.mes), r = recebimentoMes(x.mes);
    return { ym: x.ym, mes: x.mes, venc, devido: x.c.devido, sit: x.c.situacao, pagoParcial: r.principal + r.encargos };
  }).filter(m => m.sit !== 'pago' && m.devido > 0 && m.venc < data);
}

const nomeFormaAmort = { pagamento: 'Pagamento', deposito: 'Depósito judicial', levantamento: 'Levantamento (alvará)', acordo: 'Parcela de acordo', outro: 'Outro' };

/*
  Entrada do motor para um contrato e um cálculo: os meses em aberto viram uma série mensal (correção e juros desde
  cada vencimento, multa contratual), os outros débitos viram rubricas e os pagamentos (parciais dos meses e os
  registrados no cálculo) viram amortizações.
*/
function entradaMotor(ct, calc, data) {
  const crit = calc.crit || critDoContrato(ct), fora = new Set(calc.fora || []);
  const meses = mesesEmAberto(ct, data).filter(m => !fora.has(m.ym));
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
  const judicial = calc.tipo === 'judicial';
  return {
    tipo: judicial ? 'judicial' : 'extrajudicial', crit,
    series: [{ id: 'alugueis', descricao: 'Aluguel e encargos', crit, multa: Number(crit.multa) || 0, juros: 'vencimento',
      meses: meses.map(m => ({ id: m.ym, competencia: m.ym, vencimento: m.venc, valor: m.devido })) }],
    rubricas: (calc.extras || []).filter(x => Number(x.valor) > 0 && ehData(x.vencimento)).map(x => ({ id: x.id, descricao: x.descricao || 'Outro débito',
      valor: Number(x.valor), corrDesde: x.vencimento, jurosDesde: x.juros === false ? '' : x.vencimento, multa: x.multa === false ? 0 : Number(crit.multa) || 0 })),
    custas: (calc.custas || []).filter(x => Number(x.valor) > 0 && ehData(x.data)),
    honorarios: judicial ? calc.honorarios || [] : [],
    multas: judicial ? calc.multas || [] : [],
    valorCausa: calc.valorCausa || {},
    art523: judicial ? calc.art523 : null,
    honContr: judicial ? 0 : Number(calc.honContr) || 0,
    amortizacoes: amort,
  };
}

const calcularContrato = (ct, calc, data) => calcular(entradaMotor(ct, calc, data), data);

// Débito de cada mês em aberto, atualizado pelos critérios do contrato e já abatidos os pagamentos (Inadimplência)
function debitoPorMes(ct, data) {
  const r = calcularContrato(ct, { ...novoCalculo(ct), honContr: 0 }, data);
  return r.itens.filter(it => it.serie === 'alugueis' && it.total > 0.004).map(it => {
    const m = mesesEmAberto(ct, data).find(x => x.ym === it.itemId);
    const aberto = r2(it.parcelas.reduce((s, u) => s + u.Pb, 0));
    return { ct, ym: it.itemId, mes: m?.mes, venc: m?.venc || it.data, sit: m?.sit, valor: aberto, dias: it.dias, total: it.total, faltando: r.faltando };
  });
}
