'use strict';
/*
  Importação de planilhas Excel (.xlsx) ou CSV para o Cálculo do débito (mesmo leitor do aplicativo Cobrança
  Condominial): o usuário escolhe a folha, a linha de títulos e a coluna de cada informação.
  - Destino "extras": outros débitos (competência ou vencimento, valor, descrição);
  - Destino "custas": custas e despesas (data do pagamento, valor, descrição).
*/

const normalizarTxt = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/* ---------- Leitura de .xlsx e .csv ---------- */
async function descompactar(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Lê os arquivos de um .zip (o .xlsx é um zip): { nome: Uint8Array } (só os pedidos por "filtro")
async function lerZip(buf, filtro = () => true) {
  const b = new Uint8Array(buf), v = new DataView(buf);
  let fim = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { fim = i; break; }
  if (fim < 0) throw new Error('Arquivo inválido: não é uma planilha .xlsx. Planilhas antigas (.xls) precisam ser salvas antes como .xlsx no Excel (Arquivo > Salvar como).');
  const qtd = v.getUint16(fim + 10, true);
  let p = v.getUint32(fim + 16, true);
  const dec = new TextDecoder(), saida = {};
  for (let k = 0; k < qtd; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) break;
    const metodo = v.getUint16(p + 10, true), tamC = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true);
    const off = v.getUint32(p + 42, true);
    const nome = dec.decode(b.subarray(p + 46, p + 46 + nl));
    p += 46 + nl + el + cl;
    if (!filtro(nome)) continue;
    const ini = off + 30 + v.getUint16(off + 26, true) + v.getUint16(off + 28, true);
    const dados = b.subarray(ini, ini + tamC);
    saida[nome] = metodo === 0 ? dados : metodo === 8 ? await descompactar(dados) : null;
  }
  return saida;
}

const xmlDe = bytes => new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
const textoNo = n => [...n.getElementsByTagName('t')].filter(t => t.parentNode.nodeName !== 'rPh').map(t => t.textContent).join('');
function colunaNum(ref) { let n = 0; for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
const isoDeSerial = s => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(s * 864e5)); return d.toISOString().slice(0, 10); };

