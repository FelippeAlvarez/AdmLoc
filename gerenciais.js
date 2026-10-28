'use strict';
/*
  Relatórios gerenciais (PDF e Excel): clientes e imóveis, relação de imóveis, taxa de administração,
  informe de rendimentos, conferência para a DIMOB, repasses, vencimentos/reajustes e vacância.
  Cada relatório monta um "modelo" (título + seções com tabelas), desenhado em PDF ou gravado em Excel.
*/

const RELATORIOS = [
  ['demonstrativo', 'Demonstrativo / prestação de contas (contrato, imóvel ou cliente)'],
  ['clientes', 'Clientes e seus imóveis'],
  ['imoveis', 'Relação de imóveis (com e sem contrato ativo)'],
  ['taxa', 'Taxa de administração recebida'],
  ['informe', 'Informe de rendimentos para o Imposto de Renda (por cliente)'],
  ['dimob', 'Conferência para a DIMOB'],
  ['repasses', 'Repasses do período e saldos a repassar'],
  ['vencimentos', 'Contratos a vencer e reajustes próximos'],
  ['vacancia', 'Vacância (imóveis sem contrato ativo)'],
  ['recibos', 'Recibos de aluguel (vários de uma vez)'],
];

function seletorRelatorioHTML(rel) {
  return `<section class="cartao form"><div class="grade-form"><div class="campo wfull"><label for="tipoRelatorio">Relatório</label>
    <select id="tipoRelatorio">${RELATORIOS.map(([k, n]) => `<option value="${k}"${k === rel ? ' selected' : ''}>${n}</option>`).join('')}</select></div></div></section>`;
}
function ligarSeletorRelatorio() {
  $('#tipoRelatorio').addEventListener('change', e => { location.hash = '#/relatorios?rel=' + e.target.value; });
}

/* ---------- Dados ---------- */
const reais = c => c / 100;
const contratoAtivoDoImovel = id => Object.values(D.contratos).filter(c => c.imovelId === id && c.status !== 'encerrado').sort(ordemContrato)[0] || null;
const prazoEncerrado = ct => !!(ct?.fim && ct.fim < hoje());
const vigenciaTxt = ct => ct ? [fmtData(ct.inicio), ct.fim ? fmtData(ct.fim) : 'indeterminado'].filter(Boolean).join(' a ') : '';
const situacaoImovelTxt = ct => ct ? 'Locado' + (prazoEncerrado(ct) ? ' (prazo encerrado)' : '') : 'Disponível';
const pessoaDoc = (col, id) => { const p = D[col][id]; return p ? p.nome + (p.documento ? ' · ' + p.documento : '') : '—'; };
const somaC = (lista, k) => lista.reduce((s, x) => s + (x[k] || 0), 0);
function somarDias(iso, n) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }
function listaMeses(de, ate) { const l = []; for (let m = de; m <= ate; m = addMes(m, 1)) l.push(m); return l; }

async function extratosDe(contratos) {
  const exts = await Promise.all(contratos.map(ct => carregarExtrato(ct.id)));
  return contratos.map((ct, i) => ({ ct, ext: exts[i] }));
}

/*
  Recebimentos dos locatários (centavos), um por mês de referência pago ou pago em parte.
  "caixa": mês do pagamento (data informada); sem data (lançamentos antigos), o mês de referência.
*/
async function recebimentosDe(contratos) {
  const lista = [];
  for (const { ct, ext } of await extratosDe(contratos)) {
    for (const [ym, mes] of Object.entries(ext.meses)) {
      if (situacaoPagto(mes) === 'aberto') continue;
      const r = recebimentoMes(mes);
      if (!r.recebido && !r.taxa) continue;
      const data = mes.recebidoEm || '';
      lista.push({ ct, ym, data, caixa: data ? data.slice(0, 7) : ym, semData: !data, ...r });
    }
    // Pagamentos de débitos em atraso lançados na prestação de contas (Cálculo do débito), na data da disponibilização
    for (const v of Object.values(recebimentosLancados(ct, ext)).flat().filter(v => v.cobranca)) {
      lista.push({ ct, ym: v.ym, data: v.disponivelEm, caixa: v.ym, semData: false, cobranca: true, ...v.r });
    }
  }
  return lista;
}

/* ---------- Modelo → PDF / Excel ---------- */
/*
  modelo: { titulo, linhasTitulo: [texto], paisagem, arquivo, folha, notas: [texto],
            secoes: [{ cabecalho: { titulo, linhas }, novaPagina, titulo, direita, cols, linhas, vazio, notas, so: 'pdf' | 'xlsx' }] }
  cols: [{ t, w, tipo: 'texto' | 'moeda' | 'data' | 'inteiro' | 'pct', nw, xw }]; linhas: [{ c: [valores], total, grupo }]
*/
const fmtGer = (v, tipo) => tipo === 'pct' ? (v === '' || v == null ? '' : fmtPct(v) + '%') : fmtCelula(v, tipo);

function pdfDeModelo(m) {
  const P = novoDocumento(m.paisagem);
  P.cab();
  if (m.titulo) tituloPDF(P, m.titulo, (m.linhasTitulo || []).map((t, i) => [t, i ? 9 : 10, i ? 'normal' : 'bold', i ? COR_SUAVE : COR_TEXTO]));
  let primeira = true;
  for (const s of m.secoes) {
    if (s.so === 'xlsx') continue;
    if (s.novaPagina && !primeira) P.novaPagina();
    primeira = false;
    if (s.cabecalho) tituloPDF(P, s.cabecalho.titulo, (s.cabecalho.linhas || []).map((t, i) => [t, i ? 9 : 10, i ? 'normal' : 'bold', i ? COR_SUAVE : COR_TEXTO]));
    if (s.titulo) { P.espaco(30); subtituloPDF(P, s.titulo, s.direita); }
    if (s.cols && s.linhas.length) {
      const soma = s.cols.reduce((a, c) => a + c.w, 0);
      const cols = s.cols.map(c => ({ t: c.t, w: c.w * P.larg / soma, a: ['moeda', 'inteiro', 'pct'].includes(c.tipo) ? 'r' : c.a, nw: c.tipo === 'data' || c.nw }));
      tabelaPDF(P, cols, s.linhas.map(l => ({ c: l.c.map((v, i) => fmtGer(v, s.cols[i].tipo)), total: l.total, grupo: l.grupo })), 8);
    } else if (s.cols) { paragrafoPDF(P, s.vazio || 'Nenhum registro.', 8.5, 'italic', COR_SUAVE); P.y += 4; }
    (s.notas || []).forEach(n => { paragrafoPDF(P, n, 7.5, 'normal', COR_SUAVE); P.y += 1; });
  }
  (m.notas || []).forEach(n => { paragrafoPDF(P, n, 7.5, 'normal', COR_SUAVE); P.y += 1; });
  rodapePDF(P);
  return { doc: P.doc, nome: m.arquivo + '.pdf' };
}

