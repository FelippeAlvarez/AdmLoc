'use strict';
/* Telas, PDF e Excel dos acordos de pagamento (motor em acordo.js) */

const opcaoTipoAc = (nome, tipo) => `<select data-ac-tipo="${nome}" class="sel-tipo" aria-label="Percentual ou valor"><option value="pct"${tipo !== 'valor' ? ' selected' : ''}>%</option><option value="valor"${tipo === 'valor' ? ' selected' : ''}>R$</option></select>`;
const mostrarAc = (tipo, v) => v === '' || v == null ? '' : tipo === 'valor' ? fmtNum(v) : fmtPct(v);

function devedoresDoContrato(ct) {
  const lt = D.locatarios[ct.locatarioId];
  const l = [['locatario', `${lt?.nome || 'Locatário'} (locatário)`]];
  if (ct.fiadorNome) l.push(['fiador', `${ct.fiadorNome} (fiador)`]);
  if (ct.fiador2Nome) l.push(['fiador2', `${ct.fiador2Nome} (fiador)`]);
  return l;
}
const nomeDevedor = (ct, a) => (devedoresDoContrato(ct).find(d => d[0] === a.devedor) || devedoresDoContrato(ct)[0])[1];

function novoAcordo(ct, calcId) {
  const p = paramsMora(ct), h = hoje();
  return {
    id: novoId(), nome: 'Acordo de ' + fmtData(h), situacao: 'proposta', data: h, calcId: calcId || '', devedor: 'locatario',
    desconto: { modo: 'total', tipo: 'pct', valor: 0, itens: {} }, sinal: { tipo: 'pct', valor: 0, venc: h },
    parcelamento: { taxa: 0, jurosAte1: true, primeiroVenc: diaDoMes(addMes(h.slice(0, 7), 1), +h.slice(8)), modo: 'prazo', prazo: 6, parcela: '', indice: p.indice },
    encargos: { multa: p.multa, juros: p.juros }, obs: '',
  };
}

async function gravarAcordo(cid, a) {
  const reg = { ...JSON.parse(JSON.stringify(a)), atualizadoEm: new Date().toISOString(), atualizadoPor: usuario() };
  await gravarCalculos(cid, arq => { arq.acordos = arq.acordos || {}; arq.acordos[reg.id] = reg; });
  return reg;
}

/* ================= Lista ================= */
async function telaAcordos(cid) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  await carregarExtrato(cid);
  await carregarCalculos(cid); // sempre a versão mais recente (outro aparelho pode ter alterado)
  const lista = acordosDoContrato(cid).sort((a, b) => comparar(b.data, a.data));
  $('#conteudo').innerHTML = cabecalho('Acordos de pagamento', `${esc(rotuloContrato(ct))} · Locatário: <b>${esc(nomeDe('locatarios', ct.locatarioId))}</b>`,
    `<a class="bt primario" href="#/contrato/${cid}/acordo/novo">+ Novo acordo</a>`, `<a class="voltar" href="#/contrato/${cid}">&larr; ${esc(rotuloContrato(ct))}</a>`) + `
  <section class="cartao">
    ${lista.length ? `<div class="rolagem"><table class="tabela clicavel"><thead><tr><th>Acordo</th><th>Data</th><th>Situação</th><th class="num">Valor negociado</th><th>Parcelas</th><th>Próximo vencimento</th></tr></thead><tbody>
      ${lista.map(a => { const prox = parcelasDoAcordo(a).find(p => restanteNominal(p) > 0); return `<tr data-link="#/contrato/${cid}/acordo/${a.id}"><td><b>${esc(a.nome)}</b></td><td>${fmtData(a.data)}</td><td>${chipAcordo(a.situacao)}</td>
        <td class="num">${a.resumo ? fmtNum(a.resumo.negociado) : ''}</td><td>${a.plano ? a.plano.length + (a.sinalParcela ? ' + entrada' : '') : ''}</td><td>${a.situacao === 'aceito' && prox ? fmtData(prox.venc) : ''}</td></tr>`; }).join('')}
    </tbody></table></div>` : '<p class="vazio">Nenhum acordo neste contrato. Use <b>+ Novo acordo</b> para simular um parcelamento do débito.</p>'}
    <p class="dica">Os meses incluídos num acordo em andamento ou quitado saem da Inadimplência e dos novos cálculos do débito; se o acordo for descumprido, voltam. Cada pagamento pode ser lançado na prestação de contas do locador, na data indicada (ex.: depósito judicial, depois do levantamento).</p>
  </section>`;
  ligarBusca();
}

/* ================= Proposta ================= */
async function telaAcordo(cid, id, calcId) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  await carregarExtrato(cid);
  await carregarCalculos(cid); // sempre a versão mais recente (outro aparelho pode ter alterado)
  await aguardarIndices();
  const salvo = D.calcs[cid].acordos?.[id];
  if (id !== 'novo' && !salvo) throw new Error('Acordo não encontrado.');
  const a = salvo ? JSON.parse(JSON.stringify(salvo)) : novoAcordo(ct, calcId);
  if (a.situacao === 'proposta') return editorAcordo(ct, a, !salvo);
  return acompanhamentoAcordo(ct, a);
}

