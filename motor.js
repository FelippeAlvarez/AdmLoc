'use strict';
/*
  Motor de cálculo de débitos (o mesmo do aplicativo Cálculos de Cobrança, adaptado aos contratos de locação).

  Cada item do cálculo (mês de aluguel em aberto, outro débito, custa, honorário, multa processual, multa e honorários
  do art. 523 do CPC) vira uma ou mais "parcelas" com regras próprias:
  - correção monetária desde o termo inicial (corrDesde), pelo índice do regime em vigor em cada período;
  - juros de mora desde o termo inicial (jurosDesde), pela taxa do regime em vigor em cada período
    (percentual ao mês pro rata die, taxa legal do art. 406 do CC, SELIC ou sem juros), simples ou capitalizados;
  - multa contratual (cláusula penal), percentual sobre o valor originário corrigido.

  Os saldos de cada parcela ficam em "unidades da data-base" (valor ÷ fator de correção): principal (Pb), juros (Jb)
  e multa (Mb). Assim os juros incidem sobre o valor corrigido (juros simples) e os juros vencidos e não pagos são
  corrigidos, mas não rendem juros (salvo capitalização). Na data do cálculo, saldo = (Pb + Jb + Mb) × fator.

  Amortizações: o débito é atualizado até a data do pagamento, o valor é imputado (juros e multa primeiro, art. 354
  do CC, ou principal primeiro) nos itens escolhidos, e o saldo segue sendo atualizado.

  Art. 523, § 1º, do CPC: multa e honorários de 10% sobre o débito atualizado até a data do cálculo; só os pagamentos
  feitos no prazo reduzem a base (§ 2º).
*/

const ehData = s => /^(19|20)\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s || '');
const ultimoDia = ym => { const [a, m] = ym.split('-').map(Number); return new Date(Date.UTC(a, m, 0)).getUTCDate(); };
const TIPOS_JUROS = {
  mensal: 'Percentual ao mês (pro rata die)',
  legal: 'Taxa legal (art. 406 do CC)',
  selic: 'SELIC (engloba correção e juros)',
  nenhum: 'Sem juros',
};
const GRUPOS = {
  rubrica: 'Aluguéis, encargos e outros débitos', custas: 'Custas e despesas', honorarios: 'Honorários advocatícios sucumbenciais',
  multa: 'Multas processuais', art523: 'Art. 523, § 1º, do CPC',
};
const ORDEM_GRUPOS = ['rubrica', 'multa', 'custas', 'honorarios', 'art523'];
const TIPOS_MULTA = {
  litigancia: 'Multa por litigância de má-fé (art. 81 do CPC)', embargos: 'Multa por embargos protelatórios (art. 1.026, § 2º, do CPC)',
  agravo: 'Multa do agravo interno (art. 1.021, § 4º, do CPC)', atentatorio: 'Multa por ato atentatório à dignidade da justiça (art. 77, § 2º, do CPC)',
  astreintes: 'Multa cominatória (astreintes)', outra: 'Outra multa',
};

const vazioMotor = x => x === null || x === undefined || x === '';
const DATA_LEI_14905 = '2024-08-30';

const ordenarRegimes = regs => [...(regs || [])].sort((a, b) => comparar(a.desde || '', b.desde || ''));

/* ---------- Correção monetária ---------- */
// Mês a partir do qual vale um regime que começa em "data": se não começar no dia 1º, o próprio mês fica no regime anterior
const mesLimite = data => data.slice(8) === '01' ? data.slice(0, 7) : addMes(data.slice(0, 7), 1);

// Fator de um trecho [a, b) com um índice: IGP-M, IPCA etc. acumulam os meses; UFIR-RJ divide os valores anuais
function fatorTrecho(indice, a, b, mesA, mesB, faltando, ignorarNegativos) {
  if (!indice || indice === 'Nenhum') return 1;
  if (indice === 'UFIR-RJ') {
    const t = tabelaUfir(), a0 = +a.slice(0, 4);
    let a1 = +b.slice(0, 4);
    if (a1 <= a0) return 1;
    if (!t[a0]) { faltando.add(String(a0)); return 1; }
    if (!t[a1]) { faltando.add(String(a1)); while (a1 > a0 && !t[a1]) a1--; }
    return t[a1] / t[a0];
  }
  const serie = D.indices?.series?.[indice] || {};
  let f = 1;
  for (let m = mesA; m < mesB; m = addMes(m, 1)) {
    const v = serie[m];
    if (v === undefined || v === null) { faltando.add(indice + ' ' + mesNum(m)); continue; }
    if (ignorarNegativos && v < 0) continue;
    f *= 1 + v / 100;
  }
  return f;
}

