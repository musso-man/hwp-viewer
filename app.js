import { buildPdfFromJpegs, svgStringToJpegPage } from './pdf-utils.js';
import { initDocumentScanner } from './scanner.js';

const CDN_BASES = [
  'https://cdn.jsdelivr.net/npm/@rhwp/core@0.9.1',
  'https://unpkg.com/@rhwp/core@0.9.1',
];

const DEFAULT_PAGE_RATIO = 842 / 595; // A4 세로 비율
const BASE_A4_WIDTH_PX = 794; // 96dpi 기준 A4 폭
const ZOOM_STEPS = [0.25, 0.35, 0.5, 0.75, 1, 1.25, 1.5, 2];
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

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
  btnOpenScanner: document.getElementById('btn-open-scanner'),
  btnSearchToggle: document.getElementById('btn-search-toggle'),
  btnSavePdf: document.getElementById('btn-save-pdf'),
  btnTheme: document.getElementById('btn-theme'),
  fileInput: document.getElementById('file-input'),

  tabBar: document.getElementById('tab-bar'),
  docToolbar: document.getElementById('doc-toolbar'),
  btnSidebarToggle: document.getElementById('btn-sidebar-toggle'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
  pageInput: document.getElementById('page-input'),
  pageTotal: document.getElementById('page-total'),
  colBadge: document.getElementById('col-badge'),
  btnZoomOut: document.getElementById('btn-zoom-out'),
  btnZoomIn: document.getElementById('btn-zoom-in'),
  zoomSelect: document.getElementById('zoom-select'),

  searchBar: document.getElementById('search-bar'),
  searchDragHandle: document.getElementById('search-drag-handle'),
  searchInput: document.getElementById('search-input'),
  searchCount: document.getElementById('search-count'),
  btnSearchPrev: document.getElementById('btn-search-prev'),
  btnSearchNext: document.getElementById('btn-search-next'),
  btnSearchClose: document.getElementById('btn-search-close'),
  searchResults: document.getElementById('search-results'),

  welcomeScreen: document.getElementById('welcome-screen'),
  welcomeDropzone: document.getElementById('welcome-dropzone'),
  btnWelcomeScanner: document.getElementById('btn-welcome-scanner'),

  readerLayout: document.getElementById('reader-layout'),
  sidebar: document.getElementById('sidebar'),
  sidebarBody: document.querySelector('.sidebar-body'),
  paneThumbs: document.getElementById('pane-thumbs'),
  viewport: document.getElementById('viewport'),
  pagesContainer: document.getElementById('pages-container'),

  dropOverlay: document.getElementById('drop-overlay'),
  passwordModal: document.getElementById('password-modal'),
  passwordForm: document.getElementById('password-form'),
  passwordFilename: document.getElementById('password-filename'),
  passwordInput: document.getElementById('password-input'),
  passwordError: document.getElementById('password-error'),

  toastContainer: document.getElementById('toast-container'),
};

// ===== 전역 상태 =====
let HwpDocumentClass = null;
let enginePromise = null;
let tabs = [];
let activeTabId = null;
let nextTabSeq = 1;
let pendingEncrypted = null;
let scannerController = null;
let exportingPdf = false;

let pageObserver = null;
let thumbObserver = null;
let scrollTrackRaf = 0;
let searchMatches = [];
let activeSearchIdx = -1;
let activeSearchQuery = '';
let dragCounter = 0;