function editorAcordo(ct, a, novo) {
  const cid = ct.id;
  let c = null;
  const calcs = Object.values(D.calcs[cid].calculos || {});
  const cab = cabecalho(novo ? 'Novo acordo' : 'Proposta de acordo', `${esc(rotuloContrato(ct))} · ${esc(descImovel(D.imoveis[ct.imovelId]))}`,
    botoesPDF('acPdf') + '<button class="bt" id="acXlsx">Salvar planilha Excel</button>', `<a class="voltar" href="#/contrato/${cid}/acordos">&larr; Acordos</a>`);

  function render() {
    const d = a.desconto, s = a.sinal, p = a.parcelamento;
    $('#conteudo').innerHTML = cab + `<div id="telaAc">
    <section class="cartao form"><div class="grade-form">
      <div class="campo w2"><label for="acNome">Nome</label><input id="acNome" data-a="nome" value="${esc(a.nome)}"></div>
      <div class="campo"><label for="acData">Data do acordo</label><input type="date" id="acData" data-a="data" value="${a.data}"></div>
      <div class="campo w2"><label for="acDev">Devedor</label><select id="acDev" data-a="devedor">${devedoresDoContrato(ct).map(([v, r]) => `<option value="${v}"${v === a.devedor ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
      <div class="campo wfull"><label for="acCalc">Débito</label><select id="acCalc" data-a="calcId"><option value="">Débito atual pelos critérios do contrato (sem honorários)</option>
        ${calcs.map(x => `<option value="${x.id}"${x.id === a.calcId ? ' selected' : ''}>Cálculo salvo: ${esc(x.nome)}</option>`).join('')}</select>
        <small>O débito é atualizado até a data do acordo, com os critérios, custas, honorários e pagamentos do cálculo escolhido.</small></div>
    </div></section>
    <section class="cartao form"><h2>Desconto e entrada</h2><div class="grade-form">
      <div class="campo w2"><label>Desconto</label><div class="segmentado"><label><input type="radio" name="acDescModo" value="total"${d.modo !== 'itens' ? ' checked' : ''}> Sobre o total</label><label><input type="radio" name="acDescModo" value="itens"${d.modo === 'itens' ? ' checked' : ''}> Por componente</label></div></div>
      ${d.modo !== 'itens' ? `<div class="campo"><label for="acDesc">Desconto</label><div class="campo-bt">${opcaoTipoAc('desc', d.tipo)}<input id="acDesc" class="num" inputmode="decimal" data-num="desconto.valor" value="${mostrarAc(d.tipo, d.valor)}"></div></div>` : ''}
      <div class="campo"><label for="acSinal">Entrada (sinal)</label><div class="campo-bt">${opcaoTipoAc('sinal', s.tipo)}<input id="acSinal" class="num" inputmode="decimal" data-num="sinal.valor" value="${mostrarAc(s.tipo, s.valor)}"></div></div>
      <div class="campo"><label for="acSinalV">Vencimento da entrada</label><input type="date" id="acSinalV" data-a="sinal.venc" value="${s.venc || a.data}"></div>
    </div><div id="acItens"></div></section>
    <section class="cartao form"><h2>Parcelamento (Tabela Price)</h2><div class="grade-form">
      <div class="campo"><label for="acTaxa">Juros (% ao mês)</label><input id="acTaxa" class="num" inputmode="decimal" data-num="parcelamento.taxa" value="${fmtPct(p.taxa)}"></div>
      <div class="campo"><label for="acPrim">1ª parcela em</label><input type="date" id="acPrim" data-a="parcelamento.primeiroVenc" value="${p.primeiroVenc}"></div>
      <div class="campo w2"><label>Calcular por</label><div class="segmentado"><label><input type="radio" name="acModo" value="prazo"${p.modo !== 'parcela' ? ' checked' : ''}> Número de parcelas</label><label><input type="radio" name="acModo" value="parcela"${p.modo === 'parcela' ? ' checked' : ''}> Valor da parcela</label></div></div>
      ${p.modo === 'parcela' ? `<div class="campo"><label for="acParc">Valor da parcela (R$)</label><input id="acParc" class="num" inputmode="decimal" data-num="parcelamento.parcela" value="${p.parcela === '' ? '' : fmtNum(p.parcela)}"></div>`
        : `<div class="campo"><label for="acPrazo">Número de parcelas</label><input id="acPrazo" type="number" min="1" max="600" data-a="parcelamento.prazo" value="${p.prazo}"></div>`}
      <div class="campo wfull"><label class="inline"><input type="checkbox" data-chk="parcelamento.jurosAte1"${p.jurosAte1 !== false ? ' checked' : ''}> Juros desde a data do acordo até a 1ª parcela (proporcionais aos dias)</label></div>
      <h3 class="sec wfull">Parcela paga em atraso</h3>
      <div class="campo"><label for="acIdx">Correção</label><select id="acIdx" data-a="parcelamento.indice">${[...INDICES_CORRECAO, 'Nenhum'].map(i => `<option${i === p.indice ? ' selected' : ''}>${i}</option>`).join('')}</select></div>
      <div class="campo"><label for="acMulta">Multa (%)</label><input id="acMulta" class="num" inputmode="decimal" data-num="encargos.multa" value="${fmtPct(a.encargos.multa)}"></div>
      <div class="campo"><label for="acJuros">Juros (% ao mês)</label><input id="acJuros" class="num" inputmode="decimal" data-num="encargos.juros" value="${fmtPct(a.encargos.juros)}"></div>
      <div class="campo wfull"><label for="acObs">Observações</label><textarea id="acObs" data-a="obs" rows="2">${esc(a.obs || '')}</textarea></div>
    </div></section>
    <section class="cartao" id="acRes"></section>
    <div class="barra-salvar"><span id="estadoSalvar" class="dica">${sujo ? 'Alterações não salvas' : ''}</span>
      ${novo ? '' : '<button class="bt perigo" id="acExcluir">Excluir</button><button class="bt" id="acDescartar">Descartar proposta</button>'}
      <button class="bt" id="acSalvar">Salvar proposta</button><button class="bt primario" id="acAceitar">Acordo aceito: iniciar acompanhamento</button></div></div>`;
    ligar();
    recalcular();
  }

  function recalcular() {
    try {
      c = calcularAcordo(ct, a);
      if (a.desconto.modo === 'itens') $('#acItens').innerHTML = itensDescontoHTML(a, c);
      else $('#acItens').innerHTML = '';
      $('#acRes').innerHTML = resultadoAcordoHTML(a, c);
    } catch (e) { c = null; $('#acRes').innerHTML = `<p class="alerta">${esc(e.message)}</p>`; }
  }

  const caminho = (obj, k, v) => { const ps = k.split('.'); let o = obj; ps.slice(0, -1).forEach(x => { o = o[x] = o[x] || {}; }); o[ps[ps.length - 1]] = v; };
  let tempo = null;
  const mudou = (redesenhar) => { sujo = true; const e = $('#estadoSalvar'); if (e) e.textContent = 'Alterações não salvas'; if (redesenhar) return render(); clearTimeout(tempo); tempo = setTimeout(recalcular, 300); };

  function ligar() {
    const raiz = $('#telaAc');
    const ler = e => {
      const t = e.target, ds = t.dataset;
      if (e.type === 'input' && (t.type === 'date' || t.tagName === 'SELECT' || t.type === 'checkbox' || t.type === 'radio')) return;
      if (ds.a) caminho(a, ds.a, ds.a === 'parcelamento.prazo' ? Number(t.value) || '' : t.value);
      else if (ds.num) caminho(a, ds.num, t.value.trim() === '' ? '' : r2(parseValor(t.value)));
      else if (ds.chk) caminho(a, ds.chk, t.checked);
      else if (ds.acTipo) { if (ds.acTipo === 'desc') a.desconto.tipo = t.value; else if (ds.acTipo === 'sinal') a.sinal.tipo = t.value; else caminho(a.desconto.itens, ds.acTipo + '.tipo', t.value); }
      else if (ds.item) caminho(a.desconto.itens, ds.item + '.valor', t.value.trim() === '' ? '' : r2(parseValor(t.value)));
      else if (t.name === 'acDescModo') { a.desconto.modo = t.value; return mudou(true); }
      else if (t.name === 'acModo') { a.parcelamento.modo = t.value; return mudou(true); }
      else return;
      mudou(ds.a === 'calcId' || ds.a === 'data');
    };
    raiz.oninput = ler;
    raiz.onchange = ler;
    $('#acSalvar').addEventListener('click', () => executar(async () => { if (!c) throw new Error('Corrija o parcelamento antes de salvar.'); await salvar(); aviso('Proposta salva.'); }));
    $('#acAceitar').addEventListener('click', () => executar(async () => {
      if (!c) throw new Error('Corrija o parcelamento antes de continuar.');
      if (!c.deb.total) throw new Error('Não há débito para este acordo.');
      if (!confirm(`Registrar o acordo como aceito? O débito de ${fmtMoeda(c.deb.total)} em ${fmtData(a.data)} e o parcelamento ficam fixados, e os meses incluídos saem da Inadimplência e dos novos cálculos.`)) return;
      const { r: _r, ...deb } = c.deb;
      a.debito = deb;
      a.meses = deb.meses;
      a.saldoInicial = c.saldo;
      a.plano = c.plano.parcelas;
      a.sinalParcela = c.sinal > 0 ? { n: 0, venc: a.sinal.venc || a.data, valor: c.sinal, juros: 0, amort: c.sinal, saldo: c.saldo, pago: 0 } : null;
      a.propHon = c.propHon;
      a.resumo = { negociado: c.negociado, desconto: c.desconto, sinal: c.sinal, saldo: c.saldo, totalAcordo: c.totalAcordo, totalJuros: c.totalJuros, pmt: c.plano.pmt };
      a.situacao = 'aceito';
      a.aceitoEm = hoje();
      await salvar();
      aviso('Acordo registrado. Lance os pagamentos conforme forem feitos.');
      if (location.hash === `#/contrato/${cid}/acordo/${a.id}`) rotear(); else location.hash = `#/contrato/${cid}/acordo/${a.id}`;
    }));
    $('#acDescartar')?.addEventListener('click', () => executar(async () => { if (!confirm('Marcar esta proposta como descartada?')) return; a.situacao = 'descartado'; await salvar(); location.hash = `#/contrato/${cid}/acordos`; }));
    $('#acExcluir')?.addEventListener('click', () => executar(async () => {
      if (!confirm(`Excluir a proposta "${a.nome}"?`)) return;
      await gravarCalculos(cid, arq => { delete arq.acordos?.[a.id]; });
      sujo = false; location.hash = `#/contrato/${cid}/acordos`;
    }));
    ligarBotoesPDF('acPdf', async () => { if (!c) throw new Error('Corrija o parcelamento.'); return pdfAcordo(ct, a, c); });
    $('#acXlsx').addEventListener('click', () => executar(async () => { if (!c) throw new Error('Corrija o parcelamento.'); await salvarPlanilha(xlsxAcordo(ct, a, c), nomeArquivo('acordo', ct.codigo, a.data) + '.xlsx'); }));
  }

  async function salvar() {
    const reg = await gravarAcordo(cid, a);
    Object.assign(a, reg);
    sujo = false;
    if (novo) { novo = false; history.replaceState(null, '', `#/contrato/${cid}/acordo/${a.id}`); }
    const e = $('#estadoSalvar'); if (e) e.textContent = '';
  }

  render();
}