// Fator de correção da parcela entre o termo inicial da correção e a data t (os regimes mudam o índice no tempo)
function fatorParcela(u, t, faltando) {
  if (!u.corrDesde || !t || t <= u.corrDesde) return 1;
  const regs = u.regimes, ign = !!D.config?.moratorios?.ignorarNegativos;
  let f = 1;
  for (let k = 0; k < regs.length; k++) {
    const r = regs[k], prox = regs[k + 1]?.desde;
    const a = r.desde && r.desde > u.corrDesde ? r.desde : u.corrDesde;
    const b = prox && prox < t ? prox : t;
    if (a >= b || r.juros === 'selic') continue;
    const mesA = a === u.corrDesde ? a.slice(0, 7) : mesLimite(a);
    const mesB = b === t ? t.slice(0, 7) : mesLimite(b);
    f *= fatorTrecho(r.indice, a, b, mesA, mesB, faltando, ign);
  }
  return Math.round(f * 1e8) / 1e8;
}

/* ---------- Juros ---------- */
const diasNoMes = ym => ultimoDia(ym);
const SERIE_JUROS = { legal: 'Taxa legal', selic: 'SELIC' };

// Taxa mensal (%) de uma série de juros; meses ainda não divulgados usam a última taxa conhecida (com aviso)
function taxaMes(nome, ym, faltando, estimados) {
  const s = D.indices?.series?.[nome] || {};
  if (s[ym] !== undefined && s[ym] !== null) return nome === 'Taxa legal' ? Math.max(0, s[ym]) : s[ym];
  const meses = Object.keys(s).sort();
  const ult = meses[meses.length - 1];
  if (ult && ym > ult) { estimados.add(`${nome} ${mesNum(ym)} (usada a de ${mesNum(ult)})`); return nome === 'Taxa legal' ? Math.max(0, s[ult]) : s[ult]; }
  faltando.add(nome + ' ' + mesNum(ym));
  return 0;
}

/*
  Trechos de juros entre as datas a e b (a < b), já limitados ao termo inicial dos juros.
  Cada trecho: { taxa (fração, juros simples do trecho), cap (capitalizado) }.
*/
function trechosJuros(u, a, b, faltando, estimados) {
  const ini = a > u.jurosDesde ? a : u.jurosDesde;
  const out = [];
  if (!u.jurosDesde || ini >= b) return out;
  const regs = u.regimes;
  for (let k = 0; k < regs.length; k++) {
    const r = regs[k], prox = regs[k + 1]?.desde;
    const x = r.desde && r.desde > ini ? r.desde : ini;
    const y = prox && prox < b ? prox : b;
    if (x >= y || !r.juros || r.juros === 'nenhum') continue;
    if (r.juros === 'mensal') {
      const d = diasEntre(x, y), i = (Number(r.taxa) || 0) / 100;
      out.push({ taxa: r.capitalizar ? Math.pow(1 + i, d / 30) - 1 : i / 30 * d, cap: !!r.capitalizar });
      continue;
    }
    // Taxa legal e SELIC: taxa do mês ÷ dias corridos do mês × dias do trecho (Res. CMN 5.171/2024, art. 6º)
    for (let m = x.slice(0, 7); m <= y.slice(0, 7); m = addMes(m, 1)) {
      const p = m === x.slice(0, 7) ? x : m + '-01';
      const q = m === y.slice(0, 7) ? y : addMes(m, 1) + '-01';
      const d = diasEntre(p, q);
      if (d <= 0) continue;
      out.push({ taxa: taxaMes(SERIE_JUROS[r.juros], m, faltando, estimados) / 100 / diasNoMes(m) * d, cap: !!r.capitalizar });
    }
  }
  return out;
}

