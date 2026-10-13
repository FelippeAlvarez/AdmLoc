'use strict';
/* Cobrança: débito atualizado com encargos moratórios, inadimplência, contratos vigentes e índices de correção */

// Séries do Banco Central (SGS) com a variação mensal (%) de cada índice
const SERIES_BCB = { 'IGP-M': 189, 'IPCA': 433, 'INPC': 188, 'IGP-DI': 190 };

/* ================= Reajuste ================= */
function mesCorrecaoDe(ct) {
  if (ct.mesCorrecao) return +ct.mesCorrecao;
  if (ct.mesReajuste) return +ct.mesReajuste.slice(5, 7);
  if (ct.inicio) return +ct.inicio.slice(5, 7);
  return null;
}

// Próximo mês de reajuste a partir do mês atual (o primeiro só depois de 12 meses do início)
function proximoReajuste(ct) {
  const m = mesCorrecaoDe(ct);
  if (!m) return '';
  const atual = mesAtual();
  let ym = `${atual.slice(0, 4)}-${p2(m)}`;
  if (ym < atual) ym = addMes(ym, 12);
  if (ct.inicio) { const primeiro = addMes(ct.inicio.slice(0, 7), 12); while (ym < primeiro) ym = addMes(ym, 12); }
  return ym;
}

// Ciclo de reajuste (AAAA-MM) vigente no mês "ym": o último mês de reajuste até ele, a partir de 12 meses do início
function cicloReajuste(ct, ym) {
  const m = mesCorrecaoDe(ct);
  if (!m || !ym) return null;
  let ciclo = `${ym.slice(0, 4)}-${p2(m)}`;
  if (ciclo > ym) ciclo = addMes(ciclo, -12);
  if (ct.inicio && ciclo < addMes(ct.inicio.slice(0, 7), 12)) return null;
  return ciclo;
}

// Ciclo ainda não decidido (nem aplicado, nem marcado como já aplicado ou dispensado)
function reajustePendente(ct, ym) {
  const ciclo = cicloReajuste(ct, ym);
  if (!ciclo || (ct.reajustes || []).some(r => r.ciclo === ciclo)) return null;
  // Se o mês do ciclo já foi lançado com o reajuste aplicado, também está decidido
  const mesCiclo = D.extratos[ct.id]?.meses?.[ciclo];
  if (mesCiclo?.reajuste) return null;
  return ciclo;
}

// Variação acumulada em 12 meses terminando em "ateMes" (ou no último mês divulgado antes dele)
function acumuladoIndice(indice, ateMes, n = 12) {
  const serie = D.indices?.series?.[indice] || {};
  let fim = ateMes;
  for (let i = 0; i < 3 && serie[fim] === undefined; i++) fim = addMes(fim, -1);
  if (serie[fim] === undefined) return null;
  const de = addMes(fim, -(n - 1)), faltando = [];
  let f = 1;
  for (let m = de; m <= fim; m = addMes(m, 1)) {
    if (serie[m] === undefined) faltando.push(m); else f *= 1 + serie[m] / 100;
  }
  return { pct: Math.round((f - 1) * 1e6) / 1e4, de, ate: fim, faltando, atrasado: fim !== ateMes };
}

/* ================= Encargos moratórios ================= */
function paramsMora(ct) {
  const p = D.config.moratorios;
  const v = (x, padrao) => x === null || x === undefined || x === '' ? padrao : Number(x);
  return {
    multa: v(ct?.multaMora, p.multa), juros: v(ct?.jurosMora, p.juros), honorarios: v(ct?.honorarios, p.honorarios),
    indice: ct?.indiceCorrecao || p.indice, ignorarNegativos: !!p.ignorarNegativos,
  };
}

function diasEntre(de, ate) {
  const d = s => { const [a, m, dd] = s.split('-').map(Number); return Date.UTC(a, m - 1, dd); };
  return Math.round((d(ate) - d(de)) / 864e5);
}

// Variação acumulada do índice do mês do vencimento até o mês anterior ao da data do cálculo
function fatorCorrecao(indice, mesVenc, mesCalc, ignorarNegativos) {
  const faltando = [];
  if (!indice || indice === 'Nenhum') return { fator: 1, faltando };
  const serie = D.indices?.series?.[indice] || {};
  let f = 1;
  for (let m = mesVenc; m < mesCalc; m = addMes(m, 1)) {
    const t = serie[m];
    if (t === undefined || t === null) { faltando.push(m); continue; }
    if (ignorarNegativos && t < 0) continue;
    f *= 1 + t / 100;
  }
  return { fator: Math.round(f * 1e6) / 1e6, faltando };
}

// Correção monetária, juros pro rata die sobre o valor corrigido e multa sobre o valor corrigido
function encargosMoratorios(valor, venc, dataCalc, p) {
  const dias = diasEntre(venc, dataCalc);
  if (dias <= 0 || valor <= 0) return { dias: Math.max(0, dias), fator: 1, corrigido: valor, correcao: 0, juros: 0, multa: 0, total: valor, faltando: [] };
  const { fator, faltando } = fatorCorrecao(p.indice, venc.slice(0, 7), dataCalc.slice(0, 7), p.ignorarNegativos);
  const corrigido = r2(valor * fator);
  const juros = r2(corrigido * p.juros / 100 / 30 * dias);
  const multa = r2(corrigido * p.multa / 100);
  return { dias, fator, corrigido, correcao: r2(corrigido - valor), juros, multa, total: r2(corrigido + juros + multa), faltando };
}

// Meses com valor não pago e vencidos antes da data de referência (o extrato precisa estar carregado)
function debitosContrato(ct, dataRef) {
  const ext = D.extratos[ct.id];
  if (!ext) return [];
  return calcularExtrato(ct, ext)
    .map(x => ({ ct, ym: x.ym, mes: x.mes, venc: vencimentoMes(ct, x.ym, x.mes), valor: x.c.emAberto, sit: x.c.situacao }))
    .filter(d => d.valor > 0 && d.venc < dataRef);
}

const somaCent = (lista, f) => lista.reduce((s, x) => s + cent(f(x)), 0) / 100;