// ===== 유틸리티 =====
function showToast(message, type = 'info', duration = 3600) {
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

function stripExt(name) {
  return name.replace(/\.(hwpx|hwp|hml)$/i, '');
}

function detectFormatFromMagic(bytes, fileName = '') {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'hwpx';
    }
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
  if (state === 'ready') {
    setTimeout(() => {
      if (el.engineStatus.classList.contains('is-ready')) {
        el.engineStatus.classList.add('hidden');
      }
    }, 1400);
  } else {
    el.engineStatus.classList.remove('hidden');
  }
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
      setEngineStatus('loading', `엔진 준비 중... ${pct}%`);
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
        HwpDocumentClass = await loadEngineFromBase(bases[i]);
        setEngineStatus('ready', '준비 완료');
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
function syncNativeSystemTheme(theme) {
  try {
    window.AndroidHwpBridge?.setSystemTheme?.(theme === 'dark');
  } catch {
    // ignore
  }
}

function initTheme() {
  const saved = localStorage.getItem('hwp-viewer-theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', theme);
  syncNativeSystemTheme(theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('hwp-viewer-theme', next);
  syncNativeSystemTheme(next);
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
}

function closeAllModals() {
  ['password-modal', 'scanner-modal'].forEach(closeModal);
}

// ===== 문서 파싱 & SVG ID 격리 =====
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
  return String(err?.message || err || '알 수 없는 오류');
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
        showToast(`지원하지 않는 파일입니다: ${file.name || '(이름 없음)'}`, 'error');
        continue;
      }
      const name = file.name || `문서.${detectFormatFromMagic(bytes) || 'hwpx'}`;
      await openBytes(name, bytes);
    } catch (err) {
      showToast(`파일을 읽지 못했습니다: ${formatDetectionError(err)}`, 'error');
    }
  }
}

async function openBytes(name, bytes) {
  let HwpDocument;
  try {
    showToast(`${name} 여는 중...`, 'info', 1600);
    HwpDocument = await ensureEngineReady();
  } catch (err) {
    showToast(`엔진을 불러오지 못했습니다: ${formatDetectionError(err)}`, 'error', 5000);
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
    // fallback
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
    zoomMode: window.innerWidth <= 900 ? 'fit-width' : 'manual',
    renderedPages: new Set(),
    renderedThumbs: new Set(),
    pageDims: new Map(),
    pageTexts: new Map(),
    scrollTop: 0,
  };

  tabs.push(tab);
  activateTab(tab.id);
  showToast(`${name} (${pageCount}페이지)`, 'success', 2200);
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

  el.btnSearchToggle.classList.toggle('hidden', !hasDoc);
  el.btnSavePdf.classList.toggle('hidden', !hasDoc);

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
  let customOpt = el.zoomSelect.querySelector('option[data-custom-zoom]');
  if (tab.zoomMode === 'fit-width') {
    if (customOpt) customOpt.remove();
    el.zoomSelect.value = 'fit-width';
  } else if (tab.zoomMode === 'fit-page') {
    if (customOpt) customOpt.remove();
    el.zoomSelect.value = 'fit-page';
  } else {
    const exact = ZOOM_STEPS.find((z) => Math.abs(z - tab.zoom) < 0.01);
    if (exact) {
      if (customOpt) customOpt.remove();
      el.zoomSelect.value = String(exact);
    } else {
      const pct = Math.round(tab.zoom * 100);
      if (!customOpt) {
        customOpt = document.createElement('option');
        customOpt.dataset.customZoom = '1';
        el.zoomSelect.appendChild(customOpt);
      }
      customOpt.value = String(tab.zoom);
      customOpt.textContent = `${pct}%`;
      el.zoomSelect.value = customOpt.value;
    }
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
    return;
  }

  buildDocumentPages(tab);
  buildSidebarThumbs(tab);

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
  const padX = window.innerWidth <= 600 ? 20 : 40;
  if (tab.zoomMode === 'fit-width') {
    const availW = Math.max(240, el.viewport.clientWidth - padX);
    return availW / BASE_A4_WIDTH_PX;
  }
  if (tab.zoomMode === 'fit-page') {
    const availW = Math.max(240, el.viewport.clientWidth - padX);
    const availH = Math.max(280, el.viewport.clientHeight - 40);
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
  let sampleWidth = Math.max(96, Math.round(BASE_A4_WIDTH_PX * factor));

  cards.forEach((card, i) => {
    const idx = Number(card.dataset.pageIndex);
    const dim = tab.pageDims.get(idx) || { baseWidth: BASE_A4_WIDTH_PX, ratio: DEFAULT_PAGE_RATIO };
    const widthPx = Math.max(96, Math.round(dim.baseWidth * factor));
    const heightPx = Math.round(widthPx * dim.ratio);
    card.style.width = `${widthPx}px`;
    card.style.minHeight = `${heightPx}px`;
    if (i === 0) sampleWidth = widthPx;
  });

  // 축소 배율에 따라 한 줄에 2페이지 이상 들어오면 자동으로 다단(2단, 3단 등) 배치
  const padX = window.innerWidth <= 600 ? 20 : 40;
  const availW = Math.max(200, el.viewport.clientWidth - padX);
  const gap = 14;
  const cols = tab.pageCount > 1 ? Math.max(1, Math.floor((availW + gap) / (sampleWidth + gap))) : 1;
  const multiCol = cols >= 2;

  el.pagesContainer.classList.toggle('is-multi-col', multiCol);
  if (multiCol) {
    el.colBadge.textContent = `${cols}단`;
    el.colBadge.classList.remove('hidden');
  } else {
    el.colBadge.classList.add('hidden');
  }
}

function applyZoomMode(tab, mode, numericZoom) {
  tab.zoomMode = mode;
  if (mode === 'manual' && typeof numericZoom === 'number') {
    tab.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numericZoom));
  }
  applyPageCardDimensions(tab);
  syncZoomSelectUI(tab);
}