/* ---------- Parcelas ---------- */
function novaParcela(base) {
  const u = { Pb: 0, Jb: 0, Mb: 0, pago: 0, ult: '', ...base };
  // Datas inválidas (ex.: ano digitado com dois dígitos) são ignoradas
  for (const k of ['corrDesde', 'jurosDesde', 'data']) if (u[k] && !ehData(u[k])) u[k] = '';
  u.regimes = ordenarRegimes((u.regimes || []).filter((r, i) => !i || !r.desde || ehData(r.desde)));
  u.Pb = Number(u.P0) || 0;
  u.Mb = u.Pb * (Number(u.multaPct) || 0) / 100;
  u.data = u.data || u.corrDesde || u.jurosDesde || '';
  return u;
}

// Atualiza a parcela (juros) até a data d
function acumular(u, d, ctx) {
  const de = u.ult || u.jurosDesde;
  if (!de || d <= de) { if (d > (u.ult || '')) u.ult = d; return; }
  for (const t of trechosJuros(u, de, d, ctx.faltando, ctx.estimados)) {
    u.Jb += (t.cap ? u.Pb + u.Jb : u.Pb) * t.taxa;
  }
  u.ult = d;
}

const saldoBase = u => u.Pb + u.Jb + u.Mb;
const saldoEm = (u, d, ctx) => saldoBase(u) * fatorParcela(u, d, ctx.faltando);

/* ---------- Critérios de cada verba ---------- */
// Uma linha: índice, tipo de juros, taxa, capitalização e, se marcada, a transição da Lei 14.905/2024
// (a partir de 30/08/2024, IPCA e taxa legal). Internamente vira a lista de regimes por período.
const CRIT_PADRAO = { indice: 'IGP-M', juros: 'mensal', taxa: 1, capitalizar: false, lei14905: false };

function regimesDeCrit(k) {
  const r = [{ desde: '', indice: k.juros === 'selic' ? 'Nenhum' : k.indice || 'Nenhum', juros: k.juros || 'nenhum', taxa: Number(k.taxa) || 0, capitalizar: !!k.capitalizar }];
  if (k.lei14905) r.push({ desde: DATA_LEI_14905, indice: 'IPCA', juros: k.juros === 'nenhum' ? 'nenhum' : 'legal', capitalizar: false });
  return r;
}

// Critérios antigos (lista de regimes) no formato de uma linha
function critDeRegimes(regs) {
  const l = ordenarRegimes(regs || []);
  if (!l.length) return null;
  const r = l[0];
  return { indice: r.indice || 'Nenhum', juros: r.juros || 'nenhum', taxa: r.taxa ?? 1, capitalizar: !!r.capitalizar,
    lei14905: l.some(x => x.desde && x.desde <= '2024-09-01' && x.desde >= '2024-08-01' && x.indice === 'IPCA') };
}

// Critérios padrão: os do cálculo (vindos do contrato) ou, na falta, os encargos padrão da Administração
const critPadrao = c => c?.crit || critDoContrato(null);

// Regimes de um item: os critérios próprios (crit), os de versões anteriores (regimes) ou os padrão
function regimesDoItem(it, c) {
  if (it?.crit) return regimesDeCrit(it.crit);
  if (it?.regimes?.length) return it.regimes;
  return c?.regimes?.length ? c.regimes : regimesDeCrit(critPadrao(c));
}

