'use strict';
/*
  Repasses aos clientes numa tela só: saldos de todas as locações num mês, filtros, seleção de várias locações,
  visão por beneficiário (um locador com vários imóveis, ou vários beneficiários numa locação), programação e
  efetivação dos repasses, prévia da prestação de contas (PDF) e planilha do lote (Excel).

  Regras (decididas com o usuário):
  - o repasse fica registrado no mês da data do pagamento (regime de caixa), no extrato de cada contrato;
  - "programado" reserva o valor (não pode ser programado de novo), mas só o "efetuado" baixa o saldo em conta;
  - repasse parcial é permitido; o que sobra continua como saldo e passa para o mês seguinte;
  - mês fechado: permitido, com aviso;
  - beneficiários: clientes cadastrados, com percentual, no contrato (sem eles, 100% para o locador).
*/

/* ================= Beneficiários no cadastro do contrato ================= */
function beneficiarioLinhaHTML(b = {}) {
  return `<div class="ben-linha"><select class="ben-loc" aria-label="Beneficiário"><option value="">— cliente —</option>${opcoes('locadores').map(([v, r]) => `<option value="${esc(v)}"${v === b.locadorId ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>
    <input class="ben-pct num" inputmode="decimal" placeholder="%" value="${b.pct === undefined || b.pct === '' ? '' : fmtPct(b.pct)}" aria-label="Percentual"> %
    <button type="button" class="bt-x" data-acao="del-ben" title="Remover">&times;</button></div>`;
}
function beneficiariosHTML(reg) {
  return `<div class="campo wfull"><p class="dica">Quando o valor da locação é repassado a mais de uma pessoa (coproprietários, cessionário, usufrutuário), informe cada beneficiário e o seu percentual (total de 100%). Os beneficiários precisam estar cadastrados em Clientes (locadores), com os dados bancários. Em branco, 100% para o cliente do contrato.</p>
    <div id="beneficiarios">${(reg.beneficiarios || []).map(beneficiarioLinhaHTML).join('')}</div>
    <button type="button" class="bt pequeno" id="btAddBen">+ Beneficiário</button></div>`;
}
function ligarBeneficiarios() {
  $('#btAddBen')?.addEventListener('click', () => {
    const vazio = !$$('#beneficiarios .ben-linha').length;
    $('#beneficiarios').insertAdjacentHTML('beforeend', beneficiarioLinhaHTML(vazio ? { locadorId: $('#form').elements.locadorId.value, pct: 100 } : {}));
  });
  $('#beneficiarios')?.addEventListener('click', e => { if (e.target.dataset.acao === 'del-ben') e.target.closest('.ben-linha').remove(); });
}
function lerBeneficiarios() {
  const l = $$('#beneficiarios .ben-linha').map(d => ({ locadorId: $('.ben-loc', d).value, pct: $('.ben-pct', d).value.trim() === '' ? 0 : r2(parseValor($('.ben-pct', d).value)) }))
    .filter(b => b.locadorId || b.pct);
  if (!l.length) return [];
  if (l.some(b => !b.locadorId)) throw new Error('Escolha o cliente de cada beneficiário do repasse.');
  if (new Set(l.map(b => b.locadorId)).size !== l.length) throw new Error('O mesmo cliente aparece duas vezes nos beneficiários do repasse.');
  if (l.some(b => !(b.pct > 0))) throw new Error('Informe o percentual de cada beneficiário do repasse.');
  const soma = l.reduce((s, b) => s + cent(b.pct), 0) / 100;
  if (Math.abs(soma - 100) > 0.005) throw new Error(`Os percentuais dos beneficiários do repasse somam ${fmtPct(soma)}%; devem somar 100%.`);
  return l;
}

/* ================= Dados da tela ================= */
const SITUACOES_REPASSE = { pendente: 'Saldo a repassar', programado: 'Programado', repassado: 'Repassado', sem: 'Sem saldo' };
const chipRepasse = s => `<span class="chip ${s === 'pendente' ? 'pendente' : s === 'programado' ? 'aberto' : s === 'repassado' ? 'fechado' : 'neutro'}">${SITUACOES_REPASSE[s]}</span>`;
const dadosBancarios = lo => lo ? [lo.favorecido && 'Favorecido: ' + lo.favorecido, lo.banco && 'Banco ' + lo.banco, lo.agencia && 'Ag. ' + lo.agencia, lo.conta && 'Conta ' + lo.conta, lo.pix && 'PIX ' + lo.pix].filter(Boolean).join(' · ') : '';

// Uma linha por contrato no mês: valores do extrato e situação do repasse
async function linhasRepasse(mes) {
  const cts = Object.values(D.contratos).sort(ordemContrato);
  const exts = await Promise.all(cts.map(c => carregarExtrato(c.id)));
  const out = [];
  cts.forEach((ct, i) => {
    const cad = calcularExtrato(ct, exts[i]);
    const x = cad.find(z => z.ym === mes);
    if (!x) { if (ct.status !== 'encerrado' && mes >= (cad[0]?.ym || inicioControle(ct))) out.push({ ct, naoGerado: true, situacao: 'sem', livre: 0 }); return; }
    const k = x.c;
    const livre = r2(k.saldoConta - k.programado);
    const situacao = livre > 0.004 ? 'pendente' : k.programado > 0 ? 'programado' : k.repassado > 0 ? 'repassado' : 'sem';
    out.push({ ct, x, k, livre, situacao, pagou: k.situacao !== 'aberto' || k.anteriores?.length });
  });
  return out;
}

// Parte de cada beneficiário numa linha: saldo livre pelo percentual, programado e repassado pelo registrado
function partesBeneficiarios(l) {
  const bens = beneficiariosDe(l.ct);
  const reps = l.x?.mes.repasses || [];
  const deBen = (id, prog) => reps.filter(r => (r.beneficiarioId || l.ct.locadorId) === id && repasseEfetuado(r) !== prog).reduce((s, r) => s + cent(r.valor), 0) / 100;
  let resto = cent(l.livre || 0);
  return bens.map((b, i) => {
    const parte = i === bens.length - 1 ? resto : Math.round(cent(l.livre || 0) * b.pct / 100);
    resto -= parte;
    return { locadorId: b.locadorId, pct: Number(b.pct), livre: parte / 100, programado: deBen(b.locadorId, true), repassado: deBen(b.locadorId, false) };
  });
}

/* ================= Tela ================= */
async function telaRepasses(h) {
  const q = new URLSearchParams(h.split('?')[1] || '');
  const st = { mes: ehMes(q.get('m')) ? q.get('m') : mesAtual(), sit: q.get('s') || 'pendente', cli: q.get('c') || '', ver: q.get('v') || 'locacao', busca: '' };
  const todas = await linhasRepasse(st.mes);
  const sel = new Set();
  const ir = mud => { location.hash = '#/repasses?' + new URLSearchParams({ m: mud.mes ?? st.mes, s: mud.sit ?? st.sit, c: mud.cli ?? st.cli, v: mud.ver ?? st.ver }); };

  const filtradas = () => todas.filter(l => {
    if (st.cli && !beneficiariosDe(l.ct).some(b => b.locadorId === st.cli)) return false;
    if (st.sit === 'pendente' && l.situacao !== 'pendente') return false;
    if (st.sit === 'pago' && !l.pagou) return false;
    if (st.sit === 'programado' && !(l.k?.programado > 0)) return false;
    if (st.sit === 'repassado' && !(l.k?.repassado > 0)) return false;
    if (st.busca) {
      const t = [l.ct.codigo, nomeDe('locatarios', l.ct.locatarioId), ...beneficiariosDe(l.ct).map(b => nomeDe('locadores', b.locadorId)), descImovel(D.imoveis[l.ct.imovelId])].join(' ').toLowerCase();
      if (!t.includes(st.busca)) return false;
    }
    return true;
  });

  $('#conteudo').innerHTML = cabecalho('Repasses', 'Saldos de todas as locações no mês, programação e confirmação dos repasses aos clientes') + `
  <section class="cartao form"><div class="grade-form">
    <div class="campo"><label for="rpMes">Mês</label><input type="month" id="rpMes" value="${st.mes}"></div>
    <div class="campo w2"><label for="rpSit">Mostrar</label><select id="rpSit">${[['pendente', 'Com saldo a repassar'], ['pago', 'Locatário já pagou'], ['programado', 'Com repasse programado'], ['repassado', 'Com repasse efetuado'], ['todos', 'Todas as locações']].map(([v, r]) => `<option value="${v}"${v === st.sit ? ' selected' : ''}>${r}</option>`).join('')}</select></div>
    <div class="campo w2"><label for="rpCli">Cliente (beneficiário)</label><select id="rpCli"><option value="">Todos</option>${opcoes('locadores').map(([v, r]) => `<option value="${esc(v)}"${v === st.cli ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select></div>
    <div class="campo w2"><label>Ver</label><div class="segmentado"><label><input type="radio" name="rpVer" value="locacao"${st.ver !== 'beneficiario' ? ' checked' : ''}> Por locação</label><label><input type="radio" name="rpVer" value="beneficiario"${st.ver === 'beneficiario' ? ' checked' : ''}> Por beneficiário</label></div></div>
    <div class="campo w2"><label for="rpBusca">Buscar</label><input type="search" id="rpBusca" placeholder="Locatário, cliente, imóvel ou contrato"></div>
  </div></section>
  <div class="kpis" id="rpKpis"></div>
  <section class="cartao">
    <div class="cartao-cab"><h2>Locações <span class="dica" id="rpSelInfo"></span></h2><div class="acoes">
      <button class="bt" id="rpProgramar">Programar repasse</button><button class="bt primario" id="rpEfetuar">Registrar repasse efetuado</button>
      <button class="bt" id="rpConfirmar">Confirmar programados</button><button class="bt perigo" id="rpCancelar">Cancelar programados</button></div></div>
    <div id="rpLista"></div>
    <div class="acoes-linha">${botoesPDF('rpPdf', 'prévia (PDF)')}<button class="bt" id="rpXlsx">Planilha do lote (Excel)</button></div>
    <p class="dica">Marque as locações (ou nenhuma, para usar todas as listadas). O repasse fica registrado no mês da data do pagamento, no extrato de cada contrato. Programado: reserva o valor; efetuado: baixa o saldo em conta. O que não for repassado continua como saldo no mês seguinte.</p>
  </section>`;

  function desenhar() {
    const l = filtradas();
    const soma = (lst, f) => lst.reduce((s, x) => s + cent(f(x) || 0), 0) / 100;
    const base = sel.size ? l.filter(x => sel.has(x.ct.id)) : l;
    $('#rpKpis').innerHTML = `<div class="kpi"><span>Recebido dos locatários</span><b>${fmtMoeda(soma(base, x => x.k?.recebido))}</b></div>
      <div class="kpi"><span>Saldo a repassar</span><b class="${soma(base, x => x.livre) > 0 ? 'neg' : ''}">${fmtMoeda(soma(base, x => x.livre))}</b></div>
      <div class="kpi"><span>Programado</span><b>${fmtMoeda(soma(base, x => x.k?.programado))}</b></div>
      <div class="kpi"><span>Repassado no mês</span><b>${fmtMoeda(soma(base, x => x.k?.repassado))}</b></div>`;
    $('#rpSelInfo').textContent = sel.size ? `· ${sel.size} selecionada(s)` : '';
    if (!l.length) { $('#rpLista').innerHTML = '<p class="vazio">Nenhuma locação nesta seleção.</p>'; return; }
    const ck = x => x.naoGerado ? '' : `<input type="checkbox" data-sel="${x.ct.id}"${sel.has(x.ct.id) ? ' checked' : ''} aria-label="Selecionar ${esc(x.ct.codigo)}">`;
    if (st.ver === 'beneficiario') {
      const grupos = new Map();
      for (const x of l) for (const p of x.naoGerado ? [] : partesBeneficiarios(x)) {
        if (st.cli && p.locadorId !== st.cli) continue;
        if (!grupos.has(p.locadorId)) grupos.set(p.locadorId, []);
        grupos.get(p.locadorId).push({ x, p });
      }
      $('#rpLista').innerHTML = [...grupos.entries()].sort((a, b) => comparar(nomeDe('locadores', a[0]), nomeDe('locadores', b[0]))).map(([id, its]) => {
        const lo = D.locadores[id];
        return `<div class="rolagem"><table class="tabela"><thead><tr><th colspan="8">${esc(lo?.nome || '—')}${lo?.documento ? ' · ' + esc(lo.documento) : ''}<br><span class="dica">${esc(dadosBancarios(lo) || 'Dados bancários não informados no cadastro do cliente')}</span></th></tr>
          <tr><th></th><th>Contrato</th><th>Imóvel</th><th>Locatário</th><th class="num">Participação</th><th class="num">A repassar</th><th class="num">Programado</th><th class="num">Repassado</th></tr></thead><tbody>
          ${its.map(({ x, p }) => `<tr><td>${ck(x)}</td><td><a href="#/contrato/${x.ct.id}/${st.mes}">${esc(x.ct.codigo)}</a></td><td>${esc(imovelCurto(D.imoveis[x.ct.imovelId]))}</td><td>${esc(nomeDe('locatarios', x.ct.locatarioId))}</td>
            <td class="num">${fmtPct(p.pct)}%</td><td class="num">${fmtNum(p.livre)}</td><td class="num">${p.programado ? fmtNum(p.programado) : ''}</td><td class="num">${p.repassado ? fmtNum(p.repassado) : ''}</td></tr>`).join('')}
          <tr class="total-geral"><td colspan="5">Total de ${esc(lo?.nome || '—')}</td><td class="num">${fmtNum(soma(its, i => i.p.livre))}</td><td class="num">${fmtNum(soma(its, i => i.p.programado))}</td><td class="num">${fmtNum(soma(its, i => i.p.repassado))}</td></tr>
        </tbody></table></div>`;
      }).join('') || '<p class="vazio">Nenhum valor para os beneficiários nesta seleção.</p>';
    } else {
      $('#rpLista').innerHTML = `<div class="rolagem"><table class="tabela"><thead><tr><th><input type="checkbox" id="rpTodos" aria-label="Selecionar todas"></th><th>Contrato</th><th>Cliente(s)</th><th>Locatário</th><th>Pagamento</th>
        <th class="num">Saldo anterior</th><th class="num">Recebido</th><th class="num">Despesas pagas</th><th class="num">Taxa de adm.</th><th class="num">A repassar</th><th class="num">Programado</th><th class="num">Repassado</th><th>Situação</th></tr></thead><tbody>
        ${l.map(x => x.naoGerado ? `<tr><td></td><td><a href="#/contrato/${x.ct.id}/${st.mes}">${esc(x.ct.codigo)}</a></td><td>${esc(nomeDe('locadores', x.ct.locadorId))}</td><td>${esc(nomeDe('locatarios', x.ct.locatarioId))}</td><td colspan="9"><span class="dica">Mês ainda não gerado no contrato</span></td></tr>`
          : `<tr><td>${ck(x)}</td><td><a href="#/contrato/${x.ct.id}/${st.mes}">${esc(x.ct.codigo)}</a>${x.x.mes.fechado ? ' <span class="chip neutro">fechado</span>' : ''}</td>
          <td>${beneficiariosDe(x.ct).map(b => esc(nomeDe('locadores', b.locadorId)) + (beneficiariosDe(x.ct).length > 1 ? ` (${fmtPct(b.pct)}%)` : '')).join('<br>')}</td><td>${esc(nomeDe('locatarios', x.ct.locatarioId))}</td>
          <td>${chipPagto(x.k, vencimentoMes(x.ct, st.mes, x.x.mes))}</td><td class="num">${fmtNum(x.k.saldoAnterior)}</td><td class="num">${fmtNum(x.k.recebido)}</td><td class="num">${fmtNum(x.k.pago)}</td><td class="num">${fmtNum(x.k.taxa)}</td>
          <td class="num"><b>${fmtNum(x.livre)}</b></td><td class="num">${x.k.programado ? fmtNum(x.k.programado) : ''}</td><td class="num">${x.k.repassado ? fmtNum(x.k.repassado) : ''}</td><td>${chipRepasse(x.situacao)}</td></tr>`).join('')}
        <tr class="total-geral"><td colspan="5">Total</td><td class="num">${fmtNum(soma(l, x => x.k?.saldoAnterior))}</td><td class="num">${fmtNum(soma(l, x => x.k?.recebido))}</td><td class="num">${fmtNum(soma(l, x => x.k?.pago))}</td><td class="num">${fmtNum(soma(l, x => x.k?.taxa))}</td>
          <td class="num">${fmtNum(soma(l, x => x.livre))}</td><td class="num">${fmtNum(soma(l, x => x.k?.programado))}</td><td class="num">${fmtNum(soma(l, x => x.k?.repassado))}</td><td></td></tr>
      </tbody></table></div>`;
      $('#rpTodos')?.addEventListener('change', e => { l.filter(x => !x.naoGerado).forEach(x => e.target.checked ? sel.add(x.ct.id) : sel.delete(x.ct.id)); desenhar(); });
    }
    $$('[data-sel]').forEach(c => c.addEventListener('change', () => { c.checked ? sel.add(c.dataset.sel) : sel.delete(c.dataset.sel); desenhar(); }));
  }
  desenhar();

  $('#rpMes').addEventListener('change', e => { if (ehMes(e.target.value)) ir({ mes: e.target.value }); });
  $('#rpSit').addEventListener('change', e => ir({ sit: e.target.value }));
  $('#rpCli').addEventListener('change', e => ir({ cli: e.target.value }));
  $$('input[name=rpVer]').forEach(r => r.addEventListener('change', e => ir({ ver: e.target.value })));
  $('#rpBusca').addEventListener('input', e => { st.busca = e.target.value.trim().toLowerCase(); desenhar(); });

  const alvos = () => { const l = filtradas().filter(x => !x.naoGerado); return sel.size ? l.filter(x => sel.has(x.ct.id)) : l; };
  $('#rpProgramar').addEventListener('click', () => executar(() => modalRepasse(st.mes, alvos(), 'programado')));
  $('#rpEfetuar').addEventListener('click', () => executar(() => modalRepasse(st.mes, alvos(), 'efetuado')));
  $('#rpConfirmar').addEventListener('click', () => executar(() => modalConfirmar(st.mes, alvos())));
  $('#rpCancelar').addEventListener('click', () => executar(async () => {
    const l = alvos().filter(x => x.k.programado > 0);
    if (!l.length) throw new Error('Nenhum repasse programado nas locações escolhidas.');
    if (!confirm(`Cancelar os repasses programados de ${l.length} locação(ões), num total de ${fmtMoeda(l.reduce((s, x) => s + x.k.programado, 0))}?`)) return;
    for (const x of l) await alterarRepasses(x.ct, st.mes, reps => reps.filter(repasseEfetuado));
    aviso('Programações canceladas.'); rotear(true);
  }));
  ligarBotoesPDF('rpPdf', async () => previaRepassesPDF(st.mes, alvos(), st.cli));
  $('#rpXlsx').addEventListener('click', () => executar(async () => salvarPlanilha(loteRepassesXLSX(st.mes, alvos(), st.cli), nomeArquivo('repasses', st.mes) + '.xlsx')));
}

// Altera a lista de repasses de um mês de um contrato (relendo o arquivo, com a trava contra alterações simultâneas)
async function alterarRepasses(ct, ym, mudar) {
  const ext = await carregarExtrato(ct.id);
  const mes = ext.meses[ym];
  if (!mes) throw new Error(`${rotuloContrato(ct)}: o mês ${mesNum(ym)} não foi gerado.`);
  await salvarMeses(ct.id, { [ym]: { ...mes, repasses: mudar([...(mes.repasses || [])]) } });
}

// Programar ou registrar repasses: um valor por beneficiário de cada locação (sugerido: o saldo livre)
function modalRepasse(mes, lista, status) {
  const linhas = lista.flatMap(x => partesBeneficiarios(x).map(p => ({ x, p }))).filter(i => i.p.livre > 0.004);
  if (!linhas.length) throw new Error('Não há saldo a repassar nas locações escolhidas.');
  const fechados = [...new Set(linhas.filter(i => i.x.x.mes.fechado).map(i => i.x.ct.codigo))];
  const h = hoje(), padrao = h.slice(0, 7) === mes ? h : mes < h.slice(0, 7) ? fimDoMes(mes) : mes + '-01';
  abrirModal(`<div class="modal-cab"><h2>${status === 'programado' ? 'Programar repasse' : 'Registrar repasse efetuado'} · ${nomeMes(mes)}</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <div class="grade-form form-modal"><div class="campo"><label for="rmData">${status === 'programado' ? 'Data prevista' : 'Data do repasse'}</label><input type="date" id="rmData" value="${padrao}" min="${mes}-01" max="${fimDoMes(mes)}"><small>Dentro de ${nomeMes(mes)} (o repasse fica no mês da data do pagamento).</small></div>
      <div class="campo w2"><label for="rmObs">Observação</label><input id="rmObs" placeholder="Ex.: PIX, TED"></div></div>
    ${fechados.length ? `<p class="alerta">Mês fechado em: ${esc(fechados.join(', '))}. O repasse será registrado mesmo assim (muda só o saldo em conta, não o recebido).</p>` : ''}
    <div class="rolagem"><table class="tabela tab-edicao"><thead><tr><th>Contrato</th><th>Beneficiário</th><th class="num">Disponível</th><th>Valor do repasse</th></tr></thead><tbody>
      ${linhas.map((i, n) => `<tr><td>${esc(i.x.ct.codigo)}</td><td>${esc(nomeDe('locadores', i.p.locadorId))}${beneficiariosDe(i.x.ct).length > 1 ? ` (${fmtPct(i.p.pct)}%)` : ''}</td><td class="num">${fmtNum(i.p.livre)}</td>
        <td><input class="num" inputmode="decimal" data-rm="${n}" value="${fmtNum(i.p.livre)}" aria-label="Valor"></td></tr>`).join('')}
    </tbody></table></div><p class="dica" id="rmTotal"></p>
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt primario" id="rmOk">${status === 'programado' ? 'Programar' : 'Registrar'}</button></div>`, 'modal-grande');
  const total = () => { $('#rmTotal').textContent = 'Total: ' + fmtMoeda($$('[data-rm]').reduce((s, e) => s + cent(parseValor(e.value)), 0) / 100); };
  $$('[data-rm]').forEach(e => e.addEventListener('input', total));
  total();
  $('#rmOk').addEventListener('click', () => executar(async () => {
    const data = $('#rmData').value;
    if (!ehData(data) || data.slice(0, 7) !== mes) throw new Error(`Informe uma data dentro de ${nomeMes(mes)}.`);
    const valores = $$('[data-rm]').map(e => r2(parseValor(e.value)));
    valores.forEach((v, n) => { if (v < 0 || v > linhas[n].p.livre + 0.004) throw new Error(`${linhas[n].x.ct.codigo}: o valor não pode passar do disponível (${fmtMoeda(linhas[n].p.livre)}).`); });
    const porContrato = new Map();
    linhas.forEach((i, n) => { if (valores[n] > 0) { if (!porContrato.has(i.x.ct.id)) porContrato.set(i.x.ct.id, { ct: i.x.ct, novos: [] }); porContrato.get(i.x.ct.id).novos.push({ id: novoId(), data, valor: valores[n], obs: $('#rmObs').value.trim(), status, beneficiarioId: i.p.locadorId, em: new Date().toISOString(), por: usuario() }); } });
    if (!porContrato.size) throw new Error('Informe ao menos um valor.');
    for (const { ct, novos } of porContrato.values()) await alterarRepasses(ct, mes, reps => [...reps, ...novos]);
    fecharModal();
    aviso(`${status === 'programado' ? 'Repasses programados' : 'Repasses registrados'}: ${[...porContrato.values()].reduce((s, c) => s + c.novos.length, 0)}.`);
    rotear(true);
  }));
}

// Confirma os programados como efetuados (data efetiva no mesmo mês)
function modalConfirmar(mes, lista) {
  const l = lista.filter(x => x.k.programado > 0);
  if (!l.length) throw new Error('Nenhum repasse programado nas locações escolhidas.');
  const h = hoje(), padrao = h.slice(0, 7) === mes ? h : fimDoMes(mes);
  abrirModal(`<div class="modal-cab"><h2>Confirmar repasses programados · ${nomeMes(mes)}</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <p>${l.length} locação(ões), total de ${fmtMoeda(l.reduce((s, x) => s + x.k.programado, 0))}.</p>
    <div class="grade-form form-modal"><div class="campo"><label for="rcData">Data em que foram efetuados</label><input type="date" id="rcData" value="${padrao}" min="${mes}-01" max="${fimDoMes(mes)}"><small>Em branco ou dentro do mês. Pago em outro mês: cancele a programação e registre no mês do pagamento.</small></div>
      <div class="campo"><label>&nbsp;</label><label class="inline"><input type="checkbox" id="rcManter"> Manter a data prevista de cada um</label></div></div>
    <div class="acoes-linha"><span class="espaco"></span><button class="bt" data-fechar>Cancelar</button><button class="bt primario" id="rcOk">Confirmar como efetuados</button></div>`);
  $('#rcOk').addEventListener('click', () => executar(async () => {
    const manter = $('#rcManter').checked, data = $('#rcData').value;
    if (!manter && (!ehData(data) || data.slice(0, 7) !== mes)) throw new Error(`Informe uma data dentro de ${nomeMes(mes)}.`);
    for (const x of l) await alterarRepasses(x.ct, mes, reps => reps.map(r => repasseEfetuado(r) ? r : { ...r, status: 'efetuado', data: manter ? r.data : data, efetuadoEm: new Date().toISOString(), por: usuario() }));
    fecharModal(); aviso('Repasses confirmados como efetuados.'); rotear(true);
  }));
}

/* ================= Prévia (PDF) e lote (Excel) ================= */
// Por beneficiário: as locações dele, com o valor programado (ou, sem programação, o saldo livre)
function porBeneficiario(lista, cli) {
  const m = new Map();
  for (const x of lista) for (const p of partesBeneficiarios(x)) {
    if (cli && p.locadorId !== cli) continue;
    const valor = p.programado > 0 ? p.programado : p.livre;
    if (!(valor > 0) && !(p.repassado > 0)) continue;
    if (!m.has(p.locadorId)) m.set(p.locadorId, []);
    m.get(p.locadorId).push({ x, p, valor });
  }
  return [...m.entries()].sort((a, b) => comparar(nomeDe('locadores', a[0]), nomeDe('locadores', b[0])));
}

function previaRepassesPDF(mes, lista, cli) {
  const grupos = porBeneficiario(lista, cli);
  if (!grupos.length) throw new Error('Não há valores a repassar nas locações escolhidas.');
  const P = novoDocumento(true);
  grupos.forEach(([id, its], g) => {
    if (g) P.doc.addPage();
    P.cab();
    const lo = D.locadores[id];
    tituloPDF(P, 'Prévia do repasse · ' + mesNum(mes), [[`${lo?.nome || '—'}${lo?.documento ? ' · CPF/CNPJ ' + lo.documento : ''}`, 10, 'bold'], [dadosBancarios(lo) || 'Dados bancários não informados', 9, 'normal', COR_SUAVE]]);
    tabelaPDF(P, [{ t: 'Contrato', w: 12, nw: true }, { t: 'Imóvel', w: 40 }, { t: 'Locatário', w: 28 }, { t: 'Saldo anterior', w: 16, a: 'r' }, { t: 'Recebido do locatário', w: 18, a: 'r' }, { t: 'Despesas pagas', w: 16, a: 'r' },
      { t: 'Taxa de administração', w: 18, a: 'r' }, { t: 'Já repassado', w: 16, a: 'r' }, { t: 'Saldo', w: 16, a: 'r' }, { t: 'Participação', w: 13, a: 'r' }, { t: 'A repassar', w: 17, a: 'r' }],
      [...its.map(({ x, p, valor }) => ({ c: [x.ct.codigo, imovelCurto(D.imoveis[x.ct.imovelId]), nomeDe('locatarios', x.ct.locatarioId), fmtNum(x.k.saldoAnterior), fmtNum(x.k.recebido), fmtNum(x.k.pago), fmtNum(x.k.taxa),
        fmtNum(x.k.repassado), fmtNum(r2(x.k.saldoConta - (x.k.programado - p.programado))), fmtPct(p.pct) + '%', fmtNum(valor)] })),
      { c: ['Total', '', '', '', '', '', '', '', '', '', fmtNum(its.reduce((s, i) => s + cent(i.valor), 0) / 100)], total: true }], 8);
    paragrafoPDF(P, 'Saldo = saldo anterior + recebido do locatário − despesas pagas pela administradora − taxa de administração − repasses já efetuados. A repassar: valor programado ou, sem programação, a parte do beneficiário no saldo. Detalhes de cada mês na prestação de contas do contrato.', 7.5, 'normal', COR_SUAVE);
  });
  rodapePDF(P);
  return { doc: P.doc, nome: nomeArquivo('previa-repasses', mes) + '.pdf' };
}

function loteRepassesXLSX(mes, lista, cli) {
  const grupos = porBeneficiario(lista, cli);
  if (!grupos.length) throw new Error('Não há valores a repassar nas locações escolhidas.');
  const L = [...cabecalhoXLSX(), [{ v: 'Lote de repasses · ' + mesNum(mes), s: 'tit' }], null,
    { c: ['Beneficiário', 'CPF/CNPJ', 'Favorecido', 'Banco', 'Agência', 'Conta', 'PIX', 'Valor', 'Locações'].map(v => ({ v, s: 'cab' })), altura: 30 }];
  const ini = L.length + 1;
  for (const [id, its] of grupos) {
    const lo = D.locadores[id] || {};
    L.push([lo.nome || '—', lo.documento || '', lo.favorecido || '', lo.banco || '', lo.agencia || '', lo.conta || '', lo.pix || '', { v: its.reduce((s, i) => s + cent(i.valor), 0) / 100, s: 'm' }, its.map(i => i.x.ct.codigo).join(', ')]);
  }
  L.push([{ v: 'Total', s: 'bt' }, null, null, null, null, null, null, { f: `SUM(H${ini}:H${L.length})`, v: grupos.reduce((s, [, its]) => s + its.reduce((t, i) => t + cent(i.valor), 0), 0) / 100, s: 'mt' }]);
  const D2 = [{ c: ['Beneficiário', 'Contrato', 'Imóvel', 'Locatário', 'Saldo anterior', 'Recebido', 'Despesas pagas', 'Taxa de administração', 'Já repassado', 'Participação', 'A repassar'].map(v => ({ v, s: 'cab' })), altura: 30 }];
  for (const [id, its] of grupos) for (const { x, p, valor } of its) D2.push([nomeDe('locadores', id), x.ct.codigo, imovelCurto(D.imoveis[x.ct.imovelId]), nomeDe('locatarios', x.ct.locatarioId), { v: x.k.saldoAnterior, s: 'm' }, { v: x.k.recebido, s: 'm' },
    { v: x.k.pago, s: 'm' }, { v: x.k.taxa, s: 'm' }, { v: x.k.repassado, s: 'm' }, { v: p.pct / 100, s: 'p' }, { v: valor, s: 'm' }]);
  return gerarXLSX([{ nome: 'Lote', linhas: L, larguras: [32, 18, 24, 14, 10, 14, 24, 14, 20] }, { nome: 'Detalhe', linhas: D2, larguras: [28, 10, 34, 26, 14, 14, 14, 14, 14, 11, 14] }]);
}
