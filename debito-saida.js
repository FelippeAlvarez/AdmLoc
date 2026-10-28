'use strict';
/* PDF (memória de cálculo) e Excel do Cálculo do débito */

function partesDebito(ct, calc) {
  const lo = D.locadores[ct.locadorId], lt = D.locatarios[ct.locatarioId];
  const doc = p => p?.documento ? ' (' + (/^\s*(cpf|cnpj)/i.test(p.documento) ? p.documento : 'CPF/CNPJ ' + p.documento) + ')' : '';
  const fiadores = ct.tipoGarantia === 'fianca' ? [ct.fiadorNome && ct.fiadorNome + (ct.fiadorDocumento ? ` (CPF/CNPJ ${ct.fiadorDocumento})` : ''),
    ct.fiador2Nome && ct.fiador2Nome + (ct.fiador2Documento ? ` (CPF/CNPJ ${ct.fiador2Documento})` : '')].filter(Boolean) : [];
  const linhas = [
    `${rotuloContrato(ct)} · Imóvel: ${descImovel(D.imoveis[ct.imovelId])}`,
    `Credor (locador): ${lo?.nome || '—'}${doc(lo)}`,
    `Devedor (locatário): ${lt?.nome || '—'}${doc(lt)}${fiadores.length ? ' · Fiador' + (fiadores.length > 1 ? 'es' : '') + ': ' + fiadores.join('; ') : ''}`,
  ];
  if (calc.tipo === 'judicial' && (calc.processo?.numero || calc.processo?.juizo)) linhas.push(['Processo nº ' + (calc.processo.numero || '—'), calc.processo.juizo].filter(Boolean).join(' · '));
  return linhas;
}

const criteriosTexto = r => `Critérios: ${descRegimes(regimesDeCrit(r.c.crit))}${r.c.crit.multa ? `; multa contratual de ${fmtPct(r.c.crit.multa)}% sobre o valor corrigido` : ''}.`;

