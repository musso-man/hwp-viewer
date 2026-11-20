const CDN_BASES = [
  'https://cdn.jsdelivr.net/npm/@rhwp/core@0.9.1',
  'https://unpkg.com/@rhwp/core@0.9.1',
];

const DEFAULT_PAGE_RATIO = 842 / 595; // A4 세로 비율
const BASE_A4_WIDTH_PX = 794; // 96dpi 기준 A4 폭
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

// @rhwp/core WASM 초기화 전에 반드시 등록해야 하는 텍스트 폭 측정 콜백
let measureCtx = null;
let lastMeasureFont = '';
globalThis.measureTextWidth = (font, text) => {
  if (!measureCtx) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (font !== lastMeasureFont) {
    measureCtx.font = font;
    lastMeasureFont = font;
  }
  return measureCtx.measureText(text).width;
};

// ===== DOM 참조 =====
const el = {
  brandHome: document.getElementById('brand-home'),
  engineStatus: document.getElementById('engine-status'),
  engineStatusText: document.getElementById('engine-status-text'),
  btnOpenFile: document.getElementById('btn-open-file'),
  btnOpenUrl: document.getElementById('btn-open-url'),
  btnSearchToggle: document.getElementById('btn-search-toggle'),
  btnExtractText: document.getElementById('btn-extract-text'),
  btnPrint: document.getElementById('btn-print'),
  btnTheme: document.getElementById('btn-theme'),
  fileInput: document.getElementById('file-input'),

  tabBar: document.getElementById('tab-bar'),
  docToolbar: document.getElementById('doc-toolbar'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  pageInput: document.getElementById('page-input'),
  pageTotal: document.getElementById('page-total'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  zoomSelect: document.getElementById('zoom-select'),
  btnSaveHwpx: document.getElementById('btn-save-hwpx'),
  btnSaveTxt: document.getElementById('btn-save-txt'),

  searchBar: document.getElementById('search-bar'),
  searchInput: document.getElementById('search-input'),
  searchCount: document.getElementById('search-count'),
  btnSearchPrev: document.getElementById('btn-search-prev'),
  btnSearchNext: document.getElementById('btn-search-next'),
  btnSearchClose: document.getElementById('btn-search-close'),
  searchResults: document.getElementById('search-results'),

  welcomeScreen: document.getElementById('welcome-screen'),
  welcomeDropzone: document.getElementById('welcome-dropzone'),
  btnWelcomeFile: document.getElementById('btn-welcome-file'),
  btnWelcomeUrl: document.getElementById('btn-welcome-url'),
  btnSampleHwpx: document.getElementById('btn-sample-hwpx'),
  btnSampleHwp: document.getElementById('btn-sample-hwp'),

  readerLayout: document.getElementById('reader-layout'),
  sidebar: document.getElementById('sidebar'),
  sidebarBody: document.querySelector('.sidebar-body'),
  sidebarTabs: document.querySelectorAll('.sidebar-tab'),
  paneThumbs: document.getElementById('pane-thumbs'),
  paneOutline: document.getElementById('pane-outline'),
  paneInfo: document.getElementById('pane-info'),
  viewport: document.getElementById('viewport'),
  pagesContainer: document.getElementById('pages-container'),

  dropOverlay: document.getElementById('drop-overlay'),
  urlModal: document.getElementById('url-modal'),
  urlForm: document.getElementById('url-form'),
  urlInput: document.getElementById('url-input'),
  urlError: document.getElementById('url-error'),
  btnUrlSubmit: document.getElementById('btn-url-submit'),

  passwordModal: document.getElementById('password-modal'),
  passwordForm: document.getElementById('password-form'),
  passwordFilename: document.getElementById('password-filename'),
  passwordInput: document.getElementById('password-input'),
  passwordError: document.getElementById('password-error'),

  textModal: document.getElementById('text-modal'),
  extractedTextarea: document.getElementById('extracted-textarea'),
  btnDownloadTxt: document.getElementById('btn-download-txt'),
  btnCopyText: document.getElementById('btn-copy-text'),

  toastContainer: document.getElementById('toast-container'),
};

// ===== 전역 상태 =====
let HwpDocumentClass = null;
let enginePromise = null;
let tabs = [];
let activeTabId = null;
let nextTabSeq = 1;
let pendingEncrypted = null;

let pageObserver = null;
let thumbObserver = null;
let scrollTrackRaf = 0;
let searchMatches = [];
let activeSearchIdx = -1;
let dragCounter = 0;

// ===== 유틸리티 =====
function showToast(message, type = 'info', duration = 3800) {
  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  node.textContent = message;
  el.toastContainer.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.2s ease';
    setTimeout(() => node.remove(), 220);
  }, duration);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeJsonParse(str) {
  if (typeof str !== 'string') return str;
  const trimmed = str.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function stripExt(name) {
  return name.replace(/\.(hwpx|hwp|hml)$/i, '');
}

function detectFormatFromMagic(bytes, fileName = '') {
  if (bytes.length >= 4) {
    // ZIP (HWPX)
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'hwpx';
    }
    // OLE2 Compound File (HWP 5.0)
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      return 'hwp';
    }
  }
  if (bytes.length >= 17) {
    const head = new TextDecoder('ascii', { fatal: false }).decode(bytes.subarray(0, 32));
    if (head.startsWith('HWP Document File')) return 'hwp3';
    if (head.trimStart().startsWith('<?xml') || head.includes('<HWPML')) return 'hml';
  }
  const m = fileName.match(/\.(hwpx|hwp|hml)$/i);
  return m ? m[1].toLowerCase() : null;
}

function isSupportedFile(file, bytes) {
  if (/\.(hwpx|hwp|hml)$/i.test(file.name || '')) return true;
  if (bytes) {
    return detectFormatFromMagic(bytes, file.name) !== null;
  }
  return false;
}

function normalizeFileUrl(raw) {
  let trimmed = raw.trim();
  // GitHub blob URL -> raw.githubusercontent.com 자동 변환
  const ghBlob = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
  if (ghBlob) {
    trimmed = `https://raw.githubusercontent.com/${ghBlob[1]}/${ghBlob[2]}/${ghBlob[3]}`;
  }
  return trimmed;
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'document.hwpx');
    return seg;
  } catch {
    return 'document.hwpx';
  }
}

function getActiveTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

function isEditableFocused() {
  const active = document.activeElement;
  if (!active) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable;
}

function setEngineStatus(state, text) {
  el.engineStatus.className = `engine-status is-${state}`;
  el.engineStatusText.textContent = text;
}