function xlsxDeModelo(m) {
  const L = [...cabecalhoXLSX(), [{ v: m.titulo || m.secoes[0]?.cabecalho?.titulo || '', s: 'tit' }], ...(m.linhasTitulo || []).map(t => [t])];
  const larg = [];
  for (const s of m.secoes) {
    if (s.so === 'pdf') continue;
    L.push(null);
    if (s.cabecalho && (s !== m.secoes[0] || m.titulo)) { L.push([{ v: s.cabecalho.titulo, s: 'tit' }]); }
    if (s.cabecalho) (s.cabecalho.linhas || []).forEach(t => L.push([t]));
    if (s.titulo) L.push([{ v: s.titulo + (s.direita ? '   ·   ' + s.direita : ''), s: 'b' }]);
    if (s.cols) {
      L.push({ c: s.cols.map(c => ({ v: c.t, s: 'cab' })), altura: 30 });
      if (s.linhas.length) L.push(...linhasXLSX(s.cols.map(c => ({ ...c, tipo: c.tipo === 'pct' ? 'texto' : c.tipo })),
        s.linhas.map(l => ({ ...l, c: l.c.map((v, i) => s.cols[i].tipo === 'pct' ? fmtGer(v, 'pct') : v) }))));
      else L.push([s.vazio || 'Nenhum registro.']);
      s.cols.forEach((c, j) => { larg[j] = Math.max(larg[j] || 0, c.xw || 14); });
    }
    (s.notas || []).forEach(n => L.push([n]));
  }
  if (m.notas?.length) { L.push(null); m.notas.forEach(n => L.push([n])); }
  return gerarXLSX([{ nome: m.folha || 'Relatório', linhas: L, larguras: larg }]);
}

/* ---------- Campos dos formulários ---------- */
const anosDisponiveis = () => { const a = +hoje().slice(0, 4); return Array.from({ length: 8 }, (_, i) => a - i); };
const campoAno = (padrao, rotulo = 'Ano') => `<div class="campo"><label for="gAno">${rotulo}</label><select id="gAno">${anosDisponiveis().map(a => `<option${a === padrao ? ' selected' : ''}>${a}</option>`).join('')}</select></div>`;
const campoSelect = (id, rotulo, itens, todos = 'Todos', w = 2) => `<div class="campo w${w}"><label for="${id}">${rotulo}</label><select id="${id}"><option value="">${todos}</option>${itens.map(([v, r]) => `<option value="${esc(v)}">${esc(r)}</option>`).join('')}</select></div>`;
const campoRadios = (nome, rotulo, itens, valor) => `<div class="campo wfull"><label>${rotulo}</label><div class="segmentado" id="seg_${nome}">${itens.map(([v, r]) => `<label><input type="radio" name="${nome}" value="${v}"${v === valor ? ' checked' : ''}> ${r}</label>`).join('')}</div></div>`;
const campoCheck = (id, rotulo, marcado) => `<div class="campo wfull"><label class="inline"><input type="checkbox" id="${id}"${marcado ? ' checked' : ''}> ${rotulo}</label></div>`;
const radio = nome => $(`input[name=${nome}]:checked`)?.value;
function campoPeriodo() {
  const atual = mesAtual();
  return `<div class="campo"><label for="gDe">De (mês)</label><input type="month" id="gDe" value="${atual.slice(0, 4)}-01"></div>
    <div class="campo"><label for="gAte">Até (mês)</label><input type="month" id="gAte" value="${atual}"></div>
    <div class="campo w2"><label>Atalhos</label><div class="acoes-linha">
      <button type="button" class="bt pequeno" data-gper="mes">Mês atual</button><button type="button" class="bt pequeno" data-gper="ant">Mês anterior</button>
      <button type="button" class="bt pequeno" data-gper="ano">Ano atual</button><button type="button" class="bt pequeno" data-gper="anoAnt">Ano anterior</button></div></div>`;
}
function ligarPeriodo() {
  const atual = mesAtual();
  $$('[data-gper]').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.gper, a = atual.slice(0, 4);
    const [de, ate] = p === 'mes' ? [atual, atual] : p === 'ant' ? [addMes(atual, -1), addMes(atual, -1)] : p === 'ano' ? [a + '-01', atual] : [(a - 1) + '-01', (a - 1) + '-12'];
    $('#gDe').value = de; $('#gAte').value = ate;
  }));
}
function lerPeriodo() {
  let de = $('#gDe').value, ate = $('#gAte').value;
  if (!ehMes(de) || !ehMes(ate)) throw new Error('Informe o período (mês inicial e final).');
  if (de > ate) [de, ate] = [ate, de];
  return { de, ate };
}
const opcoesClientes = () => opcoes('locadores');