function bindViewportTouchZoom() {
  let pinch = null;
  let lastTap = null;

  const touchDistance = (t0, t1) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

  const commitZoomAroundPoint = (tab, fromZoom, toZoom, vpX, vpY) => {
    const originX = el.viewport.scrollLeft + vpX;
    const originY = el.viewport.scrollTop + vpY;
    applyZoomMode(tab, 'manual', toZoom);
    const actualZoom = computeZoomFactor(tab);
    const ratio = fromZoom > 0 ? actualZoom / fromZoom : 1;
    el.viewport.scrollLeft = Math.max(0, originX * ratio - vpX);
    el.viewport.scrollTop = Math.max(0, originY * ratio - vpY);
  };

  el.viewport.addEventListener(
    'touchstart',
    (e) => {
      const tab = getActiveTab();
      if (!tab) return;

      if (e.touches.length === 2) {
        lastTap = null;
        const [t0, t1] = e.touches;
        const dist = touchDistance(t0, t1);
        if (dist < 10) return;

        const rect = el.viewport.getBoundingClientRect();
        const midX = (t0.clientX + t1.clientX) / 2 - rect.left;
        const midY = (t0.clientY + t1.clientY) / 2 - rect.top;
        const startZoom = computeZoomFactor(tab);

        pinch = {
          tab,
          startDist: dist,
          startZoom,
          targetZoom: startZoom,
          midX,
          midY,
          originX: el.viewport.scrollLeft + midX,
          originY: el.viewport.scrollTop + midY,
        };
        el.pagesContainer.style.willChange = 'transform';
      } else if (e.touches.length === 1 && !pinch) {
        const t = e.touches[0];
        const now = Date.now();
        if (
          lastTap &&
          now - lastTap.time < 280 &&
          Math.hypot(t.clientX - lastTap.x, t.clientY - lastTap.y) < 28
        ) {
          e.preventDefault();
          const rect = el.viewport.getBoundingClientRect();
          const vpX = t.clientX - rect.left;
          const vpY = t.clientY - rect.top;
          const curZoom = computeZoomFactor(tab);
          const padX = window.innerWidth <= 600 ? 20 : 40;
          const fitW = Math.max(240, el.viewport.clientWidth - padX) / BASE_A4_WIDTH_PX;

          if (curZoom > fitW * 1.15) {
            const originY = el.viewport.scrollTop + vpY;
            applyZoomMode(tab, 'fit-width');
            const nextZoom = computeZoomFactor(tab);
            const ratio = curZoom > 0 ? nextZoom / curZoom : 1;
            el.viewport.scrollLeft = 0;
            el.viewport.scrollTop = Math.max(0, originY * ratio - vpY);
          } else {
            const target = Math.min(MAX_ZOOM, Math.max(1.25, fitW * 2));
            commitZoomAroundPoint(tab, curZoom, target, vpX, vpY);
          }
          lastTap = null;
        } else {
          lastTap = { time: now, x: t.clientX, y: t.clientY };
        }
      }
    },
    { passive: false }
  );

  el.viewport.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();

      const [t0, t1] = e.touches;
      const dist = touchDistance(t0, t1);
      if (dist < 10) return;

      const rawScale = dist / pinch.startDist;
      const targetZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.startZoom * rawScale));
      pinch.targetZoom = targetZoom;

      const visualScale = targetZoom / pinch.startZoom;
      el.pagesContainer.style.transformOrigin = `${pinch.originX}px ${pinch.originY}px`;
      el.pagesContainer.style.transform = `scale(${visualScale})`;
    },
    { passive: false }
  );

  const finishPinch = () => {
    if (!pinch) return;
    const p = pinch;
    pinch = null;

    el.pagesContainer.style.transform = '';
    el.pagesContainer.style.transformOrigin = '0 0';
    el.pagesContainer.style.willChange = '';

    if (Math.abs(p.targetZoom - p.startZoom) > 0.01) {
      commitZoomAroundPoint(p.tab, p.startZoom, p.targetZoom, p.midX, p.midY);
    }
  };

  el.viewport.addEventListener('touchend', (e) => {
    if (pinch && e.touches.length < 2) {
      finishPinch();
    }
  });
  el.viewport.addEventListener('touchcancel', finishPinch);
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
    const widthPx = Math.max(96, Math.round(nat.baseWidth * factor));
    card.style.width = `${widthPx}px`;
    card.style.minHeight = `${Math.round(widthPx * nat.ratio)}px`;
    tab.renderedPages.add(pageIdx);

    if (activeSearchQuery) {
      highlightSearchOnCard(card, pageIdx);
    }
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

  const immediateCount = Math.min(4, tab.pageCount);
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
    item.addEventListener('click', () => {
      jumpToPage(i + 1);
      if (window.innerWidth <= 900) {
        el.sidebar.classList.add('is-collapsed');
      }
    });
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