// ===== WASM 엔진 로드 =====
async function fetchWasmWithProgress(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} (${url})`);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    setEngineStatus('loading', '엔진 초기화 중...');
    return new Uint8Array(buf);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      const pct = Math.min(99, Math.round((received / total) * 100));
      setEngineStatus('loading', `엔진 불러오는 중... ${pct}%`);
    } else {
      const mb = (received / (1024 * 1024)).toFixed(1);
      setEngineStatus('loading', `엔진 불러오는 중... ${mb}MB`);
    }
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  setEngineStatus('loading', '엔진 초기화 중...');
  return merged;
}

async function loadEngineFromBase(baseUrl) {
  const mod = await import(`${baseUrl}/rhwp.js`);
  const init = mod.default;
  const wasmBytes = await fetchWasmWithProgress(`${baseUrl}/rhwp_bg.wasm`);
  await init({ module_or_path: wasmBytes });
  return mod.HwpDocument;
}

function isNativeApp() {
  return Boolean(window.Capacitor?.isNativePlatform?.() || window.AndroidHwpBridge);
}

function getEngineBases() {
  return isNativeApp() ? ['./vendor/rhwp', ...CDN_BASES] : CDN_BASES;
}

function ensureEngineReady() {
  if (HwpDocumentClass) return Promise.resolve(HwpDocumentClass);
  if (enginePromise) return enginePromise;

  enginePromise = (async () => {
    const bases = getEngineBases();
    let lastErr = null;
    for (let i = 0; i < bases.length; i++) {
      try {
        if (i > 0) {
          setEngineStatus('loading', '보조 서버에서 불러오는 중...');
        }
        HwpDocumentClass = await loadEngineFromBase(bases[i]);
        setEngineStatus('ready', '엔진 준비 완료');
        return HwpDocumentClass;
      } catch (err) {
        lastErr = err;
        console.warn(`엔진 로드 실패 (${bases[i]}):`, err);
      }
    }
    setEngineStatus('error', '엔진 로드 실패');
    throw lastErr || new Error('WASM 엔진을 불러올 수 없습니다.');
  })();

  return enginePromise;
}

// ===== 테마 =====
function initTheme() {
  const saved = localStorage.getItem('hwp-viewer-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('hwp-viewer-theme', next);
}

// ===== 모달 제어 =====
function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.add('hidden');
  if (id === 'password-modal') {
    pendingEncrypted = null;
    el.passwordInput.value = '';
    el.passwordError.classList.add('hidden');
  }
  if (id === 'url-modal') {
    el.urlError.classList.add('hidden');
  }
}

function closeAllModals() {
  ['url-modal', 'password-modal', 'text-modal'].forEach(closeModal);
}

// ===== 문서 파싱 헬퍼 (방어적 JSON 처리) =====
function getDocPageDimensions(doc, pageIdx) {
  try {
    const raw = doc.getPageInfo(pageIdx);
    const info = safeJsonParse(raw);
    if (info && typeof info === 'object') {
      const w = Number(info.width || info.pageWidth || info.w || info.size?.width);
      const h = Number(info.height || info.pageHeight || info.h || info.size?.height);
      if (w > 0 && h > 0) {
        return { width: w, height: h, ratio: h / w };
      }
    }
  } catch {
    // 기본 A4 비율 사용
  }
  return { width: BASE_A4_WIDTH_PX, height: Math.round(BASE_A4_WIDTH_PX * DEFAULT_PAGE_RATIO), ratio: DEFAULT_PAGE_RATIO };
}

function parseSvgNaturalSize(svgString) {
  const vbMatch = svgString.match(/viewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i);
  if (vbMatch) {
    const vbW = parseFloat(vbMatch[1]);
    const vbH = parseFloat(vbMatch[2]);
    if (vbW > 0 && vbH > 0) {
      // A4(약 595pt / 210mm)를 100% 줌에서 읽기 편한 794px 기준으로 정규화
      const ratio = vbH / vbW;
      return { baseWidth: BASE_A4_WIDTH_PX, baseHeight: Math.round(BASE_A4_WIDTH_PX * ratio), ratio };
    }
  }
  return { baseWidth: BASE_A4_WIDTH_PX, baseHeight: Math.round(BASE_A4_WIDTH_PX * DEFAULT_PAGE_RATIO), ratio: DEFAULT_PAGE_RATIO };
}

let svgScopeSeq = 0;

/**
 * 여러 페이지·썸네일 SVG를 동일 DOM에 인라인 삽입할 때
 * clipPath(cell-clip-*, body-clip-*)·gradient(grad*) 등의 id 충돌로
 * 다른 페이지의 표 셀 내용이 잘리거나 비어 보이는 문제를 방지한다.
 */
function scopeSvgIds(svgString) {
  if (!svgString || typeof svgString !== 'string') return svgString;

  const definedIds = new Set();
  const idDefRe = /\bid=(["'])([^"']+)\1/g;
  let m;
  while ((m = idDefRe.exec(svgString)) !== null) {
    definedIds.add(m[2]);
  }
  if (definedIds.size === 0) return svgString;

  const prefix = `rhwp-${++svgScopeSeq}-`;

  return svgString
    .replace(/\bid=(["'])([^"']+)\1/g, (full, q, id) =>
      definedIds.has(id) ? `id=${q}${prefix}${id}${q}` : full
    )
    .replace(/url\(\s*(["']?)#([^)"'\s]+)\1\s*\)/g, (full, q, id) =>
      definedIds.has(id) ? `url(${q}#${prefix}${id}${q})` : full
    )
    .replace(/\b((?:xlink:)?href)=(["'])#([^"']+)\2/g, (full, attr, q, id) =>
      definedIds.has(id) ? `${attr}=${q}#${prefix}${id}${q}` : full
    );
}

function extractCleanPageText(doc, pageIdx) {
  try {
    const raw = doc.getPageText(pageIdx);
    if (typeof raw !== 'string') return '';
    const trimmed = raw.trim();
    if (trimmed.startsWith('"')) {
      try {
        const unwrapped = JSON.parse(trimmed);
        if (typeof unwrapped === 'string') {
          return unwrapped.replace(/\r\n?/g, '\n').trimEnd();
        }
      } catch {
        // 일반 문자열로 폴백
      }
    }
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === 'object') {
      const text =
        typeof parsed.text === 'string'
          ? parsed.text
          : typeof parsed.content === 'string'
            ? parsed.content
            : Array.isArray(parsed.lines)
              ? parsed.lines.join('\n')
              : '';
      if (text) return text.replace(/\r\n?/g, '\n').trimEnd();
    }
    return raw.replace(/\r\n?/g, '\n').trimEnd();
  } catch {
    return '';
  }
}

function getAllPageTexts(tab) {
  const list = [];
  for (let i = 0; i < tab.pageCount; i++) {
    if (!tab.pageTexts.has(i)) {
      tab.pageTexts.set(i, extractCleanPageText(tab.doc, i));
    }
    list.push(tab.pageTexts.get(i));
  }
  return list;
}

function formatDetectionError(err) {
  const msg = String(err?.message || err || '알 수 없는 오류');
  return msg;
}

function isPasswordError(errMsg) {
  return /password|encrypt|암호|비밀번호|decrypt|locked/i.test(errMsg);
}

// ===== 문서 열기 파이프라인 =====
async function openFileObjects(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (!isSupportedFile(file, bytes)) {
        showToast(`지원하지 않는 파일 형식입니다: ${file.name || '(이름 없음)'}`, 'error');
        continue;
      }
      const name = file.name || `붙여넣은_문서.${detectFormatFromMagic(bytes) || 'hwpx'}`;
      await openBytes(name, bytes);
    } catch (err) {
      showToast(`파일을 읽지 못했습니다: ${formatDetectionError(err)}`, 'error');
    }
  }
}