// Valor do item por inteiro do cálculo (rubricas, custas e multas), para os honorários sobre a condenação
function parcelasDosItens(c, ctx) {
  const lista = [];
  for (const it of c.rubricas || []) {
    if (!(Number(it.valor) > 0)) continue;
    lista.push(novaParcela({ itemId: it.id, grupo: 'rubrica', rotulo: it.descricao || 'Rubrica', P0: Number(it.valor), data: it.data || '',
      corrDesde: it.corrDesde || '', jurosDesde: it.jurosDesde || '', regimes: regimesDoItem(it, c), multaPct: it.multa }));
  }
  // Séries mensais (aluguéis, cotas, alimentos…): cada mês é uma verba, com correção desde o próprio vencimento e
  // juros desde o vencimento (mora automática) ou desde uma data única; os critérios e a multa são os da série
  for (const s of c.series || []) {
    const regs = regimesDeCrit(s.crit || critPadrao(c));
    for (const m of s.meses || []) {
      if (m.pago || !(Number(m.valor) > 0) || !m.vencimento) continue;
      lista.push(novaParcela({ itemId: m.id, serie: s.id, grupo: 'rubrica', rotulo: `${s.descricao || 'Prestação'} ${mesNum(m.competencia || m.vencimento.slice(0, 7))}`,
        P0: Number(m.valor), corrDesde: m.vencimento, jurosDesde: s.juros === 'data' ? s.jurosData || '' : s.juros === 'nenhum' ? '' : m.vencimento,
        regimes: regs, multaPct: s.multa, data: m.vencimento }));
    }
  }
  for (const it of c.custas || []) {
    const corr = it.corrDesde || it.data || '';
    if (!(Number(it.valor) > 0) || !corr) continue;
    const regs = !it.crit && it.corrigir === false ? regimesDeCrit({ indice: 'Nenhum', juros: 'mensal', taxa: 1 }) : regimesDoItem(it, c);
    // O Id. do comprovante no processo (opcional) sai junto com a descrição em todas as planilhas
    const rotulo = (it.descricao || 'Custas') + (String(it.idProc || '').trim() ? ` (Id. ${String(it.idProc).trim()})` : '');
    lista.push(novaParcela({ itemId: it.id, grupo: 'custas', rotulo, P0: Number(it.valor), data: corr,
      corrDesde: corr, jurosDesde: it.jurosDesde || '', regimes: regs }));
  }
  const causa = c.valorCausa || {};
  for (const it of c.multas || []) {
    let P0 = 0, corr = it.corrDesde || '';
    if (it.forma === 'pctCausa') { P0 = (Number(causa.valor) || 0) * (Number(it.pct) || 0) / 100; corr = causa.data || corr; }
    else if (it.forma === 'diaria') {
      const dd = it.inicio && it.fim && it.fim >= it.inicio ? diasEntre(it.inicio, it.fim) + 1 : 0;
      P0 = (Number(it.valorDia) || 0) * dd;
      if (Number(it.teto) > 0) P0 = Math.min(P0, Number(it.teto));
    } else P0 = Number(it.valor) || 0;
    if (!(P0 > 0)) continue;
    lista.push(novaParcela({ itemId: it.id, grupo: 'multa', rotulo: it.descricao || TIPOS_MULTA[it.tipo] || 'Multa', P0,
      corrDesde: corr, jurosDesde: it.jurosDesde || '', regimes: regimesDoItem(it, c), data: it.data || corr }));
  }
  return lista;
}

function parcelasHonorarios(c, base) {
  const lista = [];
  const causa = c.valorCausa || {};
  for (const h of c.honorarios || []) {
    const pct = Number(h.pct) || 0;
    const rotulo = rotuloHonorario(h);
    if (h.forma === 'condenacao') {
      if (!pct) continue;
      // Uma "sombra" de cada item da base, com as mesmas regras: acompanha a condenação, mas não as amortizações dela
      const sel = h.rubricas?.length ? new Set(h.rubricas) : null, fora = new Set(h.fora || []);
      for (const u of base) {
        const entra = u.grupo === 'rubrica' ? (u.serie ? !fora.has('serie:' + u.serie) : (!sel || sel.has(u.itemId)) && !fora.has(u.itemId))
          : u.grupo === 'custas' ? !!h.baseCustas : u.grupo === 'multa' ? !!h.baseMultas : false;
        if (!entra) continue;
        lista.push(novaParcela({ itemId: h.id, grupo: 'honorarios', rotulo, P0: u.P0 * pct / 100, multaPct: u.multaPct,
          corrDesde: u.corrDesde, jurosDesde: u.jurosDesde, regimes: u.regimes, data: u.data, sombra: true }));
      }
      // Outras bases (ex.: proveito econômico de obrigação de fazer com valor líquido), com critérios próprios
      const outras = [];
      for (const o of h.outras || []) {
        if (!(Number(o.valor) > 0)) continue;
        const u = novaParcela({ itemId: h.id, grupo: 'honorarios', rotulo, P0: Number(o.valor) * pct / 100,
          corrDesde: o.corrDesde || '', jurosDesde: o.jurosDesde || '', regimes: regimesDoItem(o, c), sombra: true });
        lista.push(u);
        outras.push(`${o.descricao || 'outra base'} (${fmtMoeda(o.valor)}; ${u.corrDesde ? 'correção desde ' + fmtData(u.corrDesde) : 'sem correção'}; ${u.jurosDesde ? 'juros desde ' + fmtData(u.jurosDesde) : 'sem juros'}; ${descRegimes(u.regimes, !!u.jurosDesde)})`);
      }
      // Texto da base para a memória de cálculo
      const nomes = [...new Set(base.filter(u => u.grupo === 'rubrica' && (u.serie ? !fora.has('serie:' + u.serie) : (!sel || sel.has(u.itemId)) && !fora.has(u.itemId)))
        .map(u => u.serie ? (c.series || []).find(s => s.id === u.serie)?.descricao + ' (prestações mensais)' : u.rotulo)),
        h.baseCustas && 'custas e despesas', h.baseMultas && 'multas processuais'].filter(Boolean);
      const nota = `Base: ${[nomes.length ? nomes.join(', ') + ', com os critérios de correção, juros e multa de cada item' : '', ...outras].filter(Boolean).join('; ') || 'nenhum item'}.`;
      lista.filter(u => u.itemId === h.id).forEach(u => { u.notaHon = nota; });
    } else if (h.forma === 'causa') {
      if (!pct || !(Number(causa.valor) > 0)) continue;
      lista.push(novaParcela({ itemId: h.id, grupo: 'honorarios', rotulo, P0: Number(causa.valor) * pct / 100,
        corrDesde: causa.data || '', jurosDesde: h.jurosDesde || '', regimes: regimesDoItem(h, c), data: h.data || causa.data }));
    } else if (Number(h.valor) > 0) {
      lista.push(novaParcela({ itemId: h.id, grupo: 'honorarios', rotulo, P0: Number(h.valor),
        corrDesde: h.corrigir === false ? '' : (h.data || ''), jurosDesde: h.jurosDesde || '', regimes: regimesDoItem(h, c), data: h.data }));
    }
  }
  return lista;
}