/* ================= 1) Clientes e seus imóveis ================= */
const RelClientes = {
  descr: 'Quantidade de imóveis de cada cliente, com e sem contrato ativo, e a lista dos imóveis',
  form: () => campoSelect('gCliente', 'Cliente', opcoesClientes())
    + campoRadios('gOrdem', 'Ordenar por', [['nome', 'Nome do cliente'], ['qtd', 'Quantidade de imóveis']], 'nome')
    + campoCheck('gDetalhe', 'Mostrar os imóveis de cada cliente', true),
  ler: () => ({ cliente: $('#gCliente').value, ordem: radio('gOrdem'), detalhe: $('#gDetalhe').checked }),
  gerar(o) {
    const imoveis = Object.values(D.imoveis);
    let locs = Object.values(D.locadores);
    if (o.cliente) locs = locs.filter(l => l.id === o.cliente);
    const grupo = (lo, ims) => {
      const itens = ims.sort((a, b) => comparar(imovelCurto(a), imovelCurto(b))).map(im => ({ im, ct: contratoAtivoDoImovel(im.id) }));
      const ativos = itens.filter(x => x.ct);
      return { lo, itens, ativos: ativos.length, aluguel: ativos.reduce((s, x) => s + cent(x.ct.valorAluguel), 0) };
    };
    const dados = locs.map(lo => grupo(lo, imoveis.filter(i => i.locadorId === lo.id)));
    dados.sort((a, b) => (o.ordem === 'qtd' ? b.itens.length - a.itens.length : 0) || comparar(a.lo.nome, b.lo.nome));
    const semDono = imoveis.filter(i => !D.locadores[i.locadorId]);
    if (!o.cliente && semDono.length) dados.push(grupo({ nome: 'Imóveis sem cliente informado', documento: '' }, semDono));
    if (!dados.length) throw new Error('Nenhum cliente cadastrado.');
    const tot = { n: 0, a: 0, al: 0 };
    dados.forEach(d => { tot.n += d.itens.length; tot.a += d.ativos; tot.al += d.aluguel; });
    const secoes = [{
      titulo: 'Resumo por cliente',
      cols: [{ t: 'Cliente', w: 46, xw: 40 }, { t: 'CPF/CNPJ', w: 24, nw: true, xw: 20 }, { t: 'Imóveis', w: 12, tipo: 'inteiro', xw: 10 }, { t: 'Com contrato ativo', w: 15, tipo: 'inteiro', xw: 12 },
        { t: 'Sem contrato ativo', w: 15, tipo: 'inteiro', xw: 12 }, { t: 'Aluguéis mensais (contratos ativos)', w: 22, tipo: 'moeda', xw: 18 }],
      linhas: [...dados.map(d => ({ c: [d.lo.nome, d.lo.documento || '', d.itens.length, d.ativos, d.itens.length - d.ativos, reais(d.aluguel)] })),
        { c: ['Total', '', tot.n, tot.a, tot.n - tot.a, reais(tot.al)], total: true }],
    }];
    if (o.detalhe) {
      for (const d of dados) {
        if (!d.itens.length) continue;
        secoes.push({
          titulo: d.lo.nome, direita: `${d.itens.length} imóve${d.itens.length === 1 ? 'l' : 'is'} · ${d.ativos} com contrato ativo`,
          cols: [{ t: 'Imóvel', w: 50, xw: 45 }, { t: 'Situação', w: 20, xw: 18 }, { t: 'Locatário', w: 32, xw: 30 }, { t: 'Contrato', w: 12, nw: true, xw: 10 },
            { t: 'Aluguel', w: 15, tipo: 'moeda', xw: 13 }, { t: 'Vigência', w: 26, nw: true, xw: 24 }],
          linhas: d.itens.map(({ im, ct }) => ({ c: [rotuloImovel(im), situacaoImovelTxt(ct), ct ? nomeDe('locatarios', ct.locatarioId) : '', ct?.codigo || '', ct ? r2(ct.valorAluguel) : '', vigenciaTxt(ct)] })),
        });
      }
    }
    return {
      titulo: 'Clientes e imóveis', linhasTitulo: [`Posição em ${fmtData(hoje())}`], paisagem: o.detalhe, arquivo: nomeArquivo('clientes-e-imoveis', hoje()), folha: 'Clientes',
      secoes, notas: ['Contrato ativo: contrato com situação "Ativo" no cadastro, inclusive os de prazo encerrado ainda não encerrados no sistema.'],
    };
  },
};

/* ================= 2) Relação de imóveis ================= */
const RelImoveis = {
  descr: 'Imóveis cadastrados, com e sem contrato ativo',
  form: () => campoRadios('gSit', 'Imóveis', [['todos', 'Todos'], ['ativos', 'Com contrato ativo'], ['sem', 'Sem contrato ativo']], 'todos')
    + campoRadios('gAgrup', 'Agrupar por', [['nenhum', 'Não agrupar'], ['cliente', 'Cliente'], ['cidade', 'Cidade e bairro']], 'nenhum')
    + campoSelect('gCliente', 'Cliente', opcoesClientes()),
  ler: () => ({ sit: radio('gSit'), agrup: radio('gAgrup'), cliente: $('#gCliente').value }),
  gerar(o) {
    let itens = Object.values(D.imoveis).map(im => ({ im, ct: contratoAtivoDoImovel(im.id) }));
    if (o.sit === 'ativos') itens = itens.filter(x => x.ct);
    if (o.sit === 'sem') itens = itens.filter(x => !x.ct);
    if (o.cliente) itens = itens.filter(x => x.im.locadorId === o.cliente);
    const chave = x => o.agrup === 'cliente' ? nomeDe('locadores', x.im.locadorId) : o.agrup === 'cidade' ? [[x.im.cidade, x.im.uf].filter(Boolean).join('/'), x.im.bairro].filter(Boolean).join(' - ') || 'Sem endereço' : '';
    itens.sort((a, b) => comparar(chave(a), chave(b)) || comparar(imovelCurto(a.im), imovelCurto(b.im)));
    const linha = ({ im, ct }) => ({ c: [im.codigo || '', im.tipo || '', descImovel(im), nomeDe('locadores', im.locadorId), situacaoImovelTxt(ct), ct ? nomeDe('locatarios', ct.locatarioId) : '', ct?.codigo || '', ct ? r2(ct.valorAluguel) : '', vigenciaTxt(ct)] });
    const linhas = [];
    let atual = null;
    for (const x of itens) {
      if (o.agrup !== 'nenhum' && chave(x) !== atual) {
        atual = chave(x);
        const n = itens.filter(y => chave(y) === atual).length;
        linhas.push({ c: [`${atual} (${n} imóve${n === 1 ? 'l' : 'is'})`, '', '', '', '', '', '', '', ''], grupo: true });
      }
      linhas.push(linha(x));
    }
    const ativos = itens.filter(x => x.ct);
    linhas.push({ c: ['Total', '', `${itens.length} imóve${itens.length === 1 ? 'l' : 'is'}: ${ativos.length} com contrato ativo, ${itens.length - ativos.length} sem`, '', '', '', '', reais(ativos.reduce((s, x) => s + cent(x.ct.valorAluguel), 0)), ''], total: true });
    const filtro = { todos: 'Todos os imóveis', ativos: 'Imóveis com contrato ativo', sem: 'Imóveis sem contrato ativo' }[o.sit];
    return {
      titulo: 'Relação de imóveis', linhasTitulo: [filtro + (o.cliente ? ' · Cliente: ' + nomeDe('locadores', o.cliente) : ''), `Posição em ${fmtData(hoje())}`],
      paisagem: true, arquivo: nomeArquivo('imoveis', o.sit, hoje()), folha: 'Imóveis',
      secoes: [{
        cols: [{ t: 'Código', w: 11, nw: true, xw: 10 }, { t: 'Tipo', w: 13, xw: 12 }, { t: 'Endereço', w: 52, xw: 45 }, { t: 'Cliente', w: 28, xw: 28 }, { t: 'Situação', w: 18, xw: 18 },
          { t: 'Locatário', w: 28, xw: 28 }, { t: 'Contrato', w: 11, nw: true, xw: 10 }, { t: 'Aluguel', w: 14, tipo: 'moeda', xw: 13 }, { t: 'Vigência', w: 24, nw: true, xw: 24 }],
        linhas, vazio: 'Nenhum imóvel nesta seleção.',
      }],
      notas: ['Contrato ativo: contrato com situação "Ativo" no cadastro, inclusive os de prazo encerrado ainda não encerrados no sistema.'],
    };
  },
};