async function openBytes(name, bytes) {
  let HwpDocument;
  try {
    showToast(`${name} 불러오는 중...`, 'info', 1800);
    HwpDocument = await ensureEngineReady();
  } catch (err) {
    showToast(`뷰어 엔진을 불러오지 못했습니다: ${formatDetectionError(err)}`, 'error', 5000);
    return;
  }

  let doc;
  try {
    doc = new HwpDocument(bytes);
  } catch (err) {
    const errMsg = formatDetectionError(err);
    if (isPasswordError(errMsg)) {
      pendingEncrypted = { name, bytes };
      el.passwordFilename.textContent = `"${name}" 파일은 비밀번호로 보호되어 있습니다.`;
      el.passwordError.classList.add('hidden');
      el.passwordInput.value = '';
      openModal('password-modal');
      setTimeout(() => el.passwordInput.focus(), 40);
      return;
    }
    showToast(`문서를 열 수 없습니다 (${name}): ${errMsg}`, 'error', 5200);
    return;
  }

  registerOpenedDocument(name, bytes, doc);
}

async function submitPassword(e) {
  e.preventDefault();
  if (!pendingEncrypted) return;
  const pw = el.passwordInput.value;
  if (!pw) return;

  try {
    const HwpDocument = await ensureEngineReady();
    const doc = HwpDocument.openWithPassword(pendingEncrypted.bytes, pw);
    const { name, bytes } = pendingEncrypted;
    closeModal('password-modal');
    registerOpenedDocument(name, bytes, doc);
  } catch (err) {
    const msg = formatDetectionError(err);
    el.passwordError.textContent = msg.includes('비밀번호가 일치하지')
      ? '비밀번호가 일치하지 않습니다. 다시 확인해 주세요.'
      : `잠금 해제 실패: ${msg}`;
    el.passwordError.classList.remove('hidden');
    el.passwordInput.select();
  }
}

function registerOpenedDocument(name, bytes, doc) {
  let format = detectFormatFromMagic(bytes, name) || 'hwp';
  try {
    const srcFmt = doc.getSourceFormat();
    if (srcFmt) format = srcFmt.toLowerCase();
  } catch {
    // fallback to detected magic/ext
  }

  let pageCount = 1;
  try {
    pageCount = Math.max(1, doc.pageCount());
  } catch {
    pageCount = 1;
  }

  const tab = {
    id: `tab-${nextTabSeq++}`,
    name,
    size: bytes.byteLength,
    bytes,
    doc,
    format,
    pageCount,
    currentPage: 1,
    zoom: 1,
    zoomMode: window.innerWidth <= 900 ? 'fit-width' : 'manual', // 'manual' | 'fit-width' | 'fit-page'
    renderedPages: new Set(),
    renderedThumbs: new Set(),
    pageDims: new Map(),
    pageTexts: new Map(),
    scrollTop: 0,
  };

  tabs.push(tab);
  activateTab(tab.id);
  showToast(`${name} (${pageCount}페이지) 열기 완료`, 'success', 2600);
}

async function openFromUrl(rawUrl) {
  const normalized = normalizeFileUrl(rawUrl);
  if (!/^https?:\/\//i.test(normalized)) {
    throw new Error('올바른 http:// 또는 https:// 주소를 입력해 주세요.');
  }

  const fileName = fileNameFromUrl(normalized);
  showToast(`URL에서 파일 가져오는 중: ${fileName}`, 'info', 2400);

  let res;
  try {
    res = await fetch(normalized, { mode: 'cors' });
  } catch {
    throw new Error('네트워크 오류 또는 대상 서버의 CORS 제한으로 브라우저에서 직접 가져올 수 없습니다. 파일을 다운로드한 뒤 붙여넣거나 끌어다 놓아 주세요.');
  }

  if (!res.ok) {
    throw new Error(`파일 요청 실패 (HTTP ${res.status})`);
  }

  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const detected = detectFormatFromMagic(bytes, fileName);
  if (!detected) {
    throw new Error('가져온 데이터가 올바른 한글 문서(.hwpx, .hwp, .hml)가 아닙니다.');
  }

  await openBytes(fileName, bytes);
}

// ===== 샘플 문서 생성 (blank2010 템플릿 기반 실제 파일 생성 -> 재파싱) =====
async function openSampleDocument(format) {
  let HwpDocument;
  try {
    HwpDocument = await ensureEngineReady();
  } catch (err) {
    showToast(`엔진이 준비되지 않았습니다: ${formatDetectionError(err)}`, 'error');
    return;
  }

  const builder = HwpDocument.createEmpty();
  try {
    builder.createBlankDocument();

    const title = `한글 뷰어 샘플 문서 (${format.toUpperCase()})`;
    builder.insertText(0, 0, 0, title);
    try {
      builder.applyCharFormat(0, 0, 0, title.length, JSON.stringify({ bold: true, fontSize: 1800 }));
      builder.applyParaFormat(0, 0, JSON.stringify({ align: 'center' }));
    } catch {
      // 서식 적용 실패 시 기본 텍스트 유지
    }

    const lines = [
      '',
      '이 문서는 브라우저 내 WebAssembly 엔진(@rhwp/core)으로 직접 생성·파싱된 실제 한글 문서입니다.',
      '파일 탐색기나 Finder에서 .hwpx 또는 .hwp 파일을 복사(Ctrl+C)한 뒤 이 화면에서 Ctrl+V를 누르거나 끌어다 놓으면 즉시 문서를 읽을 수 있습니다.',
      'GitHub 저장소의 파일 링크(blob URL)를 붙여넣어도 자동으로 원본(raw) 파일을 불러와 안전하게 로컬에서 렌더링합니다.',
      '아래 표는 문서 내 표·셀 렌더링과 본문 검색(Ctrl+F) 기능을 확인하기 위한 예시입니다.',
    ];

    let paraIdx = 0;
    let currentLen = title.length;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const splitRes = safeJsonParse(builder.splitParagraph(0, paraIdx, currentLen));
      paraIdx = Number.isInteger(splitRes?.paraIdx) ? splitRes.paraIdx : paraIdx + 1;
      currentLen = 0;

      if (i === 0) {
        try {
          builder.applyParaFormat(0, paraIdx, JSON.stringify({ align: 'left' }));
        } catch {
          // 무시
        }
      }

      if (line) {
        builder.insertText(0, paraIdx, 0, line);
        currentLen = line.length;
      }
    }

    const tableSplit = safeJsonParse(builder.splitParagraph(0, paraIdx, currentLen));
    paraIdx = Number.isInteger(tableSplit?.paraIdx) ? tableSplit.paraIdx : paraIdx + 1;
    const tblRes = safeJsonParse(builder.createTable(0, paraIdx, 0, 3, 3));
    const tblPara = tblRes && Number.isInteger(tblRes.paraIdx) ? tblRes.paraIdx : paraIdx;
    const tblCtrl = tblRes && Number.isInteger(tblRes.controlIdx) ? tblRes.controlIdx : 0;

    const cells = [
      '지원 기능', '입력 방법', '비고',
      'HWPX / HWP 5.0', 'Ctrl+V 붙여넣기 / 드롭', '100% 브라우저 처리',
      '검색 · 추출 · 인쇄', 'Ctrl+F / PDF 저장', '암호 문서 열기 지원',
    ];

    cells.forEach((txt, idx) => {
      try {
        builder.insertTextInCell(0, tblPara, tblCtrl, idx, 0, 0, txt);
      } catch {
        // 무시
      }
    });

    const bytes = format === 'hwp' ? builder.exportHwp() : builder.exportHwpx();
    const sampleName = format === 'hwp' ? '샘플_안내문서.hwp' : '샘플_안내문서.hwpx';
    await openBytes(sampleName, new Uint8Array(bytes));
  } catch (err) {
    showToast(`샘플 문서 생성 실패: ${formatDetectionError(err)}`, 'error');
  } finally {
    try {
      builder.free();
    } catch {
      // ignore
    }
  }
}