// ===== 글자 검색 & 붉은색 음영 표시 =====
const SVG_NS = 'http://www.w3.org/2000/svg';

function clearAllSearchHighlights() {
  el.pagesContainer.querySelectorAll('.search-highlight-layer').forEach((g) => g.remove());
}

function getCharBoxInSvg(svgEl, textEl, charIdx, svgInvCtm) {
  try {
    let box;
    if (typeof textEl.getExtentOfChar === 'function') {
      box = textEl.getExtentOfChar(charIdx);
    } else {
      box = textEl.getBBox();
    }
    if (!box || (box.width <= 0 && box.height <= 0)) return null;

    const ctm = textEl.getCTM?.();
    if (ctm && svgInvCtm) {
      const m = svgInvCtm.multiply(ctm);
      const pts = [
        new DOMPoint(box.x, box.y).matrixTransform(m),
        new DOMPoint(box.x + box.width, box.y).matrixTransform(m),
        new DOMPoint(box.x, box.y + box.height).matrixTransform(m),
        new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(m),
      ];
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
    }
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  } catch {
    return null;
  }
}

function mergeLineBoxes(boxes) {
  if (!boxes.length) return [];
  const merged = [];
  for (const b of boxes) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      Math.abs(prev.y - b.y) <= Math.max(prev.height, b.height) * 0.65 &&
      b.x >= prev.x - 4 &&
      b.x <= prev.x + prev.width + Math.max(prev.height, b.height) * 1.4
    ) {
      const x1 = Math.min(prev.x, b.x);
      const y1 = Math.min(prev.y, b.y);
      const x2 = Math.max(prev.x + prev.width, b.x + b.width);
      const y2 = Math.max(prev.y + prev.height, b.y + b.height);
      prev.x = x1;
      prev.y = y1;
      prev.width = x2 - x1;
      prev.height = y2 - y1;
    } else {
      merged.push({ ...b });
    }
  }
  return merged;
}