function itensDescontoHTML(a, c) {
  return `<div class="rolagem"><table class="tabela tab-edicao"><thead><tr><th>Componente</th><th class="num">Valor</th><th>Desconto</th><th class="num">Desconto (R$)</th></tr></thead><tbody>
    ${COMPONENTES_ACORDO.filter(([k]) => c.deb.comp[k]).map(([k, rot]) => { const it = a.desconto.itens?.[k] || {}; return `<tr><td>${esc(rot)}</td><td class="num">${fmtNum(c.deb.comp[k])}</td>
      <td><div class="campo-bt">${opcaoTipoAc(k, it.tipo)}<input class="num" inputmode="decimal" data-item="${k}" value="${mostrarAc(it.tipo, it.valor)}" aria-label="Desconto em ${esc(rot)}"></div></td><td class="num">${fmtNum(c.descItens[k] || 0)}</td></tr>`; }).join('')}
  </tbody></table></div>`;
}

function resultadoAcordoHTML(a, c) {
  const deb = c.deb;
  return `<h2>Resultado</h2>
    <div class="kpis"><div class="kpi"><span>Débito em ${fmtData(a.data)}</span><b>${fmtMoeda(deb.total)}</b></div><div class="kpi"><span>Desconto</span><b>${fmtMoeda(c.desconto)}</b></div>
      <div class="kpi"><span>Valor negociado</span><b>${fmtMoeda(c.negociado)}</b></div><div class="kpi"><span>Entrada</span><b>${fmtMoeda(c.sinal)}</b></div>
      <div class="kpi"><span>${c.plano.n} parcela${c.plano.n === 1 ? '' : 's'} de</span><b>${fmtMoeda(c.plano.pmt)}</b></div><div class="kpi"><span>Total do acordo</span><b>${fmtMoeda(c.totalAcordo)}</b></div></div>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Composição do débito (${esc(deb.calcNome)})</th><th class="num">Valor</th></tr></thead><tbody>
      ${COMPONENTES_ACORDO.filter(([k]) => deb.comp[k]).map(([k, rot]) => `<tr><td>${esc(rot)}</td><td class="num">${fmtNum(deb.comp[k])}</td></tr>`).join('')}
      <tr class="total-geral"><td>Total</td><td class="num">${fmtNum(deb.total)}</td></tr></tbody></table></div>
    ${c.plano.parcelas.length ? `<h3 class="sec">Parcelas</h3><div class="rolagem"><table class="tabela"><thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Juros</th><th class="num">Amortização</th><th class="num">Saldo</th></tr></thead><tbody>
      ${c.sinal ? `<tr><td>Entrada</td><td>${fmtData(a.sinal.venc || a.data)}</td><td class="num">${fmtNum(c.sinal)}</td><td class="num"></td><td class="num">${fmtNum(c.sinal)}</td><td class="num">${fmtNum(c.saldo)}</td></tr>` : ''}
      ${c.plano.parcelas.map(p => `<tr><td>${p.n}</td><td>${fmtData(p.venc)}</td><td class="num">${fmtNum(p.valor)}</td><td class="num">${fmtNum(p.juros)}</td><td class="num">${fmtNum(p.amort)}</td><td class="num">${fmtNum(p.saldo)}</td></tr>`).join('')}
      <tr class="total-geral"><td colspan="2">Total</td><td class="num">${fmtNum(c.totalAcordo)}</td><td class="num">${fmtNum(c.totalJuros)}</td><td colspan="2"></td></tr></tbody></table></div>` : ''}
    ${c.honNeg > 0 ? `<p class="dica">Rateio de cada pagamento: ${fmtPct(r2((1 - c.propHon) * 100))}% para o locador e ${fmtPct(r2(c.propHon * 100))}% de honorários advocatícios (${fmtMoeda(c.honNeg)} no valor negociado).</p>` : ''}
    ${deb.r ? notasDebito(deb.r).map(n => `<p class="dica">${esc(n)}</p>`).join('') : ''}`;
}