// ===== 탭 & 뷰포트 렌더링 =====
function renderTabBar() {
  el.tabBar.innerHTML = '';
  if (tabs.length === 0) {
    el.tabBar.classList.add('hidden');
    return;
  }
  el.tabBar.classList.remove('hidden');

  for (const tab of tabs) {
    const btn = document.createElement('div');
    btn.className = `doc-tab${tab.id === activeTabId ? ' is-active' : ''}`;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(tab.id === activeTabId));
    btn.title = tab.name;

    const badge = document.createElement('span');
    badge.className = 'tab-badge';
    badge.textContent = tab.format.toUpperCase();

    const title = document.createElement('span');
    title.className = 'tab-name';
    title.textContent = tab.name;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tab-close';
    closeBtn.setAttribute('aria-label', `${tab.name} 닫기`);
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab.id);
    });

    btn.append(badge, title, closeBtn);
    btn.addEventListener('click', () => activateTab(tab.id));
    el.tabBar.appendChild(btn);
  }
}

function updateDocControlsState() {
  const tab = getActiveTab();
  const hasDoc = Boolean(tab);

  el.btnSearchToggle.disabled = !hasDoc;
  el.btnExtractText.disabled = !hasDoc;
  el.btnPrint.disabled = !hasDoc;

  el.welcomeScreen.classList.toggle('hidden', hasDoc);
  el.readerLayout.classList.toggle('hidden', !hasDoc);
  el.docToolbar.classList.toggle('hidden', !hasDoc);

  if (!hasDoc) {
    el.searchBar.classList.add('hidden');
    return;
  }

  el.pageTotal.textContent = String(tab.pageCount);
  el.pageInput.max = String(tab.pageCount);
  el.pageInput.value = String(tab.currentPage);
  el.btnPrevPage.disabled = tab.currentPage <= 1;
  el.btnNextPage.disabled = tab.currentPage >= tab.pageCount;

  syncZoomSelectUI(tab);
}

function syncZoomSelectUI(tab) {
  if (tab.zoomMode === 'fit-width') {
    el.zoomSelect.value = 'fit-width';
  } else if (tab.zoomMode === 'fit-page') {
    el.zoomSelect.value = 'fit-page';
  } else {
    const exact = ZOOM_STEPS.find((z) => Math.abs(z - tab.zoom) < 0.01);
    el.zoomSelect.value = exact ? String(exact) : '1';
  }
}

function disconnectObservers() {
  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
  if (thumbObserver) {
    thumbObserver.disconnect();
    thumbObserver = null;
  }
}

function activateTab(tabId) {
  const prevTab = getActiveTab();
  if (prevTab) {
    prevTab.scrollTop = el.viewport.scrollTop;
  }

  activeTabId = tabId;
  searchMatches = [];
  activeSearchIdx = -1;
  el.searchBar.classList.add('hidden');
  el.searchResults.classList.add('hidden');

  renderTabBar();
  updateDocControlsState();

  const tab = getActiveTab();
  if (!tab) {
    disconnectObservers();
    el.pagesContainer.innerHTML = '';
    el.paneThumbs.innerHTML = '';
    el.paneOutline.innerHTML = '';
    el.paneInfo.innerHTML = '';
    return;
  }

  buildDocumentPages(tab);
  buildSidebarThumbs(tab);
  buildSidebarOutline(tab);
  buildSidebarInfo(tab);

  if (tab.zoomMode !== 'manual') {
    applyZoomMode(tab, tab.zoomMode);
  }
  el.viewport.scrollTop = tab.scrollTop || 0;
}

function closeTab(tabId) {
  const idx = tabs.findIndex((t) => t.id === tabId);
  if (idx === -1) return;
  const [removed] = tabs.splice(idx, 1);
  try {
    removed.doc.free();
  } catch {
    // ignore
  }

  if (activeTabId === tabId) {
    const next = tabs[idx] || tabs[idx - 1] || null;
    activateTab(next ? next.id : null);
  } else {
    renderTabBar();
  }
}

function computeZoomFactor(tab) {
  if (tab.zoomMode === 'fit-width') {
    const availW = Math.max(280, el.viewport.clientWidth - 48);
    return availW / BASE_A4_WIDTH_PX;
  }
  if (tab.zoomMode === 'fit-page') {
    const availW = Math.max(280, el.viewport.clientWidth - 48);
    const availH = Math.max(320, el.viewport.clientHeight - 48);
    const dim = tab.pageDims.get(tab.currentPage - 1) || { baseWidth: BASE_A4_WIDTH_PX, ratio: DEFAULT_PAGE_RATIO };
    const wRatio = availW / dim.baseWidth;
    const hRatio = availH / (dim.baseWidth * dim.ratio);
    return Math.min(wRatio, hRatio);
  }
  return tab.zoom;
}

function applyPageCardDimensions(tab) {
  const factor = computeZoomFactor(tab);
  const cards = el.pagesContainer.querySelectorAll('.page-card');
  cards.forEach((card) => {
    const idx = Number(card.dataset.pageIndex);
    const dim = tab.pageDims.get(idx) || { baseWidth: BASE_A4_WIDTH_PX, ratio: DEFAULT_PAGE_RATIO };
    const widthPx = Math.max(240, Math.round(dim.baseWidth * factor));
    const heightPx = Math.round(widthPx * dim.ratio);
    card.style.width = `${widthPx}px`;
    card.style.minHeight = `${heightPx}px`;
  });
}

function applyZoomMode(tab, mode, numericZoom) {
  tab.zoomMode = mode;
  if (mode === 'manual' && typeof numericZoom === 'number') {
    tab.zoom = Math.min(3, Math.max(0.3, numericZoom));
  }
  applyPageCardDimensions(tab);
  syncZoomSelectUI(tab);
}