function rotuloHonorario(h) {
  if (h.descricao) return h.descricao;
  if (h.forma === 'condenacao') return `Honorários sucumbenciais (${fmtPct(h.pct)}% sobre a condenação)`;
  if (h.forma === 'causa') return `Honorários sucumbenciais (${fmtPct(h.pct)}% sobre o valor da causa)`;
  return 'Honorários sucumbenciais (valor fixado)';
}

/* ---------- Amortizações ---------- */
function imputar(u, X, d, imputacao, ctx, reg) {
  const f = fatorParcela(u, d, ctx.faltando);
  let xb = X / f;
  const ordem = imputacao === 'principal' ? ['Pb', 'Jb', 'Mb'] : ['Jb', 'Mb', 'Pb'];
  const nomes = { Pb: 'principal', Jb: 'juros', Mb: 'multa' };
  const linha = { rotulo: u.rotulo, itemId: u.itemId, serie: u.grupo === 'rubrica' ? u.serie : undefined, principal: 0, juros: 0, multa: 0 };
  for (const k of ordem) {
    const v = Math.min(u[k], xb);
    if (v <= 0) continue;
    u[k] -= v; xb -= v;
    linha[nomes[k]] += v * f;
  }
  const usado = X - xb * f;
  u.pago += usado;
  if (usado > 1e-9) reg.push(linha);
  return Math.max(0, xb * f);
}

function distribuir(lista, X, d, imputacao, ctx, reg) {
  // Proporcional ao saldo atualizado de cada parcela na data do pagamento
  const saldos = lista.map(u => saldoEm(u, d, ctx));
  const total = saldos.reduce((s, v) => s + v, 0);
  if (total <= 0) return X;
  let sobra = 0;
  const parte = Math.min(X, total);
  lista.forEach((u, i) => { sobra += imputar(u, parte * saldos[i] / total, d, imputacao, ctx, reg); });
  return X - parte + sobra;
}

function emOrdem(lista, X, d, imputacao, ctx, reg) {
  const ord = [...lista].sort((a, b) => comparar(a.data, b.data) || ORDEM_GRUPOS.indexOf(a.grupo) - ORDEM_GRUPOS.indexOf(b.grupo));
  for (const u of ord) { if (X <= 1e-9) break; X = imputar(u, X, d, imputacao, ctx, reg); }
  return X;
}