function pdfDebito(ct, r, calc) {
  const P = novoDocumento(true);
  P.cab();
  const judicial = calc.tipo === 'judicial';
  tituloPDF(P, tituloDebito(calc),
    [...partesDebito(ct, calc).map((t, i) => [t, i ? 9 : 10, i ? 'normal' : 'bold']), [r.finalidade === 'purga' ? `Valores para depósito judicial em ${fmtData(r.dataCalc)}` : `Atualizado até ${fmtData(r.dataCalc)}${judicial && r.finalidade !== 'inicial' ? ' (art. 524 do CPC)' : ''}`, 9, 'normal', COR_SUAVE]]);
  paragrafoPDF(P, criteriosTexto(r), 8.5);
  P.y += 3;
  const cols = [{ t: 'Item', w: 52 }, { t: 'Data', w: 16, nw: true }, { t: 'Valor original', w: 18, a: 'r' }, { t: 'Fator de correção', w: 16, a: 'r' }, { t: 'Principal corrigido', w: 19, a: 'r' },
    { t: 'Juros', w: 16, a: 'r' }, { t: 'Multa', w: 15, a: 'r' }, { t: 'Pago', w: 15, a: 'r' }, { t: 'Total', w: 19, a: 'r' }];
  const fat = f => f ? f.toLocaleString('pt-BR', { minimumFractionDigits: 6 }) : '';
  for (const g of r.grupos) {
    subtituloPDF(P, g.nome);
    tabelaPDF(P, cols, [...g.itens.map(it => ({ c: [it.rotulo, fmtData(it.data), fmtNum(it.original), fat(it.fator), fmtNum(it.principal), fmtNum(it.juros), fmtNum(it.multa), it.pago ? fmtNum(it.pago) : '', fmtNum(it.total)] })),
      { c: ['Subtotal', '', fmtNum(g.original), '', fmtNum(g.principal), fmtNum(g.juros), fmtNum(g.multa), '', fmtNum(g.total)], total: true }], 8);
    // Regras próprias dos itens que não seguem os critérios gerais (custas, honorários, multas, art. 523)
    if (g.grupo !== 'rubrica') [...new Set(g.itens.map(it => it.rotulo + ': ' + descItem(it)))].forEach(t => { paragrafoPDF(P, t, 7.5, 'normal', COR_SUAVE); });
    P.y += 2;
  }
  if (r.amort.length) {
    subtituloPDF(P, 'Pagamentos abatidos');
    tabelaPDF(P, [{ t: 'Data', w: 16, nw: true }, { t: 'Pagamento', w: 70 }, { t: 'Valor', w: 20, a: 'r' }, { t: 'Débito antes', w: 22, a: 'r' }, { t: 'Juros e multa abatidos', w: 22, a: 'r' },
      { t: 'Principal abatido', w: 22, a: 'r' }, { t: 'Débito depois', w: 22, a: 'r' }],
    r.amort.map(x => ({ c: [fmtData(x.data), (nomeFormaAmort[x.a.forma] || 'Pagamento') + (x.a.obs ? ': ' + x.a.obs : '') + (x.a.imputacao === 'principal' ? ' (imputado no principal)' : ' (imputado primeiro em juros e multa)'),
      fmtNum(x.valor), fmtNum(x.antes), fmtNum(x.imputado.reduce((s, l) => s + l.juros + l.multa, 0)), fmtNum(x.imputado.reduce((s, l) => s + l.principal, 0)), fmtNum(x.depois)] })), 8);
  }
  const rr = r.porRubrica ? resumoRubricas(r) : [];
  if (rr.length > 1) {
    subtituloPDF(P, 'Resumo por rubrica');
    tabelaPDF(P, [{ t: 'Rubrica', w: 60 }, { t: 'Meses', w: 12, a: 'r' }, { t: 'Valor original', w: 22, a: 'r' }, { t: 'Principal corrigido', w: 22, a: 'r' }, { t: 'Juros', w: 20, a: 'r' }, { t: 'Multa', w: 20, a: 'r' }, { t: 'Total', w: 22, a: 'r' }],
      rr.map(x => ({ c: [x.nome + (x.locacao ? ' (locação)' : ''), String(x.meses), fmtNum(x.original), fmtNum(x.principal), fmtNum(x.juros), fmtNum(x.multa), fmtNum(x.total)] })), 8);
  }
  resumoPDF(P, [
    ...r.grupos.map(g => [g.nome, g.total]),
    ...(r.honContr ? [[`${rotuloHon(r)} (${fmtPct(r.pctContr)}%)`, r.honContr]] : []),
    [`Total do débito em ${fmtData(r.dataCalc)}`, r.total, 'f'],
  ], 140);
  const vc = r.valorCausaDespejo;
  if (vc) resumoPDF(P, [['Débito (cobrança)', vc.debito], [`12 × última locação com encargos (${fmtNum(vc.mensal)}${vc.ref ? ', ' + mesNum(vc.ref) : ''})`, vc.doze],
    ['Valor da causa (Lei 8.245/91, art. 58, III; CPC, art. 292, VI)', vc.total, 'f']], 140);
  [...notasDebito(r), NOTA_METODO].forEach(n => { paragrafoPDF(P, n, 7.5, 'normal', COR_SUAVE); P.y += 1; });
  rodapePDF(P);
  return { doc: P.doc, nome: nomeArquivo('debito', ct.codigo, r.dataCalc) + '.pdf' };
}

/* ---------- Excel ---------- */
const IDX_INI_DEB = 6; // primeira linha de dados da folha Índices