function renderSinglePage(tab, pageIdx, card) {
  if (!tab || tab.renderedPages.has(pageIdx)) return;
  if (getActiveTab()?.id !== tab.id) return;

  try {
    const svg = scopeSvgIds(tab.doc.renderPageSvg(pageIdx));
    const nat = parseSvgNaturalSize(svg);
    tab.pageDims.set(pageIdx, nat);

    const wrap = card.querySelector('.page-svg-wrap');
    if (wrap) {
      wrap.innerHTML = svg;
      const svgEl = wrap.querySelector('svg');
      if (svgEl) {
        svgEl.removeAttribute('width');
        svgEl.removeAttribute('height');
        svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      }
    }

    const factor = computeZoomFactor(tab);
    const widthPx = Math.max(240, Math.round(nat.baseWidth * factor));
    card.style.width = `${widthPx}px`;
    card.style.minHeight = `${Math.round(widthPx * nat.ratio)}px`;
    tab.renderedPages.add(pageIdx);
  } catch (err) {
    const wrap = card.querySelector('.page-svg-wrap');
    if (wrap) {
      wrap.innerHTML = `<div class="page-placeholder">${pageIdx + 1}페이지를 렌더링하지 못했습니다: ${escapeHtml(formatDetectionError(err))}</div>`;
    }
  }
}

function renderSingleThumb(tab, pageIdx, previewEl) {
  if (!tab || tab.renderedThumbs.has(pageIdx)) return;
  if (getActiveTab()?.id !== tab.id) return;

  try {
    const svg = scopeSvgIds(tab.doc.renderPageSvg(pageIdx));
    previewEl.innerHTML = svg;
    const svgEl = previewEl.querySelector('svg');
    if (svgEl) {
      svgEl.removeAttribute('width');
      svgEl.removeAttribute('height');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    tab.renderedThumbs.add(pageIdx);
  } catch {
    previewEl.textContent = `${pageIdx + 1}`;
  }
}

function buildDocumentPages(tab) {
  disconnectObservers();
  tab.renderedPages.clear();
  el.pagesContainer.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (let i = 0; i < tab.pageCount; i++) {
    const info = getDocPageDimensions(tab.doc, i);
    const dim = { baseWidth: BASE_A4_WIDTH_PX, ratio: info.ratio || DEFAULT_PAGE_RATIO };
    tab.pageDims.set(i, dim);

    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.pageIndex = String(i);
    card.id = `page-card-${i}`;
    card.style.width = `${BASE_A4_WIDTH_PX}px`;
    card.style.minHeight = `${Math.round(BASE_A4_WIDTH_PX * dim.ratio)}px`;

    const wrap = document.createElement('div');
    wrap.className = 'page-svg-wrap';
    wrap.innerHTML = `<div class="page-placeholder">${i + 1}페이지 불러오는 중...</div>`;

    const caption = document.createElement('div');
    caption.className = 'page-caption';
    caption.textContent = `${i + 1} / ${tab.pageCount}`;

    card.append(wrap, caption);
    frag.appendChild(card);
  }
  el.pagesContainer.appendChild(frag);
  applyPageCardDimensions(tab);

  // 첫 3페이지는 즉시 렌더링
  const immediateCount = Math.min(3, tab.pageCount);
  for (let i = 0; i < immediateCount; i++) {
    const card = el.pagesContainer.children[i];
    if (card) renderSinglePage(tab, i, card);
  }

  pageObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const card = entry.target;
        const idx = Number(card.dataset.pageIndex);
        if (!tab.renderedPages.has(idx)) {
          requestAnimationFrame(() => renderSinglePage(tab, idx, card));
        }
      }
    },
    { root: el.viewport, rootMargin: '600px 0px' }
  );

  Array.from(el.pagesContainer.children).forEach((card) => pageObserver.observe(card));
}

function buildSidebarThumbs(tab) {
  tab.renderedThumbs.clear();
  el.paneThumbs.innerHTML = '';

  const list = document.createElement('div');
  list.className = 'thumb-list';

  for (let i = 0; i < tab.pageCount; i++) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `thumb-item${i + 1 === tab.currentPage ? ' is-active' : ''}`;
    item.dataset.pageIndex = String(i);

    const preview = document.createElement('div');
    preview.className = 'thumb-preview';
    preview.textContent = `${i + 1}`;

    const label = document.createElement('span');
    label.className = 'thumb-label';
    label.textContent = `${i + 1}페이지`;

    item.append(preview, label);
    item.addEventListener('click', () => jumpToPage(i + 1));
    list.appendChild(item);
  }

  el.paneThumbs.appendChild(list);

  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const item = entry.target;
        const idx = Number(item.dataset.pageIndex);
        const preview = item.querySelector('.thumb-preview');
        if (preview && !tab.renderedThumbs.has(idx)) {
          requestAnimationFrame(() => renderSingleThumb(tab, idx, preview));
        }
      }
    },
    { root: el.sidebarBody, rootMargin: '250px 0px' }
  );

  list.querySelectorAll('.thumb-item').forEach((item) => thumbObserver.observe(item));
}

function buildSidebarOutline(tab) {
  el.paneOutline.innerHTML = '';
  let items = [];

  try {
    const raw = tab.doc.getOutlineNavigation();
    const parsed = safeJsonParse(raw);
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && typeof parsed === 'object') {
      items = parsed.items || parsed.outline || parsed.entries || parsed.nodes || [];
    }
  } catch {
    items = [];
  }

  if (!Array.isArray(items) || items.length === 0) {
    el.paneOutline.innerHTML = '<div class="empty-state">이 문서에는 개요 번호 기반 목차가 없습니다.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'outline-list';

  for (const item of items) {
    const title = item.title || item.text || item.label || '(제목 없음)';
    const level = Math.min(5, Math.max(0, Number(item.level || item.depth || 0)));

    let pageNum = null;
    if (Number.isInteger(item.page)) {
      pageNum = item.page + 1;
    } else if (Number.isInteger(item.pageIndex)) {
      pageNum = item.pageIndex + 1;
    } else if (Number.isInteger(item.paraIdx) || Number.isInteger(item.para_idx)) {
      try {
        const sec = Number(item.sectionIdx ?? item.section_idx ?? item.sec ?? 0);
        const para = Number(item.paraIdx ?? item.para_idx ?? 0);
        const pos = safeJsonParse(tab.doc.getPageOfPosition(sec, para));
        if (pos && Number.isInteger(pos.page)) pageNum = pos.page + 1;
        else if (pos && Number.isInteger(pos.pageIndex)) pageNum = pos.pageIndex + 1;
      } catch {
        pageNum = null;
      }
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'outline-item';
    btn.style.paddingLeft = `${10 + level * 14}px`;
    btn.innerHTML = `<span>${escapeHtml(title)}</span>${pageNum ? `<span class="outline-page">${pageNum}쪽</span>` : ''}`;
    btn.addEventListener('click', () => {
      if (pageNum) jumpToPage(pageNum);
    });
    list.appendChild(btn);
  }

  el.paneOutline.appendChild(list);
}

function buildSidebarInfo(tab) {
  let meta = {};
  try {
    const raw = tab.doc.getDocumentInfo();
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === 'object') {
      meta = parsed.metadata || parsed.summary || parsed;
    }
  } catch {
    meta = {};
  }

  const rows = [
    ['파일명', tab.name],
    ['형식', tab.format.toUpperCase()],
    ['파일 크기', formatBytes(tab.size)],
    ['총 페이지', `${tab.pageCount}페이지`],
  ];

  const optionalKeys = [
    ['title', '제목'],
    ['subject', '주제'],
    ['author', '작성자'],
    ['creator', '작성자'],
    ['created', '만든 날짜'],
    ['modified', '수정한 날짜'],
  ];

  const seenLabels = new Set();
  for (const [k, label] of optionalKeys) {
    const v = meta[k];
    if (v && typeof v === 'string' && v.trim() && !seenLabels.has(label)) {
      rows.push([label, v.trim()]);
      seenLabels.add(label);
    }
  }

  el.paneInfo.innerHTML = `<div class="info-table">${rows
    .map(
      ([label, value]) =>
        `<div class="info-row"><span class="info-label">${escapeHtml(label)}</span><span class="info-value">${escapeHtml(value)}</span></div>`
    )
    .join('')}</div>`;
}