/* ---------- Cálculo ---------- */
function calcular(c, dataCalc) {
  const ctx = { faltando: new Set(), estimados: new Set(), avisos: [] };
  const base = parcelasDosItens(c, ctx);
  const parcelas = [...base, ...parcelasHonorarios(c, base)];
  const art = c.tipo === 'judicial' && c.art523?.aplicar ? c.art523 : null;
  const existe = (u, d) => !u.data || u.data <= d;

  /*
    Art. 523, § 1º: multa e honorários sobre o débito atualizado até a data do cálculo. Cada um é uma "sombra" dos itens
    da base, que acompanha a correção e os juros deles. Os pagamentos marcados como feitos no prazo reduzem a base (§ 2º);
    os demais, não (a sombra é sincronizada com o item só nos pagamentos feitos no prazo).
  */
  let r523 = null;
  if (art) {
    const inclui = u => u.grupo === 'rubrica' || (u.grupo === 'honorarios' && art.baseHonorarios) || (u.grupo === 'custas' && art.baseCustas) || (u.grupo === 'multa' && art.baseMultas);
    const baseItens = parcelas.filter(inclui);
    r523 = { multaPct: art.incluirMulta === false ? 0 : Number(art.multa) || 0, honPct: art.incluirHonorarios === false ? 0 : Number(art.honorarios) || 0 };
    const sombra523 = (itemId, rotulo, pct, oculta) => baseItens.forEach(u => parcelas.push(novaParcela({ itemId, grupo: 'art523', rotulo,
      P0: u.P0 * pct / 100, multaPct: u.multaPct, corrDesde: u.corrDesde, jurosDesde: u.jurosDesde, regimes: u.regimes, data: u.data,
      sombra: true, nota523: true, fonte: u, pct523: pct, oculta })));
    if (r523.multaPct) sombra523('art523-multa', `Multa do art. 523, § 1º, do CPC (${fmtPct(r523.multaPct)}%)`, r523.multaPct);
    if (r523.honPct) sombra523('art523-hon', `Honorários advocatícios do art. 523, § 1º, do CPC (${fmtPct(r523.honPct)}%)`, r523.honPct);
    // Cópia oculta da base (100%), só para informar o valor da base na data do cálculo
    sombra523('art523-base', '', 100, true);
  }

  const eventos = (c.amortizacoes || []).filter(a => Number(a.valor) > 0 && ehData(a.data) && a.data <= dataCalc)
    .map(a => ({ data: a.data, a })).sort((x, y) => comparar(x.data, y.data));

  const amort = [];
  let excedente = 0;
  for (const ev of eventos) {
    parcelas.forEach(u => acumular(u, ev.data, ctx));
    const a = ev.a, d = ev.data, reg = [];
    const noPrazo = !!(art && a.noPrazo);
    // Pagamento no prazo do art. 523 não é imputado na multa e nos honorários (ainda não devidos)
    const vivos = parcelas.filter(u => !u.oculta && !(noPrazo && u.grupo === 'art523') && existe(u, d) && saldoBase(u) > 1e-9);
    const antes = vivos.reduce((s, u) => s + saldoEm(u, d, ctx), 0);
    let X = Number(a.valor);
    const dest = a.destino || 'proporcional';
    if (dest === 'proporcional') X = distribuir(vivos, X, d, a.imputacao, ctx, reg);
    else if (dest === 'antigas') X = emOrdem(vivos, X, d, a.imputacao, ctx, reg);
    else if (dest === 'custasPrimeiro') {
      // Primeiro as custas e despesas (proporcionalmente entre elas); o que sobrar, proporcionalmente nos demais itens
      X = distribuir(vivos.filter(u => u.grupo === 'custas'), X, d, a.imputacao, ctx, reg);
      if (X > 0.005) X = distribuir(vivos.filter(u => u.grupo !== 'custas' && saldoBase(u) > 1e-9), X, d, a.imputacao, ctx, reg);
    }
    else {
      const alvo = dest.startsWith('grupo:') ? vivos.filter(u => u.grupo === dest.slice(6))
        : dest.startsWith('serie:') ? vivos.filter(u => u.serie === dest.slice(6)) : vivos.filter(u => u.itemId === dest);
      X = distribuir(alvo, X, d, a.imputacao, ctx, reg);
      if (X > 0.005) X = emOrdem(vivos.filter(u => saldoBase(u) > 1e-9), X, d, a.imputacao, ctx, reg);
    }
    // Junta as linhas do mesmo item (honorários sobre a condenação têm várias parcelas)
    const porItem = [];
    for (const l of reg) {
      const j = porItem.find(x => x.itemId === l.itemId);
      if (j) { j.principal += l.principal; j.juros += l.juros; j.multa += l.multa; } else porItem.push({ ...l });
    }
    // Pagamento no prazo (§ 2º): a multa e os honorários passam a incidir só sobre o restante
    if (noPrazo) parcelas.filter(s => s.fonte).forEach(s => { for (const k of ['Pb', 'Jb', 'Mb']) s[k] = s.fonte[k] * s.pct523 / 100; });
    const depois = vivos.reduce((s, u) => s + saldoEm(u, d, ctx), 0);
    if (X > 0.005) excedente += X;
    amort.push({ a, data: d, valor: Number(a.valor), antes: r2(antes), imputado: porItem, sobra: X > 0.005 ? r2(X) : 0, depois: r2(depois) });
  }
  parcelas.forEach(u => acumular(u, dataCalc, ctx));
  if (r523) r523.baseFinal = r2(parcelas.filter(u => u.oculta).reduce((s, u) => s + saldoEm(u, dataCalc, ctx), 0));

  // Resultado por item
  const itens = [];
  for (const u of parcelas) {
    if (u.oculta || (!existe(u, dataCalc) && !u.Jb)) continue;
    const f = fatorParcela(u, dataCalc, ctx.faltando);
    let it = itens.find(x => x.itemId === u.itemId);
    if (!it) {
      it = { itemId: u.itemId, serie: u.grupo === 'rubrica' ? u.serie : undefined, grupo: u.grupo, rotulo: u.rotulo, data: u.data, original: 0, corrigidoBruto: 0, principal: 0, juros: 0, multa: 0, pago: 0, total: 0, parcelas: [] };
      itens.push(it);
    }
    it.parcelas.push(u);
    it.original += u.P0;
    it.corrigidoBruto += u.P0 * f;
    it.principal += u.Pb * f;
    it.juros += u.Jb * f;
    it.multa += u.Mb * f;
    it.pago += u.pago;
  }
  for (const it of itens) {
    const u = it.parcelas[0];
    it.fator = u.sombra ? null : fatorParcela(u, dataCalc, ctx.faltando);
    it.taxaJuros = u.sombra ? null : trechosJuros(u, u.jurosDesde, dataCalc, new Set(), new Set()).reduce((s, t) => s + t.taxa, 0);
    it.dias = u.jurosDesde && dataCalc > u.jurosDesde ? diasEntre(u.jurosDesde, dataCalc) : 0;
    for (const k of ['original', 'corrigidoBruto', 'principal', 'juros', 'multa', 'pago']) it[k] = r2(it[k]);
    it.total = r2(it.principal + it.juros + it.multa);
    it.correcao = r2(it.corrigidoBruto - it.original);
  }
  itens.sort((a, b) => ORDEM_GRUPOS.indexOf(a.grupo) - ORDEM_GRUPOS.indexOf(b.grupo) || comparar(a.data, b.data));

  const grupos = ORDEM_GRUPOS.map(g => {
    const l = itens.filter(i => i.grupo === g);
    const soma = k => l.reduce((s, i) => s + cent(i[k]), 0) / 100;
    return { grupo: g, nome: GRUPOS[g], itens: l, original: soma('original'), principal: soma('principal'), juros: soma('juros'), multa: soma('multa'), total: soma('total') };
  }).filter(g => g.itens.length);

  const subtotal = grupos.reduce((s, g) => s + cent(g.total), 0) / 100;
  const pctContr = c.tipo !== 'judicial' ? Number(c.honContr) || 0 : 0;
  const honContr = r2(subtotal * pctContr / 100);
  const temPagamento = amort.length > 0;

  return {
    c, dataCalc, itens, grupos, amort, r523, subtotal, pctContr, honContr, temPagamento,
    aVencer: (c.series || []).flatMap(s => s.meses || []).filter(m => !m.pago && Number(m.valor) > 0 && m.vencimento > dataCalc).length,
    excedente: r2(excedente), total: r2(subtotal + honContr),
    faltando: [...ctx.faltando].sort(), estimados: [...ctx.estimados].sort(),
  };
}