/* ================= Acompanhamento ================= */
function situacaoParcela(p, data) {
  if (restanteNominal(p) <= 0) return '<span class="chip fechado">Paga</span>';
  if (p.pago > 0) return `<span class="chip aberto">Paga em parte</span>`;
  const d = diasEntre(p.venc, data);
  return d > 0 ? `<span class="chip pendente">Vencida há ${d} dia${d === 1 ? '' : 's'}</span>` : '<span class="chip neutro">A vencer</span>';
}

function acompanhamentoAcordo(ct, a) {
  const cid = ct.id, h = hoje();
  const parcelas = parcelasDoAcordo(a), q = a.situacao === 'aceito' ? valorQuitacao(a, h) : null;
  const pago = somar(a.eventos || [], e => e.valor || 0);
  $('#conteudo').innerHTML = cabecalho(esc(a.nome) + ' ' + chipAcordo(a.situacao), `${esc(rotuloContrato(ct))} · Devedor: <b>${esc(nomeDevedor(ct, a))}</b> · Acordo de ${fmtData(a.data)}`,
    botoesPDF('acExt', 'extrato') + botoesPDF('acPdf', 'acordo'), `<a class="voltar" href="#/contrato/${cid}/acordos">&larr; Acordos</a>`) + `
  <div class="kpis"><div class="kpi"><span>Valor negociado</span><b>${fmtMoeda(a.resumo?.negociado || 0)}</b></div><div class="kpi"><span>Total do acordo</span><b>${fmtMoeda(a.resumo?.totalAcordo || 0)}</b></div>
    <div class="kpi"><span>Pago até hoje</span><b>${fmtMoeda(pago)}</b></div>${q ? `<div class="kpi"><span>Para quitar hoje</span><b>${fmtMoeda(q.total)}</b></div>` : ''}</div>
  <section class="cartao">
    <div class="cartao-cab"><h2>Parcelas</h2>${a.situacao === 'aceito' ? `<div class="acoes"><button class="bt" id="acAmort">Amortização antecipada</button><button class="bt" id="acQuitar">Quitar o acordo</button><button class="bt perigo" id="acDescump">Descumprimento</button></div>` : ''}</div>
    <div class="rolagem"><table class="tabela"><thead><tr><th>Parcela</th><th>Vencimento</th><th class="num">Valor</th><th class="num">Pago (nominal)</th><th>Situação</th><th></th></tr></thead><tbody>
      ${parcelas.map(p => `<tr><td>${p.n || 'Entrada'}</td><td>${fmtData(p.venc)}</td><td class="num">${fmtNum(p.valor)}</td><td class="num">${p.pago ? fmtNum(p.pago) : ''}</td><td>${situacaoParcela(p, h)}</td>
        <td>${a.situacao === 'aceito' && restanteNominal(p) > 0 ? `<button class="bt pequeno" data-pagar="${p.n}">Registrar pagamento</button>` : ''}</td></tr>`).join('')}
    </tbody></table></div>
  </section>
  <section class="cartao">
    <div class="cartao-cab"><h2>Lançamentos</h2>${(a.eventos || []).length ? '<div class="acoes"><button class="bt pequeno" id="acDesfazer">Desfazer o último</button></div>' : ''}</div>
    ${(a.eventos || []).length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Data</th><th>Lançamento</th><th class="num">Valor</th><th>Prestação de contas</th><th>Observação</th></tr></thead><tbody>
      ${a.eventos.map(e => `<tr><td>${fmtData(e.data)}</td><td>${esc(descEvento(e))}</td><td class="num">${e.valor ? fmtNum(e.valor) : fmtNum(e.devido || 0)}</td>
        <td>${e.prestacao?.lancar ? `${fmtMoeda(e.prestacao.valor === '' || e.prestacao.valor == null ? e.valor : e.prestacao.valor)} em ${fmtData(e.prestacao.data)}${e.prestacao.taxa === false ? ' (sem taxa)' : ''}` : e.valor ? 'Não lançado' : ''}</td><td>${esc(e.obs || '')}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="vazio">Nenhum pagamento lançado.</p>'}
    <p class="dica">Os pagamentos marcados para a prestação de contas entram no mês da data informada, como "Recebido de acordo", com a taxa de administração do contrato (se marcada).</p>
  </section>`;

  const gravar = async () => { await gravarAcordo(cid, a); rotear(); };
  $$('[data-pagar]').forEach(b => b.addEventListener('click', () => modalPagamentoAcordo(ct, a, +b.dataset.pagar, gravar)));
  $('#acAmort')?.addEventListener('click', () => modalAmortAcordo(ct, a, gravar));
  $('#acQuitar')?.addEventListener('click', () => modalQuitarAcordo(ct, a, gravar));
  $('#acDescump')?.addEventListener('click', () => modalDescumprimento(ct, a, gravar));
  $('#acDesfazer')?.addEventListener('click', () => executar(async () => {
    const ult = a.eventos[a.eventos.length - 1];
    if (!confirm(`Desfazer o último lançamento (${descEvento(ult)} de ${fmtData(ult.data)})?`)) return;
    desfazerUltimo(a); await gravar(); aviso('Lançamento desfeito.');
  }));
  ligarBotoesPDF('acExt', async () => pdfExtratoAcordo(ct, a, h));
  ligarBotoesPDF('acPdf', async () => pdfAcordo(ct, a, { deb: a.debito, desconto: a.resumo.desconto, negociado: a.resumo.negociado, sinal: a.resumo.sinal, saldo: a.resumo.saldo,
    plano: { pmt: a.resumo.pmt, n: (a.plano || []).length, parcelas: a.plano || [] }, totalAcordo: a.resumo.totalAcordo, totalJuros: a.resumo.totalJuros, propHon: a.propHon || 0, honNeg: 0 }));
}

// Campos da prestação de contas nos modais de pagamento
function prestacaoHTML(valorLocador) {
  return `<h3 class="sec">Prestação de contas do locador</h3>
    <div class="grade-form"><div class="campo wfull"><label class="inline"><input type="checkbox" id="mpLancar" checked> Lançar na prestação de contas do locador</label></div>
      <div class="campo"><label for="mpDisp">Disponível em</label><input type="date" id="mpDisp"><small>Ex.: depósito judicial: data do levantamento.</small></div>
      <div class="campo"><label for="mpValLoc">Valor a lançar (R$)</label><input id="mpValLoc" class="num" inputmode="decimal" value="${fmtNum(valorLocador)}"><small>Parte do locador (sem os honorários).</small></div>
      <div class="campo"><label>&nbsp;</label><label class="inline"><input type="checkbox" id="mpTaxa" checked> Incide taxa de administração</label></div></div>`;
}
const lerPrestacao = data => ({ lancar: $('#mpLancar').checked, data: $('#mpDisp').value || data, valor: $('#mpValLoc').value.trim() === '' ? '' : r2(parseValor($('#mpValLoc').value)), taxa: $('#mpTaxa').checked });

function modalPagamentoAcordo(ct, a, n, gravar) {
  const p = parcelasDoAcordo(a).find(x => x.n === n), h = hoje();
  const d = devidoParcela(a, p, h);
  abrirModal(`<div class="modal-cab"><h2>Pagamento da ${n ? 'parcela ' + n : 'entrada'}</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <p>Vencimento ${fmtData(p.venc)} · valor ${fmtMoeda(p.valor)}${p.pago ? ` · já pago ${fmtMoeda(p.pago)}` : ''}</p>
    <div class="grade-form form-modal">
      <div class="campo"><label for="mpData">Data do pagamento</label><input type="date" id="mpData" value="${h}"></div>
      <div class="campo"><label for="mpValor">Valor pago (R$)</label><input id="mpValor" class="num" inputmode="decimal" value="${fmtNum(d.total)}"></div>
      <div class="campo w2"><label for="mpObs">Observação</label><input id="mpObs"></div>
    </div><p class="dica" id="mpInfo"></p>
    ${prestacaoHTML(rateio(d.total, a.propHon || 0).locador)}
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt primario" id="mpOk">Registrar</button></div>`);
  const info = () => { const dt = $('#mpData').value; if (!ehData(dt)) return; const x = devidoParcela(a, p, dt);
    $('#mpInfo').textContent = x.dias ? `Em atraso: ${x.dias} dia(s). Devido em ${fmtData(dt)}: ${fmtMoeda(x.total)} (correção ${fmtMoeda(r2(x.corrigido - x.base))}, juros ${fmtMoeda(x.juros)}, multa ${fmtMoeda(x.multa)}).` : `Devido em ${fmtData(dt)}: ${fmtMoeda(x.total)}.`; };
  $('#mpData').addEventListener('change', () => { info(); const x = devidoParcela(a, p, $('#mpData').value); $('#mpValor').value = fmtNum(x.total); $('#mpValLoc').value = fmtNum(rateio(x.total, a.propHon || 0).locador); });
  $('#mpValor').addEventListener('change', () => { $('#mpValLoc').value = fmtNum(rateio(r2(parseValor($('#mpValor').value)), a.propHon || 0).locador); });
  info();
  $('#mpOk').addEventListener('click', () => executar(async () => {
    const data = $('#mpData').value;
    lancarPagamento(a, { n, data, valor: r2(parseValor($('#mpValor').value)), obs: $('#mpObs').value.trim(), prestacao: lerPrestacao(data) });
    fecharModal(); await gravar(); aviso('Pagamento registrado.');
  }));
}