/* ================= 3) Taxa de administração recebida ================= */
const AGRUP_TAXA = {
  mes: ['Consolidado por mês', 'Cliente', 'locadores'],
  cliente: ['Por cliente', 'Cliente', 'locadores'],
  contrato: ['Por contrato', 'Contrato', 'contratos'],
  inquilino: ['Por inquilino (locatário)', 'Inquilino', 'locatarios'],
};
const RelTaxa = {
  descr: 'Taxa de administração recebida no período: por mês, cliente, contrato ou inquilino',
  form: () => campoPeriodo()
    + campoRadios('gBase', 'Contar pelo', [['caixa', 'Mês do pagamento (caixa)'], ['ref', 'Mês de referência']], 'caixa')
    + campoRadios('gAgrup', 'Agrupar', Object.entries(AGRUP_TAXA).map(([k, [r]]) => [k, r]), 'mes')
    + '<div id="gFiltroCx" class="campo w2"></div>'
    + '<div id="gDetCx" class="campo wfull"><label class="inline"><input type="checkbox" id="gDet"> Detalhar mês a mês</label></div>',
  ligar() {
    const ajustar = () => {
      const [, rot, col] = AGRUP_TAXA[radio('gAgrup')];
      $('#gFiltroCx').outerHTML = campoSelect('gFiltro', rot, opcoes(col), 'Todos').replace('class="campo w2"', 'id="gFiltroCx" class="campo w2"');
      $('#gDetCx').hidden = radio('gAgrup') === 'mes';
    };
    $('#seg_gAgrup').addEventListener('change', ajustar);
    ajustar();
  },
  ler: () => ({ ...lerPeriodo(), base: radio('gBase'), agrup: radio('gAgrup'), filtro: $('#gFiltro').value, det: $('#gDet').checked }),
  async gerar(o) {
    const campoMes = o.base === 'caixa' ? 'caixa' : 'ym';
    const [, , col] = AGRUP_TAXA[o.agrup];
    const doItem = { locadores: ct => ct.locadorId, contratos: ct => ct.id, locatarios: ct => ct.locatarioId }[col];
    let lista = (await recebimentosDe(Object.values(D.contratos))).filter(x => x[campoMes] >= o.de && x[campoMes] <= o.ate);
    if (o.filtro) lista = lista.filter(x => doItem(x.ct) === o.filtro);
    const tot = l => ({ n: l.length, rec: somaC(l, 'recebido'), base: somaC(l, 'base'), taxa: somaC(l, 'taxa') });
    const pct = t => t.base ? Math.round(t.taxa / t.base * 10000) / 100 : '';
    const periodoTxt = `Período: ${periodoNum(o.de, o.ate)} · contado pelo ${o.base === 'caixa' ? 'mês do pagamento (regime de caixa)' : 'mês de referência'}`;
    const filtroTxt = o.filtro ? `${AGRUP_TAXA[o.agrup][1]}: ${col === 'contratos' ? rotuloContrato(D.contratos[o.filtro]) : nomeDe(col, o.filtro)}` : '';
    let cols, linhas = [];
    if (o.agrup === 'mes') {
      cols = [{ t: 'Mês', w: 18, nw: true, xw: 12 }, { t: 'Pagamentos', w: 14, tipo: 'inteiro', xw: 12 }, { t: 'Recebido dos locatários', w: 24, tipo: 'moeda', xw: 18 },
        { t: 'Base da taxa', w: 22, tipo: 'moeda', xw: 16 }, { t: '% médio', w: 14, tipo: 'pct', xw: 10 }, { t: 'Taxa de administração', w: 24, tipo: 'moeda', xw: 18 }];
      for (const m of listaMeses(o.de, o.ate)) {
        const t = tot(lista.filter(x => x[campoMes] === m));
        linhas.push({ c: [mesNum(m), t.n, reais(t.rec), reais(t.base), pct(t), reais(t.taxa)] });
      }
      const t = tot(lista);
      linhas.push({ c: ['Total', t.n, reais(t.rec), reais(t.base), pct(t), reais(t.taxa)], total: true });
    } else {
      const ehContrato = o.agrup === 'contrato', colsExtra = ehContrato && !o.det;
      const nomeItem = id => ehContrato ? rotuloContrato(D.contratos[id]) : nomeDe(col, id);
      const extra = id => colsExtra ? [nomeDe('locadores', D.contratos[id]?.locadorId), nomeDe('locatarios', D.contratos[id]?.locatarioId)] : [];
      cols = [{ t: AGRUP_TAXA[o.agrup][1], w: 34, xw: 30 }, ...(colsExtra ? [{ t: 'Cliente', w: 28, xw: 26 }, { t: 'Inquilino', w: 28, xw: 26 }] : []),
        { t: o.det ? 'Mês' : 'Pagamentos', w: 13, ...(o.det ? { nw: true } : { tipo: 'inteiro' }), xw: 11 }, { t: 'Recebido dos locatários', w: 22, tipo: 'moeda', xw: 18 },
        { t: 'Base da taxa', w: 20, tipo: 'moeda', xw: 16 }, { t: '% médio', w: 12, tipo: 'pct', xw: 10 }, { t: 'Taxa de administração', w: 22, tipo: 'moeda', xw: 18 }];
      const vazios = colsExtra ? ['', ''] : [];
      const rotuloGrupo = id => ehContrato ? `${nomeItem(id)} · Cliente: ${nomeDe('locadores', D.contratos[id]?.locadorId)} · Inquilino: ${nomeDe('locatarios', D.contratos[id]?.locatarioId)}` : nomeItem(id);
      const ids = [...new Set(lista.map(x => doItem(x.ct)))].sort((a, b) => comparar(nomeItem(a), nomeItem(b)));
      for (const id of ids) {
        const doId = lista.filter(x => doItem(x.ct) === id), t = tot(doId);
        if (o.det) {
          linhas.push({ c: [rotuloGrupo(id), ...vazios, '', '', '', '', ''], grupo: true });
          for (const m of [...new Set(doId.map(x => x[campoMes]))].sort()) {
            const tm = tot(doId.filter(x => x[campoMes] === m));
            linhas.push({ c: ['', ...vazios, mesNum(m), reais(tm.rec), reais(tm.base), pct(tm), reais(tm.taxa)] });
          }
          linhas.push({ c: ['Subtotal: ' + nomeItem(id), ...vazios, '', reais(t.rec), reais(t.base), pct(t), reais(t.taxa)], total: true });
        } else linhas.push({ c: [nomeItem(id), ...extra(id), t.n, reais(t.rec), reais(t.base), pct(t), reais(t.taxa)] });
      }
      const t = tot(lista);
      linhas.push({ c: ['Total', ...vazios, o.det ? '' : t.n, reais(t.rec), reais(t.base), pct(t), reais(t.taxa)], total: true });
    }
    const notas = ['Recebido dos locatários: valores pagos, inclusive multa, juros e correção. Meses não pagos não geram taxa; pagamentos parciais geram taxa proporcional ao valor pago. % médio = taxa ÷ base.'];
    if (o.base === 'caixa' && lista.some(x => x.semData)) notas.push('Meses pagos sem a data do pagamento informada foram contados no mês de referência.');
    return {
      titulo: 'Taxa de administração recebida', linhasTitulo: [AGRUP_TAXA[o.agrup][0] + (filtroTxt ? ' · ' + filtroTxt : ''), periodoTxt],
      paisagem: o.agrup === 'contrato' && !o.det, arquivo: nomeArquivo('taxa-administracao', o.agrup, o.de === o.ate ? o.de : o.de + '_a_' + o.ate), folha: 'Taxa de administração',
      secoes: [{ cols, linhas: lista.length || o.agrup === 'mes' ? linhas : [], vazio: 'Nenhum pagamento de locatário no período.' }], notas,
    };
  },
};