/* ---------- Descrição dos critérios (memória de cálculo, art. 524 do CPC) ---------- */
const pelo = indice => (indice === 'UFIR-RJ' ? 'pela ' : 'pelo ') + indice;

// comJuros = false: só a correção monetária (itens sem juros)
function descRegime(r, comJuros = true) {
  const corr = r.juros === 'selic' ? '' : (r.indice && r.indice !== 'Nenhum' ? 'correção ' + pelo(r.indice) : 'sem correção monetária');
  const j = r.juros === 'mensal' ? `juros de ${fmtPct(r.taxa)}% ao mês${r.capitalizar ? ', capitalizados mensalmente' : ', simples, pro rata die'}`
    : r.juros === 'legal' ? 'juros pela taxa legal (art. 406 do CC; Res. CMN 5.171/2024), simples, pro rata die'
    : r.juros === 'selic' ? (comJuros ? 'taxa SELIC, que engloba correção monetária e juros, pro rata die' : 'sem correção monetária (período da SELIC)')
    : 'sem juros';
  return comJuros ? [corr, j].filter(Boolean).join(' e ') : corr || j;
}

function descRegimes(regs, comJuros = true) {
  // Períodos seguidos com a mesma descrição são unidos
  const l = [];
  for (const r of ordenarRegimes(regs)) {
    const t = descRegime(r, comJuros);
    if (l.length && l[l.length - 1].t === t) continue;
    l.push({ desde: r.desde, t });
  }
  if (l.length === 1) return l[0].t;
  return l.map((r, i) => {
    const fim = l[i + 1]?.desde;
    const per = !r.desde ? (fim ? `até ${fmtData(addDias(fim, -1))}` : '') : fim ? `de ${fmtData(r.desde)} a ${fmtData(addDias(fim, -1))}` : `a partir de ${fmtData(r.desde)}`;
    return `${per}: ${r.t}`;
  }).join('; ');
}