// ===== 페이지 이동 & 스크롤 동기화 =====
function jumpToPage(pageNum, flash = false) {
  const tab = getActiveTab();
  if (!tab) return;
  const target = Math.min(tab.pageCount, Math.max(1, Math.round(pageNum)));
  const card = el.pagesContainer.children[target - 1];
  if (!card) return;

  renderSinglePage(tab, target - 1, card);
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setCurrentPageUI(tab, target);

  if (flash) {
    card.classList.remove('is-search-flash');
    void card.offsetWidth;
    card.classList.add('is-search-flash');
    setTimeout(() => card.classList.remove('is-search-flash'), 1200);
  }
}

function setCurrentPageUI(tab, pageNum) {
  tab.currentPage = pageNum;
  el.pageInput.value = String(pageNum);
  el.btnPrevPage.disabled = pageNum <= 1;
  el.btnNextPage.disabled = pageNum >= tab.pageCount;

  el.paneThumbs.querySelectorAll('.thumb-item').forEach((item, idx) => {
    item.classList.toggle('is-active', idx + 1 === pageNum);
  });
}

function handleViewportScroll() {
  if (scrollTrackRaf) return;
  scrollTrackRaf = requestAnimationFrame(() => {
    scrollTrackRaf = 0;
    const tab = getActiveTab();
    if (!tab) return;

    const vpRect = el.viewport.getBoundingClientRect();
    const midY = vpRect.top + vpRect.height * 0.35;
    let bestPage = tab.currentPage;
    let bestDist = Infinity;

    const cards = el.pagesContainer.children;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const dist = Math.abs((r.top + r.bottom) / 2 - midY);
      if (dist < bestDist) {
        bestDist = dist;
        bestPage = i + 1;
      }
    }

    if (bestPage !== tab.currentPage) {
      setCurrentPageUI(tab, bestPage);
    }
  });
}

