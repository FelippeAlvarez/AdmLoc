'use strict';
/* Tela do Cálculo do débito de um contrato (dados e motor em debito.js e motor.js) */

// Campos de listas editáveis: [chave, rótulo, tipo, largura, opções]
const CAMPOS_EXTRA = [['descricao', 'Descrição', 'texto', 3], ['vencimento', 'Vencimento', 'data', 1], ['valor', 'Valor (R$)', 'moeda', 1], ['multa', 'Multa', 'check', 1]];
const CAMPOS_CUSTA = [['descricao', 'Descrição (ex.: custas iniciais, diligência)', 'texto', 3], ['data', 'Data do pagamento', 'data', 1], ['valor', 'Valor (R$)', 'moeda', 1], ['idProc', 'Id. no processo', 'texto', 1]];
const FORMAS_HON = [['condenacao', '% sobre a condenação'], ['causa', '% sobre o valor da causa'], ['fixo', 'Valor fixo']];
const FORMAS_MULTA = [['valor', 'Valor fixo'], ['pctCausa', '% do valor da causa'], ['diaria', 'Multa diária']];

const valorCampo = (tipo, v) => tipo === 'moeda' ? (v === '' || v == null ? '' : fmtNum(v)) : tipo === 'pct' ? (v === '' || v == null ? '' : fmtPct(v)) : v ?? '';
const lerValor = (tipo, el) => tipo === 'check' ? el.checked : tipo === 'moeda' || tipo === 'pct' ? (el.value.trim() === '' ? '' : r2(parseValor(el.value))) : el.value.trim();