// { folhas: [{ nome, linhas: [[célula]] }] }; datas como 'AAAA-MM-DD', números como number
async function lerPlanilha(arquivo) {
  const nomeArq = arquivo.name.toLowerCase();
  if (nomeArq.endsWith('.csv') || nomeArq.endsWith('.txt')) return { folhas: [{ nome: arquivo.name, linhas: lerCSV(await arquivo.text()) }] };
  if (nomeArq.endsWith('.xls')) throw new Error('Planilhas no formato antigo (.xls) precisam ser salvas antes como .xlsx no Excel (Arquivo > Salvar como > Pasta de Trabalho do Excel).');
  if (!window.DecompressionStream) throw new Error('Este navegador não consegue ler arquivos .xlsx. Use o Chrome, o Edge ou o Safari atualizados, ou salve a planilha como CSV.');
  const z = await lerZip(await arquivo.arrayBuffer(), n => n.startsWith('xl/') && n.endsWith('.xml') || n.endsWith('.rels'));
  if (!z['xl/workbook.xml']) throw new Error('Não foi possível ler a planilha (formato não reconhecido).');
  const wb = xmlDe(z['xl/workbook.xml']);
  const rels = {};
  if (z['xl/_rels/workbook.xml.rels']) for (const r of xmlDe(z['xl/_rels/workbook.xml.rels']).getElementsByTagName('Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  const compart = z['xl/sharedStrings.xml'] ? [...xmlDe(z['xl/sharedStrings.xml']).getElementsByTagName('si')].map(textoNo) : [];
  const ehDataFmt = new Set();
  if (z['xl/styles.xml']) {
    const st = xmlDe(z['xl/styles.xml']), custom = {};
    for (const f of st.getElementsByTagName('numFmt')) custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode');
    const xfs = st.getElementsByTagName('cellXfs')[0];
    if (xfs) [...xfs.getElementsByTagName('xf')].forEach((xf, i) => {
      const id = +xf.getAttribute('numFmtId');
      const cod = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\./g, '');
      if ((id >= 14 && id <= 22) || (id >= 45 && id <= 47) || /[dy]/i.test(cod) || /m{1,4}.*[dy]|[dy].*m/i.test(cod)) ehDataFmt.add(i);
    });
  }
  const folhas = [];
  for (const sh of wb.getElementsByTagName('sheet')) {
    const rid = sh.getAttribute('r:id') || sh.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    let alvo = rels[rid] || '';
    alvo = alvo.startsWith('/') ? alvo.slice(1) : 'xl/' + alvo.replace(/^\.\//, '');
    if (!z[alvo]) continue;
    const linhas = [];
    for (const row of xmlDe(z[alvo]).getElementsByTagName('row')) {
      const lin = linhas[+row.getAttribute('r') - 1] = [];
      for (const c of row.getElementsByTagName('c')) {
        const t = c.getAttribute('t'), s = +c.getAttribute('s') || 0;
        const vNo = c.getElementsByTagName('v')[0], v = vNo ? vNo.textContent : null;
        let val = null;
        if (t === 's') val = compart[+v] ?? '';
        else if (t === 'inlineStr') val = textoNo(c);
        else if (t === 'str' || t === 'e') val = v ?? '';
        else if (t === 'b') val = v === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (v !== null && v !== '') { val = Number(v); if (ehDataFmt.has(s) && val > 0 && val < 2958466) val = isoDeSerial(val); }
        lin[colunaNum(c.getAttribute('r'))] = val;
      }
    }
    for (let i = 0; i < linhas.length; i++) linhas[i] = linhas[i] || [];
    folhas.push({ nome: sh.getAttribute('name'), linhas });
  }
  return { folhas };
}

function lerCSV(texto) {
  const prim = texto.split(/\r?\n/, 1)[0];
  const sep = ['\t', ';', ','].map(s => [s, prim.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const linhas = [];
  let lin = [], campo = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspas) {
      if (ch === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += ch;
    } else if (ch === '"') aspas = true;
    else if (ch === sep) { lin.push(campo); campo = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      lin.push(campo); linhas.push(lin); lin = []; campo = '';
    } else campo += ch;
  }
  if (campo || lin.length) { lin.push(campo); linhas.push(lin); }
  return linhas;
}

/* ---------- Interpretação ---------- */
const CAMPOS_IMP = {
  extras: [['competencia', 'Competência (mês de referência)'], ['vencimento', 'Vencimento'], ['valor', 'Valor *'], ['descricao', 'Descrição']],
  custas: [['data', 'Data do pagamento *'], ['valor', 'Valor *'], ['descricao', 'Descrição']],
};
const PISTAS_IMP = {
  competencia: /compet|refer|m[eê]s|per[ií]odo/, vencimento: /venc/, valor: /valor|quantia|aluguel|debito|r\$/, descricao: /descri|hist[oó]rico|tipo|natureza|rubrica/,
  data: /data|pagamento|pago em/,
};
const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const anoCompleto = a => { a = +a; return a < 100 ? (a < 70 ? 2000 + a : 1900 + a) : a; };

function lerDataImp(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v > 20000 && v < 80000 ? isoDeSerial(v) : '';
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return ehData(`${m[1]}-${m[2]}-${m[3]}`) ? `${m[1]}-${m[2]}-${m[3]}` : '';
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) { const d = `${anoCompleto(m[3])}-${p2(m[2])}-${p2(m[1])}`; return ehData(d) ? d : ''; }
  return '';
}

function lerCompetencia(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v > 20000 && v < 80000 ? isoDeSerial(v).slice(0, 7) : '';
  const s = normalizarTxt(v);
  let m = s.match(/^(\d{4})-(\d{2})/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2]}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (m) return `${anoCompleto(m[3])}-${p2(m[2])}`;
  m = s.match(/^(\d{1,2})[\/.-](\d{2,4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return `${anoCompleto(m[2])}-${p2(m[1])}`;
  m = s.match(/^([a-zç]{3,})\.?\s*[\/.\- ]?\s*(?:de\s+)?(\d{2,4})$/);
  if (m) { const i = MESES_ABREV.indexOf(m[1].slice(0, 3)); if (i >= 0) return `${anoCompleto(m[2])}-${p2(i + 1)}`; }
  return '';
}

const textoCel = v => v === null || v === undefined ? '' : typeof v === 'number' ? String(v) : String(v).trim();
const mostrarCel = v => typeof v === 'number' ? fmtNum(v).replace(/,00$/, '') : /^\d{4}-\d{2}-\d{2}$/.test(v || '') ? fmtData(v) : textoCel(v);

function sugerirCabecalho(linhas) {
  for (let i = 0; i < Math.min(30, linhas.length); i++) {
    const textos = (linhas[i] || []).filter(v => typeof v === 'string' && v.trim());
    if (textos.filter(t => Object.values(PISTAS_IMP).some(re => re.test(normalizarTxt(t)))).length >= 2) return i;
  }
  return 0;
}

const NAO_DATA = /meses|dias|qtd|quant|\bn[ºo°]?\b|numero/;
const ehValorCel = v => typeof v === 'number' ? v > 0 : /^-?\(?R?\$?\s*\d{1,3}(\.?\d{3})*,\d{2}\)?$/.test(String(v ?? '').trim());
const TESTES_IMP = { competencia: v => !!lerCompetencia(v), vencimento: v => !!lerDataImp(v), data: v => !!lerDataImp(v), valor: ehValorCel };

function sugerirColunas(linhas, cab, campos) {
  const titulos = (linhas[cab] || []).map(textoCel), amostra = linhas.slice(cab + 1, cab + 16);
  const usados = new Set(), mapa = {};
  for (const [k] of campos) {
    const re = PISTAS_IMP[k];
    const j = titulos.findIndex((t, j) => {
      if (usados.has(j) || !re || !re.test(normalizarTxt(t))) return false;
      if ((k === 'vencimento' || k === 'data') && NAO_DATA.test(normalizarTxt(t))) return false;
      return !TESTES_IMP[k] || amostra.some(l => TESTES_IMP[k](l[j]));
    });
    if (j >= 0) { mapa[k] = j; usados.add(j); }
  }
  return mapa;
}

/*
  abrirImportacao({ destino: 'extras' | 'custas', dia, aoConcluir(lista) })
*/
function abrirImportacao(opcoes) {
  const st = { ...opcoes, planilha: null, folha: 0, cab: 0, mapa: {}, dia: opcoes.dia || 10 };
  const campos = CAMPOS_IMP[st.destino];
  abrirModal(`<div class="modal-cab"><h2>${st.destino === 'custas' ? 'Importar custas e despesas' : 'Importar débitos'}</h2><button class="bt-x" data-fechar title="Fechar">&times;</button></div>
    <p class="dica">Escolha uma planilha Excel (.xlsx) ou CSV. Depois confira a linha dos títulos e a coluna de cada informação. Linhas sem valor ou de totais são ignoradas.</p>
    <div class="campo-arquivo"><input type="file" id="impArq" accept=".xlsx,.xlsm,.csv,.txt,.xls"></div>
    <div id="impCorpo"></div>`, 'modal-grande');
  $('#impArq').addEventListener('change', e => executar(async () => {
    const f = e.target.files[0];
    if (!f) return;
    $('#impCorpo').innerHTML = '<p class="carregando">Lendo o arquivo…</p>';
    try { st.planilha = await lerPlanilha(f); } catch (err) { $('#impCorpo').innerHTML = ''; throw err; }
    st.folha = Math.max(0, st.planilha.folhas.findIndex(x => x.linhas.some(l => l.length)));
    prepararFolha();
  }));

  function prepararFolha() {
    const linhas = st.planilha.folhas[st.folha].linhas;
    st.cab = sugerirCabecalho(linhas);
    st.mapa = sugerirColunas(linhas, st.cab, campos);
    desenhar();
  }

  function linhasConvertidas() {
    const linhas = st.planilha.folhas[st.folha].linhas.slice(st.cab + 1);
    const pegar = (l, k) => st.mapa[k] === undefined || st.mapa[k] === '' ? null : l[st.mapa[k]];
    const saida = [], ign = { valor: [], data: [], total: [] };
    linhas.forEach((l, i) => {
      if (!l.some(v => textoCel(v))) return;
      const nLinha = st.cab + i + 2;
      if (l.some(v => typeof v === 'string' && /^\s*(sub[\s-]?)?tota(l|is)\b/i.test(v))) { ign.total.push(nLinha); return; }
      const valor = r2(parseValor(pegar(l, 'valor')));
      if (!(valor > 0)) { ign.valor.push(nLinha); return; }
      if (st.destino === 'custas') {
        const data = lerDataImp(pegar(l, 'data'));
        if (!data) { ign.data.push(nLinha); return; }
        saida.push({ id: novoId(), descricao: textoCel(pegar(l, 'descricao')) || 'Despesa', data, valor, idProc: '' });
        return;
      }
      let venc = lerDataImp(pegar(l, 'vencimento'));
      let comp = lerCompetencia(pegar(l, 'competencia'));
      if (!comp && venc) comp = venc.slice(0, 7);
      if (!venc && comp) venc = diaDoMes(comp, st.dia);
      if (!venc) { ign.data.push(nLinha); return; }
      saida.push({ id: novoId(), descricao: textoCel(pegar(l, 'descricao')) || 'Aluguel e encargos ' + mesNum(comp), vencimento: venc, valor, multa: true });
    });
    return { saida, ign };
  }

  function desenhar() {
    const pl = st.planilha, linhas = pl.folhas[st.folha].linhas;
    const ncol = Math.max(1, ...linhas.slice(0, 300).map(l => l.length));
    const titulos = Array.from({ length: ncol }, (_, j) => textoCel((linhas[st.cab] || [])[j]));
    const opcoesCol = sel => `<option value="">— não usar —</option>` + titulos.map((t, j) => `<option value="${j}" ${String(sel) === String(j) ? 'selected' : ''}>${colunaXLSX(j)}${t ? ': ' + esc(t.slice(0, 40)) : ''}</option>`).join('');
    const prev = linhas.slice(0, 60).map((l, i) => `<tr class="${i === st.cab ? 'grupo' : ''}"><td class="dica">${i + 1}</td>${Array.from({ length: ncol }, (_, j) => `<td>${esc(mostrarCel(l[j]))}</td>`).join('')}</tr>`).join('');
    const { saida, ign } = linhasConvertidas();
    const total = saida.reduce((s, x) => s + cent(x.valor), 0) / 100;
    const lista = (n, rot) => n.length ? `${n.length} ${rot} (linha${n.length > 1 ? 's' : ''} ${n.slice(0, 10).join(', ')}${n.length > 10 ? '…' : ''})` : '';
    const ignTxt = [lista(ign.valor, 'sem valor'), lista(ign.data, st.destino === 'custas' ? 'sem data reconhecível' : 'sem competência ou vencimento reconhecível'), lista(ign.total, 'de totais')].filter(Boolean).join('; ');
    $('#impCorpo').innerHTML = `
      <div class="grade-form">
        ${pl.folhas.length > 1 ? `<div class="campo"><label for="impFolha">Folha</label><select id="impFolha">${pl.folhas.map((f, i) => `<option value="${i}" ${i === st.folha ? 'selected' : ''}>${esc(f.nome)}</option>`).join('')}</select></div>` : ''}
        <div class="campo"><label for="impCab">Linha dos títulos</label><input type="number" id="impCab" min="1" value="${st.cab + 1}"></div>
        ${campos.map(([k, r]) => `<div class="campo"><label>${r}</label><select data-mapa="${k}">${opcoesCol(st.mapa[k])}</select></div>`).join('')}
        ${st.destino === 'extras' ? `<div class="campo"><label for="impDia">Dia do vencimento (se não houver coluna)</label><input type="number" id="impDia" min="1" max="31" value="${st.dia}"></div>` : ''}
      </div>
      <p class="${saida.length ? 'dica' : 'alerta'}"><b>${saida.length}</b> linha(s) serão importadas, total de <b>${fmtMoeda(total)}</b>. ${ignTxt ? 'Ignoradas: ' + esc(ignTxt) + '.' : ''}
        ${!saida.length && (st.mapa.valor === undefined || st.mapa.valor === '') ? '<br><b>Escolha a coluna do valor.</b>' : ''}</p>
      <div class="acoes-linha"><button class="bt primario" id="impOk" ${saida.length ? '' : 'disabled'}>Importar</button><button class="bt" data-fechar>Cancelar</button></div>
      <h3 class="sec">Prévia (${Math.min(60, linhas.length)} primeiras linhas)</h3>
      <div class="rolagem"><table class="tabela"><thead><tr><th></th>${titulos.map((_, j) => `<th>${colunaXLSX(j)}</th>`).join('')}</tr></thead><tbody>${prev}</tbody></table></div>`;
    $('#impFolha')?.addEventListener('change', e => { st.folha = +e.target.value; prepararFolha(); });
    $('#impCab').addEventListener('change', e => { st.cab = Math.max(0, (+e.target.value || 1) - 1); st.mapa = sugerirColunas(linhas, st.cab, campos); desenhar(); });
    $('#impDia')?.addEventListener('change', e => { st.dia = +e.target.value || 10; desenhar(); });
    $$('[data-mapa]').forEach(s => s.addEventListener('change', () => { st.mapa[s.dataset.mapa] = s.value === '' ? '' : +s.value; desenhar(); }));
    $('#impOk').addEventListener('click', () => {
      const lista = linhasConvertidas().saida;
      st.aoConcluir(lista);
      fecharModal();
      aviso(`${lista.length} linha(s) incluída(s). Confira e clique em Salvar.`);
    });
  }
}