/* ================= 4) Informe de rendimentos (Imposto de Renda) ================= */
const RelInforme = {
  descr: 'Por cliente, no ano: aluguéis recebidos, taxa de administração, despesas pagas e repasses, mês a mês',
  form: () => campoAno(+hoje().slice(0, 4) - 1, 'Ano-calendário') + campoSelect('gCliente', 'Cliente', opcoesClientes(), 'Todos (um cliente por página)'),
  ler: () => ({ ano: $('#gAno').value, cliente: $('#gCliente').value }),
  async gerar(o) {
    const ano = String(o.ano);
    let locs = Object.values(D.locadores).sort((a, b) => comparar(a.nome, b.nome));
    if (o.cliente) locs = locs.filter(l => l.id === o.cliente);
    const secoes = [];
    for (const lo of locs) {
      const cts = Object.values(D.contratos).filter(c => c.locadorId === lo.id).sort(ordemContrato);
      const recs = (await recebimentosDe(cts)).filter(x => x.caixa.startsWith(ano));
      const exts = await extratosDe(cts);
      const despesas = {}, repasses = {};
      for (const { ext } of exts) {
        for (const [ym, mes] of Object.entries(ext.meses)) {
          if (ym.startsWith(ano)) despesas[ym] = (despesas[ym] || 0) + (mes.linhas || []).reduce((s, l) => s + cent(l.pago), 0);
          for (const r of repassesEfetuados(mes)) if ((r.data || '').startsWith(ano)) repasses[r.data.slice(0, 7)] = (repasses[r.data.slice(0, 7)] || 0) + cent(r.valor);
        }
      }
      const temMov = recs.length || Object.values(despesas).some(Boolean) || Object.values(repasses).some(Boolean);
      if (!temMov && !o.cliente) continue;
      const linhas = [], T = { loc: 0, enc: 0, out: 0, rec: 0, taxa: 0, desp: 0, rep: 0 };
      for (let i = 1; i <= 12; i++) {
        const ym = `${ano}-${p2(i)}`, l = recs.filter(x => x.caixa === ym);
        const v = { loc: somaC(l, 'locacao'), enc: somaC(l, 'encargos'), rec: somaC(l, 'recebido'), taxa: somaC(l, 'taxa'), desp: despesas[ym] || 0, rep: repasses[ym] || 0 };
        v.out = v.rec - v.loc - v.enc;
        Object.keys(T).forEach(k => { T[k] += v[k]; });
        linhas.push({ c: [MESES[i - 1], reais(v.loc), reais(v.enc), reais(v.out), reais(v.rec), reais(v.taxa), reais(v.desp), reais(v.rep)] });
      }
      linhas.push({ c: ['Total do ano', reais(T.loc), reais(T.enc), reais(T.out), reais(T.rec), reais(T.taxa), reais(T.desp), reais(T.rep)], total: true });
      secoes.push({
        novaPagina: true,
        cabecalho: { titulo: 'Informe de rendimentos de aluguéis - ano-calendário ' + ano, linhas: [`Cliente (locador): ${lo.nome}${lo.documento ? ' · CPF/CNPJ ' + lo.documento : ''}`, 'Valores pela data do pagamento do locatário (regime de caixa).'] },
        titulo: 'Mês a mês',
        cols: [{ t: 'Mês', w: 16, xw: 12 }, { t: 'Aluguéis recebidos', w: 18, tipo: 'moeda', xw: 15 }, { t: 'Multa, juros e correção', w: 18, tipo: 'moeda', xw: 15 },
          { t: 'Outros valores (condomínio, IPTU etc.)', w: 20, tipo: 'moeda', xw: 17 }, { t: 'Total recebido do locatário', w: 19, tipo: 'moeda', xw: 16 },
          { t: 'Taxa de administração', w: 18, tipo: 'moeda', xw: 15 }, { t: 'Despesas pagas pela administradora', w: 20, tipo: 'moeda', xw: 17 }, { t: 'Repassado ao cliente', w: 18, tipo: 'moeda', xw: 15 }],
        linhas,
      });
      const porCt = cts.map(ct => ({ ct, l: recs.filter(x => x.ct.id === ct.id) })).filter(x => x.l.length);
      secoes.push({
        titulo: 'Por contrato (fonte pagadora)',
        cols: [{ t: 'Contrato', w: 12, nw: true, xw: 10 }, { t: 'Locatário', w: 34, xw: 30 }, { t: 'CPF/CNPJ do locatário', w: 22, nw: true, xw: 20 }, { t: 'Imóvel', w: 44, xw: 40 },
          { t: 'Aluguéis recebidos', w: 17, tipo: 'moeda', xw: 15 }, { t: 'Multa, juros e correção', w: 17, tipo: 'moeda', xw: 15 }, { t: 'Taxa de administração', w: 17, tipo: 'moeda', xw: 15 }],
        linhas: porCt.map(({ ct, l }) => ({ c: [ct.codigo || '', nomeDe('locatarios', ct.locatarioId), D.locatarios[ct.locatarioId]?.documento || '', imovelCurto(D.imoveis[ct.imovelId]), reais(somaC(l, 'locacao')), reais(somaC(l, 'encargos')), reais(somaC(l, 'taxa'))] })),
        vazio: 'Nenhum recebimento no ano.',
        notas: ['Aluguéis recebidos: rubricas marcadas como Locação (menos descontos), na proporção do valor pago. Outros valores: demais rubricas cobradas do locatário (condomínio, IPTU, seguro etc.), que normalmente não são rendimento do locador. Despesas pela referência do mês; repasses pela data do repasse. Documento auxiliar: confira os critérios com o seu contador.'],
      });
    }
    if (!secoes.length) throw new Error(`Nenhum cliente com movimento em ${ano}.`);
    const alvo = o.cliente ? nomeDe('locadores', o.cliente) : 'todos';
    return { titulo: null, paisagem: true, arquivo: nomeArquivo('informe-rendimentos', ano, alvo), folha: 'Informe ' + ano, secoes };
  },
};