/* ================= Índices de correção ================= */
// Busca a série em blocos de até 10 anos (limite da API), em paralelo
async function buscarSerieBCB(codigo, desdeAno) {
  const ultimo = new Date().getFullYear(), blocos = [];
  for (let a = desdeAno; a <= ultimo; a += 10) blocos.push([a, Math.min(a + 9, ultimo)]);
  const partes = await Promise.all(blocos.map(async ([de, ate]) => {
    const r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados?formato=json&dataInicial=01/01/${de}&dataFinal=31/12/${ate}`);
    if (r.status === 404) return [];
    if (!r.ok) throw new Error(`Banco Central: erro ${r.status}.`);
    return r.json();
  }));
  const valores = {};
  for (const { data, valor } of partes.flat()) {
    const [, m, y] = data.split('/');
    valores[`${y}-${m}`] = Number(valor);
  }
  return valores;
}

// valores = { nome: { 'AAAA-MM': % } } — uma única gravação para vários índices
async function salvarIndices(valores) {
  await backupDiario();
  return comTrava(async () => {
  const atual = await lerJSON('indices.json', { series: {} });
  atual.series = atual.series || {};
  for (const [nome, v] of Object.entries(valores)) atual.series[nome] = { ...(atual.series[nome] || {}), ...v };
  atual.rev = (atual.rev || 0) + 1;
  atual.atualizadoEm = new Date().toISOString();
  await Armaz.gravar('indices.json', JSON.stringify(atual));
  D.indices = atual;
  });
}

// Busca no Banco Central os índices informados (desde o último ano já gravado) e grava tudo de uma vez
async function atualizarIndicesBCB(nomes) {
  const res = await Promise.all(nomes.map(async nome => {
    const meses = Object.keys(D.indices?.series?.[nome] || {}).sort();
    const desde = meses.length ? +meses[meses.length - 1].slice(0, 4) - 1 : 2000;
    return [nome, await buscarSerieBCB(SERIES_BCB[nome], desde)];
  }));
  const valores = Object.fromEntries(res.filter(([, v]) => Object.keys(v).length));
  if (!Object.keys(valores).length) throw new Error('O Banco Central não retornou dados.');
  await salvarIndices(valores);
  return Object.fromEntries(res.map(([n, v]) => [n, Object.keys(v).length]));
}

// Atualiza em silêncio os índices sem o mês anterior ao atual (no máximo a cada 6 horas por aparelho)
let atualizandoIndices = null;
function garantirIndices() {
  if (atualizandoIndices) return atualizandoIndices;
  const precisa = addMes(mesAtual(), -1);
  const nomes = Object.keys(SERIES_BCB).filter(nome => {
    if ((D.indices?.series?.[nome] || {})[precisa] !== undefined) return false;
    return Date.now() - +(localStorage.getItem('cl-idx-' + nome) || 0) > 6 * 3600e3;
  });
  if (!nomes.length) return Promise.resolve();
  nomes.forEach(n => localStorage.setItem('cl-idx-' + n, String(Date.now())));
  atualizandoIndices = atualizarIndicesBCB(nomes)
    .catch(e => console.warn('Índices de correção', e))
    .finally(() => { atualizandoIndices = null; });
  return atualizandoIndices;
}

// Mostra um aviso na tela enquanto os índices são buscados (só demora na primeira vez)
async function aguardarIndices() {
  const p = garantirIndices();
  const t = setTimeout(() => { $('#conteudo').innerHTML = '<p class="carregando">Atualizando os índices de correção no Banco Central…</p>'; }, 300);
  try { await p; } finally { clearTimeout(t); }
}

function secaoIndicesHTML() {
  const linhas = Object.keys(SERIES_BCB).map(nome => {
    const s = D.indices?.series?.[nome] || {};
    const meses = Object.keys(s).sort();
    const u = meses[meses.length - 1];
    return `<tr><td><b>${nome}</b></td><td class="num">${meses.length}</td><td>${meses.length ? nomeMes(meses[0]) + ' a ' + nomeMes(u) : '—'}</td>
      <td class="num">${u ? fmtPct(s[u]) + '%' : ''}</td><td><button class="bt pequeno" data-idx="${nome}">Atualizar</button></td></tr>`;
  }).join('');
  return `<section class="cartao form" id="secIndices">
    <h2>Índices de correção monetária</h2>
    <p class="dica">Variações mensais (%) usadas para corrigir os débitos, obtidas do Banco Central (Sistema Gerenciador de Séries). O aplicativo atualiza os índices automaticamente ao calcular débitos; use os botões para forçar a atualização. O fator de correção acumula a variação do mês do vencimento até o mês anterior ao da data do cálculo.</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Índice</th><th class="num">Meses</th><th>Período</th><th class="num">Último</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>
    <div class="acoes-linha"><button class="bt" id="btIdxTodos">Atualizar todos pelo Banco Central</button></div>
    <details class="detalhes"><summary>Informar índices manualmente</summary>
      <p class="dica">Uma linha por mês, no formato <b>MM/AAAA;variação</b> (ex.: <code>09/2026;0,45</code>). Também é possível colar duas colunas copiadas de uma planilha. Os meses informados substituem os existentes.</p>
      <div class="grade-form"><div class="campo"><label for="idxManualNome">Índice</label><select id="idxManualNome">${Object.keys(SERIES_BCB).map(n => `<option>${n}</option>`).join('')}</select></div></div>
      <textarea id="idxManual" rows="5" placeholder="09/2026;0,45"></textarea>
      <div class="acoes-linha"><button class="bt" id="btIdxManual">Incluir valores</button></div>
    </details>
  </section>`;
}

// Redesenha só a seção dos índices, sem perder o que foi digitado no resto das Configurações
function redesenharIndices() {
  $('#secIndices').outerHTML = secaoIndicesHTML();
  ligarIndices();
}

function ligarIndices() {
  const atualizar = async nomes => {
    const qtd = await atualizarIndicesBCB(nomes);
    aviso('Recebido do Banco Central: ' + Object.entries(qtd).map(([n, q]) => `${n} (${q} meses)`).join(', ') + '.');
    redesenharIndices();
  };
  $$('[data-idx]').forEach(b => b.addEventListener('click', () => executar(async () => {
    b.disabled = true; b.textContent = 'Buscando…';
    await atualizar([b.dataset.idx]);
  })));
  $('#btIdxTodos').addEventListener('click', e => executar(async () => {
    e.target.disabled = true; e.target.textContent = 'Buscando…';
    await atualizar(Object.keys(SERIES_BCB));
  }));
  $('#btIdxManual').addEventListener('click', () => executar(async () => {
    const valores = {};
    for (const linha of $('#idxManual').value.split(/\r?\n/)) {
      const m = linha.match(/(\d{1,2})[\/.-](\d{4})\D+?(-?\d+(?:[.,]\d+)?)/) || linha.match(/(\d{4})-(\d{2})\D+?(-?\d+(?:[.,]\d+)?)/);
      if (!m) continue;
      const [mes, ano] = m[1].length === 4 ? [m[2], m[1]] : [m[1], m[2]];
      valores[`${ano}-${p2(+mes)}`] = Number(m[3].replace(',', '.'));
    }
    const qtd = Object.keys(valores).length;
    if (!qtd) throw new Error('Nenhuma linha no formato MM/AAAA;variação.');
    const nome = $('#idxManualNome').value;
    await salvarIndices({ [nome]: valores });
    aviso(`${nome}: ${qtd} mês(es) incluídos.`);
    redesenharIndices();
  }));
}

/* ================= Exportação genérica (PDF e Excel) ================= */
// cols: [{ t, w, tipo: 'texto' | 'moeda' | 'data' | 'inteiro' | 'fator', xw (largura no Excel) }]
// linhas: [{ c: [valores], total, grupo }]
function fmtCelula(v, tipo) {
  if (v === null || v === undefined || v === '') return '';
  if (tipo === 'moeda') return fmtNum(v);
  if (tipo === 'data') return fmtData(v);
  if (tipo === 'fator') return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 6, maximumFractionDigits: 6 });
  return String(v);
}

function pdfDeTabela({ titulo, linhasTitulo = [], cols, linhas, paisagem, notas = [], resumo }) {
  const P = novoDocumento(paisagem);
  P.cab();
  tituloPDF(P, titulo, linhasTitulo);
  const soma = cols.reduce((s, c) => s + c.w, 0);
  const colsPDF = cols.map(c => ({ t: c.t, w: c.w * P.larg / soma, a: ['moeda', 'inteiro', 'fator'].includes(c.tipo) ? 'r' : c.a, nw: c.tipo === 'data' || c.nw }));
  tabelaPDF(P, colsPDF, linhas.map(l => ({ c: l.c.map((v, i) => fmtCelula(v, cols[i].tipo)), total: l.total, grupo: l.grupo })), 8);
  if (resumo) resumoPDF(P, resumo, paisagem ? 140 : 118);
  notas.forEach(n => { paragrafoPDF(P, n, 7.5, 'normal', COR_SUAVE); P.y += 1; });
  rodapePDF(P);
  return P.doc;
}

function linhasXLSX(cols, linhas) {
  return linhas.map(l => l.c.map((v, i) => {
    const tp = cols[i].tipo, tot = l.total || l.grupo;
    if (v === null || v === undefined || v === '') return tot ? { v: '', s: 'bt' } : null;
    if (tp === 'moeda') return { v: Number(v), s: tot ? 'mt' : 'm' };
    if (tp === 'data') return { v, s: 'd' };
    if (tp === 'inteiro') return { v: Number(v), s: tot ? 'it' : 'i' };
    if (tp === 'fator') return { v: Number(v), s: 'f' };
    return { v: String(v), s: tot ? 'bt' : 't' };
  }));
}

// Dados da administradora no topo das planilhas
function cabecalhoXLSX() {
  const a = D.config.administradora || {};
  if (!a.nome) return [];
  return [
    [{ v: a.nome, s: 'b' }],
    ...[[a.documento, a.creci && 'CRECI ' + a.creci].filter(Boolean).join('  ·  '), a.endereco, [a.telefone, a.email, a.site].filter(Boolean).join('  ·  ')].filter(Boolean).map(t => [t]),
    null,
  ];
}

function xlsxDeTabela({ titulo, linhasTitulo = [], cols, linhas, nomeFolha, notas = [] }) {
  const L = [...cabecalhoXLSX(), [{ v: titulo, s: 'tit' }], ...linhasTitulo.map(t => [t]), null, { c: cols.map(c => ({ v: c.t, s: 'cab' })), altura: 30 }];
  const congelar = L.length;
  L.push(...linhasXLSX(cols, linhas));
  if (notas.length) { L.push(null); notas.forEach(n => L.push([n])); }
  return gerarXLSX([{ nome: nomeFolha, linhas: L, larguras: cols.map(c => c.xw || 14), congelar }]);
}

const oferecerArquivo = salvarPlanilha;

/* ================= Cálculo do débito de um contrato ================= */
function montarDebito(ct, st) {
  const p = st.p;
  const itens = [
    ...debitosContrato(ct, st.data).map(d => ({ id: d.ym, ref: mesNum(d.ym), ym: d.ym, venc: d.venc, valor: d.valor, parcial: d.sit === 'parcial' })),
    ...st.extras.filter(x => x.venc && x.valor).map(x => ({ id: x.id, ref: x.desc || 'Outro débito', venc: x.venc, valor: x.valor, extra: true })),
  ].sort((a, b) => comparar(a.venc, b.venc));
  const faltando = new Set();
  const linhas = itens.map(it => {
    const e = encargosMoratorios(it.valor, it.venc, st.data, p);
    e.faltando.forEach(m => faltando.add(m));
    return { ...it, e, incluido: !st.fora.has(it.id) };
  });
  const inc = linhas.filter(l => l.incluido);
  const tot = {
    original: somaCent(inc, l => l.valor), correcao: somaCent(inc, l => l.e.correcao), corrigido: somaCent(inc, l => l.e.corrigido),
    juros: somaCent(inc, l => l.e.juros), multa: somaCent(inc, l => l.e.multa), subtotal: somaCent(inc, l => l.e.total),
  };
  tot.honorarios = r2(tot.subtotal * p.honorarios / 100);
  tot.total = r2(tot.subtotal + tot.honorarios);
  return { linhas, inc, tot, faltando: [...faltando].sort() };
}

const descCriterios = (p, data) => `Débito atualizado até ${fmtData(data)}. Correção monetária: ${p.indice === 'Nenhum' ? 'não aplicada' : p.indice + (p.ignorarNegativos ? ' (desconsiderados os índices negativos)' : '')}. Juros de mora: ${fmtPct(p.juros)}% ao mês, pro rata die. Multa: ${fmtPct(p.multa)}%. Honorários advocatícios: ${fmtPct(p.honorarios)}%.`;
const notaMetodo = 'Critérios: o fator de correção acumula a variação mensal do índice desde o mês do vencimento até o mês anterior ao da data do cálculo (fonte: Banco Central do Brasil, SGS). Os juros incidem sobre o valor corrigido, à taxa mensal dividida por 30, multiplicada pelos dias de atraso. A multa incide sobre o valor corrigido. Os honorários incidem sobre o total do débito (valor corrigido + juros + multa).';
const notaFaltando = f => f.length ? `Atenção: índice não disponível para ${f.map(m => m.split('-').reverse().join('/')).join(', ')} (considerado 0%).` : '';

async function telaDebito(cid) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  await carregarExtrato(cid);
  await aguardarIndices();
  const im = D.imoveis[ct.imovelId], lt = D.locatarios[ct.locatarioId];
  const st = { data: hoje(), p: paramsMora(ct), fora: new Set(), extras: [] };

  $('#conteudo').innerHTML = cabecalho('Cálculo do débito',
    `${esc(rotuloContrato(ct))} · ${esc(descImovel(im))}<br>Locatário: <b>${esc(lt?.nome || '—')}</b> · Cliente: <b>${esc(nomeDe('locadores', ct.locadorId))}</b>`,
    botoesPDF('debPdf') + `<button class="bt primario" id="btDebXlsx">Salvar planilha Excel</button>`,
    `<a class="voltar" href="#/contrato/${cid}">&larr; ${esc(rotuloContrato(ct))}</a>`) + `
  <section class="cartao form">
    <h2>Critérios do cálculo</h2>
    <div class="grade-form">
      <div class="campo"><label for="dData">Data do cálculo</label><input type="date" id="dData" value="${st.data}"></div>
      <div class="campo"><label for="dIndice">Correção monetária</label><select id="dIndice">${[...Object.keys(SERIES_BCB), 'Nenhum'].map(i => `<option${i === st.p.indice ? ' selected' : ''}>${i}</option>`).join('')}</select></div>
      <div class="campo"><label for="dMulta">Multa (%)</label><input id="dMulta" class="num" inputmode="decimal" value="${fmtPct(st.p.multa)}"></div>
      <div class="campo"><label for="dJuros">Juros (% ao mês, pro rata die)</label><input id="dJuros" class="num" inputmode="decimal" value="${fmtPct(st.p.juros)}"></div>
      <div class="campo"><label for="dHon">Honorários advocatícios (%)</label><input id="dHon" class="num" inputmode="decimal" value="${fmtPct(st.p.honorarios)}"></div>
      <div class="campo w2"><label>&nbsp;</label><label class="inline"><input type="checkbox" id="dNeg"${st.p.ignorarNegativos ? ' checked' : ''}> Desconsiderar índices negativos</label></div>
    </div>
    <p class="dica">Os valores vêm do cadastro do contrato e podem ser alterados só para este cálculo.</p>
  </section>
  <section class="cartao">
    <div class="cartao-cab"><h2>Débitos vencidos até a data do cálculo</h2><div class="acoes"><button class="bt pequeno" id="btAddExtra">+ Outro débito</button></div></div>
    <div id="tabDeb"></div>
    <p class="alerta" id="avisoIdx" hidden></p>
  </section>
  <section class="cartao"><h2>Total do débito</h2><div class="resumo resumo-estreito" id="totDeb"></div></section>`;

  const render = () => {
    const d = montarDebito(ct, st);
    const extras = st.extras.map(x => `<tr class="extra" data-extra="${x.id}"><td></td>
      <td><input data-c="desc" value="${esc(x.desc)}" placeholder="Descrição (ex.: reparos)"></td>
      <td><input type="date" data-c="venc" value="${esc(x.venc)}"></td>
      <td><input class="num" inputmode="decimal" data-tipo="money" data-c="valor" value="${x.valor ? fmtNum(x.valor) : ''}"></td>
      <td colspan="5" class="dica">${x.venc && x.valor ? '' : 'Informe o vencimento e o valor.'}</td><td><button class="bt-x" data-del="${x.id}" title="Remover">&times;</button></td></tr>`).join('');
    $('#tabDeb').innerHTML = d.linhas.length || st.extras.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th></th><th>Referência</th><th>Vencimento</th><th class="num">Valor em aberto</th><th class="num">Fator de correção</th><th class="num">Valor corrigido</th><th class="num">Dias</th><th class="num">Juros</th><th class="num">Multa</th><th class="num">Total</th></tr></thead><tbody>
      ${d.linhas.map(l => `<tr class="${l.incluido ? '' : 'excluido'}"><td><input type="checkbox" data-inc="${l.id}"${l.incluido ? ' checked' : ''} title="Incluir no cálculo"></td>
        <td>${l.ym ? `<a href="#/contrato/${cid}/${l.ym}">${esc(l.ref)}</a>` : esc(l.ref)}${l.parcial ? ' <span class="chip aberto">saldo parcial</span>' : ''}</td><td>${fmtData(l.venc)}</td>
        <td class="num">${fmtNum(l.valor)}</td><td class="num">${fmtCelula(l.e.fator, 'fator')}</td><td class="num">${fmtNum(l.e.corrigido)}</td><td class="num">${l.e.dias}</td>
        <td class="num">${fmtNum(l.e.juros)}</td><td class="num">${fmtNum(l.e.multa)}</td><td class="num"><b>${fmtNum(l.e.total)}</b></td></tr>`).join('')}
      ${extras}
      <tr class="subtotal"><td></td><td>Totais</td><td></td><td class="num">${fmtNum(d.tot.original)}</td><td></td><td class="num">${fmtNum(d.tot.corrigido)}</td><td></td><td class="num">${fmtNum(d.tot.juros)}</td><td class="num">${fmtNum(d.tot.multa)}</td><td class="num">${fmtNum(d.tot.subtotal)}</td></tr>
      </tbody></table></div>` : `<p class="vazio">Nenhum débito vencido até ${fmtData(st.data)}. Os meses aparecem aqui quando estão marcados como <b>não pagos</b> (ou pagos em parte) e o vencimento já passou.</p>`;
    const t = d.tot;
    $('#totDeb').innerHTML = [
      ['Valor original em aberto', t.original], ['(+) Correção monetária', t.correcao], ['(+) Juros de mora', t.juros], ['(+) Multa', t.multa],
      ['(=) Subtotal', t.subtotal, 'dest'], [`(+) Honorários advocatícios (${fmtPct(st.p.honorarios)}%)`, t.honorarios], ['(=) Total do débito', t.total, 'final'],
    ].map(([r, v, c]) => `<div class="res-l ${c || ''}"><span>${r}</span><b>${fmtMoeda(v)}</b></div>`).join('');
    const av = notaFaltando(d.faltando);
    $('#avisoIdx').hidden = !av;
    $('#avisoIdx').textContent = av + (av ? ' Atualize os índices em Configurações ou informe-os manualmente.' : '');
    return d;
  };
  render();

  const num = id => r2(parseValor($(id).value));
  $('#dData').addEventListener('change', e => { if (e.target.value) { st.data = e.target.value; render(); } });
  $('#dIndice').addEventListener('change', e => { st.p.indice = e.target.value; render(); });
  $('#dNeg').addEventListener('change', e => { st.p.ignorarNegativos = e.target.checked; render(); });
  [['#dMulta', 'multa'], ['#dJuros', 'juros'], ['#dHon', 'honorarios']].forEach(([id, k]) => $(id).addEventListener('change', () => { st.p[k] = num(id); render(); }));
  $('#tabDeb').addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.inc) { if (t.checked) st.fora.delete(t.dataset.inc); else st.fora.add(t.dataset.inc); return render(); }
    const tr = t.closest('[data-extra]');
    if (tr && t.dataset.c) {
      const x = st.extras.find(z => z.id === tr.dataset.extra);
      x[t.dataset.c] = t.dataset.c === 'valor' ? r2(parseValor(t.value)) : t.value;
      render();
    }
  });
  $('#tabDeb').addEventListener('click', e => {
    if (!e.target.dataset.del) return;
    st.extras = st.extras.filter(x => x.id !== e.target.dataset.del);
    render();
  });
  $('#btAddExtra').addEventListener('click', () => { st.extras.push({ id: novoId(), desc: '', venc: '', valor: 0 }); render(); $('#tabDeb tr.extra:last-of-type input').focus(); });

  const validar = () => { const d = montarDebito(ct, st); if (!d.inc.length) throw new Error('Não há débitos incluídos no cálculo.'); return d; };
  ligarBotoesPDF('debPdf', async () => ({ doc: pdfDebito(ct, validar(), st), nome: nomeArquivo('debito', 'contrato', ct.codigo, st.data) + '.pdf' }));
  $('#btDebXlsx').addEventListener('click', () => executar(async () => {
    const d = validar();
    oferecerArquivo(xlsxDebito(ct, d, st), nomeArquivo('planilha-debito', 'contrato', ct.codigo, st.data) + '.xlsx');
  }));
}