// Folha "Índices" com o índice do cálculo: meses, variação e número-índice acumulado; e a UFIR-RJ por ano
function folhaIndicesDebito(indice, ignorarNegativos) {
  const s = D.indices?.series?.[indice] || {};
  const meses = Object.keys(s).sort();
  const L = [[{ v: 'Índices de correção monetária', s: 'tit' }],
    ['Usados nas fórmulas da folha do débito. Novos meses podem ser acrescentados ao final (a variação; o acumulado segue a fórmula da linha de cima).'],
    [ignorarNegativos ? 'Variações mensais negativas desconsideradas no acumulado.' : 'Fontes: Banco Central do Brasil (SGS) e SEFAZ-RJ (UFIR-RJ).'], null,
    { c: ['Mês', `${indice} (% no mês)`, `${indice} acumulado`, '', 'Ano', 'UFIR-RJ'].map(v => (v ? { v, s: 'cab' } : null)), altura: 30 }];
  const ufir = Object.entries(tabelaUfir()).sort((a, b) => a[0] - b[0]);
  const lista = meses.length && indice !== 'UFIR-RJ' ? [addMes(meses[0], -1), ...meses] : [];
  let acum = 1;
  const n = Math.max(lista.length, ufir.length);
  for (let i = 0; i < n; i++) {
    const lin = IDX_INI_DEB + i, m = lista[i], linha = [];
    if (m) {
      const v = i ? s[m] : undefined;
      if (v !== undefined) acum *= 1 + (ignorarNegativos ? Math.max(0, v) : v) / 100;
      linha.push({ v: m + '-01', s: 'd' }, v === undefined ? null : { v, s: 'f' },
        i === 0 ? { v: 1, s: 'f' } : { f: ignorarNegativos ? `C${lin - 1}*(1+MAX(0,B${lin})/100)` : `C${lin - 1}*(1+B${lin}/100)`, v: Math.round(acum * 1e10) / 1e10, s: 'f' });
    } else linha.push(null, null, null);
    linha.push(null);
    if (ufir[i]) linha.push({ v: +ufir[i][0], s: 'i' }, { v: ufir[i][1], s: 'f' });
    L.push(linha);
  }
  return { nome: 'Índices', linhas: L, larguras: [12, 16, 16, 3, 8, 12], congelar: IDX_INI_DEB - 1, ult: IDX_INI_DEB + lista.length + 600 };
}

function formulaFatorDeb(indice, x, DATA, ult) {
  if (!indice || indice === 'Nenhum') return '1';
  if (indice === 'UFIR-RJ') {
    const t = `'Índices'!$E$${IDX_INI_DEB}:$F$${IDX_INI_DEB + 200}`;
    return `IF(${x}>=${DATA},1,IFERROR(ROUND(VLOOKUP(YEAR(${DATA}),${t},2,TRUE)/VLOOKUP(YEAR(${x}),${t},2,TRUE),6),1))`;
  }
  const meses = `'Índices'!$A$${IDX_INI_DEB}:$A$${ult}`, acum = `'Índices'!$C$${IDX_INI_DEB}:$C$${ult}`;
  const num = d => `INDEX(${acum},MATCH(EOMONTH(${d},-2)+1,${meses},1))`;
  return `IF(${x}>=${DATA},1,ROUND(${num(DATA)}/${num(x)},6))`;
}