/* ================= 5) Conferência para a DIMOB ================= */
const RelDimob = {
  descr: 'Relação anual por contrato: locador, locatário, imóvel, aluguéis recebidos e comissão, para conferir a DIMOB',
  form: () => campoAno(+hoje().slice(0, 4) - 1, 'Ano-calendário') + campoSelect('gCliente', 'Cliente', opcoesClientes()) + campoCheck('gDet', 'Detalhar mês a mês no PDF (no Excel, os meses saem sempre)', false),
  ler: () => ({ ano: $('#gAno').value, cliente: $('#gCliente').value, det: $('#gDet').checked }),
  async gerar(o) {
    const ano = String(o.ano);
    let cts = Object.values(D.contratos);
    if (o.cliente) cts = cts.filter(c => c.locadorId === o.cliente);
    const recs = (await recebimentosDe(cts)).filter(x => x.caixa.startsWith(ano));
    const porCt = [...new Set(recs.map(x => x.ct))].sort((a, b) => comparar(nomeDe('locadores', a.locadorId), nomeDe('locadores', b.locadorId)) || ordemContrato(a, b))
      .map(ct => ({ ct, l: recs.filter(x => x.ct === ct) }));
    if (!porCt.length) throw new Error(`Nenhum recebimento de aluguel em ${ano}.`);
    const imovelDimob = im => im ? [descImovel(im), im.cep && 'CEP ' + im.cep].filter(Boolean).join(' · ') : '—';
    const T = { loc: 0, taxa: 0 };
    const linhas = porCt.map(({ ct, l }) => {
      const loc = somaC(l, 'locacao'), taxa = somaC(l, 'taxa');
      T.loc += loc; T.taxa += taxa;
      return { c: [ct.codigo || '', nomeDe('locadores', ct.locadorId), D.locadores[ct.locadorId]?.documento || '', nomeDe('locatarios', ct.locatarioId), D.locatarios[ct.locatarioId]?.documento || '',
        imovelDimob(D.imoveis[ct.imovelId]), ct.inicio || '', reais(loc), reais(taxa)] };
    });
    linhas.push({ c: ['Total', `${porCt.length} contrato${porCt.length === 1 ? '' : 's'}`, '', '', '', '', '', reais(T.loc), reais(T.taxa)], total: true });
    const secoes = [{
      cols: [{ t: 'Contrato', w: 10, nw: true, xw: 10 }, { t: 'Locador', w: 26, xw: 28 }, { t: 'CPF/CNPJ do locador', w: 18, nw: true, xw: 20 }, { t: 'Locatário', w: 26, xw: 28 },
        { t: 'CPF/CNPJ do locatário', w: 18, nw: true, xw: 20 }, { t: 'Imóvel', w: 42, xw: 45 }, { t: 'Data do contrato', w: 12, tipo: 'data', xw: 12 },
        { t: 'Aluguéis recebidos no ano', w: 16, tipo: 'moeda', xw: 15 }, { t: 'Comissão (taxa de administração)', w: 16, tipo: 'moeda', xw: 15 }],
      linhas,
    }];
    // Mês a mês: no PDF, uma tabela por contrato (opcional); no Excel, uma linha por contrato com os 12 meses
    if (o.det) {
      for (const { ct, l } of porCt) {
        secoes.push({
          so: 'pdf', titulo: `${rotuloContrato(ct)} · ${nomeDe('locadores', ct.locadorId)} → ${nomeDe('locatarios', ct.locatarioId)}`,
          cols: [{ t: 'Mês', w: 20 }, { t: 'Aluguel recebido', w: 20, tipo: 'moeda' }, { t: 'Comissão', w: 20, tipo: 'moeda' }],
          linhas: [...Array.from({ length: 12 }, (_, i) => { const m = l.filter(x => x.caixa === `${ano}-${p2(i + 1)}`); return { c: [MESES[i], reais(somaC(m, 'locacao')), reais(somaC(m, 'taxa'))] }; }),
            { c: ['Total', reais(somaC(l, 'locacao')), reais(somaC(l, 'taxa'))], total: true }],
        });
      }
    }
    const colsMes = [{ t: 'Contrato', xw: 10 }, ...MESES.flatMap(m => [{ t: 'Aluguel ' + m.slice(0, 3).toLowerCase(), tipo: 'moeda', xw: 12 }, { t: 'Comissão ' + m.slice(0, 3).toLowerCase(), tipo: 'moeda', xw: 12 }])];
    secoes.push({
      so: 'xlsx', titulo: 'Mês a mês (pela data do pagamento)', cols: colsMes.map(c => ({ w: 10, ...c })),
      linhas: porCt.map(({ ct, l }) => ({ c: [ct.codigo || '', ...Array.from({ length: 12 }, (_, i) => { const m = l.filter(x => x.caixa === `${ano}-${p2(i + 1)}`); return [reais(somaC(m, 'locacao')), reais(somaC(m, 'taxa'))]; }).flat()] })),
    });
    return {
      titulo: 'Conferência para a DIMOB - ano-calendário ' + ano, linhasTitulo: [o.cliente ? 'Cliente: ' + nomeDe('locadores', o.cliente) : 'Todos os clientes', 'Valores pela data do pagamento do locatário (regime de caixa).'],
      paisagem: true, arquivo: nomeArquivo('dimob-conferencia', ano), folha: 'DIMOB ' + ano, secoes,
      notas: ['Relação auxiliar para conferir a DIMOB (Declaração de Informações sobre Atividades Imobiliárias). Não substitui o programa oficial da Receita Federal. Aluguéis recebidos: rubricas marcadas como Locação (menos descontos), na proporção do valor pago, sem multa e juros; comissão: taxa de administração. Confirme os critérios com o seu contador.'],
    };
  },
};