function cabecalhoDebito(ct) {
  const lt = D.locatarios[ct.locatarioId];
  return [
    `${rotuloContrato(ct)} - ${descImovel(D.imoveis[ct.imovelId])}`,
    `Locatário: ${lt?.nome || '—'}${lt?.documento ? ' (CPF/CNPJ ' + lt.documento + ')' : ''}   ·   Cliente (locador): ${nomeDe('locadores', ct.locadorId)}`,
  ];
}

function pdfDebito(ct, d, st) {
  const [l1, l2] = cabecalhoDebito(ct);
  const t = d.tot;
  return pdfDeTabela({
    titulo: 'Demonstrativo de débito', paisagem: true,
    linhasTitulo: [[l1, 10, 'bold'], [l2, 9], [descCriterios(st.p, st.data), 8.5, 'normal', COR_SUAVE]],
    cols: [{ t: 'Referência', w: 50 }, { t: 'Vencimento', w: 24, tipo: 'data' }, { t: 'Valor original', w: 28, tipo: 'moeda' }, { t: 'Fator de correção', w: 24, tipo: 'fator' },
      { t: 'Valor corrigido', w: 28, tipo: 'moeda' }, { t: 'Dias de atraso', w: 16, tipo: 'inteiro' }, { t: 'Juros', w: 30, tipo: 'moeda' }, { t: 'Multa', w: 30, tipo: 'moeda' }, { t: 'Total', w: 39, tipo: 'moeda' }],
    linhas: [
      ...d.inc.map(l => ({ c: [l.ref + (l.parcial ? ' (saldo)' : ''), l.venc, l.valor, l.e.fator, l.e.corrigido, l.e.dias, l.e.juros, l.e.multa, l.e.total] })),
      { c: ['Totais', '', t.original, '', t.corrigido, '', t.juros, t.multa, t.subtotal], total: true },
    ],
    resumo: [
      ['Valor original em aberto', t.original], ['(+) Correção monetária', t.correcao], ['(+) Juros de mora', t.juros], ['(+) Multa', t.multa],
      ['(=) Subtotal', t.subtotal, 'b'], [`(+) Honorários advocatícios (${fmtPct(st.p.honorarios)}%)`, t.honorarios], ['(=) Total do débito', t.total, 'f'],
    ],
    notas: [notaMetodo, notaFaltando(d.faltando)].filter(Boolean),
  });
}