// ===== 본문 검색 =====
function runSearch(query) {
  const tab = getActiveTab();
  if (!tab) return;

  const q = query.trim();
  searchMatches = [];
  activeSearchIdx = -1;

  if (!q) {
    el.searchCount.textContent = '0 / 0';
    el.searchResults.classList.add('hidden');
    el.searchResults.innerHTML = '';
    return;
  }

  // 1) 페이지 텍스트 기반 안정적 매치 수집 (모든 페이지에서 정확한 페이지 번호 + 스니펫 보장)
  const lowerQ = q.toLowerCase();
  const pageTexts = getAllPageTexts(tab);

  for (let p = 0; p < pageTexts.length; p++) {
    const text = pageTexts[p] || '';
    const lowerText = text.toLowerCase();
    let pos = 0;
    while (pos < lowerText.length) {
      const idx = lowerText.indexOf(lowerQ, pos);
      if (idx === -1) break;
      const start = Math.max(0, idx - 24);
      const end = Math.min(text.length, idx + q.length + 34);
      searchMatches.push({
        page: p + 1,
        before: text.slice(start, idx).replace(/[\r\n]+/g, ' '),
        match: text.slice(idx, idx + q.length).replace(/[\r\n]+/g, ' '),
        after: text.slice(idx + q.length, end).replace(/[\r\n]+/g, ' '),
      });
      pos = idx + Math.max(1, q.length);
      if (searchMatches.length >= 200) break;
    }
    if (searchMatches.length >= 200) break;
  }

  // 2) 만약 getPageText에서 못 찾았을 경우 WASM searchAllText 보조 호출
  if (searchMatches.length === 0) {
    try {
      const raw = tab.doc.searchAllText(q, false, true);
      const parsed = safeJsonParse(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed?.matches || parsed?.results || [];
      if (Array.isArray(arr)) {
        for (const m of arr) {
          let pageNum = 1;
          if (Number.isInteger(m.page)) pageNum = m.page + 1;
          else if (Number.isInteger(m.sectionIdx ?? m.sec) && Number.isInteger(m.paraIdx ?? m.para)) {
            try {
              const pos = safeJsonParse(tab.doc.getPageOfPosition(m.sectionIdx ?? m.sec ?? 0, m.paraIdx ?? m.para ?? 0));
              if (pos && Number.isInteger(pos.page)) pageNum = pos.page + 1;
            } catch {
              pageNum = 1;
            }
          }
          searchMatches.push({
            page: pageNum,
            before: '',
            match: m.text || q,
            after: '',
          });
        }
      }
    } catch {
      // ignore
    }
  }

  if (searchMatches.length === 0) {
    el.searchCount.textContent = '0 / 0';
    el.searchResults.innerHTML = '<div class="empty-state" style="padding:14px;">일치하는 검색 결과가 없습니다.</div>';
    el.searchResults.classList.remove('hidden');
    return;
  }

  renderSearchResults();
  selectSearchMatch(0);
}

function renderSearchResults() {
  el.searchResults.innerHTML = '';
  const frag = document.createDocumentFragment();
  searchMatches.forEach((m, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `search-result-item${idx === activeSearchIdx ? ' is-active' : ''}`;
    btn.innerHTML = `
      <span class="search-result-page">${m.page}페이지</span>
      <span class="search-result-snippet">${escapeHtml(m.before)}<mark>${escapeHtml(m.match)}</mark>${escapeHtml(m.after)}</span>
    `;
    btn.addEventListener('click', () => selectSearchMatch(idx));
    frag.appendChild(btn);
  });
  el.searchResults.appendChild(frag);
  el.searchResults.classList.remove('hidden');
}

function selectSearchMatch(idx) {
  if (!searchMatches.length) return;
  activeSearchIdx = ((idx % searchMatches.length) + searchMatches.length) % searchMatches.length;
  el.searchCount.textContent = `${activeSearchIdx + 1} / ${searchMatches.length}`;

  const items = el.searchResults.querySelectorAll('.search-result-item');
  items.forEach((item, i) => {
    item.classList.toggle('is-active', i === activeSearchIdx);
  });
  if (items[activeSearchIdx]) {
    items[activeSearchIdx].scrollIntoView({ block: 'nearest' });
  }

  jumpToPage(searchMatches[activeSearchIdx].page, true);
}

// ===== 텍스트 추출 / 내보내기 / 인쇄 =====
function buildCombinedPlainText(tab) {
  const texts = getAllPageTexts(tab);
  if (texts.length === 1) return texts[0];
  return texts.map((t, i) => `--- ${i + 1}페이지 ---\n${t}`).join('\n\n');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function downloadBlob(data, mime, filename) {
  if (window.AndroidHwpBridge?.saveFile) {
    const bytes =
      data instanceof Uint8Array
        ? data
        : typeof data === 'string'
          ? new TextEncoder().encode(data)
          : new Uint8Array(data);
    const result = window.AndroidHwpBridge.saveFile(filename, mime, bytesToBase64(bytes));
    if (typeof result === 'string' && result.startsWith('error:')) {
      throw new Error(result.slice(6));
    }
    return;
  }

  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportActiveAsHwpx() {
  const tab = getActiveTab();
  if (!tab) return;
  try {
    const hwpxBytes = tab.doc.exportHwpx();
    downloadBlob(hwpxBytes, 'application/vnd.hancom.hwpx', `${stripExt(tab.name)}.hwpx`);
    showToast(`${stripExt(tab.name)}.hwpx 파일로 저장했습니다.`, 'success');
  } catch (err) {
    showToast(`HWPX 변환 저장 실패: ${formatDetectionError(err)}`, 'error');
  }
}

function exportActiveAsTxt() {
  const tab = getActiveTab();
  if (!tab) return;
  const text = buildCombinedPlainText(tab);
  downloadBlob(text, 'text/plain;charset=utf-8', `${stripExt(tab.name)}.txt`);
  showToast(`${stripExt(tab.name)}.txt 파일로 저장했습니다.`, 'success');
}

function ensureAllPagesRendered() {
  const tab = getActiveTab();
  if (!tab) return;
  for (let i = 0; i < tab.pageCount; i++) {
    if (!tab.renderedPages.has(i)) {
      const card = el.pagesContainer.children[i];
      if (card) renderSinglePage(tab, i, card);
    }
  }
}

function printActiveDocument() {
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.pageCount > 20 && tab.renderedPages.size < tab.pageCount) {
    showToast('전체 페이지를 인쇄용으로 준비 중입니다...', 'info', 2500);
  }
  ensureAllPagesRendered();
  setTimeout(() => window.print(), 60);
}

// ===== 이벤트 바인딩 =====
function bindEvents() {
  el.brandHome.addEventListener('click', (e) => {
    e.preventDefault();
    if (tabs.length > 0) {
      el.welcomeScreen.classList.remove('hidden');
      el.readerLayout.classList.add('hidden');
      el.docToolbar.classList.add('hidden');
    }
  });

  // 파일 열기
  const triggerPicker = () => el.fileInput.click();
  el.btnOpenFile.addEventListener('click', triggerPicker);
  el.btnWelcomeFile.addEventListener('click', triggerPicker);
  el.fileInput.addEventListener('change', async () => {
    if (el.fileInput.files?.length) {
      await openFileObjects(el.fileInput.files);
      el.fileInput.value = '';
    }
  });

  // URL 열기 모달
  const openUrlDialog = () => {
    el.urlError.classList.add('hidden');
    openModal('url-modal');
    setTimeout(() => el.urlInput.focus(), 40);
  };
  el.btnOpenUrl.addEventListener('click', openUrlDialog);
  el.btnWelcomeUrl.addEventListener('click', openUrlDialog);

  el.urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = el.urlInput.value.trim();
    if (!raw) return;
    el.urlError.classList.add('hidden');
    el.btnUrlSubmit.disabled = true;
    el.btnUrlSubmit.textContent = '불러오는 중...';
    try {
      await openFromUrl(raw);
      closeModal('url-modal');
      el.urlInput.value = '';
    } catch (err) {
      el.urlError.textContent = formatDetectionError(err);
      el.urlError.classList.remove('hidden');
    } finally {
      el.btnUrlSubmit.disabled = false;
      el.btnUrlSubmit.textContent = '불러오기';
    }
  });

  // 암호 모달
  el.passwordForm.addEventListener('submit', submitPassword);

  // 모달 닫기
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal(backdrop.id);
    });
  });

  // 샘플 체험
  el.btnSampleHwpx.addEventListener('click', () => openSampleDocument('hwpx'));
  el.btnSampleHwp.addEventListener('click', () => openSampleDocument('hwp'));

  // 테마
  el.btnTheme.addEventListener('click', toggleTheme);

  // 사이드바
  el.btnSidebarToggle.addEventListener('click', () => {
    el.sidebar.classList.toggle('is-collapsed');
    const tab = getActiveTab();
    if (tab && tab.zoomMode !== 'manual') {
      setTimeout(() => applyPageCardDimensions(tab), 220);
    }
  });

  el.sidebarTabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.sidebarTab;
      el.sidebarTabs.forEach((b) => {
        const active = b.dataset.sidebarTab === target;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', String(active));
      });
      document.getElementById('pane-thumbs').classList.toggle('is-active', target === 'thumbs');
      document.getElementById('pane-outline').classList.toggle('is-active', target === 'outline');
      document.getElementById('pane-info').classList.toggle('is-active', target === 'info');
    });
  });

  // 페이지 네비게이션
  el.btnPrevPage.addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.currentPage > 1) jumpToPage(tab.currentPage - 1);
  });
  el.btnNextPage.addEventListener('click', () => {
    const tab = getActiveTab();
    if (tab && tab.currentPage < tab.pageCount) jumpToPage(tab.currentPage + 1);
  });
  el.pageInput.addEventListener('change', () => {
    const val = Number(el.pageInput.value);
    if (Number.isFinite(val)) jumpToPage(val);
  });
  el.viewport.addEventListener('scroll', handleViewportScroll, { passive: true });

  // 줌 제어
  el.zoomSelect.addEventListener('change', () => {
    const tab = getActiveTab();
    if (!tab) return;
    const val = el.zoomSelect.value;
    if (val === 'fit-width' || val === 'fit-page') {
      applyZoomMode(tab, val);
    } else {
      applyZoomMode(tab, 'manual', Number(val));
    }
  });

  el.btnZoomIn.addEventListener('click', () => {
    const tab = getActiveTab();
    if (!tab) return;
    const cur = computeZoomFactor(tab);
    const next = ZOOM_STEPS.find((z) => z > cur + 0.03) || Math.min(3, cur + 0.25);
    applyZoomMode(tab, 'manual', next);
  });

  el.btnZoomOut.addEventListener('click', () => {
    const tab = getActiveTab();
    if (!tab) return;
    const cur = computeZoomFactor(tab);
    const next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.03) || Math.max(0.3, cur - 0.25);
    applyZoomMode(tab, 'manual', next);
  });

  window.addEventListener('resize', () => {
    const tab = getActiveTab();
    if (tab && tab.zoomMode !== 'manual') {
      applyPageCardDimensions(tab);
    }
  });

  // 검색 바
  const openSearch = () => {
    if (!getActiveTab()) return;
    el.searchBar.classList.remove('hidden');
    el.searchInput.focus();
    el.searchInput.select();
  };
  el.btnSearchToggle.addEventListener('click', () => {
    if (el.searchBar.classList.contains('hidden')) openSearch();
    else el.searchBar.classList.add('hidden');
  });
  el.btnSearchClose.addEventListener('click', () => el.searchBar.classList.add('hidden'));
  el.searchInput.addEventListener('input', () => runSearch(el.searchInput.value));
  el.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) selectSearchMatch(activeSearchIdx - 1);
      else selectSearchMatch(activeSearchIdx + 1);
    }
  });
  el.btnSearchPrev.addEventListener('click', () => selectSearchMatch(activeSearchIdx - 1));
  el.btnSearchNext.addEventListener('click', () => selectSearchMatch(activeSearchIdx + 1));

  // 텍스트 추출 & 저장
  el.btnExtractText.addEventListener('click', () => {
    const tab = getActiveTab();
    if (!tab) return;
    el.extractedTextarea.value = buildCombinedPlainText(tab) || '(추출된 텍스트가 없습니다.)';
    openModal('text-modal');
  });
  el.btnCopyText.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.extractedTextarea.value);
      showToast('클립보드에 전체 텍스트를 복사했습니다.', 'success');
    } catch {
      el.extractedTextarea.select();
      document.execCommand('copy');
      showToast('텍스트를 복사했습니다.', 'success');
    }
  });
  el.btnDownloadTxt.addEventListener('click', exportActiveAsTxt);
  el.btnSaveTxt.addEventListener('click', exportActiveAsTxt);
  el.btnSaveHwpx.addEventListener('click', exportActiveAsHwpx);

  // 인쇄 / PDF
  el.btnPrint.addEventListener('click', printActiveDocument);
  window.addEventListener('beforeprint', ensureAllPagesRendered);

  // 전역 붙여넣기 (Ctrl+V) — 파일 및 URL 모두 지원
  window.addEventListener('paste', async (e) => {
    if (isEditableFocused()) return;

    const dt = e.clipboardData;
    if (!dt) return;

    const attachedFiles = [];
    if (dt.files && dt.files.length > 0) {
      attachedFiles.push(...dt.files);
    } else if (dt.items && dt.items.length > 0) {
      for (const item of dt.items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) attachedFiles.push(f);
        }
      }
    }

    if (attachedFiles.length > 0) {
      e.preventDefault();
      await openFileObjects(attachedFiles);
      return;
    }

    const text = (dt.getData('text/plain') || '').trim();
    if (/^https?:\/\/\S+/i.test(text)) {
      e.preventDefault();
      try {
        await openFromUrl(text);
      } catch (err) {
        showToast(formatDetectionError(err), 'error', 5200);
      }
      return;
    }

    if (text) {
      showToast('파일 탐색기에서 .hwpx/.hwp 파일을 복사(Ctrl+C)해 붙여넣거나, 파일 URL을 붙여넣어 주세요.', 'info', 4200);
    } else {
      showToast('붙여넣은 클립보드에 파일 데이터가 없습니다. 파일을 끌어다 놓거나 [파일 선택]을 이용해 주세요.', 'info', 4200);
    }
  });

  // 전체 창 드래그 앤 드롭
  window.addEventListener('dragenter', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      dragCounter += 1;
      el.dropOverlay.classList.remove('hidden');
    }
  });
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  });
  window.addEventListener('dragleave', () => {
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      el.dropOverlay.classList.add('hidden');
    }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    el.dropOverlay.classList.add('hidden');
    if (e.dataTransfer?.files?.length) {
      await openFileObjects(e.dataTransfer.files);
    }
  });

  // 단축키
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      triggerPicker();
      return;
    }
    if (mod && e.key.toLowerCase() === 'f') {
      if (getActiveTab()) {
        e.preventDefault();
        openSearch();
      }
      return;
    }
    if (e.key === 'Escape') {
      closeAllModals();
      el.searchBar.classList.add('hidden');
      return;
    }
    if (isEditableFocused()) return;

    const tab = getActiveTab();
    if (!tab) return;

    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      el.btnZoomIn.click();
    } else if (e.key === '-') {
      e.preventDefault();
      el.btnZoomOut.click();
    } else if (e.key === '0') {
      e.preventDefault();
      applyZoomMode(tab, 'manual', 1);
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
      if (tab.currentPage > 1) {
        e.preventDefault();
        jumpToPage(tab.currentPage - 1);
      }
    } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
      if (tab.currentPage < tab.pageCount) {
        e.preventDefault();
        jumpToPage(tab.currentPage + 1);
      }
    }
  });

  // 페이지 종료 시 WASM 문서 메모리 정리
  window.addEventListener('beforeunload', () => {
    for (const tab of tabs) {
      try {
        tab.doc.free();
      } catch {
        // ignore
      }
    }
  });
}

