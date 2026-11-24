// 오프라인 다중 문서 포맷 어댑터 (PDF · DOCX · DOC · TXT)

const PDFJS_CDN_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build';
const FFLATE_CDN_URL = 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js';

const A4_W = 595;
const A4_H = 842;

let pdfjsLibPromise = null;
let fflatePromise = null;

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeTextSmart(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('euc-kr', { fatal: false }).decode(bytes);
    } catch {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
  }
}

function estimateCharUnits(ch) {
  const code = ch.charCodeAt(0);
  if (code <= 0x7f) return 0.56;
  return 1.0;
}

function wrapLine(text, maxUnits) {
  if (!text) return [''];
  const lines = [];
  let cur = '';
  let units = 0;

  for (const ch of text) {
    const u = estimateCharUnits(ch);
    if (units + u > maxUnits && cur.length > 0) {
      lines.push(cur);
      cur = ch;
      units = u;
    } else {
      cur += ch;
      units += u;
    }
  }
  if (cur.length > 0 || lines.length === 0) {
    lines.push(cur);
  }
  return lines;
}

/**
 * 블록 배열({ type: 'para'|'heading'|'table', ... })을 A4 SVG 페이지 배열로 조판한다.
 */
function layoutBlocksToSvgPages(blocks) {
  const marginX = 48;
  const marginTop = 52;
  const marginBottom = 52;
  const contentW = A4_W - marginX * 2;
  const maxY = A4_H - marginBottom;

  const pages = [];
  let curSvgParts = [];
  let curTexts = [];
  let y = marginTop;

  const flushPage = () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${A4_W} ${A4_H}">` +
      `<rect x="0" y="0" width="${A4_W}" height="${A4_H}" fill="#ffffff"/>` +
      curSvgParts.join('') +
      `</svg>`;
    pages.push({ svg, text: curTexts.join('\n') });
    curSvgParts = [];
    curTexts = [];
    y = marginTop;
  };

  const ensureSpace = (needed) => {
    if (y + needed > maxY && curSvgParts.length > 0) {
      flushPage();
    }
  };

  for (const blk of blocks) {
    if (blk.type === 'table' && Array.isArray(blk.rows) && blk.rows.length > 0) {
      const colCount = Math.max(1, ...blk.rows.map((r) => r.length));
      const colW = contentW / colCount;
      const fontSize = 9.5;
      const lineH = 14;
      const padX = 6;
      const padY = 5;
      const maxUnits = Math.max(4, (colW - padX * 2) / fontSize);

      for (const row of blk.rows) {
        const wrappedCells = [];
        let maxLines = 1;
        for (let c = 0; c < colCount; c++) {
          const cellText = String(row[c] || '').trim();
          const lines = cellText ? wrapLine(cellText, maxUnits) : [''];
          wrappedCells.push(lines);
          if (lines.length > maxLines) maxLines = lines.length;
        }
        const rowH = maxLines * lineH + padY * 2;
        ensureSpace(rowH);

        for (let c = 0; c < colCount; c++) {
          const cx = marginX + c * colW;
          curSvgParts.push(
            `<rect x="${cx.toFixed(1)}" y="${y.toFixed(1)}" width="${colW.toFixed(1)}" height="${rowH.toFixed(1)}" fill="none" stroke="#94a3b8" stroke-width="0.7"/>`
          );
          const lines = wrappedCells[c];
          lines.forEach((line, li) => {
            if (!line) return;
            const ty = y + padY + (li + 1) * lineH - 3;
            curSvgParts.push(
              `<text x="${(cx + padX).toFixed(1)}" y="${ty.toFixed(1)}" font-family="'Noto Sans KR','Nanum Gothic',sans-serif" font-size="${fontSize}" fill="#111827">${escapeXml(line)}</text>`
            );
          });
        }
        curTexts.push(row.map((v) => String(v || '').trim()).join(' '));
        y += rowH;
      }
      y += 8;
      continue;
    }

    const fontSize = blk.type === 'heading' ? 14 : 10.5;
    const lineH = blk.type === 'heading' ? 22 : 17;
    const weight = blk.type === 'heading' || blk.bold ? '700' : '400';
    const maxUnits = Math.max(10, contentW / fontSize);
    const rawText = String(blk.text ?? '');
    const lines = wrapLine(rawText, maxUnits);

    if (blk.type === 'heading' && curSvgParts.length > 0) {
      y += 6;
    }

    for (const line of lines) {
      ensureSpace(lineH);
      if (line.length > 0) {
        curSvgParts.push(
          `<text x="${marginX}" y="${(y + fontSize).toFixed(1)}" font-family="'Noto Sans KR','Nanum Gothic',sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="#111827">${escapeXml(line)}</text>`
        );
      }
      curTexts.push(line);
      y += lineH;
    }
    if (blk.type === 'heading') y += 4;
  }

  if (curSvgParts.length > 0 || pages.length === 0) {
    flushPage();
  }
  return pages;
}