// Planilha com fórmulas: os percentuais e a data podem ser alterados no próprio Excel
function xlsxDebito(ct, d, st) {
  const p = st.p, [l1, l2] = cabecalhoDebito(ct);
  const L = [...cabecalhoXLSX(), [{ v: 'Planilha de débito', s: 'tit' }], [l1], [l2], null];
  // Parâmetros: as fórmulas apontam para estas células (coluna B)
  const param = (rotulo, valor) => { L.push([{ v: rotulo, s: 'b' }, valor]); return '$B$' + L.length; };
  const DATA = param('Data do cálculo', { v: st.data, s: 'd' });
  param('Índice de correção monetária', p.indice + (p.ignorarNegativos ? ' (sem índices negativos)' : ''));
  const MULTA = param('Multa', { v: p.multa / 100, s: 'p' });
  const JUROS = param('Juros de mora ao mês (pro rata die)', { v: p.juros / 100, s: 'p' });
  const HON = param('Honorários advocatícios', { v: p.honorarios / 100, s: 'p' });
  L.push(null, { c: ['Referência', 'Vencimento', 'Valor original', 'Fator de correção', 'Valor corrigido', 'Dias de atraso', 'Juros', 'Multa', 'Total'].map(v => ({ v, s: 'cab' })), altura: 30 });
  const ini = L.length + 1;
  for (const l of d.inc) {
    const n = L.length + 1;
    L.push([l.ref, { v: l.venc, s: 'd' }, { v: l.valor, s: 'm' }, { v: l.e.fator, s: 'f' },
      { f: `ROUND(C${n}*D${n},2)`, v: l.e.corrigido, s: 'm' }, { f: `MAX(0,${DATA}-B${n})`, v: l.e.dias, s: 'i' },
      { f: `ROUND(E${n}*${JUROS}/30*F${n},2)`, v: l.e.juros, s: 'm' }, { f: `IF(F${n}>0,ROUND(E${n}*${MULTA},2),0)`, v: l.e.multa, s: 'm' },
      { f: `E${n}+G${n}+H${n}`, v: l.e.total, s: 'm' }]);
  }
  const fim = L.length, nt = L.length + 1, t = d.tot;
  const soma = (col, v) => ({ f: `SUM(${col}${ini}:${col}${fim})`, v, s: 'mt' });
  L.push([{ v: 'Totais', s: 'bt' }, { v: '', s: 'bt' }, soma('C', t.original), { v: '', s: 'bt' }, soma('E', t.corrigido), { v: '', s: 'bt' }, soma('G', t.juros), soma('H', t.multa), soma('I', t.subtotal)]);
  L.push(null);
  const ns = L.length + 1;
  L.push([{ v: 'Subtotal (valor corrigido + juros + multa)', s: 'b' }, null, null, null, null, null, null, null, { f: `I${nt}`, v: t.subtotal, s: 'm' }]);
  const nh = L.length + 1;
  L.push([{ v: 'Honorários advocatícios', s: 'b' }, null, null, null, null, null, null, null, { f: `ROUND(I${ns}*${HON},2)`, v: t.honorarios, s: 'm' }]);
  L.push([{ v: 'Total do débito', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { v: '', s: 'bt' }, { f: `I${ns}+I${nh}`, v: t.total, s: 'mt' }]);
  L.push(null);
  L.push([notaMetodo]);
  L.push(['Os fatores de correção foram calculados para a data do cálculo informada. Se a data for alterada na planilha, os dias, juros, multa e honorários são recalculados, mas os fatores de correção não.']);
  if (d.faltando.length) L.push([notaFaltando(d.faltando)]);
  return gerarXLSX([{ nome: 'Débito', linhas: L, larguras: [36, 13, 15, 15, 15, 11, 13, 13, 15] }]);
}

/* ================= Inadimplência ================= */
async function telaInadimplencia(h) {
  const q = new URLSearchParams(h.split('?')[1] || '');
  const st = { data: q.get('data') || hoje(), tipo: q.get('tipo') || 'todos', id: q.get('id') || '', agrupar: q.get('agrupar') || 'locatario', hon: q.get('hon') === '1' };
  const todos = Object.values(D.contratos).sort(ordemContrato);
  await Promise.all(todos.map(c => carregarExtrato(c.id)));
  await aguardarIndices();

  const filtro = ct => st.tipo === 'todos' || !st.id ? true
    : st.tipo === 'contrato' ? ct.id === st.id : st.tipo === 'locatario' ? ct.locatarioId === st.id : ct.locadorId === st.id;
  const itens = todos.filter(filtro).flatMap(ct => debitosContrato(ct, st.data).map(d => {
    const p = paramsMora(ct);
    const e = encargosMoratorios(d.valor, d.venc, st.data, p);
    const hon = st.hon ? r2(e.total * p.honorarios / 100) : 0;
    return { ...d, e, hon, encargos: r2(e.total - d.valor + hon), atualizado: r2(e.total + hon) };
  }));
  const chave = { contrato: d => d.ct.id, locatario: d => d.ct.locatarioId, locador: d => d.ct.locadorId }[st.agrupar];
  const rotulo = { contrato: d => rotuloContrato(d.ct) + ' · ' + descImovel(D.imoveis[d.ct.imovelId]), locatario: d => 'Locatário: ' + nomeDe('locatarios', d.ct.locatarioId), locador: d => 'Cliente: ' + nomeDe('locadores', d.ct.locadorId) }[st.agrupar];
  const grupos = new Map();
  for (const d of itens) { const k = chave(d); if (!grupos.has(k)) grupos.set(k, { rotulo: rotulo(d), itens: [] }); grupos.get(k).itens.push(d); }
  const lista = [...grupos.values()].sort((a, b) => comparar(a.rotulo, b.rotulo));
  lista.forEach(g => g.itens.sort((a, b) => ordemContrato(a.ct, b.ct) || comparar(a.ym, b.ym)));
  const tot = { valor: somaCent(itens, d => d.valor), encargos: somaCent(itens, d => d.encargos), atualizado: somaCent(itens, d => d.atualizado) };
  const maiorAtraso = itens.reduce((m, d) => Math.max(m, d.e.dias), 0);
  const faltando = [...new Set(itens.flatMap(d => d.e.faltando))].sort();

  const colDe = { contrato: 'contratos', locatario: 'locatarios', locador: 'locadores' };
  $('#conteudo').innerHTML = cabecalho('Inadimplência', `Débitos vencidos e não pagos até ${fmtData(st.data)}`,
    botoesPDF('inadPdf') + `<button class="bt" id="btInadXlsx">Salvar planilha Excel</button>`) + `
  <section class="cartao form">
    <div class="grade-form">
      <div class="campo"><label for="iData">Posição em</label><input type="date" id="iData" value="${st.data}"></div>
      <div class="campo"><label for="iTipo">Mostrar</label><select id="iTipo">
        <option value="todos"${st.tipo === 'todos' ? ' selected' : ''}>Todos</option>
        <option value="locatario"${st.tipo === 'locatario' ? ' selected' : ''}>Um locatário</option>
        <option value="contrato"${st.tipo === 'contrato' ? ' selected' : ''}>Um contrato</option>
        <option value="locador"${st.tipo === 'locador' ? ' selected' : ''}>Um cliente (locador)</option></select></div>
      <div class="campo w2"${st.tipo === 'todos' ? ' hidden' : ''} id="campoAlvo"><label for="iAlvo">Selecione</label><select id="iAlvo"><option value="">— todos —</option>
        ${st.tipo === 'todos' ? '' : opcoes(colDe[st.tipo]).map(([v, r]) => `<option value="${esc(v)}"${v === st.id ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
      <div class="campo"><label for="iAgrupar">Agrupar por</label><select id="iAgrupar">
        <option value="locatario"${st.agrupar === 'locatario' ? ' selected' : ''}>Locatário</option>
        <option value="contrato"${st.agrupar === 'contrato' ? ' selected' : ''}>Contrato</option>
        <option value="locador"${st.agrupar === 'locador' ? ' selected' : ''}>Cliente (locador)</option></select></div>
      <div class="campo w2"><label>&nbsp;</label><label class="inline"><input type="checkbox" id="iHon"${st.hon ? ' checked' : ''}> Incluir honorários advocatícios no valor atualizado</label></div>
    </div>
  </section>
  <div class="kpis">
    <div class="kpi"><span>Em aberto (valor original)</span><b class="${tot.valor ? 'neg' : ''}">${fmtMoeda(tot.valor)}</b></div>
    <div class="kpi"><span>Atualizado com encargos</span><b class="${tot.atualizado ? 'neg' : ''}">${fmtMoeda(tot.atualizado)}</b></div>
    <div class="kpi"><span>Contratos inadimplentes</span><b>${new Set(itens.map(d => d.ct.id)).size}</b></div>
    <div class="kpi"><span>Locatários inadimplentes</span><b>${new Set(itens.map(d => d.ct.locatarioId)).size}</b></div>
    <div class="kpi"><span>Maior atraso</span><b>${maiorAtraso} dia${maiorAtraso === 1 ? '' : 's'}</b></div>
  </div>
  <section class="cartao">
    ${itens.length ? `<div class="rolagem"><table class="tabela clicavel"><thead><tr><th>Contrato</th><th>Locatário</th><th>Cliente</th><th>Referência</th><th>Vencimento</th><th class="num">Dias</th><th class="num">Em aberto</th><th class="num">Encargos</th><th class="num">Atualizado</th></tr></thead><tbody>
      ${lista.map(g => `<tr class="grupo"><td colspan="9">${esc(g.rotulo)}</td></tr>` + g.itens.map(d => `<tr data-link="#/contrato/${d.ct.id}/${d.ym}">
        <td>${esc(d.ct.codigo)}</td><td>${esc(nomeDe('locatarios', d.ct.locatarioId))}</td><td>${esc(nomeDe('locadores', d.ct.locadorId))}</td>
        <td>${nomeMes(d.ym)}${d.sit === 'parcial' ? ' <span class="chip aberto">parcial</span>' : ''}</td><td>${fmtData(d.venc)}</td><td class="num">${d.e.dias}</td>
        <td class="num">${fmtNum(d.valor)}</td><td class="num">${fmtNum(d.encargos)}</td><td class="num"><b>${fmtNum(d.atualizado)}</b></td></tr>`).join('') +
        `<tr class="subtotal"><td colspan="6">Subtotal (${g.itens.length} mês${g.itens.length > 1 ? 'es' : ''})</td><td class="num">${fmtNum(somaCent(g.itens, d => d.valor))}</td><td class="num">${fmtNum(somaCent(g.itens, d => d.encargos))}</td><td class="num">${fmtNum(somaCent(g.itens, d => d.atualizado))}</td></tr>`).join('')}
      <tr class="total-geral"><td colspan="6">Total geral</td><td class="num">${fmtNum(tot.valor)}</td><td class="num">${fmtNum(tot.encargos)}</td><td class="num">${fmtNum(tot.atualizado)}</td></tr>
    </tbody></table></div>` : '<p class="vazio">Nenhum débito vencido e não pago para a seleção escolhida.</p>'}
    ${faltando.length ? `<p class="alerta">${esc(notaFaltando(faltando))}</p>` : ''}
    <p class="dica">Encargos: correção monetária, juros pro rata die e multa, conforme os critérios de cada contrato${st.hon ? ', mais honorários advocatícios' : ''}. Para o cálculo detalhado de um contrato, use <b>Cálculo do débito</b> na tela do contrato.</p>
  </section>`;
  ligarBusca();

  const ir = mud => {
    const n = { ...st, ...mud };
    location.hash = '#/inadimplencia?' + new URLSearchParams({ data: n.data, tipo: n.tipo, id: n.tipo === 'todos' ? '' : n.id, agrupar: n.agrupar, hon: n.hon ? '1' : '0' });
  };
  $('#iData').addEventListener('change', e => { if (e.target.value) ir({ data: e.target.value }); });
  $('#iTipo').addEventListener('change', e => ir({ tipo: e.target.value, id: '', agrupar: e.target.value === 'todos' ? st.agrupar : e.target.value }));
  $('#iAlvo').addEventListener('change', e => ir({ id: e.target.value }));
  $('#iAgrupar').addEventListener('change', e => ir({ agrupar: e.target.value }));
  $('#iHon').addEventListener('change', e => ir({ hon: e.target.checked }));

  const filtroDesc = st.tipo === 'todos' || !st.id ? 'Todos os contratos'
    : { contrato: () => rotuloContrato(D.contratos[st.id]), locatario: () => 'Locatário: ' + nomeDe('locatarios', st.id), locador: () => 'Cliente: ' + nomeDe('locadores', st.id) }[st.tipo]();
  const exp = () => {
    if (!itens.length) throw new Error('Não há débitos para exportar.');
    const cols = [{ t: 'Contrato', w: 18, xw: 11 }, { t: 'Locatário', w: 46, xw: 30 }, { t: 'Cliente', w: 40, xw: 28 }, { t: 'Referência', w: 28, xw: 16 }, { t: 'Vencimento', w: 22, xw: 13 },
      { t: 'Dias', w: 13, tipo: 'inteiro', xw: 8 }, { t: 'Em aberto', w: 26, tipo: 'moeda', xw: 14 }, { t: 'Encargos', w: 26, tipo: 'moeda', xw: 14 }, { t: 'Atualizado', w: 28, tipo: 'moeda', xw: 15 }];
    const linhas = [];
    for (const g of lista) {
      linhas.push({ c: [g.rotulo, '', '', '', '', '', '', '', ''], grupo: true });
      g.itens.forEach(d => linhas.push({ c: [d.ct.codigo, nomeDe('locatarios', d.ct.locatarioId), nomeDe('locadores', d.ct.locadorId), mesNum(d.ym) + (d.sit === 'parcial' ? ' (parcial)' : ''), d.venc, d.e.dias, d.valor, d.encargos, d.atualizado] }));
      linhas.push({ c: ['Subtotal', '', '', '', '', '', somaCent(g.itens, d => d.valor), somaCent(g.itens, d => d.encargos), somaCent(g.itens, d => d.atualizado)], total: true });
    }
    linhas.push({ c: ['Total geral', '', '', '', '', '', tot.valor, tot.encargos, tot.atualizado], total: true });
    const sub = `${filtroDesc} · posição em ${fmtData(st.data)}`;
    const notas = [`Encargos: correção monetária, juros de mora pro rata die e multa, conforme os critérios de cada contrato${st.hon ? ', mais honorários advocatícios' : ''}.`, notaFaltando(faltando)].filter(Boolean);
    return { cols, linhas, sub, notas };
  };
  ligarBotoesPDF('inadPdf', async () => {
    const { cols, linhas, sub, notas } = exp();
    const doc = pdfDeTabela({ titulo: 'Relatório de inadimplência', paisagem: true, linhasTitulo: [[sub, 10, 'bold']], cols: cols.map(c => c.tipo ? c : { ...c, tipo: c.t === 'Vencimento' ? 'data' : undefined }), linhas, notas });
    return { doc, nome: nomeArquivo('inadimplencia', st.data) + '.pdf' };
  });
  $('#btInadXlsx').addEventListener('click', () => executar(async () => {
    const { cols, linhas, sub, notas } = exp();
    const blob = xlsxDeTabela({ titulo: 'Relatório de inadimplência', linhasTitulo: [sub], cols: cols.map(c => c.t === 'Vencimento' ? { ...c, tipo: 'data' } : c), linhas, nomeFolha: 'Inadimplência', notas });
    oferecerArquivo(blob, nomeArquivo('inadimplencia', st.data) + '.xlsx');
  }));
}

/* ================= Contratos vigentes ================= */
const ORDENS_VIGENTES = {
  locatario: ['Nome do locatário', 'locatario'], cliente: ['Nome do cliente (locador)', 'cliente'], imovel: ['Imóvel', 'imovel'],
  contrato: ['Número do contrato', 'contrato'], mesCorr: ['Mês de aplicação do reajuste', 'mesCorr', 'n'], prox: ['Próximo reajuste', 'prox'],
  dia: ['Dia de vencimento do aluguel', 'dia', 'n'], fim: ['Término do contrato', 'fim'], inicio: ['Início do contrato', 'inicio'], aluguel: ['Valor do aluguel', 'aluguel', 'n'],
};

function telaVigentes() {
  let ord = { k: 'locatario', d: 1 };
  try { Object.assign(ord, JSON.parse(sessionStorage.getItem('cl-vig') || '{}')); } catch { /* usa o padrão */ }
  if (!ORDENS_VIGENTES[ord.k]) ord = { k: 'locatario', d: 1 };
  const atual = mesAtual(), h = hoje();
  const dados = contratosAtivos().map(ct => ({
    ct, contrato: ct.codigo, locatario: nomeDe('locatarios', ct.locatarioId), cliente: nomeDe('locadores', ct.locadorId),
    imovel: descImovel(D.imoveis[ct.imovelId]), inicio: ct.inicio || '', fim: ct.fim || '', dia: Number(ct.diaVencimento) || 0,
    mesCorr: mesCorrecaoDe(ct) || 0, prox: proximoReajuste(ct), indice: ct.indiceReajuste || '', aluguel: Number(ct.valorAluguel) || 0,
  }));
  const [, campo, tipo] = ORDENS_VIGENTES[ord.k];
  const vazio = ord.k === 'fim' ? '9999' : '';
  dados.sort((a, b) => {
    let r = tipo === 'n' ? (a[campo] || 99) - (b[campo] || 99) : comparar(a[campo] || vazio, b[campo] || vazio);
    if (!r) r = comparar(a.locatario, b.locatario);
    return r * ord.d;
  });
  const situacaoFim = fim => {
    if (!fim) return '';
    const dias = diasEntre(h, fim);
    if (dias < 0) return ' <span class="chip pendente">Prazo encerrado</span>';
    if (dias <= 90) return ` <span class="chip aberto">em ${dias} dia${dias === 1 ? '' : 's'}</span>`;
    return '';
  };
  const situacaoReaj = prox => prox === atual ? ' <span class="chip aberto">Este mês</span>' : prox === addMes(atual, 1) ? ' <span class="chip neutro">Próximo mês</span>' : '';
  const th = (k, t, cls = '') => `<th class="ordenavel ${cls}" data-ord="${k}">${t}${ord.k === k ? (ord.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;

  $('#conteudo').innerHTML = cabecalho('Contratos vigentes', `${dados.length} contrato${dados.length === 1 ? '' : 's'} ativo${dados.length === 1 ? '' : 's'}`,
    botoesPDF('vigPdf') + `<button class="bt" id="btVigXlsx">Salvar planilha Excel</button>`) + `
  <section class="cartao">
    <div class="cartao-cab"><div class="acoes">
      <label class="inline">Ordenar por <select id="vigOrd">${Object.entries(ORDENS_VIGENTES).map(([k, [r]]) => `<option value="${k}"${k === ord.k ? ' selected' : ''}>${r}</option>`).join('')}</select></label>
      <select id="vigDir"><option value="1"${ord.d > 0 ? ' selected' : ''}>Crescente</option><option value="-1"${ord.d < 0 ? ' selected' : ''}>Decrescente</option></select>
    </div><input type="search" id="busca" placeholder="Buscar…"></div>
    ${dados.length ? `<div class="rolagem"><table class="tabela clicavel"><thead><tr>
      ${th('contrato', 'Contrato')}${th('locatario', 'Locatário')}${th('cliente', 'Cliente')}${th('imovel', 'Imóvel')}${th('inicio', 'Início')}${th('fim', 'Término')}
      ${th('dia', 'Vencimento do aluguel', 'num')}${th('mesCorr', 'Mês do reajuste')}${th('prox', 'Próximo reajuste')}<th>Índice</th>${th('aluguel', 'Aluguel', 'num')}</tr></thead><tbody>
      ${dados.map(x => `<tr data-link="#/contrato/${x.ct.id}" data-busca="${esc([x.contrato, x.locatario, x.cliente, x.imovel].join(' ').toLowerCase())}">
        <td><b>${esc(x.contrato)}</b></td><td>${esc(x.locatario)}</td><td>${esc(x.cliente)}</td><td>${esc(x.imovel)}</td>
        <td>${fmtData(x.inicio)}</td><td>${x.fim ? fmtData(x.fim) : '<span class="dica">indeterminado</span>'}${situacaoFim(x.fim)}</td>
        <td class="num">${x.dia ? 'Dia ' + x.dia + (x.ct.vencMesSeguinte === 'sim' ? ' (mês seg.)' : '') : ''}</td>
        <td>${x.mesCorr ? MESES[x.mesCorr - 1] : ''}</td><td>${x.prox ? nomeMes(x.prox) : ''}${situacaoReaj(x.prox)}</td>
        <td>${esc(x.indice)}</td><td class="num">${fmtNum(x.aluguel)}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="vazio">Nenhum contrato ativo.</p>'}
  </section>`;
  ligarBusca();

  const ordenar = mud => { sessionStorage.setItem('cl-vig', JSON.stringify({ ...ord, ...mud })); telaVigentes(); };
  $('#vigOrd').addEventListener('change', e => ordenar({ k: e.target.value }));
  $('#vigDir').addEventListener('change', e => ordenar({ d: +e.target.value }));
  $$('th[data-ord]').forEach(t => t.addEventListener('click', () => ordenar(t.dataset.ord === ord.k ? { d: -ord.d } : { k: t.dataset.ord, d: 1 })));

  const exp = () => {
    if (!dados.length) throw new Error('Não há contratos para exportar.');
    const cols = [{ t: 'Contrato', w: 16, xw: 11 }, { t: 'Locatário', w: 38, xw: 30 }, { t: 'Cliente', w: 34, xw: 28 }, { t: 'Imóvel', w: 56, xw: 45 },
      { t: 'Início', w: 19, tipo: 'data', xw: 12 }, { t: 'Término', w: 19, tipo: 'data', xw: 12 }, { t: 'Venc. (dia)', w: 13, tipo: 'inteiro', xw: 10 },
      { t: 'Mês do reajuste', w: 20, xw: 14 }, { t: 'Próximo reajuste', w: 22, xw: 16 }, { t: 'Índice', w: 14, xw: 10 }, { t: 'Aluguel', w: 22, tipo: 'moeda', xw: 14 }];
    const linhas = dados.map(x => ({ c: [x.contrato, x.locatario, x.cliente, x.imovel, x.inicio, x.fim, x.dia || '', x.mesCorr ? MESES[x.mesCorr - 1] : '', x.prox ? mesNum(x.prox) : '', x.indice, x.aluguel] }));
    linhas.push({ c: ['Total', `${dados.length} contratos`, '', '', '', '', '', '', '', '', somaCent(dados, x => x.aluguel)], total: true });
    return { cols, linhas, sub: `Ordenados por ${ORDENS_VIGENTES[ord.k][0].toLowerCase()} (${ord.d > 0 ? 'crescente' : 'decrescente'}) · posição em ${fmtData(h)}` };
  };
  ligarBotoesPDF('vigPdf', async () => {
    const { cols, linhas, sub } = exp();
    return { doc: pdfDeTabela({ titulo: 'Contratos vigentes', paisagem: true, linhasTitulo: [[sub, 9.5]], cols, linhas }), nome: nomeArquivo('contratos-vigentes', h) + '.pdf' };
  });
  $('#btVigXlsx').addEventListener('click', () => executar(async () => {
    const { cols, linhas, sub } = exp();
    oferecerArquivo(xlsxDeTabela({ titulo: 'Contratos vigentes', linhasTitulo: [sub], cols, linhas, nomeFolha: 'Contratos vigentes' }), nomeArquivo('contratos-vigentes', h) + '.xlsx');
  }));
}