let drainingAndroidFiles = false;
async function consumeAndroidPendingFiles() {
  if (!window.AndroidHwpBridge?.consumePendingFile || drainingAndroidFiles) return;
  drainingAndroidFiles = true;
  try {
    while (true) {
      const raw = window.AndroidHwpBridge.consumePendingFile();
      if (!raw) break;
      const payload = safeJsonParse(raw);
      if (!payload?.base64) continue;
      const bytes = base64ToBytes(payload.base64);
      const name = payload.name || `document.${detectFormatFromMagic(bytes) || 'hwpx'}`;
      await openBytes(name, bytes);
    }
  } catch (err) {
    showToast(`외부 파일을 열지 못했습니다: ${formatDetectionError(err)}`, 'error', 5200);
  } finally {
    drainingAndroidFiles = false;
  }
}

// ===== 초기화 =====
async function bootstrap() {
  initTheme();
  if (window.innerWidth <= 900) {
    el.sidebar.classList.add('is-collapsed');
  }
  if (isNativeApp()) {
    // 안드로이드 파일 선택기에서 .hwpx/.hwp MIME 미등록으로 비활성화되는 문제 방지
    el.fileInput.removeAttribute('accept');
    window.addEventListener('android-hwp-file', () => {
      consumeAndroidPendingFiles();
    });
  }
  bindEvents();
  updateDocControlsState();

  // 페이지 진입과 동시에 WASM 엔진 선로드 시작
  ensureEngineReady().catch(() => {
    // 에러 상태는 엔진 배지에서 안내됨
  });

  if (isNativeApp()) {
    await consumeAndroidPendingFiles();
  }

  // ?url=... 쿼리 파라미터가 있으면 자동 열기
  const paramUrl = new URLSearchParams(window.location.search).get('url');
  if (paramUrl) {
    try {
      await openFromUrl(paramUrl);
    } catch (err) {
      showToast(`URL 문서를 불러오지 못했습니다: ${formatDetectionError(err)}`, 'error', 5200);
    }
  }
}

bootstrap();