/* ================= 6) Repasses do período e saldos a repassar ================= */
const RelRepasses = {
  descr: 'Repasses feitos aos clientes no período e o saldo em conta atual de cada contrato',
  form: () => campoPeriodo() + campoSelect('gCliente', 'Cliente', opcoesClientes())
    + campoRadios('gAgrup', 'Agrupar os repasses por', [['cliente', 'Cliente'], ['contrato', 'Contrato'], ['nenhum', 'Não agrupar (por data)']], 'cliente'),
  ler: () => ({ ...lerPeriodo(), cliente: $('#gCliente').value, agrup: radio('gAgrup') }),
  async gerar(o) {
    let cts = Object.values(D.contratos);
    if (o.cliente) cts = cts.filter(c => c.locadorId === o.cliente);
    const ini = o.de + '-01', fim = o.ate + '-31';
    const reps = [], saldos = [];
    for (const { ct, ext } of await extratosDe(cts)) {
      for (const [ym, mes] of Object.entries(ext.meses)) {
        for (const r of repassesEfetuados(mes)) if (r.data >= ini && r.data <= fim) reps.push({ ct, ym, ...r, v: cent(r.valor) });
      }
      const cad = calcularExtrato(ct, ext);
      const ult = cad[cad.length - 1];
      if (ult && (ct.status !== 'encerrado' || Math.abs(ult.c.saldoConta) >= 0.01)) saldos.push({ ct, ym: ult.ym, saldo: cent(ult.c.saldoConta) });
    }
    const chave = x => o.agrup === 'cliente' ? nomeDe('locadores', x.ct.locadorId) : o.agrup === 'contrato' ? rotuloContrato(x.ct) : '';
    reps.sort((a, b) => comparar(chave(a), chave(b)) || comparar(a.data, b.data));
    const linhas = [];
    let atual = null;
    for (const r of reps) {
      if (o.agrup !== 'nenhum' && chave(r) !== atual) {
        if (atual !== null) { const s = reps.filter(x => chave(x) === atual); linhas.push({ c: ['Subtotal', '', '', '', '', '', reais(somaC(s, 'v'))], total: true }); }
        atual = chave(r);
        linhas.push({ c: [atual, '', '', '', '', '', ''], grupo: true });
      }
      linhas.push({ c: [r.data, nomeDe('locadores', r.ct.locadorId), r.ct.codigo || '', imovelCurto(D.imoveis[r.ct.imovelId]), mesNum(r.ym), r.obs || '', reais(r.v)] });
    }
    if (o.agrup !== 'nenhum' && atual !== null) { const s = reps.filter(x => chave(x) === atual); linhas.push({ c: ['Subtotal', '', '', '', '', '', reais(somaC(s, 'v'))], total: true }); }
    if (reps.length) linhas.push({ c: ['Total do período', '', '', '', '', '', reais(somaC(reps, 'v'))], total: true });
    saldos.sort((a, b) => comparar(nomeDe('locadores', a.ct.locadorId), nomeDe('locadores', b.ct.locadorId)) || ordemContrato(a.ct, b.ct));
    return {
      titulo: 'Repasses e saldos a repassar', linhasTitulo: [(o.cliente ? 'Cliente: ' + nomeDe('locadores', o.cliente) : 'Todos os clientes'), 'Repasses feitos de ' + fmtData(ini) + ' a ' + fmtData(fimDoMes(o.ate))],
      paisagem: true, arquivo: nomeArquivo('repasses', o.de === o.ate ? o.de : o.de + '_a_' + o.ate), folha: 'Repasses',
      secoes: [{
        titulo: 'Repasses ao cliente no período',
        cols: [{ t: 'Data', w: 14, tipo: 'data', xw: 12 }, { t: 'Cliente', w: 32, xw: 30 }, { t: 'Contrato', w: 11, nw: true, xw: 10 }, { t: 'Imóvel', w: 44, xw: 40 },
          { t: 'Referência', w: 13, nw: true, xw: 11 }, { t: 'Observação', w: 30, xw: 28 }, { t: 'Valor', w: 16, tipo: 'moeda', xw: 14 }],
        linhas, vazio: 'Nenhum repasse no período.',
      }, {
        titulo: 'Saldo em conta atual (a repassar)', direita: 'Saldo do último mês lançado de cada contrato',
        cols: [{ t: 'Cliente', w: 34, xw: 30 }, { t: 'Contrato', w: 12, nw: true, xw: 10 }, { t: 'Imóvel', w: 50, xw: 45 }, { t: 'Último mês lançado', w: 16, nw: true, xw: 14 }, { t: 'Saldo em conta', w: 18, tipo: 'moeda', xw: 15 }],
        linhas: saldos.length ? [...saldos.map(s => ({ c: [nomeDe('locadores', s.ct.locadorId), s.ct.codigo || '', imovelCurto(D.imoveis[s.ct.imovelId]), mesNum(s.ym), reais(s.saldo)] })),
          { c: ['Total', '', '', '', reais(somaC(saldos, 'saldo'))], total: true }] : [],
        vazio: 'Nenhum contrato com meses lançados.',
      }],
    };
  },
};
const fimDoMes = ym => { const [a, m] = ym.split('-').map(Number); return `${ym}-${p2(new Date(a, m, 0).getDate())}`; };

/* ================= 7) Contratos a vencer e reajustes próximos ================= */
const RelVencimentos = {
  descr: 'Contratos ativos com término próximo (ou já vencidos) e reajustes anuais próximos',
  form: () => `<div class="campo"><label for="gPrazo">Próximos</label><select id="gPrazo">${[[30, '30 dias'], [60, '60 dias'], [90, '90 dias'], [180, '6 meses'], [365, '12 meses']].map(([v, r]) => `<option value="${v}"${v === 90 ? ' selected' : ''}>${r}</option>`).join('')}</select></div>`
    + campoCheck('gVencidos', 'Incluir contratos ativos com prazo já encerrado', true),
  ler: () => ({ dias: +$('#gPrazo').value, vencidos: $('#gVencidos').checked }),
  gerar(o) {
    const h = hoje(), limite = somarDias(h, o.dias), mesLimite = limite.slice(0, 7);
    const ativos = contratosAtivos();
    const termino = ativos.filter(ct => ct.fim && ct.fim <= limite && (o.vencidos || ct.fim >= h)).sort((a, b) => comparar(a.fim, b.fim));
    const reaj = ativos.map(ct => ({ ct, prox: proximoReajuste(ct) })).filter(x => x.prox && x.prox <= mesLimite).sort((a, b) => comparar(a.prox, b.prox) || ordemContrato(a.ct, b.ct));
    const sitFim = fim => { const d = diasEntre(h, fim); return d < 0 ? `Prazo encerrado há ${-d} dia${d === -1 ? '' : 's'}` : d === 0 ? 'Termina hoje' : `Termina em ${d} dia${d === 1 ? '' : 's'}`; };
    const base = ct => [ct.codigo || '', nomeDe('locatarios', ct.locatarioId), nomeDe('locadores', ct.locadorId), imovelCurto(D.imoveis[ct.imovelId])];
    const colsBase = [{ t: 'Contrato', w: 11, nw: true, xw: 10 }, { t: 'Locatário', w: 30, xw: 28 }, { t: 'Cliente', w: 30, xw: 28 }, { t: 'Imóvel', w: 44, xw: 40 }];
    return {
      titulo: 'Contratos a vencer e reajustes próximos', linhasTitulo: [`Até ${fmtData(limite)} (próximos ${o.dias} dias)`, `Posição em ${fmtData(h)}`],
      paisagem: true, arquivo: nomeArquivo('vencimentos-reajustes', h), folha: 'Vencimentos',
      secoes: [{
        titulo: 'Contratos com término até ' + fmtData(limite),
        cols: [...colsBase, { t: 'Término', w: 14, tipo: 'data', xw: 12 }, { t: 'Situação', w: 26, xw: 24 }, { t: 'Aluguel', w: 15, tipo: 'moeda', xw: 13 }],
        linhas: termino.map(ct => ({ c: [...base(ct), ct.fim, sitFim(ct.fim), r2(ct.valorAluguel)] })), vazio: 'Nenhum contrato com término no período.',
      }, {
        titulo: 'Reajustes anuais até ' + mesNum(mesLimite),
        cols: [...colsBase, { t: 'Próximo reajuste', w: 15, nw: true, xw: 13 }, { t: 'Índice', w: 15, xw: 12 }, { t: 'Aluguel atual', w: 15, tipo: 'moeda', xw: 13 }],
        linhas: reaj.map(({ ct, prox }) => ({ c: [...base(ct), mesNum(prox), ct.indiceReajuste || '', r2(ct.valorAluguel)] })), vazio: 'Nenhum reajuste no período.',
      }],
      notas: ['Somente contratos com situação "Ativo". Reajuste: mês de correção do contrato, a partir de 12 meses do início.'],
    };
  },
};