function inputCampo(lista, i, [k, rot, tipo, , ops], v) {
  const a = `data-lista="${lista}" data-i="${i}" data-k2="${k}" data-t="${tipo}" aria-label="${esc(rot)}"`;
  if (tipo === 'check') return `<input type="checkbox" ${a}${v !== false ? ' checked' : ''}>`;
  if (tipo === 'select') return `<select ${a}>${ops.map(([o, r]) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(r)}</option>`).join('')}</select>`;
  const t = tipo === 'data' ? 'date' : 'text', cls = tipo === 'moeda' || tipo === 'pct' ? ' class="num" inputmode="decimal"' : '';
  return `<input type="${t}"${cls} ${a} value="${esc(valorCampo(tipo, v))}">`;
}

function listaHTML(lista, itens, campos, rotuloNovo) {
  return `<div class="lista-calc">
    ${itens.length ? `<div class="rolagem"><table class="tabela tab-edicao"><thead><tr>${campos.map(c => `<th>${esc(c[1])}</th>`).join('')}<th></th></tr></thead><tbody>
      ${itens.map((it, i) => `<tr>${campos.map(c => `<td>${inputCampo(lista, i, c, it[c[0]])}</td>`).join('')}<td><button type="button" class="bt-x" data-del="${lista}" data-i="${i}" title="Remover">&times;</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <button type="button" class="bt pequeno" data-add="${lista}">${rotuloNovo}</button></div>`;
}

const NOVOS_ITENS = {
  extras: () => ({ id: novoId(), descricao: '', vencimento: '', valor: '', multa: true }),
  custas: () => ({ id: novoId(), descricao: '', data: '', valor: '', idProc: '' }),
  honorarios: () => ({ id: novoId(), forma: 'condenacao', pct: 10, valor: '', data: '', baseCustas: false }),
  multas: () => ({ id: novoId(), tipo: 'litigancia', forma: 'valor', valor: '', pct: '', corrDesde: '', valorDia: '', inicio: '', fim: '' }),
  amort: () => ({ id: novoId(), data: hoje(), valor: '', forma: 'pagamento', imputacao: 'juros', destino: 'antigas', obs: '', prestacao: { lancar: false, data: '', valor: '', taxa: true } }),
};

async function telaDebito(cid, calcId) {
  const ct = D.contratos[cid];
  if (!ct) throw new Error('Contrato não encontrado.');
  await carregarExtrato(cid);
  await carregarCalculos(cid); // sempre a versão mais recente (outro aparelho pode ter alterado)
  await aguardarIndices();
  const salvos = () => Object.values(D.calcs[cid]?.calculos || {}).sort((a, b) => comparar(b.atualizadoEm || '', a.atualizadoEm || ''));
  const copia = x => JSON.parse(JSON.stringify(x));
  let calc = calcId && D.calcs[cid].calculos[calcId] ? copia(D.calcs[cid].calculos[calcId]) : !calcId && salvos()[0] ? copia(salvos()[0]) : novoCalculo(ct);
  let novo = !D.calcs[cid].calculos[calc.id];
  if (!ehData(calc.dataCalc)) calc.dataCalc = hoje();
  // Pagamentos do contrato (valem para todos os cálculos): cópia editável até salvar
  let amort = copia(D.calcs[cid].amortizacoes || []);
  let r = null;
  const im = D.imoveis[ct.imovelId], lt = D.locatarios[ct.locatarioId];

  const destinos = () => [['antigas', 'Débitos mais antigos primeiro (CC, art. 355)'], ['proporcional', 'Proporcional ao saldo de cada item'], ['custasPrimeiro', 'Custas e despesas primeiro'],
    ...mesesEmAberto(ct, calc.dataCalc).map(m => ['mes:' + m.ym, 'Aluguel de ' + mesNum(m.ym)])];
  const camposAmort = () => [['data', 'Data', 'data'], ['valor', 'Valor (R$)', 'moeda'], ['forma', 'Forma', 'select', 1, Object.entries(nomeFormaAmort)],
    ['imputacao', 'Imputação', 'select', 1, [['juros', 'Juros e multa primeiro (art. 354)'], ['principal', 'Principal primeiro']]],
    ['destino', 'Abater de', 'select', 2, destinos()], ['obs', 'Observação', 'texto']];

  const cab = cabecalho('Cálculo do débito',
    `${esc(rotuloContrato(ct))} · ${esc(descImovel(im))}<br>Locatário: <b>${esc(lt?.nome || '—')}</b> · Cliente: <b>${esc(nomeDe('locadores', ct.locadorId))}</b>`,
    botoesPDF('debPdf') + `<button class="bt" id="btDebXlsx">Salvar planilha Excel</button>`,
    `<a class="voltar" href="#/contrato/${cid}">&larr; ${esc(rotuloContrato(ct))}</a>`);

  function render() {
    const emAcordo = mesesEmAcordo(cid);
    const judicial = calc.tipo === 'judicial', purga = ehPurga(calc), k = calc.crit, meses = mesesEmAberto(ct, calc.dataCalc, purga), fora = new Set(calc.fora || []);
    const a523 = calc.art523 || {};
    $('#conteudo').innerHTML = cab + `<div id="telaDeb">
    <section class="cartao form">
      <div class="grade-form">
        <div class="campo w2"><label for="dCalc">Cálculo</label><select id="dCalc">
          ${salvos().map(c => `<option value="${c.id}"${c.id === calc.id ? ' selected' : ''}>${esc(c.nome || 'Cálculo')} · salvo em ${fmtData((c.atualizadoEm || '').slice(0, 10))}</option>`).join('')}
          ${novo ? `<option value="" selected>${esc(calc.nome)} (novo, ainda não salvo)</option>` : ''}<option value="+novo">+ Novo cálculo</option></select></div>
        <div class="campo w2"><label for="dNome">Nome do cálculo</label><input id="dNome" data-c="nome" value="${esc(calc.nome)}"></div>
        <div class="campo"><label for="dData">${purga ? 'Data do depósito' : 'Data do cálculo'}</label><input type="date" id="dData" data-c="dataCalc" value="${calc.dataCalc}"></div>
        <div class="campo w2"><label>Tipo</label><div class="segmentado"><label><input type="radio" name="dTipo" value="extrajudicial"${!judicial ? ' checked' : ''}> Extrajudicial</label><label><input type="radio" name="dTipo" value="judicial"${judicial ? ' checked' : ''}> Judicial</label></div></div>
        ${judicial ? `<div class="campo wfull"><label for="dFinal">Finalidade</label><select id="dFinal" data-c="finalidade">${Object.entries(FINALIDADES).map(([v, t]) => `<option value="${v}"${v === (calc.finalidade || 'geral') ? ' selected' : ''}>${t}</option>`).join('')}</select>
          ${purga ? '<small>Inclui os aluguéis e acessórios vencidos e os que vencem até a data do depósito, a multa contratual, os juros, as custas e os honorários do advogado do locador (art. 62, II).</small>'
            : calc.finalidade === 'inicial' ? '<small>Cálculo discriminado do débito para a inicial, em nome do locatário e dos fiadores (art. 62, I).</small>' : ''}</div>
          <div class="campo w2"><label for="dProc">Número do processo</label><input id="dProc" data-p="numero" value="${esc(calc.processo?.numero || '')}"></div>
          <div class="campo w2"><label for="dJuizo">Juízo</label><input id="dJuizo" data-p="juizo" value="${esc(calc.processo?.juizo || '')}"></div>
          <div class="campo"><label for="dAjuiz">Ajuizamento</label><input type="date" id="dAjuiz" data-p="ajuizamento" value="${esc(calc.processo?.ajuizamento || '')}"></div>
          <div class="campo"><label for="dCit">Citação</label><input type="date" id="dCit" data-p="citacao" value="${esc(calc.processo?.citacao || '')}"></div>` : ''}
      </div>
    </section>
    <section class="cartao form">
      <div class="cartao-cab"><h2>Critérios de correção, juros e multa</h2><div class="acoes"><button type="button" class="bt pequeno" id="btCritContrato">Usar os do contrato</button></div></div>
      <div class="grade-form">
        <div class="campo"><label for="kIndice">Correção monetária</label><select id="kIndice" data-k="indice">${[...INDICES_CORRECAO, 'Nenhum'].map(i => `<option${i === k.indice ? ' selected' : ''}>${i}</option>`).join('')}</select></div>
        <div class="campo w2"><label for="kJuros">Juros de mora</label><select id="kJuros" data-k="juros">${Object.entries(TIPOS_JUROS).map(([v, t]) => `<option value="${v}"${v === k.juros ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
        ${k.juros === 'mensal' ? `<div class="campo"><label for="kTaxa">Taxa (% ao mês)</label><input id="kTaxa" class="num" inputmode="decimal" data-k="taxa" data-t="pct" value="${fmtPct(k.taxa)}"></div>` : ''}
        <div class="campo"><label for="kMulta">Multa contratual (%)</label><input id="kMulta" class="num" inputmode="decimal" data-k="multa" data-t="pct" value="${fmtPct(k.multa)}"></div>
        <div class="campo wfull"><label class="inline"><input type="checkbox" data-k="capitalizar"${k.capitalizar ? ' checked' : ''}> Juros capitalizados mensalmente</label>
          <label class="inline"><input type="checkbox" data-k="lei14905"${k.lei14905 ? ' checked' : ''}> A partir de 30/08/2024, IPCA e taxa legal (Lei 14.905/2024)</label></div>
      </div>
      <p class="dica">Começam iguais aos encargos moratórios do contrato. Juros e multa incidem sobre o valor corrigido; juros desde cada vencimento.</p>
    </section>
    <section class="cartao">
      <h2>Débitos</h2>
      ${meses.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Incluir</th><th>Referência</th><th>Vencimento</th><th class="num">Valor devido</th><th>Situação</th></tr></thead><tbody>
        ${meses.map(m => emAcordo.has(m.ym) ? `<tr><td></td><td>${nomeMes(m.ym)}</td><td>${fmtData(m.venc)}</td><td class="num">${fmtNum(m.devido)}</td><td>Incluído em acordo (fora deste cálculo)</td></tr>` : `<tr><td><input type="checkbox" data-mes="${m.ym}"${fora.has(m.ym) ? '' : ' checked'} aria-label="Incluir ${mesNum(m.ym)}"></td><td>${nomeMes(m.ym)}</td><td>${fmtData(m.venc)}</td><td class="num">${fmtNum(m.devido)}</td>
          <td>${m.sit === 'parcial' ? `Pago em parte: ${fmtMoeda(m.pagoParcial / 100)}${m.mes.recebidoEm ? ' em ' + fmtData(m.mes.recebidoEm) : ''} (abatido como pagamento)` : m.sit === 'projetado' ? 'A vencer até o depósito (valor do contrato)' : m.venc >= calc.dataCalc ? 'Vence até o depósito' : 'Não pago'}</td></tr>`).join('')}
      </tbody></table></div>` : `<p class="vazio">Nenhum mês vencido e não pago até ${fmtData(calc.dataCalc)}.</p>`}
      <h3 class="sec">Outros débitos</h3>
      <p class="dica">Ex.: reparos, aluguéis anteriores ao controle no aplicativo, diferenças. Correção e juros desde o vencimento; multa contratual se marcada.</p>
      ${listaHTML('extras', calc.extras, CAMPOS_EXTRA, '+ Outro débito')}<button type="button" class="bt pequeno" data-imp="extras">Importar planilha (Excel ou CSV)</button>
    </section>
    <section class="cartao">
      <h2>Custas e despesas</h2>
      <p class="dica">${judicial ? 'Custas judiciais, diligências, taxa judiciária, perícia etc.' : 'Despesas da cobrança, como notificações.'} Corrigidas desde a data do pagamento, sem juros.</p>
      ${listaHTML('custas', calc.custas, CAMPOS_CUSTA, '+ Custa ou despesa')}<button type="button" class="bt pequeno" data-imp="custas">Importar planilha (Excel ou CSV)</button>
    </section>
    <section class="cartao form">
      <h2>Honorários advocatícios</h2>
      ${purga ? `<div class="grade-form"><div class="campo"><label for="dHonP">Honorários do advogado do locador (%)</label><input id="dHonP" class="num" inputmode="decimal" data-c="honPurga" data-t="pct" value="${fmtPct(calc.honPurga ?? 10)}"></div></div>
        <p class="dica">Sobre o montante devido (aluguéis e acessórios, multa e juros). A lei fixa 10%, se o contrato não dispuser de outra forma (art. 62, II, d).</p>`
        : judicial ? `<p class="dica">Honorários sucumbenciais. Sobre a condenação: acompanham a correção, os juros e a multa de cada débito e não são reduzidos pelos pagamentos do locatário.</p>
        ${listaHTML('honorarios', calc.honorarios, [['forma', 'Forma', 'select', 2, FORMAS_HON], ['pct', '%', 'pct'], ['valor', 'Valor fixo (R$)', 'moeda'], ['data', 'Data do valor fixo', 'data'], ['baseCustas', 'Base inclui custas', 'check']], '+ Honorários')}
        <div class="grade-form"><div class="campo"><label for="dCausa">Valor da causa (R$)</label><input id="dCausa" class="num" inputmode="decimal" data-causa="valor" value="${valorCampo('moeda', calc.valorCausa?.valor)}"></div>
          <div class="campo"><label for="dCausaData">Data do valor da causa</label><input type="date" id="dCausaData" data-causa="data" value="${esc(calc.valorCausa?.data || '')}"></div></div>`
        : `<div class="grade-form"><div class="campo"><label for="dHon">Honorários contratuais (%)</label><input id="dHon" class="num" inputmode="decimal" data-c="honContr" data-t="pct" value="${fmtPct(calc.honContr)}"></div></div>
        <p class="dica">Sobre o total do débito (valor corrigido, juros, multa e despesas).</p>`}
    </section>
    ${judicial && !purga ? `<section class="cartao">
      <h2>Multas processuais</h2>
      ${listaHTML('multas', calc.multas, [['tipo', 'Tipo', 'select', 2, Object.entries(TIPOS_MULTA)], ['forma', 'Forma', 'select', 1, FORMAS_MULTA], ['valor', 'Valor (R$)', 'moeda'], ['pct', '% da causa', 'pct'], ['corrDesde', 'Correção desde', 'data'],
        ['valorDia', 'Valor por dia', 'moeda'], ['inicio', 'Início', 'data'], ['fim', 'Fim', 'data']], '+ Multa processual')}
    </section>
    <section class="cartao form">
      <h2>Art. 523, § 1º, do CPC (cumprimento de sentença)</h2>
      <div class="grade-form">
        <div class="campo wfull"><label class="inline"><input type="checkbox" data-a="aplicar"${a523.aplicar ? ' checked' : ''}> Incluir multa e honorários do art. 523, § 1º (débito não pago no prazo de 15 dias)</label></div>
        ${a523.aplicar ? `<div class="campo"><label>Multa (%)</label><input class="num" inputmode="decimal" data-a="multa" value="${fmtPct(a523.multa)}"></div>
          <div class="campo"><label>Honorários (%)</label><input class="num" inputmode="decimal" data-a="honorarios" value="${fmtPct(a523.honorarios)}"></div>
          <div class="campo wfull">Base inclui: <label class="inline"><input type="checkbox" data-a="baseHonorarios"${a523.baseHonorarios ? ' checked' : ''}> honorários sucumbenciais</label>
            <label class="inline"><input type="checkbox" data-a="baseCustas"${a523.baseCustas ? ' checked' : ''}> custas</label>
            <label class="inline"><input type="checkbox" data-a="baseMultas"${a523.baseMultas ? ' checked' : ''}> multas processuais</label></div>
          <p class="dica wfull">Pagamento feito no prazo de 15 dias: marque "No prazo do art. 523" no pagamento; a multa e os honorários incidem só sobre o restante (§ 2º).</p>` : ''}
      </div>
    </section>` : ''}
    <section class="cartao">
      <h2>Pagamentos e amortizações</h2>
      <p class="dica">Pagamentos do débito em atraso (do locatário ou do fiador), depósitos judiciais etc. Valem para todos os cálculos deste contrato e para a Inadimplência. O débito é atualizado até a data de cada pagamento antes do abatimento. Os pagamentos em parte lançados nos meses entram automaticamente.</p>
      ${listaHTML('amort', amort, [...camposAmort(), ...(judicial && a523.aplicar ? [['noPrazo', 'No prazo do art. 523', 'check']] : [])], '+ Pagamento')}
      ${amort.length ? `<h3 class="sec">Prestação de contas do locador</h3>
        <p class="dica">Marque para lançar o pagamento na prestação de contas do locador, no mês da data em que o valor ficou disponível (ex.: depósito judicial: data do levantamento). Em branco, o valor a lançar é o valor pago. A taxa de administração do contrato incide, salvo se desmarcada.</p>
        <div class="rolagem"><table class="tabela tab-edicao"><thead><tr><th>Pagamento</th><th>Lançar</th><th>Disponível em</th><th>Valor a lançar (R$)</th><th>Taxa de administração</th></tr></thead><tbody>
        ${amort.map((a, i) => { const p = a.prestacao || {}; return `<tr><td>${a.data ? fmtData(a.data) : '—'} · ${fmtMoeda(Number(a.valor) || 0)}</td>
          <td><input type="checkbox" data-pr="lancar" data-i="${i}"${p.lancar ? ' checked' : ''} aria-label="Lançar na prestação de contas"></td>
          <td><input type="date" data-pr="data" data-i="${i}" value="${esc(p.data || '')}" aria-label="Disponível em"></td>
          <td><input class="num" inputmode="decimal" data-pr="valor" data-i="${i}" value="${valorCampo('moeda', p.valor)}" placeholder="${fmtNum(Number(a.valor) || 0)}" aria-label="Valor a lançar"></td>
          <td><input type="checkbox" data-pr="taxa" data-i="${i}"${p.taxa === false ? '' : ' checked'} aria-label="Incide taxa de administração"></td></tr>`; }).join('')}
        </tbody></table></div>` : ''}
    </section>
    <section class="cartao" id="resDebito"></section>
    <div class="barra-salvar"><span id="estadoSalvar" class="dica">${sujo ? 'Alterações não salvas' : ''}</span>
      ${novo ? '' : '<button class="bt perigo" id="btExcluirCalc">Excluir este cálculo</button>'}
      ${novo ? '' : `<a class="bt" href="#/contrato/${cid}/acordo/novo?calc=${calc.id}">Simular acordo</a>`}<button class="bt" id="btSalvarComo">Salvar como novo cálculo</button><button class="bt primario" id="btSalvarCalc">Salvar</button></div></div>`;
    ligar();
    recalcular();
  }

  function recalcular() {
    const area = $('#resDebito');
    if (!area) return;
    try { r = calcularContrato(ct, calc, calc.dataCalc); area.innerHTML = resultadoHTML(r); }
    catch (e) { console.error(e); r = null; area.innerHTML = `<p class="alerta">${esc(e.message)}</p>`; }
  }

  const marcar = () => { sujo = true; const e = $('#estadoSalvar'); if (e) e.textContent = 'Alterações não salvas'; };
  let tempo = null;
  const mudou = () => { marcar(); clearTimeout(tempo); tempo = setTimeout(recalcular, 300); };

  function ligar() {
    const raiz = $('#telaDeb');
    raiz.oninput = ler;
    raiz.onchange = e => {
      if (e.target.id === 'dCalc') return trocarCalculo(e.target.value);
      ler(e);
      // Mudanças que alteram o próprio formulário: redesenha
      if (e.target.name === 'dTipo' || e.target.dataset.k === 'juros' || e.target.dataset.a === 'aplicar' || e.target.id === 'dData' || e.target.id === 'dFinal') render();
    };
    raiz.onclick = e => {
      const add = e.target.dataset.add, del = e.target.dataset.del, imp = e.target.dataset.imp;
      if (imp) return abrirImportacao({ destino: imp, dia: Number(ct.diaVencimento) || 10, aoConcluir: lista => { calc[imp].push(...lista); marcar(); render(); } });
      if (add) { (add === 'amort' ? amort : calc[add]).push(NOVOS_ITENS[add]()); marcar(); render(); }
      else if (del) { (del === 'amort' ? amort : calc[del]).splice(+e.target.dataset.i, 1); marcar(); render(); }
    };
    $('#btCritContrato').addEventListener('click', () => { calc.crit = critDoContrato(ct); marcar(); render(); });
    $('#btSalvarCalc').addEventListener('click', () => executar(() => salvar(false)));
    $('#btSalvarComo').addEventListener('click', () => executar(() => salvar(true)));
    $('#btExcluirCalc')?.addEventListener('click', () => executar(async () => {
      if (!confirm(`Excluir o cálculo "${calc.nome}"? Os pagamentos registrados continuam no contrato.`)) return;
      await gravarCalculos(cid, arq => { delete arq.calculos[calc.id]; });
      sujo = false;
      aviso('Cálculo excluído.');
      calc = salvos()[0] ? copia(salvos()[0]) : novoCalculo(ct);
      novo = !D.calcs[cid].calculos[calc.id];
      render();
    }));
    ligarBotoesPDF('debPdf', async () => { if (!r) throw new Error('Não há cálculo.'); return pdfDebito(ct, r, calc); });
    $('#btDebXlsx').addEventListener('click', () => executar(async () => {
      if (!r) throw new Error('Não há cálculo.');
      await salvarPlanilha(xlsxDebito(ct, r, calc), nomeArquivo('debito', ct.codigo, calc.dataCalc) + '.xlsx');
    }));
  }

  function ler(e) {
    const t = e.target, ds = t.dataset;
    if (t.id === 'dCalc') return;
    // Datas e listas de escolha só no "change" (o "input" dispara a cada tecla)
    if (e.type === 'input' && (t.type === 'date' || t.tagName === 'SELECT' || t.type === 'checkbox' || t.type === 'radio')) return;
    if (ds.c) { calc[ds.c] = ds.t === 'pct' ? (t.value.trim() === '' ? 0 : r2(parseValor(t.value))) : t.value; if (ds.c === 'finalidade' && t.value === 'purga' && calc.honPurga === undefined) calc.honPurga = paramsMora(ct).honorarios; }
    else if (t.name === 'dTipo') { calc.tipo = t.value; if (/^Cobrança (extra)?judicial$/.test(calc.nome)) calc.nome = t.value === 'judicial' ? 'Cobrança judicial' : 'Cobrança extrajudicial'; }
    else if (ds.p) calc.processo = { ...(calc.processo || {}), [ds.p]: t.value };
    else if (ds.k) calc.crit = { ...calc.crit, [ds.k]: t.type === 'checkbox' ? t.checked : ds.t === 'pct' ? (t.value.trim() === '' ? 0 : r2(parseValor(t.value))) : t.value };
    else if (ds.mes) { const f = new Set(calc.fora || []); if (t.checked) f.delete(ds.mes); else f.add(ds.mes); calc.fora = [...f]; }
    else if (ds.lista) { const l = ds.lista === 'amort' ? amort : calc[ds.lista]; if (l[+ds.i]) l[+ds.i][ds.k2] = lerValor(ds.t, t); }
    else if (ds.causa) calc.valorCausa = { ...(calc.valorCausa || {}), [ds.causa]: ds.causa === 'valor' ? (t.value.trim() === '' ? '' : r2(parseValor(t.value))) : t.value };
    else if (ds.a) calc.art523 = { ...(calc.art523 || {}), [ds.a]: t.type === 'checkbox' ? t.checked : r2(parseValor(t.value)) };
    else if (ds.pr) { const a = amort[+ds.i]; if (a) a.prestacao = { ...(a.prestacao || {}), [ds.pr]: t.type === 'checkbox' ? t.checked : ds.pr === 'valor' ? (t.value.trim() === '' ? '' : r2(parseValor(t.value))) : t.value }; }
    else return;
    mudou();
  }

  function trocarCalculo(v) {
    if (sujo && !confirm('Há alterações não salvas neste cálculo. Trocar mesmo assim?')) { $('#dCalc').value = novo ? '' : calc.id; return; }
    sujo = false;
    calc = v === '+novo' ? novoCalculo(ct) : copia(D.calcs[cid].calculos[v]);
    novo = v === '+novo';
    amort = copia(D.calcs[cid].amortizacoes || []);
    render();
  }

  async function salvar(comoNovo) {
    for (const a of amort) {
      if (!ehData(a.data) || !(Number(a.valor) > 0)) throw new Error('Informe a data e o valor de todos os pagamentos.');
      if (a.prestacao?.lancar && !ehData(a.prestacao.data)) throw new Error(`Informe a data em que o pagamento de ${fmtData(a.data)} ficou disponível, para lançá-lo na prestação de contas.`);
    }
    if (calc.extras.some(x => !ehData(x.vencimento) || !(Number(x.valor) > 0))) throw new Error('Informe o vencimento e o valor de todos os outros débitos.');
    if (calc.custas.some(x => !ehData(x.data) || !(Number(x.valor) > 0))) throw new Error('Informe a data e o valor de todas as custas e despesas.');
    if (comoNovo) {
      const nome = prompt('Nome do novo cálculo:', calc.nome + ' (cópia)');
      if (!nome) return;
      calc = { ...copia(calc), id: novoId(), nome };
    }
    const reg = { ...copia(calc), atualizadoEm: new Date().toISOString(), atualizadoPor: usuario() };
    await gravarCalculos(cid, arq => { arq.calculos[reg.id] = reg; arq.amortizacoes = amort; });
    calc = copia(reg);
    novo = false;
    sujo = false;
    aviso('Cálculo salvo.');
    render();
  }

  render();
}

// Resultado na tela: itens por grupo, pagamentos e totais
function resultadoHTML(r) {
  const fat = f => f ? f.toLocaleString('pt-BR', { minimumFractionDigits: 6 }) : '';
  const linhaItem = it => `<tr><td>${esc(it.rotulo)}</td><td>${fmtData(it.data)}</td><td class="num">${fmtNum(it.original)}</td><td class="num">${fat(it.fator)}</td>
    <td class="num">${fmtNum(it.principal)}</td><td class="num">${fmtNum(it.juros)}</td><td class="num">${fmtNum(it.multa)}</td><td class="num">${it.pago ? fmtNum(it.pago) : ''}</td><td class="num"><b>${fmtNum(it.total)}</b></td></tr>`;
  const notas = notasDebito(r);
  return `<h2>Resultado em ${fmtData(r.dataCalc)}</h2>
    <div class="kpis"><div class="kpi"><span>Total do débito</span><b class="${r.total ? 'neg' : ''}">${fmtMoeda(r.total)}</b></div>
      ${r.grupos.map(g => `<div class="kpi"><span>${esc(g.nome)}</span><b>${fmtMoeda(g.total)}</b></div>`).join('')}
      ${r.honContr ? `<div class="kpi"><span>${rotuloHon(r)} (${fmtPct(r.pctContr)}%)</span><b>${fmtMoeda(r.honContr)}</b></div>` : ''}</div>
    ${r.itens.length ? `<div class="rolagem"><table class="tabela"><thead><tr><th>Item</th><th>Data</th><th class="num">Valor original</th><th class="num">Fator de correção</th><th class="num">Principal corrigido</th><th class="num">Juros</th><th class="num">Multa</th><th class="num">Pago</th><th class="num">Total</th></tr></thead><tbody>
      ${r.grupos.map(g => `<tr class="grupo"><td colspan="9">${esc(g.nome)}</td></tr>${g.itens.map(linhaItem).join('')}<tr class="subtotal"><td colspan="8">Subtotal</td><td class="num">${fmtNum(g.total)}</td></tr>`).join('')}
      ${r.honContr ? `<tr class="subtotal"><td colspan="8">${rotuloHon(r)} (${fmtPct(r.pctContr)}% sobre ${fmtMoeda(r.baseHon ?? r.subtotal)})</td><td class="num">${fmtNum(r.honContr)}</td></tr>` : ''}
      <tr class="total-geral"><td colspan="8">Total</td><td class="num">${fmtNum(r.total)}</td></tr></tbody></table></div>` : '<p class="vazio">Nenhum débito neste cálculo.</p>'}
    ${r.amort.length ? `<h3 class="sec">Pagamentos abatidos</h3><div class="rolagem"><table class="tabela"><thead><tr><th>Data</th><th>Pagamento</th><th class="num">Valor</th><th class="num">Débito antes</th><th class="num">Juros e multa abatidos</th><th class="num">Principal abatido</th><th class="num">Débito depois</th></tr></thead><tbody>
      ${r.amort.map(x => `<tr><td>${fmtData(x.data)}</td><td>${esc(nomeFormaAmort[x.a.forma] || 'Pagamento')}${x.a.obs ? ': ' + esc(x.a.obs) : ''}</td><td class="num">${fmtNum(x.valor)}</td><td class="num">${fmtNum(x.antes)}</td>
        <td class="num">${fmtNum(x.imputado.reduce((s, l) => s + l.juros + l.multa, 0))}</td><td class="num">${fmtNum(x.imputado.reduce((s, l) => s + l.principal, 0))}</td><td class="num">${fmtNum(x.depois)}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${notas.map(n => `<p class="alerta">${esc(n)}</p>`).join('')}
    <p class="dica">Critérios: ${esc(descRegimes(regimesDeCrit(r.c.crit)))}${r.c.crit.multa ? `; multa de ${fmtPct(r.c.crit.multa)}% sobre o valor corrigido` : ''}. ${esc(NOTA_METODO)}</p>`;
}