function modalAmortAcordo(ct, a, gravar) {
  const h = hoje();
  abrirModal(`<div class="modal-cab"><h2>Amortização antecipada</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <div class="grade-form form-modal">
      <div class="campo"><label for="mpData">Data</label><input type="date" id="mpData" value="${h}"></div>
      <div class="campo"><label for="mpValor">Valor (R$)</label><input id="mpValor" class="num" inputmode="decimal"></div>
      <div class="campo w2"><label>Efeito</label><div class="segmentado"><label><input type="radio" name="mpEf" value="prazo" checked> Reduz o prazo</label><label><input type="radio" name="mpEf" value="parcela"> Reduz a parcela</label></div></div>
      <div class="campo wfull"><label for="mpObs">Observação</label><input id="mpObs"></div>
    </div>
    ${prestacaoHTML(0)}
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt primario" id="mpOk">Registrar</button></div>`);
  $('#mpValor').addEventListener('change', () => { $('#mpValLoc').value = fmtNum(rateio(r2(parseValor($('#mpValor').value)), a.propHon || 0).locador); });
  $('#mpOk').addEventListener('click', () => executar(async () => {
    const data = $('#mpData').value;
    lancarAmortizacao(a, { data, valor: r2(parseValor($('#mpValor').value)), efeito: $('input[name=mpEf]:checked').value, obs: $('#mpObs').value.trim(), prestacao: lerPrestacao(data) });
    fecharModal(); await gravar(); aviso('Amortização registrada; as parcelas restantes foram recalculadas.');
  }));
}