/* ================= 8) Vacância ================= */
const RelVacancia = {
  descr: 'Imóveis sem contrato ativo e há quanto tempo estão sem contrato',
  form: () => campoSelect('gCliente', 'Cliente', opcoesClientes()),
  ler: () => ({ cliente: $('#gCliente').value }),
  gerar(o) {
    const h = hoje();
    let ims = Object.values(D.imoveis).filter(im => !contratoAtivoDoImovel(im.id));
    if (o.cliente) ims = ims.filter(im => im.locadorId === o.cliente);
    const dados = ims.map(im => {
      // Fim do último contrato: término informado (se já passou) ou a data em que foi encerrado no sistema
      const fins = Object.values(D.contratos).filter(c => c.imovelId === im.id)
        .map(c => ({ c, data: c.fim && c.fim <= h ? c.fim : (c.atualizadoEm || '').slice(0, 10) })).filter(x => x.data).sort((a, b) => comparar(b.data, a.data));
      const ult = fins[0];
      return { im, ult, dias: ult ? Math.max(0, diasEntre(ult.data, h)) : null };
    }).sort((a, b) => (b.dias ?? -1) - (a.dias ?? -1) || comparar(imovelCurto(a.im), imovelCurto(b.im)));
    const comDias = dados.filter(x => x.dias !== null);
    return {
      titulo: 'Vacância: imóveis sem contrato ativo', linhasTitulo: [(o.cliente ? 'Cliente: ' + nomeDe('locadores', o.cliente) : 'Todos os clientes'), `Posição em ${fmtData(h)}`],
      paisagem: true, arquivo: nomeArquivo('vacancia', h), folha: 'Vacância',
      secoes: [{
        cols: [{ t: 'Imóvel', w: 56, xw: 50 }, { t: 'Cliente', w: 32, xw: 30 }, { t: 'Último contrato', w: 16, nw: true, xw: 14 }, { t: 'Último locatário', w: 30, xw: 28 },
          { t: 'Sem contrato desde', w: 16, tipo: 'data', xw: 14 }, { t: 'Dias sem contrato', w: 14, tipo: 'inteiro', xw: 12 }],
        linhas: dados.length ? [...dados.map(x => ({ c: [rotuloImovel(x.im), nomeDe('locadores', x.im.locadorId), x.ult ? (x.ult.c.codigo || 's/nº') : 'Nunca locado (no sistema)',
          x.ult ? nomeDe('locatarios', x.ult.c.locatarioId) : '', x.ult?.data || '', x.dias ?? ''] })),
          { c: [`Total: ${dados.length} imóve${dados.length === 1 ? 'l' : 'is'}`, '', '', '', comDias.length ? 'Média' : '', comDias.length ? Math.round(somaC(comDias, 'dias') / comDias.length) : ''], total: true }] : [],
        vazio: 'Todos os imóveis estão com contrato ativo.',
      }],
      notas: ['Sem contrato desde: término do último contrato ou, se ele foi encerrado antes do término, a data em que foi marcado como encerrado no sistema.'],
    };
  },
};

/* ================= Recibos de aluguel em lote ================= */
const RelRecibos = {
  descr: 'Recibos dos pagamentos dos locatários no período, um por folha, para impressão ou envio',
  semExcel: true,
  form: () => campoPeriodo()
    + campoRadios('gBase', 'Selecionar pelo', [['caixa', 'Mês do pagamento'], ['ref', 'Mês de referência']], 'caixa')
    + campoSelect('gCliente', 'Cliente', opcoesClientes()) + campoSelect('gContrato', 'Contrato', opcoes('contratos')),
  ler: () => ({ ...lerPeriodo(), base: radio('gBase'), cliente: $('#gCliente').value, contrato: $('#gContrato').value }),
  async pdf(o) {
    let cts = Object.values(D.contratos);
    if (o.cliente) cts = cts.filter(c => c.locadorId === o.cliente);
    if (o.contrato) cts = cts.filter(c => c.id === o.contrato);
    const itens = [];
    for (const { ct, ext } of await extratosDe(cts)) {
      for (const [ym, mes] of Object.entries(ext.meses)) {
        if (situacaoPagto(mes) === 'aberto' || !mes.recebidoEm) continue;
        const m = o.base === 'caixa' ? mes.recebidoEm.slice(0, 7) : ym;
        if (m >= o.de && m <= o.ate) itens.push({ ct, ym, mes });
      }
    }
    itens.sort((a, b) => comparar(nomeDe('locadores', a.ct.locadorId), nomeDe('locadores', b.ct.locadorId)) || ordemContrato(a.ct, b.ct) || comparar(a.ym, b.ym));
    if (!itens.length) throw new Error('Nenhum pagamento de locatário (com data informada) no período.');
    return gerarRecibos(itens, nomeArquivo('recibos', o.de === o.ate ? o.de : o.de + '_a_' + o.ate) + '.pdf');
  },
};

const GERENCIAIS = { recibos: RelRecibos, clientes: RelClientes, imoveis: RelImoveis, taxa: RelTaxa, informe: RelInforme, dimob: RelDimob, repasses: RelRepasses, vencimentos: RelVencimentos, vacancia: RelVacancia };

function telaRelatorioGerencial(rel) {
  const R = GERENCIAIS[rel];
  $('#conteudo').innerHTML = cabecalho('Relatórios', R.descr) + seletorRelatorioHTML(rel) + `
  <section class="cartao form">
    <div class="grade-form">${R.form()}</div>
    <div class="barra-form"><span class="dica">${D.config.administradora?.nome ? '' : 'Os dados e o logotipo da administradora, que formam o cabeçalho dos relatórios, ainda não foram preenchidos (Administração).'}</span><span class="espaco"></span>
      ${botoesPDF('gerPdf')}${R.semExcel ? '' : '<button class="bt" id="gerXlsx">Exportar Excel</button>'}</div>
  </section>`;
  ligarSeletorRelatorio();
  if ($('#gDe')) ligarPeriodo();
  R.ligar?.();
  const modelo = async () => R.gerar(R.ler());
  ligarBotoesPDF('gerPdf', async () => R.pdf ? R.pdf(R.ler()) : pdfDeModelo(await modelo()));
  $('#gerXlsx')?.addEventListener('click', () => executar(async () => { const m = await modelo(); await salvarPlanilha(xlsxDeModelo(m), m.arquivo + '.xlsx'); }));
}