function createSvgPagesAdapter(pages, format) {
  return {
    isPdfAdapter: false,
    getSourceFormat: () => format,
    pageCount: () => pages.length,
    getPageInfo: () => JSON.stringify({ width: A4_W, height: A4_H }),
    renderPageSvg: (idx) => pages[idx]?.svg || pages[0].svg,
    getPageText: (idx) => pages[idx]?.text || '',
    free: () => {},
  };
}

// ===== 1. TXT 어댑터 =====
export function openTxtDocument(bytes) {
  const text = decodeTextSmart(bytes).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rawLines = text.split('\n');
  const blocks = rawLines.map((line) => ({ type: 'para', text: line }));
  const pages = layoutBlocksToSvgPages(blocks);
  return createSvgPagesAdapter(pages, 'txt');
}

// ===== 2. DOCX 어댑터 (오프라인 fflate ZIP + word/document.xml 파싱) =====
async function loadFflate(isNativeApp) {
  if (fflatePromise) return fflatePromise;
  fflatePromise = (async () => {
    const urls = isNativeApp ? ['./vendor/fflate/browser.js', FFLATE_CDN_URL] : [FFLATE_CDN_URL, './vendor/fflate/browser.js'];
    let lastErr = null;
    for (const url of urls) {
      try {
        return await import(url);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('ZIP 라이브러리를 불러올 수 없습니다.');
  })();
  return fflatePromise;
}

export async function openDocxDocument(bytes, isNativeApp) {
  const fflate = await loadFflate(isNativeApp);
  const files = fflate.unzipSync(bytes);
  const docXmlBytes = files['word/document.xml'];
  if (!docXmlBytes) {
    throw new Error('올바른 DOCX 문서가 아닙니다 (word/document.xml 없음).');
  }

  const xmlStr = new TextDecoder('utf-8').decode(docXmlBytes);
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlStr, 'application/xml');
  const body = xmlDoc.getElementsByTagNameNS('*', 'body')[0] || xmlDoc.documentElement;

  const extractParaText = (pNode) => {
    let text = '';
    const walk = (node) => {
      if (node.nodeType !== 1) return;
      const local = node.localName;
      if (local === 't') {
        text += node.textContent || '';
      } else if (local === 'tab') {
        text += '    ';
      } else if (local === 'br' || local === 'cr') {
        text += '\n';
      } else {
        for (const child of node.childNodes) walk(child);
      }
    };
    walk(pNode);
    return text;
  };

  const blocks = [];
  for (const child of body.childNodes) {
    if (child.nodeType !== 1) continue;
    if (child.localName === 'p') {
      const pStyle = child.getElementsByTagNameNS('*', 'pStyle')[0];
      const styleVal = pStyle?.getAttribute('w:val') || pStyle?.getAttribute('val') || '';
      const isHeading = /heading|title|제목/i.test(styleVal);
      const hasBold = child.getElementsByTagNameNS('*', 'b').length > 0;
      const text = extractParaText(child);
      for (const subLine of text.split('\n')) {
        blocks.push({ type: isHeading ? 'heading' : 'para', bold: hasBold, text: subLine });
      }
    } else if (child.localName === 'tbl') {
      const rows = [];
      for (const tr of child.childNodes) {
        if (tr.nodeType !== 1 || tr.localName !== 'tr') continue;
        const row = [];
        for (const tc of tr.childNodes) {
          if (tc.nodeType !== 1 || tc.localName !== 'tc') continue;
          const cellLines = [];
          for (const p of tc.childNodes) {
            if (p.nodeType === 1 && p.localName === 'p') {
              cellLines.push(extractParaText(p));
            }
          }
          row.push(cellLines.join(' ').trim());
        }
        if (row.length > 0) rows.push(row);
      }
      if (rows.length > 0) {
        blocks.push({ type: 'table', rows });
      }
    }
  }

  const pages = layoutBlocksToSvgPages(blocks.length ? blocks : [{ type: 'para', text: '(내용 없음)' }]);
  return createSvgPagesAdapter(pages, 'docx');
}

// ===== 3. DOC (Word 97-2003 OLE2) 어댑터 =====
function extractDocTextFromOle2(bytes) {
  // UTF-16LE 텍스트 런 추출 (Word 97-2003 본문은 주로 UTF-16LE로 저장됨)
  const chunks = [];
  let cur = '';
  const flush = () => {
    const cleaned = cur.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
    if (cleaned.length >= 2 && /[가-힣a-zA-Z0-9]/.test(cleaned)) {
      chunks.push(cleaned);
    }
    cur = '';
  };

  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    const isKorean = (code >= 0xac00 && code <= 0xd7a3) || (code >= 0x3131 && code <= 0x318e);
    const isAscii = code >= 0x20 && code <= 0x7e;
    const isPunct = code === 0x0d || code === 0x0a || code === 0x09 || (code >= 0x2000 && code <= 0x206f) || (code >= 0x3000 && code <= 0x303f);

    if (isKorean || isAscii || isPunct) {
      if (code === 0x0d || code === 0x0a) {
        cur += '\n';
      } else if (code === 0x09) {
        cur += '  ';
      } else {
        cur += String.fromCharCode(code);
      }
    } else {
      if (cur.length >= 4) flush();
      else cur = '';
    }
  }
  flush();

  // 메타데이터/스트림 헤더 노이즈 제거
  const filtered = chunks.filter(
    (s) => !/^(Root Entry|WordDocument|1Table|0Table|SummaryInformation|DocumentSummaryInformation|CompObj|MsoDataStore|Microsoft Word|Normal\.dotm?|Times New Roman|Calibri|Batang|Gulim|Malgun Gothic)$/i.test(s)
  );
  return filtered.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function openDocDocument(bytes) {
  const extracted = extractDocTextFromOle2(bytes);
  const lines = extracted ? extracted.split('\n') : ['(DOC 문서에서 텍스트를 추출하지 못했습니다. DOCX 또는 PDF로 변환 후 열어 주세요.)'];
  const blocks = lines.map((line) => ({ type: 'para', text: line }));
  const pages = layoutBlocksToSvgPages(blocks);
  return createSvgPagesAdapter(pages, 'doc');
}

// ===== 4. PDF 어댑터 (오프라인 pdfjs-dist) =====
async function loadPdfJs(isNativeApp) {
  if (pdfjsLibPromise) return pdfjsLibPromise;
  pdfjsLibPromise = (async () => {
    const candidates = isNativeApp
      ? [
          { lib: './vendor/pdfjs/pdf.min.mjs', worker: './vendor/pdfjs/pdf.worker.min.mjs' },
          { lib: `${PDFJS_CDN_BASE}/pdf.min.mjs`, worker: `${PDFJS_CDN_BASE}/pdf.worker.min.mjs` },
        ]
      : [
          { lib: `${PDFJS_CDN_BASE}/pdf.min.mjs`, worker: `${PDFJS_CDN_BASE}/pdf.worker.min.mjs` },
          { lib: './vendor/pdfjs/pdf.min.mjs', worker: './vendor/pdfjs/pdf.worker.min.mjs' },
        ];

    let lastErr = null;
    for (const c of candidates) {
      try {
        const lib = await import(c.lib);
        if (lib?.GlobalWorkerOptions) {
          lib.GlobalWorkerOptions.workerSrc = new URL(c.worker, import.meta.url).href;
        }
        return lib;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('PDF 엔진을 불러올 수 없습니다.');
  })();
  return pdfjsLibPromise;
}

export async function openPdfDocument(bytes, password, isNativeApp) {
  const pdfjs = await loadPdfJs(isNativeApp);
  const originalCopy = new Uint8Array(bytes);
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    password: password || undefined,
  });

  let pdfDoc;
  try {
    pdfDoc = await loadingTask.promise;
  } catch (err) {
    if (err?.name === 'PasswordException') {
      const msg = err.code === 2 ? '비밀번호가 일치하지 않습니다.' : 'password required';
      throw new Error(msg);
    }
    throw err;
  }

  const pageDimsCache = new Map();
  const pageTextCache = new Map();

  // 첫 페이지 크기를 미리 읽어 비율 정확도 확보
  try {
    const first = await pdfDoc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    pageDimsCache.set(0, { width: vp.width, height: vp.height });
  } catch {
    // ignore
  }

  return {
    isPdfAdapter: true,
    getSourceFormat: () => 'pdf',
    pageCount: () => pdfDoc.numPages,
    getPageInfo: (idx) => {
      const d = pageDimsCache.get(idx) || pageDimsCache.get(0) || { width: A4_W, height: A4_H };
      return JSON.stringify(d);
    },
    getPageText: (idx) => pageTextCache.get(idx) || '',
    async ensureAllPageTexts() {
      for (let i = 0; i < pdfDoc.numPages; i++) {
        if (pageTextCache.has(i)) continue;
        try {
          const page = await pdfDoc.getPage(i + 1);
          const tc = await page.getTextContent();
          const text = tc.items.map((it) => it.str || '').join(' ');
          pageTextCache.set(i, text);
        } catch {
          pageTextCache.set(i, '');
        }
      }
    },
    async renderPdfPageInto(idx, wrapEl) {
      const page = await pdfDoc.getPage(idx + 1);
      const baseVp = page.getViewport({ scale: 1 });
      pageDimsCache.set(idx, { width: baseVp.width, height: baseVp.height });

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const renderScale = Math.max(1.5, (1100 / baseVp.width) * dpr);
      const vp = page.getViewport({ scale: renderScale });

      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.className = 'pdf-page-canvas';

      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      // 검색어 붉은색 음영 표시를 위한 투명 SVG 텍스트 오버레이 생성
      const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svgEl.setAttribute('viewBox', `0 0 ${baseVp.width} ${baseVp.height}`);
      svgEl.setAttribute('class', 'pdf-text-svg');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

      try {
        const tc = await page.getTextContent();
        const plainParts = [];
        for (const item of tc.items) {
          const str = item.str || '';
          if (!str) continue;
          plainParts.push(str);
          const tx = pdfjs.Util.transform(baseVp.transform, item.transform);
          const fontH = Math.hypot(tx[2], tx[3]) || 12;
          const tEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          tEl.setAttribute('x', String(tx[4]));
          tEl.setAttribute('y', String(tx[5]));
          tEl.setAttribute('font-size', String(fontH));
          tEl.setAttribute('fill', 'transparent');
          if (item.width > 0) {
            tEl.setAttribute('textLength', String(item.width));
            tEl.setAttribute('lengthAdjust', 'spacingAndGlyphs');
          }
          tEl.textContent = str;
          svgEl.appendChild(tEl);
        }
        if (!pageTextCache.has(idx)) {
          pageTextCache.set(idx, plainParts.join(' '));
        }
      } catch {
        // 텍스트 레이어 추출 실패 시 캔버스만 표시
      }

      wrapEl.innerHTML = '';
      wrapEl.append(canvas, svgEl);
      return { width: baseVp.width, height: baseVp.height, ratio: baseVp.height / baseVp.width };
    },
    async renderPdfThumbInto(idx, previewEl) {
      const page = await pdfDoc.getPage(idx + 1);
      const baseVp = page.getViewport({ scale: 1 });
      const scale = Math.min(0.4, 180 / baseVp.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.className = 'pdf-thumb-canvas';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      previewEl.innerHTML = '';
      previewEl.appendChild(canvas);
    },
    getOriginalPdfBytes: () => originalCopy,
    free: () => {
      try {
        pdfDoc.destroy();
      } catch {
        // ignore
      }
    },
  };
}