function highlightSearchOnCard(card, pageIdx, activeOccIdx = -1) {
  const svgEl = card?.querySelector('.page-svg-wrap svg');
  if (!svgEl) return null;

  svgEl.querySelectorAll('.search-highlight-layer').forEach((g) => g.remove());

  const normQuery = activeSearchQuery.replace(/\s+/g, '').toLowerCase();
  if (!normQuery) return null;

  const textEls = svgEl.querySelectorAll('text');
  if (!textEls.length) return null;

  const normChars = [];
  const normMap = [];
  for (const tEl of textEls) {
    const str = tEl.textContent || '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (!/\s/.test(ch)) {
        normChars.push(ch.toLowerCase());
        normMap.push({ el: tEl, charIdx: i });
      }
    }
  }

  const fullNorm = normChars.join('');
  let svgInvCtm = null;
  try {
    const rootCtm = svgEl.getCTM?.();
    if (rootCtm) svgInvCtm = rootCtm.inverse();
  } catch {
    svgInvCtm = null;
  }

  const layer = document.createElementNS(SVG_NS, 'g');
  layer.setAttribute('class', 'search-highlight-layer');

  let pos = 0;
  let occIdx = 0;
  let activeRectEl = null;

  while (pos < fullNorm.length) {
    const idx = fullNorm.indexOf(normQuery, pos);
    if (idx === -1) break;

    const boxes = [];
    for (let k = idx; k < idx + normQuery.length; k++) {
      const ref = normMap[k];
      const box = getCharBoxInSvg(svgEl, ref.el, ref.charIdx, svgInvCtm);
      if (box) boxes.push(box);
    }

    const lineBoxes = mergeLineBoxes(boxes);
    const isActive = occIdx === activeOccIdx;

    for (const lb of lineBoxes) {
      const pad = 1.5;
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(lb.x - pad));
      rect.setAttribute('y', String(lb.y - pad));
      rect.setAttribute('width', String(lb.width + pad * 2));
      rect.setAttribute('height', String(lb.height + pad * 2));
      rect.setAttribute('rx', '2');
      rect.setAttribute('class', isActive ? 'search-hl-rect is-active' : 'search-hl-rect');
      layer.appendChild(rect);
      if (isActive && !activeRectEl) activeRectEl = rect;
    }

    occIdx += 1;
    pos = idx + Math.max(1, normQuery.length);
  }

  if (layer.childNodes.length > 0) {
    svgEl.appendChild(layer);
  }
  return activeRectEl;
}

function getActiveOccurrenceOnPage(targetIdx) {
  const m = searchMatches[targetIdx];
  if (!m) return -1;
  let occ = 0;
  for (let i = 0; i < targetIdx; i++) {
    if (searchMatches[i].page === m.page) occ += 1;
  }
  return occ;
}

function refreshAllSearchHighlights() {
  const tab = getActiveTab();
  if (!tab) return;
  const activeMatch = activeSearchIdx >= 0 ? searchMatches[activeSearchIdx] : null;
  const activePageIdx = activeMatch ? activeMatch.page - 1 : -1;
  const activeOcc = activeMatch ? getActiveOccurrenceOnPage(activeSearchIdx) : -1;

  for (const idx of tab.renderedPages) {
    const card = el.pagesContainer.children[idx];
    if (card) {
      highlightSearchOnCard(card, idx, idx === activePageIdx ? activeOcc : -1);
    }
  }
}