function modalQuitarAcordo(ct, a, gravar) {
  const h = hoje(), q = valorQuitacao(a, h);
  abrirModal(`<div class="modal-cab"><h2>Quitar o acordo</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <div class="grade-form form-modal">
      <div class="campo"><label for="mpData">Data</label><input type="date" id="mpData" value="${h}"></div>
      <div class="campo"><label for="mpValor">Valor pago (R$)</label><input id="mpValor" class="num" inputmode="decimal" value="${fmtNum(q.total)}"></div>
      <div class="campo wfull"><label for="mpObs">Observação</label><input id="mpObs"></div>
    </div><p class="dica" id="mpInfo">Para quitação em ${fmtData(h)}: ${fmtMoeda(q.total)} (parcelas vencidas com encargos ${fmtMoeda(q.totalVencidas)} + saldo futuro ${fmtMoeda(q.futuroCorrigido)}).</p>
    ${prestacaoHTML(rateio(q.total, a.propHon || 0).locador)}
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt primario" id="mpOk">Registrar quitação</button></div>`);
  $('#mpData').addEventListener('change', () => { const x = valorQuitacao(a, $('#mpData').value); $('#mpValor').value = fmtNum(x.total); $('#mpValLoc').value = fmtNum(rateio(x.total, a.propHon || 0).locador);
    $('#mpInfo').textContent = `Para quitação em ${fmtData($('#mpData').value)}: ${fmtMoeda(x.total)}.`; });
  $('#mpOk').addEventListener('click', () => executar(async () => {
    const data = $('#mpData').value;
    lancarQuitacao(a, { data, valor: r2(parseValor($('#mpValor').value)), obs: $('#mpObs').value.trim(), prestacao: lerPrestacao(data) });
    fecharModal(); await gravar(); aviso('Acordo quitado.');
  }));
}

