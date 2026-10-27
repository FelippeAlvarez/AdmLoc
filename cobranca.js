'use strict';
/* Cobrança: débito atualizado com encargos moratórios, inadimplência, contratos vigentes e índices de correção */

// Séries do Banco Central (SGS): variação mensal (%) dos índices de correção e taxas mensais de juros (SELIC e taxa legal)
const SERIES_BCB = { 'IGP-M': 189, 'IPCA': 433, 'INPC': 188, 'IGP-DI': 190, 'IPCA-E': 10764, 'SELIC': 4390, 'Taxa legal': 29543 };
const DESDE_SERIE = { 'Taxa legal': 2024 };
const TAXAS_JUROS_BCB = ['SELIC', 'Taxa legal'];
// Índices de correção monetária (para escolha nos contratos e cálculos)
const INDICES_CORRECAO = ['IGP-M', 'IPCA', 'INPC', 'IGP-DI', 'IPCA-E', 'UFIR-RJ'];
const INDICES_REAJUSTE = INDICES_CORRECAO.filter(i => i !== 'UFIR-RJ');

// Valores anuais da UFIR-RJ (fonte: SEFAZ-RJ); novos anos podem ser incluídos em Administração › Índices
const UFIR_RJ_PADRAO = {
  2000: 1.0641, 2001: 1.1283, 2002: 1.2130, 2003: 1.3584, 2004: 1.4924, 2005: 1.6049, 2006: 1.6992,
  2007: 1.7495, 2008: 1.8258, 2009: 1.9372, 2010: 2.0183, 2011: 2.1352, 2012: 2.2752, 2013: 2.4066,
  2014: 2.5473, 2015: 2.7119, 2016: 3.0023, 2017: 3.1999, 2018: 3.2939, 2019: 3.4211, 2020: 3.5550,
  2021: 3.7053, 2022: 4.0915, 2023: 4.3329, 2024: 4.5373, 2025: 4.7508, 2026: 4.9604,
};
const tabelaUfir = () => ({ ...UFIR_RJ_PADRAO, ...(D.indices?.ufirRJ || {}) });

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
  // UFIR-RJ: valor do ano do cálculo dividido pelo do ano do vencimento
  if (indice === 'UFIR-RJ') {
    const t = tabelaUfir(), a0 = +mesVenc.slice(0, 4);
    let a1 = +mesCalc.slice(0, 4);
    if (a1 <= a0) return { fator: 1, faltando };
    if (!t[a0]) return { fator: 1, faltando: [String(a0)] };
    if (!t[a1]) { faltando.push(String(a1)); while (a1 > a0 && !t[a1]) a1--; }
    return { fator: Math.round(t[a1] / t[a0] * 1e6) / 1e6, faltando };
  }
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

const somaCent = (lista, f) => lista.reduce((s, x) => s + cent(f(x)), 0) / 100;