function runSearch(query) {
  const tab = getActiveTab();
  if (!tab) return;

  const q = query.trim();
  activeSearchQuery = q;
  searchMatches = [];
  activeSearchIdx = -1;

  if (!q) {
    clearAllSearchHighlights();
    el.searchCount.textContent = '0 / 0';
    el.searchResults.classList.add('hidden');
    el.searchResults.innerHTML = '';
    return;
  }

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
          searchMatches.push({ page: pageNum, before: '', match: m.text || q, after: '' });
        }
      }
    } catch {
      // ignore
    }
  }

  if (searchMatches.length === 0) {
    clearAllSearchHighlights();
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

  const tab = getActiveTab();
  const targetPage = searchMatches[activeSearchIdx].page;
  const card = el.pagesContainer.children[targetPage - 1];
  if (tab && card) {
    renderSinglePage(tab, targetPage - 1, card);
    refreshAllSearchHighlights();
    const activeRect = highlightSearchOnCard(card, targetPage - 1, getActiveOccurrenceOnPage(activeSearchIdx));
    setCurrentPageUI(tab, targetPage);
    if (activeRect) {
      activeRect.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    } else {
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } else {
    jumpToPage(targetPage, true);
  }
}

function bindDraggableSearchPopup() {
  const handle = el.searchDragHandle;
  const popup = el.searchBar;
  if (!handle || !popup) return;

  let drag = null;

  const startDrag = (clientX, clientY) => {
    const rect = popup.getBoundingClientRect();
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.top}px`;
    popup.style.right = 'auto';
    drag = {
      offsetX: clientX - rect.left,
      offsetY: clientY - rect.top,
      w: rect.width,
      h: rect.height,
    };
  };

  const moveDrag = (clientX, clientY) => {
    if (!drag) return;
    const maxX = Math.max(6, window.innerWidth - drag.w - 6);
    const maxY = Math.max(6, window.innerHeight - Math.min(drag.h, 80) - 6);
    const x = Math.min(maxX, Math.max(6, clientX - drag.offsetX));
    const y = Math.min(maxY, Math.max(6, clientY - drag.offsetY));
    popup.style.left = `${x}px`;
    popup.style.top = `${y}px`;
  };

  const endDrag = () => {
    drag = null;
  };

  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    startDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mousemove', (e) => {
    if (drag) moveDrag(e.clientX, e.clientY);
  });
  window.addEventListener('mouseup', endDrag);

  handle.addEventListener(
    'touchstart',
    (e) => {
      if (e.target.closest('button') || e.touches.length !== 1) return;
      e.preventDefault();
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: false }
  );
  window.addEventListener(
    'touchmove',
    (e) => {
      if (!drag || e.touches.length !== 1) return;
      e.preventDefault();
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: false }
  );
  window.addEventListener('touchend', endDrag);
  window.addEventListener('touchcancel', endDrag);
}

// ===== 파일 다운로드 & 오프라인 PDF 저장 =====
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

async function exportActiveAsPdf() {
  const tab = getActiveTab();
  if (!tab || exportingPdf) return;
  exportingPdf = true;

  const labelEl = el.btnSavePdf.querySelector('span');
  const origLabel = labelEl ? labelEl.textContent : 'PDF';
  el.btnSavePdf.disabled = true;

  try {
    showToast(`PDF 생성 중... (총 ${tab.pageCount}페이지)`, 'info', 2200);
    const pages = [];
    // 페이지 수가 많을 때는 메모리 절약을 위해 해상도를 자동 조절
    const targetW = tab.pageCount > 40 ? 1100 : 1440;

    for (let i = 0; i < tab.pageCount; i++) {
      if (labelEl) labelEl.textContent = `${i + 1}/${tab.pageCount}`;
      await new Promise((r) => setTimeout(r, 0));
      const svg = tab.doc.renderPageSvg(i);
      const pageImg = await svgStringToJpegPage(svg, targetW);
      pages.push(pageImg);
    }

    const pdfBytes = buildPdfFromJpegs(pages);
    const filename = `${stripExt(tab.name)}.pdf`;
    downloadBlob(pdfBytes, 'application/pdf', filename);
    showToast(
      isNativeApp()
        ? `Downloads 폴더에 ${filename} 저장 완료`
        : `${filename} 파일로 저장했습니다.`,
      'success',
      3800
    );
  } catch (err) {
    showToast(`PDF 저장 실패: ${formatDetectionError(err)}`, 'error', 5200);
  } finally {
    exportingPdf = false;
    el.btnSavePdf.disabled = false;
    if (labelEl) labelEl.textContent = origLabel;
  }
}

// ===== 이벤트 바인딩 =====
function bindEvents() {
  el.brandHome.addEventListener('click', (e) => {
    e.preventDefault();
    if (tabs.length > 0) {
      el.welcomeScreen.classList.remove('hidden');
      el.readerLayout.classList.add('hidden');
      el.docToolbar.classList.add('hidden');
      el.searchBar.classList.add('hidden');
    }
  });

  // 문서 열기
  const triggerPicker = () => el.fileInput.click();
  el.btnOpenFile.addEventListener('click', triggerPicker);
  el.welcomeDropzone.addEventListener('click', triggerPicker);
  el.fileInput.addEventListener('change', async () => {
    if (el.fileInput.files?.length) {
      await openFileObjects(el.fileInput.files);
      el.fileInput.value = '';
    }
  });

  // 문서 스캔 열기
  const openScanner = () => scannerController?.open();
  el.btnOpenScanner.addEventListener('click', openScanner);
  el.btnWelcomeScanner.addEventListener('click', openScanner);

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

  // 테마
  el.btnTheme.addEventListener('click', toggleTheme);

  // 사이드바(페이지 목록)
  el.btnSidebarToggle.addEventListener('click', () => {
    el.sidebar.classList.toggle('is-collapsed');
    const tab = getActiveTab();
    if (tab) {
      setTimeout(() => applyPageCardDimensions(tab), 220);
    }
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
  bindViewportTouchZoom();

  // 확대/축소 제어
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
    const next = ZOOM_STEPS.find((z) => z > cur + 0.03) || Math.min(MAX_ZOOM, cur + 0.25);
    applyZoomMode(tab, 'manual', next);
  });

  el.btnZoomOut.addEventListener('click', () => {
    const tab = getActiveTab();
    if (!tab) return;
    const cur = computeZoomFactor(tab);
    const next = [...ZOOM_STEPS].reverse().find((z) => z < cur - 0.03) || Math.max(MIN_ZOOM, cur - 0.1);
    applyZoomMode(tab, 'manual', next);
  });

  window.addEventListener('resize', () => {
    const tab = getActiveTab();
    if (tab) {
      applyPageCardDimensions(tab);
    }
  });

  // 글자 검색
  const closeSearch = () => {
    el.searchBar.classList.add('hidden');
    activeSearchQuery = '';
    clearAllSearchHighlights();
  };
  const openSearch = () => {
    if (!getActiveTab()) return;
    el.searchBar.classList.remove('hidden');
    el.searchInput.focus();
    el.searchInput.select();
    if (el.searchInput.value.trim()) {
      runSearch(el.searchInput.value);
    }
  };
  el.btnSearchToggle.addEventListener('click', () => {
    if (el.searchBar.classList.contains('hidden')) openSearch();
    else closeSearch();
  });
  el.btnSearchClose.addEventListener('click', closeSearch);
  bindDraggableSearchPopup();
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

  // PDF 저장
  el.btnSavePdf.addEventListener('click', exportActiveAsPdf);

  // 전역 붙여넣기 (Ctrl+V) — 파일 붙여넣기
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
      applyZoomMode(tab, 'fit-width');
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

  if (isNativeApp()) {
    el.fileInput.removeAttribute('accept');
    window.addEventListener('android-hwp-file', () => {
      consumeAndroidPendingFiles();
    });
  }

  scannerController = initDocumentScanner({
    showToast,
    onSavePdf(pdfBytes, filename) {
      downloadBlob(pdfBytes, 'application/pdf', filename);
      showToast(
        isNativeApp()
          ? `Downloads 폴더에 ${filename} 저장 완료`
          : `${filename} 파일로 저장했습니다.`,
        'success',
        3800
      );
    },
  });

  bindEvents();
  updateDocControlsState();

  ensureEngineReady().catch(() => {
    // 에러 상태는 엔진 배지에서 안내됨
  });

  if (isNativeApp()) {
    await consumeAndroidPendingFiles();
  }
}

bootstrap();
