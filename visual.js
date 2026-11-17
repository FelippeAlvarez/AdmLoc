'use strict';
/* Apresentação: ícones, indicadores, gráficos, iniciais coloridas, busca geral, contadores do menu, marca e aparência */

const ic = (nome, cls = '') => `<svg${cls ? ` class="${cls}"` : ''} aria-hidden="true"><use href="#i-${nome}"/></svg>`;

/* ---------- Pessoas: iniciais com cor fixa por nome ---------- */
const CORES_PESSOA = ['#2563eb', '#0d9488', '#9333ea', '#c2410c', '#be185d', '#4f46e5', '#15803d', '#b45309', '#0369a1', '#7c3aed'];
function iniciais(nome) {
  const p = String(nome || '').replace(/\b(d[aeo]s?|e)\b/gi, ' ').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return '?';
  return ((p[0][0] || '') + (p.length > 1 ? p[p.length - 1][0] : (p[0][1] || ''))).toUpperCase();
}
function corPessoa(nome) {
  let h = 0;
  for (const c of String(nome || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CORES_PESSOA[h % CORES_PESSOA.length];
}
const avatarHTML = (nome, tam) => `<span class="av" style="background:${corPessoa(nome)}${tam ? `;width:${tam}px;height:${tam}px;font-size:${Math.round(tam * .37)}px` : ''}" aria-hidden="true">${esc(iniciais(nome))}</span>`;
const pessoaHTML = (nome, sub, tam) => `<div class="pessoa">${avatarHTML(nome, tam)}<div>${esc(nome)}${sub ? `<small>${esc(sub)}</small>` : ''}</div></div>`;

/* ---------- Indicadores ---------- */
// k = { ic, cor ('az'|'vd'|'vm'|'am'|'rx'|'cz'), t, v, neg, sub, variacao: { txt, cls }, sp: [valores], spCor, href, mini }
function kpiHTML(k) {
  const tag = k.href ? 'a' : 'div';
  return `<${tag} class="kpi c-${k.cor || 'az'}${k.mini ? ' mini' : ''}"${k.href ? ` href="${k.href}"` : ''}${k.titulo ? ` title="${esc(k.titulo)}"` : ''}>
    ${k.ic ? `<div class="ic">${ic(k.ic)}</div>` : ''}${k.sp ? sparkHTML(k.sp, k.spCor) : ''}
    <span>${k.t}</span><b class="${k.neg ? 'neg' : ''}">${k.v}</b>
    ${k.variacao ? `<span class="var ${k.variacao.cls || ''}">${k.variacao.txt}</span>` : ''}${k.sub ? `<small>${k.sub}</small>` : ''}</${tag}>`;
}
// Linha de tendência (últimos meses)
function sparkHTML(vals, cor = 'var(--pri)') {
  const v = (vals || []).filter(x => Number.isFinite(x));
  if (v.length < 2) return '';
  const max = Math.max(...v), min = Math.min(...v), amp = max - min || 1, W = 76, H = 26;
  const pts = v.map((x, i) => `${(i * W / (v.length - 1)).toFixed(1)},${(H - 3 - (x - min) / amp * (H - 6)).toFixed(1)}`).join(' ');
  return `<svg class="sp" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${cor}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}
// Variação em relação ao mês anterior: { txt, cls }. bom = 'sobe' quando aumentar é bom, 'desce' quando diminuir é bom
function variacao(atual, anterior, bom = 'sobe') {
  if (!(anterior > 0.004)) return null;
  const pct = (atual - anterior) / anterior * 100;
  if (Math.abs(pct) < 0.5) return { txt: '= mês anterior', cls: '' };
  const subiu = pct > 0, txt = `${subiu ? '▲' : '▼'} ${Math.abs(pct).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}% sobre o mês anterior`;
  return { txt, cls: (subiu ? 'sobe' : 'desce') === bom ? 'sobe' : 'desce' };
}
// "12 mil", "1,2 mi"
function fmtCurto(v) {
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (a >= 1e3) return (v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: a >= 1e4 ? 0 : 1 }) + ' mil';
  return Math.round(v).toLocaleString('pt-BR');
}

/* ---------- Gráficos (SVG próprio, sem biblioteca, funciona sem internet) ---------- */
// Barras devido × recebido. meses = [{ ym, dev, rec }]
function graficoBarrasHTML(meses, atual) {
  const W = 600, H = 190, X0 = 44, Y0 = 150, AH = 128;
  const max = Math.max(1, ...meses.flatMap(m => [m.dev, m.rec]));
  const passo = [1, 2, 2.5, 5, 10].map(f => f * 10 ** Math.floor(Math.log10(max / 4))).find(p => max / p <= 4) || max / 4;
  const topo = Math.ceil(max / passo) * passo, y = v => Y0 - v / topo * AH;
  const linhas = [];
  for (let v = 0; v <= topo + 1e-6; v += passo) linhas.push(`<line class="grade" x1="${X0}" x2="${W - 4}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${X0 - 6}" y="${(y(v) + 3.5).toFixed(1)}" font-size="10.5" text-anchor="end">${fmtCurto(v)}</text>`);
  const larg = (W - 4 - X0) / meses.length, bw = Math.min(16, larg / 2 - 3);
  const barras = meses.map((m, i) => {
    const x = X0 + i * larg + larg / 2;
    const r = (cls, xx, v) => `<rect class="${cls}" x="${xx.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, Y0 - y(v)).toFixed(1)}" rx="3"/>`;
    return `<g class="mes${m.ym === atual ? ' atual' : ''}" data-ym="${m.ym}"><title>${nomeMes(m.ym)}: devido ${fmtMoeda(m.dev)} · recebido ${fmtMoeda(m.rec)}</title>
      <rect x="${(x - larg / 2).toFixed(1)}" y="0" width="${larg.toFixed(1)}" height="${H}" fill="transparent"/>
      ${r('b-dev', x - bw - 1, m.dev)}${r('b-rec', x + 1, m.rec)}
      <text x="${x.toFixed(1)}" y="${Y0 + 17}" font-size="10.5" text-anchor="middle">${MESES[+m.ym.slice(5) - 1].slice(0, 3).toLowerCase()}</text></g>`;
  }).join('');
  return `<svg class="graf-barras" viewBox="0 0 ${W} ${H - 18}" role="img" aria-label="Devido e recebido nos últimos meses">${linhas.join('')}${barras}</svg>`;
}
// Rosca: faixas = [{ rot, v, cor }]
function roscaHTML(faixas, centro, rotCentro) {
  const tot = faixas.reduce((s, f) => s + f.v, 0), R = 15.915;
  let acum = 0;
  const arcos = tot > 0 ? faixas.filter(f => f.v > 0).map(f => {
    const p = f.v / tot * 100, a = `<circle cx="21" cy="21" r="${R}" fill="none" stroke="${f.cor}" stroke-width="6" stroke-dasharray="${p.toFixed(2)} ${(100 - p).toFixed(2)}" stroke-dashoffset="${(25 - acum).toFixed(2)}"/>`;
    acum += p; return a;
  }).join('') : '';
  return `<svg viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="${R}" fill="none" stroke="var(--borda-suave)" stroke-width="6"/>${arcos}
    <text x="21" y="21" text-anchor="middle" font-size="7" font-weight="700" fill="var(--texto)">${esc(centro)}</text>
    <text x="21" y="27" text-anchor="middle" font-size="3.4" fill="var(--suave)">${esc(rotCentro)}</text></svg>
    <ul>${faixas.map(f => `<li><i style="background:${f.cor}"></i>${esc(f.rot)}<b>${fmtMoeda(f.v)}</b></li>`).join('')}</ul>`;
}

/* ---------- Contadores do menu (com os extratos já carregados; não busca nada na nuvem) ---------- */
function atualizarContadores() {
  try {
    if (!Auth.usuario || !D.config) return;
    const ativos = contratosAtivos(), h = hoje();
    if (!ativos.length || ativos.some(ct => !D.extratos[ct.id])) return; // ainda sem todos os extratos: mantém o que estava
    let inad = 0, rep = 0;
    for (const ct of ativos) {
      const cad = calcularExtrato(ct, D.extratos[ct.id]);
      if (cad.some(x => x.c.emAberto > 0 && vencimentoMes(ct, x.ym, x.mes) < h)) inad++;
      if ((cad[cad.length - 1]?.c.saldoConta || 0) > 0.004) rep++;
    }
    const pon = (id, n) => { const e = $('#' + id); if (e) { e.textContent = n; e.hidden = !n; } };
    pon('contInad', inad); pon('contRep', rep);
  } catch (e) { console.warn('Contadores do menu:', e); }
}

/* ---------- Busca geral (Ctrl K) ---------- */
function resultadosBusca(termo) {
  const t = termo.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (t.length < 2) return [];
  const tem = (...xs) => xs.filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(t);
  const R = [];
  Object.values(D.contratos).sort(ordemContrato).forEach(ct => {
    const im = D.imoveis[ct.imovelId], lt = nomeDe('locatarios', ct.locatarioId), lo = nomeDe('locadores', ct.locadorId);
    if (tem(ct.codigo, 'contrato ' + ct.codigo, lt, lo, im && descImovel(im), im?.codigo))
      R.push({ grp: 'Contratos', ic: 'contrato', t: rotuloContrato(ct) + (ct.status === 'encerrado' ? ' (encerrado)' : ''), s: `${lt} · ${imovelCurto(im)}`, href: '#/contrato/' + ct.id });
  });
  Object.values(D.locatarios).sort((a, b) => comparar(a.nome, b.nome)).forEach(r => {
    if (tem(r.nome, r.documento, r.telefone, r.email)) R.push({ grp: 'Locatários', ic: 'locatario', t: r.nome, s: r.documento || r.telefone || '', href: '#/locatarios/' + r.id, nome: r.nome });
  });
  Object.values(D.locadores).sort((a, b) => comparar(a.nome, b.nome)).forEach(r => {
    if (tem(r.nome, r.documento, r.telefone, r.email)) R.push({ grp: 'Clientes', ic: 'cliente', t: r.nome, s: r.documento || r.telefone || '', href: '#/locadores/' + r.id, nome: r.nome });
  });
  Object.values(D.imoveis).forEach(r => {
    if (tem(r.codigo, descImovel(r))) R.push({ grp: 'Imóveis', ic: 'imovel', t: imovelCurto(r), s: [r.tipo, nomeDe('locadores', r.locadorId)].filter(Boolean).join(' · '), href: '#/imoveis/' + r.id });
  });
  return R.slice(0, 30);
}
function ligarBuscaGlobal() {
  const campo = $('#buscaGlobalCampo'), caixa = $('#buscaGlobalRes');
  let lista = [], sel = 0;
  const fechar = () => { caixa.hidden = true; };
  const desenhar = () => {
    lista = resultadosBusca(campo.value);
    if (campo.value.trim().length < 2) return fechar();
    let grp = '';
    caixa.innerHTML = lista.length ? lista.map((r, i) => (r.grp !== grp ? `<div class="grp">${(grp = r.grp)}</div>` : '') +
      `<a href="${r.href}" data-i="${i}" class="${i === sel ? 'sel' : ''}">${r.nome ? avatarHTML(r.nome, 26) : ic(r.ic)}<div>${esc(r.t)}${r.s ? `<small>${esc(r.s)}</small>` : ''}</div></a>`).join('')
      : '<p class="vazio">Nada encontrado.</p>';
    caixa.hidden = false;
  };
  const ir = i => { const r = lista[i]; if (!r) return; campo.value = ''; fechar(); campo.blur(); location.hash = r.href; };
  campo.addEventListener('input', () => { sel = 0; desenhar(); });
  campo.addEventListener('focus', () => { if (campo.value.trim().length >= 2) desenhar(); });
  campo.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, Math.min(lista.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1))); desenhar(); caixa.querySelector('a.sel')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); ir(sel); }
    else if (e.key === 'Escape') { campo.value = ''; fechar(); campo.blur(); }
  });
  caixa.addEventListener('mousedown', e => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); ir(+a.dataset.i); } });
  campo.addEventListener('blur', () => setTimeout(fechar, 150));
  document.addEventListener('keydown', e => {
    if (!document.body.classList.contains('conectado')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); campo.focus(); campo.select(); }
  });
}

/* ---------- Marca da administradora (guardada neste aparelho para a tela de entrada) ---------- */
const MARCA_CHAVE = 'cl-marca';
function lerMarca() { try { return JSON.parse(localStorage.getItem(MARCA_CHAVE) || 'null'); } catch { return null; } }
function guardarMarca() {
  const a = D.config?.administradora;
  if (!a) return;
  const m = { nome: a.nome || '', logo: a.logo || null };
  try { if (JSON.stringify(m) !== JSON.stringify(lerMarca())) localStorage.setItem(MARCA_CHAVE, JSON.stringify(m)); } catch { /* sem espaço: segue sem guardar */ }
  aplicarMarcaTopo(m);
}
function aplicarMarcaTopo(m = lerMarca()) {
  const box = $('#marcaLogo');
  if (!box) return;
  const logo = m?.logo;
  box.classList.toggle('com-logo', !!logo);
  box.innerHTML = `<img src="${logo ? esc(logo) : 'icone.svg'}" alt="">`;
  box.title = m?.nome || '';
}
const CIDADE_SVG = `<svg class="cidade" viewBox="0 0 300 110" fill="none" stroke="#fff" stroke-width="2" aria-hidden="true"><path d="M10 100h280"/><path d="M30 100V55l30-22 30 22v45"/><path d="M50 100V75h20v25"/><rect x="110" y="30" width="60" height="70"/><path d="M120 42h12M148 42h12M120 58h12M148 58h12M120 74h12M148 74h12"/><path d="M190 100V60l40-30 40 30v40"/><rect x="215" y="68" width="30" height="32"/></svg>`;
// Envolve o conteúdo da tela de entrada com o painel ilustrado da marca
function entradaHTML(caixa) {
  const m = lerMarca();
  const nome = m?.nome || '';
  const logo = m?.logo ? `<img src="${esc(m.logo)}" alt="">` : (nome ? esc(iniciais(nome)) : `<img src="icone.svg" alt="" style="height:34px">`);
  return `<div class="entrada"><div class="arte">
      <div class="adm"><div class="adm-logo">${logo}</div><div><b>${esc(nome || 'Controle de Locações')}</b><small>Administração de locações</small></div></div>
      <h2>Controle de Locações</h2><p>Contratos, recebimentos, repasses e cobrança num só lugar.</p>${CIDADE_SVG}
    </div>${caixa}</div>`;
}

/* ---------- Aparência (claro, escuro ou conforme o aparelho) ---------- */
const temaEscolhido = () => { try { return localStorage.getItem('cl-tema') || 'claro'; } catch { return 'claro'; } };
const escuroDoSistema = matchMedia('(prefers-color-scheme: dark)');
function aplicarTema(t = temaEscolhido()) {
  const efetivo = t === 'auto' ? (escuroDoSistema.matches ? 'escuro' : 'claro') : t;
  document.documentElement.dataset.tema = efetivo;
  $('meta[name=theme-color]')?.setAttribute('content', efetivo === 'escuro' ? '#0b1424' : '#1f4e79');
}
function escolherTema(t) {
  try { localStorage.setItem('cl-tema', t); } catch { /* sem armazenamento */ }
  aplicarTema(t);
}
escuroDoSistema.addEventListener?.('change', () => { if (temaEscolhido() === 'auto') aplicarTema('auto'); });
aplicarTema();
function secaoAparenciaHTML() {
  const t = temaEscolhido();
  return `<section class="cartao"><h2>Aparência neste aparelho</h2>
    <div class="segmentado temas">${[['claro', 'Claro'], ['escuro', 'Escuro'], ['auto', 'Igual ao aparelho']].map(([v, r]) => `<label><input type="radio" name="tema" value="${v}"${v === t ? ' checked' : ''}> ${r}</label>`).join('')}</div>
    <p class="dica">Vale só para este aparelho. Os PDFs e as planilhas não mudam.</p></section>`;
}
function ligarAparencia() { $$('input[name=tema]').forEach(r => r.addEventListener('change', () => escolherTema(r.value))); }