/* ================= Índices de correção ================= */
// Busca a série em blocos de até 10 anos (limite da API), um de cada vez e com novas tentativas:
// o Banco Central recusa muitos pedidos simultâneos
async function buscarSerieBCB(codigo, desdeAno) {
  const ultimo = new Date().getFullYear(), blocos = [];
  for (let a = desdeAno; a <= ultimo; a += 10) blocos.push([a, Math.min(a + 9, ultimo)]);
  const partes = [];
  for (const [de, ate] of blocos) {
    for (let tentativa = 1; ; tentativa++) {
      let r = null;
      try { r = await fetch(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados?formato=json&dataInicial=01/01/${de}&dataFinal=31/12/${ate}`); } catch { r = null; }
      if (r?.status === 404) break;
      if (r?.ok) { partes.push(await r.json()); break; }
      if (tentativa >= 3) throw new Error(`Banco Central: ${r ? 'erro ' + r.status : 'sem conexão'}.`);
      await new Promise(ok => setTimeout(ok, 800 * tentativa));
    }
  }
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
  const res = [];
  for (const nome of nomes) {
    const meses = Object.keys(D.indices?.series?.[nome] || {}).sort();
    const desde = meses.length ? +meses[meses.length - 1].slice(0, 4) - 1 : (DESDE_SERIE[nome] || 2000);
    res.push([nome, await buscarSerieBCB(SERIES_BCB[nome], desde)]);
  }
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
    return `<tr><td><b>${nome}</b>${TAXAS_JUROS_BCB.includes(nome) ? ' <span class="dica">(taxa de juros)</span>' : ''}</td><td class="num">${meses.length}</td><td>${meses.length ? nomeMes(meses[0]) + ' a ' + nomeMes(u) : '—'}</td>
      <td class="num">${u ? fmtPct(s[u]) + '%' : ''}</td><td><button class="bt pequeno" data-idx="${nome}">Atualizar</button></td></tr>`;
  }).join('');
  const ufir = Object.keys(tabelaUfir()).sort(), ultU = ufir[ufir.length - 1];
  return `<section class="cartao form" id="secIndices">
    <h2>Índices de correção monetária e taxas de juros</h2>
    <p class="dica">Variações mensais (%) usadas para corrigir os débitos e taxas mensais de juros (SELIC e taxa legal do art. 406 do Código Civil), obtidas do Banco Central (Sistema Gerenciador de Séries). O aplicativo atualiza tudo automaticamente ao calcular débitos; use os botões para forçar a atualização. O fator de correção acumula a variação do mês do vencimento até o mês anterior ao da data do cálculo. A UFIR-RJ (SEFAZ-RJ) tem um valor por ano: o fator é o valor do ano do cálculo dividido pelo do ano do vencimento.</p>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Índice</th><th class="num">Meses</th><th>Período</th><th class="num">Último</th><th></th></tr></thead><tbody>${linhas}
      <tr><td><b>UFIR-RJ</b> <span class="dica">(valor anual)</span></td><td class="num">${ufir.length} anos</td><td>${ufir[0]} a ${ultU}</td><td class="num">${Number(tabelaUfir()[ultU]).toLocaleString('pt-BR', { minimumFractionDigits: 4 })}</td><td></td></tr></tbody></table></div>
    <div class="acoes-linha"><button class="bt" id="btIdxTodos">Atualizar todos pelo Banco Central</button></div>
    <details class="detalhes"><summary>Informar índices manualmente</summary>
      <p class="dica">Uma linha por mês, no formato <b>MM/AAAA;variação</b> (ex.: <code>09/2026;0,45</code>). Para a UFIR-RJ, uma linha por ano: <b>AAAA;valor</b> (ex.: <code>2027;5,1234</code>). Também é possível colar duas colunas copiadas de uma planilha. Os valores informados substituem os existentes.</p>
      <div class="grade-form"><div class="campo"><label for="idxManualNome">Índice</label><select id="idxManualNome">${[...Object.keys(SERIES_BCB), 'UFIR-RJ'].map(n => `<option>${n}</option>`).join('')}</select></div></div>
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
    if ($('#idxManualNome').value === 'UFIR-RJ') {
      const anos = {};
      for (const linha of $('#idxManual').value.split(/\r?\n/)) {
        const m = linha.match(/(\d{4})\D+?(\d+(?:[.,]\d+)?)/);
        if (m && +m[1] >= 1990 && +m[1] <= 2100) anos[m[1]] = Number(m[2].replace(',', '.'));
      }
      if (!Object.keys(anos).length) throw new Error('Nenhuma linha no formato AAAA;valor.');
      await backupDiario();
      await comTrava(async () => {
        const atual = await lerJSON('indices.json', { series: {} });
        atual.ufirRJ = { ...(atual.ufirRJ || {}), ...anos };
        atual.rev = (atual.rev || 0) + 1;
        await Armaz.gravar('indices.json', JSON.stringify(atual));
        D.indices = atual;
      });
      aviso(`UFIR-RJ: ${Object.keys(anos).length} ano(s) incluído(s).`);
      return redesenharIndices();
    }
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

/* ================= Cálculo do débito: debito.js, debito-tela.js, debito-saida.js e motor.js ================= */
const notaFaltando = f => f.length ? `Atenção: índice não disponível para ${f.map(m => m.split('-').reverse().join('/')).join(', ')} (considerado 0%).` : '';

async function telaInadimplencia(h) {
  const q = new URLSearchParams(h.split('?')[1] || '');
  const st = { data: q.get('data') || hoje(), tipo: q.get('tipo') || 'todos', id: q.get('id') || '', agrupar: q.get('agrupar') || 'locatario', hon: q.get('hon') === '1' };
  const todos = Object.values(D.contratos).sort(ordemContrato);
  await Promise.all(todos.map(c => carregarExtrato(c.id)));
  await aguardarIndices();

  const filtro = ct => st.tipo === 'todos' || !st.id ? true
    : st.tipo === 'contrato' ? ct.id === st.id : st.tipo === 'locatario' ? ct.locatarioId === st.id : ct.locadorId === st.id;
  // Mesmo motor do Cálculo do débito: critérios do contrato e pagamentos já abatidos (art. 354 do CC)
  const itens = todos.filter(filtro).flatMap(ct => debitoPorMes(ct, st.data).map(d => {
    const p = paramsMora(ct);
    const hon = st.hon ? r2(d.total * p.honorarios / 100) : 0;
    return { ...d, e: { dias: d.dias, faltando: d.faltando }, hon, encargos: r2(d.total - d.valor + hon), atualizado: r2(d.total + hon) };
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
    <p class="dica">Encargos: correção monetária, juros e multa, conforme os critérios de cada contrato, já abatidos os pagamentos (pagamentos em parte lançados nos meses e os registrados no Cálculo do débito)${st.hon ? ', mais honorários advocatícios' : ''}. Para o cálculo detalhado de um contrato, use <b>Cálculo do débito</b> na tela do contrato.</p>
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