function addDias(iso, n) {
  const [a, m, d] = iso.split('-').map(Number);
  const x = new Date(Date.UTC(a, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}

// Texto das regras de um item (para a memória de cálculo)
function descItem(it) {
  const u = it.parcelas[0];
  if (u.nota523) return 'Calculados sobre o débito atualizado até a data do cálculo, com os mesmos critérios de correção e juros de cada item da base; só os pagamentos feitos no prazo reduzem a base (§ 2º).';
  if (u.notaHon) return u.notaHon;
  if (u.sombra) return 'Calculados sobre os itens da condenação, com os mesmos critérios de correção, juros e multa de cada item.';
  const partes = [];
  partes.push(u.corrDesde ? `Correção monetária desde ${fmtData(u.corrDesde)}` : 'Sem correção monetária');
  partes.push(u.jurosDesde ? `juros de mora desde ${fmtData(u.jurosDesde)}` : 'sem juros de mora');
  let t = partes.join('; ') + '. ';
  if (u.corrDesde || u.jurosDesde) t += 'Critérios: ' + descRegimes(u.regimes, !!u.jurosDesde) + '.';
  if (u.multaPct) t += ` Multa de ${fmtPct(u.multaPct)}% sobre o valor corrigido.`;
  return t;
}

function notasCalculo(r) {
  const n = [];
  if (r.aVencer) n.push(`Não incluída(s) ${r.aVencer} prestação(ões) mensal(is) com vencimento depois de ${fmtData(r.dataCalc)} (a vencer).`);
  if (r.faltando.length) n.push('Atenção: índice ou taxa não disponível para ' + r.faltando.join(', ') + ' (não considerado no cálculo).');
  if (r.estimados.length) n.push('Taxa ainda não divulgada, estimada pela última disponível: ' + r.estimados.join('; ') + '.');
  if (r.excedente) n.push(`Os pagamentos excederam o débito existente nas respectivas datas em ${fmtMoeda(r.excedente)} (valor nominal), não abatidos de outros itens.`);
  return n;
}

const NOTA_METODO = 'Correção monetária: IGP-M, IPCA, INPC e IPCA-E acumulam as variações mensais do mês do termo inicial até o mês anterior ao do cálculo (Banco Central, SGS); '
  + 'UFIR-RJ: valor do ano final dividido pelo valor do ano inicial (SEFAZ-RJ). Juros simples sobre o valor corrigido; juros vencidos e não pagos são corrigidos, mas não rendem juros. '
  + 'Taxa legal e SELIC: taxa do mês dividida pelos dias corridos do mês, multiplicada pelos dias do período (Res. CMN 5.171/2024, art. 6º). '
  + 'Quando um regime começa no meio do mês, o índice de correção desse mês segue o regime anterior.';