function modalDescumprimento(ct, a, gravar) {
  const h = hoje();
  abrirModal(`<div class="modal-cab"><h2>Descumprimento do acordo</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <div class="grade-form form-modal">
      <div class="campo"><label for="mpData">Data</label><input type="date" id="mpData" value="${h}"></div>
      <div class="campo w2"><label>Valor devido</label><div class="segmentado"><label><input type="radio" name="mpModo" value="saldo" checked> Vencimento antecipado do saldo</label><label><input type="radio" name="mpModo" value="original"> Perda do desconto (débito original menos pagamentos)</label></div></div>
      <div class="campo"><label for="mpMulta">Multa pelo descumprimento (%)</label><input id="mpMulta" class="num" inputmode="decimal" value="0"></div>
      <div class="campo wfull"><label for="mpObs">Observação</label><input id="mpObs"></div>
    </div><p class="dica" id="mpInfo"></p>
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt perigo" id="mpOk">Registrar descumprimento</button></div>`);
  const info = () => { try { const r = valorDescumprimento(ct, a, $('#mpData').value, $('input[name=mpModo]:checked').value, parseValor($('#mpMulta').value));
    $('#mpInfo').textContent = `Valor devido em ${fmtData($('#mpData').value)}: ${fmtMoeda(r.total)}${r.multa ? ` (inclui multa de ${fmtMoeda(r.multa)})` : ''}. Os meses do acordo voltam à Inadimplência e aos cálculos do débito.`; } catch (e) { $('#mpInfo').textContent = e.message; } };
  $$('#mpData, #mpMulta, input[name=mpModo]').forEach(e => e.addEventListener('change', info));
  info();
  $('#mpOk').addEventListener('click', () => executar(async () => {
    lancarDescumprimento(ct, a, { data: $('#mpData').value, modo: $('input[name=mpModo]:checked').value, multa: parseValor($('#mpMulta').value), obs: $('#mpObs').value.trim() });
    fecharModal(); await gravar(); aviso('Descumprimento registrado.');
  }));
}

/* ================= PDF e Excel ================= */
function infoAcordo(ct, a) {
  const lo = D.locadores[ct.locadorId];
  return [
    `${rotuloContrato(ct)} · Imóvel: ${descImovel(D.imoveis[ct.imovelId])}`,
    `Credor (locador): ${lo?.nome || '—'}${lo?.documento ? ' (CPF/CNPJ ' + lo.documento + ')' : ''}`,
    `Devedor: ${nomeDevedor(ct, a)}`,
  ];
}

function pdfAcordo(ct, a, c) {
  const P = novoDocumento();
  P.cab();
  tituloPDF(P, a.situacao === 'proposta' ? 'Proposta de acordo' : 'Acordo de pagamento', [...infoAcordo(ct, a).map((t, i) => [t, i ? 9 : 10, i ? 'normal' : 'bold']), [`Data do acordo: ${fmtData(a.data)}`, 9, 'normal', COR_SUAVE]]);
  subtituloPDF(P, 'Débito em ' + fmtData(a.data));
  tabelaPDF(P, [{ t: 'Componente', w: 140 }, { t: 'Valor (R$)', w: 42, a: 'r' }],
    [...COMPONENTES_ACORDO.filter(([k]) => c.deb.comp[k]).map(([k, rot]) => ({ c: [rot, fmtNum(c.deb.comp[k])] })), { c: ['Total do débito', fmtNum(c.deb.total)], total: true }], 9);
  resumoPDF(P, [['Débito', c.deb.total], ['(-) Desconto', c.desconto], ['(=) Valor negociado', c.negociado, 'b'], ['(-) Entrada', c.sinal], ['(=) Saldo parcelado', c.saldo, 'b'], ['Total do acordo (entrada + parcelas)', c.totalAcordo, 'f']], 110);
  if (c.plano.parcelas.length || c.sinal) {
    subtituloPDF(P, 'Parcelas' + (Number(a.parcelamento?.taxa) ? ` (juros de ${fmtPct(a.parcelamento.taxa)}% ao mês, Tabela Price)` : ''));
    tabelaPDF(P, [{ t: 'Parcela', w: 20 }, { t: 'Vencimento', w: 28, nw: true }, { t: 'Valor', w: 34, a: 'r' }, { t: 'Juros', w: 32, a: 'r' }, { t: 'Amortização', w: 34, a: 'r' }, { t: 'Saldo', w: 34, a: 'r' }],
      [...(c.sinal ? [{ c: ['Entrada', fmtData(a.sinal?.venc || a.data), fmtNum(c.sinal), '', fmtNum(c.sinal), fmtNum(c.saldo)] }] : []),
        ...c.plano.parcelas.map(p => ({ c: [String(p.n), fmtData(p.venc), fmtNum(p.valor), fmtNum(p.juros), fmtNum(p.amort), fmtNum(p.saldo)] })),
        { c: ['Total', '', fmtNum(c.totalAcordo), fmtNum(c.totalJuros), '', ''], total: true }], 8.5);
  }
  const enc = a.encargos || {};
  paragrafoPDF(P, `Parcela paga em atraso: correção ${a.parcelamento?.indice && a.parcelamento.indice !== 'Nenhum' ? 'pelo ' + a.parcelamento.indice : 'não aplicada'}, juros de ${fmtPct(enc.juros || 0)}% ao mês pro rata die e multa de ${fmtPct(enc.multa || 0)}%.`, 8.5);
  if (a.obs) { P.y += 2; paragrafoPDF(P, 'Observações: ' + a.obs, 8.5, 'italic', COR_SUAVE); }
  rodapePDF(P);
  return { doc: P.doc, nome: nomeArquivo(a.situacao === 'proposta' ? 'proposta-acordo' : 'acordo', ct.codigo, a.data) + '.pdf' };
}