function xlsxDebito(ct, r, calc) {
  const k = r.c.crit;
  // Fórmulas só no caso simples: juros ao mês simples, sem pagamentos e sem itens judiciais (honorários, multas, art. 523)
  const simples = r.finalidade !== 'purga' && k.juros === 'mensal' && !k.capitalizar && !k.lei14905 && !r.amort.length && r.grupos.every(g => g.grupo === 'rubrica' || g.grupo === 'custas');
  const LARG = [12, 34, 12, 14, 12, 14, 8, 13, 9, 13, 15];
  const L = [...cabecalhoXLSX(), [{ v: tituloDebito(calc), s: 'tit' }], ...partesDebito(ct, calc).map(t => [t]), null];
  const param = (rot, val) => { L.push([{ v: rot, s: 'b' }, null, null, val]); return '$D$' + L.length; };
  const DATA = param('Data do cálculo', { v: r.dataCalc, s: 'd' });
  param('Critérios', criteriosTexto(r).replace(/^Critérios: /, ''));
  const JUROS = simples ? param('Juros de mora ao mês (pro rata die)', { v: (Number(k.taxa) || 0) / 100, s: 'p' }) : null;
  const HON = r.pctContr ? param(rotuloHon(r), { v: r.pctContr / 100, s: 'p' }) : null;
  const idx = simples && k.indice !== 'Nenhum' ? folhaIndicesDebito(k.indice, !!D.config.moratorios?.ignorarNegativos) : null;
  const fator = x => formulaFatorDeb(k.indice, x, DATA, idx?.ult);
  if (!simples) L.push(['Valores calculados pelo aplicativo (critérios com pagamentos abatidos, taxa legal, SELIC, capitalização ou itens judiciais não são reproduzidos em fórmulas).']);
  const totais = [];

  for (const g of r.grupos) {
    L.push(null, [{ v: g.nome, s: 'b' }]);
    if (simples && g.grupo === 'rubrica') {
      L.push({ c: ['Referência', 'Descrição', 'Vencimento', 'Valor original', 'Fator de correção', 'Valor corrigido', 'Dias', 'Juros', 'Multa (%)', 'Multa', 'Total'].map(v => ({ v, s: 'cab' })), altura: 30 });
      const ini = L.length + 1;
      const linha = it => {
        const n = L.length + 1, se = (f, v, s) => ({ f: `IF(D${n}="","",${f})`, v, s }), u = it?.parcelas[0];
        L.push([it?.serie ? mesNum(it.itemId) : null, it ? it.rotulo : null, { v: it ? u.corrDesde : '', s: 'd' }, { v: it ? it.original : '', s: 'm' },
          se(fator('C' + n), it?.fator, 'f'), se(`ROUND(D${n}*E${n},2)`, it?.principal, 'm'), se(`MAX(0,${DATA}-C${n})`, it?.dias, 'i'), se(`ROUND(F${n}*${JUROS}/30*G${n},2)`, it?.juros, 'm'),
          { v: it ? (Number(u.multaPct) || 0) / 100 : '', s: 'p' }, se(`ROUND(F${n}*I${n},2)`, it?.multa, 'm'), se(`F${n}+H${n}+J${n}`, it?.total, 'm')]);
      };
      g.itens.forEach(linha);
      for (let i = 0; i < 10; i++) linha(null);
      const fim = L.length;
      L.push([{ v: 'Subtotal', s: 'bt' }, null, null, { f: `SUM(D${ini}:D${fim})`, v: g.original, s: 'mt' }, null, { f: `SUM(F${ini}:F${fim})`, s: 'mt' }, null,
        { f: `SUM(H${ini}:H${fim})`, v: g.juros, s: 'mt' }, null, { f: `SUM(J${ini}:J${fim})`, v: g.multa, s: 'mt' }, { f: `SUM(K${ini}:K${fim})`, v: g.total, s: 'mt' }]);
      totais.push('K' + L.length);
    } else if (simples && g.grupo === 'custas') {
      L.push({ c: ['Data', 'Descrição', '', 'Valor', 'Fator de correção', 'Valor corrigido'].map(v => (v ? { v, s: 'cab' } : null)), altura: 30 });
      const ini = L.length + 1;
      const linha = it => {
        const n = L.length + 1, se = (f, v, s) => ({ f: `IF(D${n}="","",${f})`, v, s });
        L.push([{ v: it ? it.data : '', s: 'd' }, it ? it.rotulo : null, null, { v: it ? it.original : '', s: 'm' }, se(fator('A' + n), it?.fator, 'f'), se(`ROUND(D${n}*E${n},2)`, it?.total, 'm')]);
      };
      g.itens.forEach(linha);
      for (let i = 0; i < 4; i++) linha(null);
      L.push([{ v: 'Subtotal', s: 'bt' }, null, null, { f: `SUM(D${ini}:D${L.length})`, v: g.original, s: 'mt' }, null, { f: `SUM(F${ini}:F${L.length})`, v: g.total, s: 'mt' }]);
      totais.push('F' + L.length);
    } else {
      L.push({ c: ['Data', 'Item', '', 'Valor original', 'Fator de correção', 'Principal corrigido', '', 'Juros', '', 'Multa', 'Total', 'Pago'].map(v => (v ? { v, s: 'cab' } : null)), altura: 30 });
      const ini = L.length + 1;
      g.itens.forEach(it => L.push([{ v: it.data, s: 'd' }, it.rotulo, null, { v: it.original, s: 'm' }, it.fator ? { v: it.fator, s: 'f' } : null, { v: it.principal, s: 'm' }, null,
        { v: it.juros, s: 'm' }, null, { v: it.multa, s: 'm' }, { v: it.total, s: 'm' }, it.pago ? { v: it.pago, s: 'm' } : null]));
      L.push([{ v: 'Subtotal', s: 'bt' }, null, null, null, null, null, null, null, null, null, { f: `SUM(K${ini}:K${L.length})`, v: g.total, s: 'mt' }]);
      totais.push('K' + L.length);
    }
  }
  if (r.amort.length) {
    L.push(null, [{ v: 'Pagamentos abatidos', s: 'b' }], { c: ['Data', 'Pagamento', '', 'Valor', 'Débito antes', 'Juros e multa abatidos', '', 'Principal abatido', '', 'Débito depois'].map(v => (v ? { v, s: 'cab' } : null)), altura: 30 });
    r.amort.forEach(x => L.push([{ v: x.data, s: 'd' }, (nomeFormaAmort[x.a.forma] || 'Pagamento') + (x.a.obs ? ': ' + x.a.obs : ''), null, { v: x.valor, s: 'm' }, { v: x.antes, s: 'm' },
      { v: r2(x.imputado.reduce((s, l) => s + l.juros + l.multa, 0)), s: 'm' }, null, { v: r2(x.imputado.reduce((s, l) => s + l.principal, 0)), s: 'm' }, null, { v: x.depois, s: 'm' }]));
  }
  L.push(null);
  const sub = { f: totais.length ? totais.join('+') : '0', v: r.subtotal, s: 'mt' };
  L.push([{ v: 'Subtotal do débito', s: 'bt' }, null, null, null, null, null, null, null, null, null, sub]);
  const nSub = L.length;
  if (HON) L.push([{ v: rotuloHon(r), s: 'bt' }, null, null, null, null, null, null, null, null, null, { f: `ROUND(${r.baseHon !== undefined && totais[0] ? totais[0] : 'K' + nSub}*${HON},2)`, v: r.honContr, s: 'mt' }]);
  L.push([{ v: `Total do débito`, s: 'bt' }, null, null, null, null, null, null, null, null, null, { f: HON ? `K${nSub}+K${nSub + 1}` : `K${nSub}`, v: r.total, s: 'mt' }]);
  const nTot = L.length, vc = r.valorCausaDespejo;
  if (vc) {
    L.push([{ v: `12 × última locação com encargos (${vc.ref ? mesNum(vc.ref) : 'contrato'})`, s: 'bt' }, null, null, { v: vc.mensal, s: 'm' }, null, null, null, null, null, null, { f: `ROUND(D${L.length + 1}*12,2)`, v: vc.doze, s: 'mt' }]);
    L.push([{ v: 'Valor da causa (Lei 8.245/91, art. 58, III; CPC, art. 292, VI)', s: 'bt' }, null, null, null, null, null, null, null, null, null, { f: `K${nTot}+K${nTot + 1}`, v: vc.total, s: 'mt' }]);
  }
  const rr = r.porRubrica ? resumoRubricas(r) : [];
  if (rr.length > 1) {
    L.push(null, [{ v: 'Resumo por rubrica', s: 'b' }], { c: ['Rubrica', '', '', 'Valor original', '', 'Principal corrigido', '', 'Juros', '', 'Multa', 'Total'].map(v => (v ? { v, s: 'cab' } : null)), altura: 30 });
    rr.forEach(x => L.push([x.nome + (x.locacao ? ' (locação)' : ''), null, null, { v: x.original, s: 'm' }, null, { v: x.principal, s: 'm' }, null, { v: x.juros, s: 'm' }, null, { v: x.multa, s: 'm' }, { v: x.total, s: 'm' }]));
  }
  L.push(null);
  [...notasDebito(r), NOTA_METODO].forEach(n => L.push([n]));
  const folhas = [{ nome: 'Débito', linhas: L, larguras: LARG }];
  if (idx) folhas.push(idx);
  return gerarXLSX(folhas);
}