function pdfExtratoAcordo(ct, a, data) {
  const P = novoDocumento();
  P.cab();
  tituloPDF(P, 'Extrato do acordo', [...infoAcordo(ct, a).map((t, i) => [t, i ? 9 : 10, i ? 'normal' : 'bold']), [`Acordo de ${fmtData(a.data)} · situação em ${fmtData(data)}: ${SITUACOES_ACORDO[a.situacao]}`, 9, 'normal', COR_SUAVE]]);
  subtituloPDF(P, 'Parcelas');
  tabelaPDF(P, [{ t: 'Parcela', w: 22 }, { t: 'Vencimento', w: 28, nw: true }, { t: 'Valor', w: 34, a: 'r' }, { t: 'Pago (nominal)', w: 34, a: 'r' }, { t: 'Situação', w: 64 }],
    parcelasDoAcordo(a).map(p => ({ c: [p.n ? String(p.n) : 'Entrada', fmtData(p.venc), fmtNum(p.valor), p.pago ? fmtNum(p.pago) : '', situacaoParcela(p, data).replace(/<[^>]+>/g, '')] })), 8.5);
  if ((a.eventos || []).length) {
    subtituloPDF(P, 'Lançamentos');
    tabelaPDF(P, [{ t: 'Data', w: 24, nw: true }, { t: 'Lançamento', w: 100 }, { t: 'Valor', w: 32, a: 'r' }, { t: 'Observação', w: 46 }],
      a.eventos.map(e => ({ c: [fmtData(e.data), descEvento(e), fmtNum(e.valor || e.devido || 0), e.obs || ''] })), 8.5);
  }
  if (a.situacao === 'aceito') { const q = valorQuitacao(a, data); resumoPDF(P, [['Pago até a data', somar(a.eventos || [], e => e.valor || 0)], [`Valor para quitação em ${fmtData(data)}`, q.total, 'f']], 110); }
  rodapePDF(P);
  return { doc: P.doc, nome: nomeArquivo('extrato-acordo', ct.codigo, data) + '.pdf' };
}

function xlsxAcordo(ct, a, c) {
  const L = [...cabecalhoXLSX(), [{ v: a.situacao === 'proposta' ? 'Proposta de acordo' : 'Acordo de pagamento', s: 'tit' }], ...infoAcordo(ct, a).map(t => [t]), [`Data do acordo: ${fmtData(a.data)}`], null,
    { c: ['Componente', 'Valor'].map(v => ({ v, s: 'cab' })) }];
  const ini = L.length + 1;
  COMPONENTES_ACORDO.filter(([k]) => c.deb.comp[k]).forEach(([k, rot]) => L.push([rot, { v: c.deb.comp[k], s: 'm' }]));
  L.push([{ v: 'Total do débito', s: 'bt' }, { f: `SUM(B${ini}:B${L.length})`, v: c.deb.total, s: 'mt' }]);
  L.push([{ v: 'Desconto', s: 'b' }, { v: c.desconto, s: 'm' }], [{ v: 'Valor negociado', s: 'b' }, { v: c.negociado, s: 'm' }], [{ v: 'Entrada', s: 'b' }, { v: c.sinal, s: 'm' }], [{ v: 'Saldo parcelado', s: 'b' }, { v: c.saldo, s: 'm' }], null);
  L.push({ c: ['Parcela', 'Vencimento', 'Valor', 'Juros', 'Amortização', 'Saldo'].map(v => ({ v, s: 'cab' })) });
  const ip = L.length + 1;
  if (c.sinal) L.push(['Entrada', { v: a.sinal?.venc || a.data, s: 'd' }, { v: c.sinal, s: 'm' }, null, { v: c.sinal, s: 'm' }, { v: c.saldo, s: 'm' }]);
  c.plano.parcelas.forEach(p => L.push([{ v: p.n, s: 'i' }, { v: p.venc, s: 'd' }, { v: p.valor, s: 'm' }, { v: p.juros, s: 'm' }, { v: p.amort, s: 'm' }, { v: p.saldo, s: 'm' }]));
  L.push([{ v: 'Total', s: 'bt' }, null, { f: `SUM(C${ip}:C${L.length})`, v: c.totalAcordo, s: 'mt' }, { f: `SUM(D${ip}:D${L.length})`, v: c.totalJuros, s: 'mt' }]);
  return gerarXLSX([{ nome: 'Acordo', linhas: L, larguras: [40, 14, 14, 14, 14, 14] }]);
}
