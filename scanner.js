// 오프라인 문서 스캔(촬영 · 4모서리 원근 보정 · 기울기 조절 · 필터 · PDF 저장) 모듈
import { buildPdfFromJpegs, dataUrlToUint8Array } from './pdf-utils.js';

const MAX_WORK_DIM = 1800; // 모바일 메모리 안전 및 선명한 A4 스캔 해상도

function solveLinear8(A, b) {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];

    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }
  return M.map((row) => row[n]);
}

/**
 * 출력 직사각형 (0,0)-(W,H) -> 원본 사각형 corners[TL, TR, BR, BL] 역변환 호모그래피 계산
 */
function computeInverseHomography(dstW, dstH, srcPts) {
  const dstPts = [
    { x: 0, y: 0 },
    { x: dstW, y: 0 },
    { x: dstW, y: dstH },
    { x: 0, y: dstH },
  ];
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = dstPts[i];
    const { x: u, y: v } = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear8(A, b);
  return h ? [...h, 1] : null;
}

function getRotatedSourceCanvas(img, rotDeg, fineTiltDeg) {
  const totalRad = ((rotDeg + fineTiltDeg) * Math.PI) / 180;
  const baseScale = Math.min(1, MAX_WORK_DIM / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const sw = Math.max(1, Math.round((img.naturalWidth || img.width) * baseScale));
  const sh = Math.max(1, Math.round((img.naturalHeight || img.height) * baseScale));

  const cos = Math.abs(Math.cos(totalRad));
  const sin = Math.abs(Math.sin(totalRad));
  const cw = Math.max(1, Math.round(sw * cos + sh * sin));
  const ch = Math.max(1, Math.round(sw * sin + sh * cos));

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate(totalRad);
  ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
  return canvas;
}

function applyScanFilter(imageData, filter) {
  if (filter === 'original') return;
  const d = imageData.data;

  if (filter === 'enhance') {
    // 문서 배경을 밝게, 글자 대비를 선명하게 보정
    const contrast = 1.38;
    const brightness = 16;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = Math.min(255, Math.max(0, (d[i] - 128) * contrast + 128 + brightness));
      d[i + 1] = Math.min(255, Math.max(0, (d[i + 1] - 128) * contrast + 128 + brightness));
      d[i + 2] = Math.min(255, Math.max(0, (d[i + 2] - 128) * contrast + 128 + brightness));
    }
  } else if (filter === 'bw') {
    // 깔끔한 흑백 문서 스캔 효과
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      let v = (lum - 135) * 2.4 + 140;
      if (v > 225) v = 255;
      else if (v < 30) v = 0;
      v = Math.min(255, Math.max(0, v));
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
  }
}

function renderWarpedPageCanvas(page, maxOutDim = 1600) {
  const srcCanvas = getRotatedSourceCanvas(page.img, page.rot90, page.tilt);
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;

  const pts = page.corners.map((c) => ({ x: c.x * sw, y: c.y * sh }));
  const topW = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  const botW = Math.hypot(pts[2].x - pts[3].x, pts[2].y - pts[3].y);
  const leftH = Math.hypot(pts[3].x - pts[0].x, pts[3].y - pts[0].y);
  const rightH = Math.hypot(pts[2].x - pts[1].x, pts[2].y - pts[1].y);

  let dstW = Math.max(200, Math.round(Math.max(topW, botW)));
  let dstH = Math.max(200, Math.round(Math.max(leftH, rightH)));

  const scaleDown = Math.min(1, maxOutDim / Math.max(dstW, dstH));
  dstW = Math.max(200, Math.round(dstW * scaleDown));
  dstH = Math.max(200, Math.round(dstH * scaleDown));

  const H = computeInverseHomography(dstW, dstH, pts);
  const outCanvas = document.createElement('canvas');
  outCanvas.width = dstW;
  outCanvas.height = dstH;
  const outCtx = outCanvas.getContext('2d');

  if (!H) {
    outCtx.drawImage(srcCanvas, 0, 0, dstW, dstH);
  } else {
    const srcCtx = srcCanvas.getContext('2d');
    const srcImg = srcCtx.getImageData(0, 0, sw, sh);
    const srcData = srcImg.data;
    const dstImg = outCtx.createImageData(dstW, dstH);
    const dstData = dstImg.data;

    const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = H;

    for (let y = 0; y < dstH; y++) {
      const y1 = h1 * y + h2;
      const y4 = h4 * y + h5;
      const y7 = h7 * y + h8;
      for (let x = 0; x < dstW; x++) {
        const w = h6 * x + y7;
        const u = (h0 * x + y1) / w;
        const v = (h3 * x + y4) / w;
        const dstIdx = (y * dstW + x) * 4;

        const x0 = Math.floor(u);
        const y0 = Math.floor(v);
        if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
          dstData[dstIdx] = 255;
          dstData[dstIdx + 1] = 255;
          dstData[dstIdx + 2] = 255;
          dstData[dstIdx + 3] = 255;
          continue;
        }

        const fx = u - x0;
        const fy = v - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const i00 = (y0 * sw + x0) * 4;
        const i10 = i00 + 4;
        const i01 = i00 + sw * 4;
        const i11 = i01 + 4;

        dstData[dstIdx] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
        dstData[dstIdx + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
        dstData[dstIdx + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
        dstData[dstIdx + 3] = 255;
      }
    }

    applyScanFilter(dstImg, page.filter);
    outCtx.putImageData(dstImg, 0, 0);
  }

  return outCanvas;
}

function defaultCorners() {
  return [
    { x: 0.06, y: 0.06 }, // TL
    { x: 0.94, y: 0.06 }, // TR
    { x: 0.94, y: 0.94 }, // BR
    { x: 0.06, y: 0.94 }, // BL
  ];
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('이미지를 불러올 수 없습니다.'));
    };
    img.src = url;
  });
}

export function initDocumentScanner({ onSavePdf, showToast }) {
  const modal = document.getElementById('scanner-modal');
  const emptyView = document.getElementById('scanner-empty');
  const editorView = document.getElementById('scanner-editor');
  const canvas = document.getElementById('scanner-canvas');
  const ctx = canvas.getContext('2d');
  const cameraInput = document.getElementById('scanner-camera-input');
  const galleryInput = document.getElementById('scanner-gallery-input');

  const btnCamera = document.getElementById('btn-scan-camera');
  const btnGallery = document.getElementById('btn-scan-gallery');
  const btnAddCamera = document.getElementById('btn-scan-add-camera');
  const btnAddGallery = document.getElementById('btn-scan-add-gallery');
  const btnRotateLeft = document.getElementById('btn-scan-rot-left');
  const btnRotateRight = document.getElementById('btn-scan-rot-right');
  const btnResetCorners = document.getElementById('btn-scan-reset');
  const btnPreviewToggle = document.getElementById('btn-scan-preview');
  const btnDeletePage = document.getElementById('btn-scan-delete');
  const btnSavePdf = document.getElementById('btn-scan-save-pdf');

  const tiltRange = document.getElementById('scan-tilt-range');
  const tiltValue = document.getElementById('scan-tilt-value');
  const filterBtns = document.querySelectorAll('[data-scan-filter]');
  const pagesStrip = document.getElementById('scanner-pages-strip');
  const pageBadge = document.getElementById('scanner-page-badge');

  let pages = [];
  let activeIdx = -1;
  let previewMode = false;
  let draggingCorner = -1;
  let cachedSrcCanvas = null;
  let cachedSrcKey = '';

  function getActivePage() {
    return activeIdx >= 0 && activeIdx < pages.length ? pages[activeIdx] : null;
  }

  function updateUIState() {
    const hasPages = pages.length > 0;
    emptyView.classList.toggle('hidden', hasPages);
    editorView.classList.toggle('hidden', !hasPages);
    btnSavePdf.disabled = !hasPages;

    if (!hasPages) {
      pageBadge.textContent = '0장';
      pagesStrip.innerHTML = '';
      return;
    }

    const page = getActivePage();
    pageBadge.textContent = `${activeIdx + 1} / ${pages.length}장`;
    tiltRange.value = String(page.tilt);
    tiltValue.textContent = `${page.tilt > 0 ? '+' : ''}${page.tilt.toFixed(1)}°`;

    filterBtns.forEach((b) => {
      b.classList.toggle('is-active', b.dataset.scanFilter === page.filter);
    });

    btnPreviewToggle.classList.toggle('is-active', previewMode);
    btnPreviewToggle.textContent = previewMode ? '모서리 조절' : '보정 미리보기';

    renderPagesStrip();
    redrawCanvas();
  }

  function renderPagesStrip() {
    pagesStrip.innerHTML = '';
    pages.forEach((p, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `scan-thumb${idx === activeIdx ? ' is-active' : ''}`;
      btn.innerHTML = `<img src="${p.thumbUrl}" alt="${idx + 1}페이지" /><span>${idx + 1}</span>`;
      btn.addEventListener('click', () => {
        activeIdx = idx;
        previewMode = false;
        updateUIState();
      });
      pagesStrip.appendChild(btn);
    });
  }

  function getCachedSource(page) {
    const key = `${page.id}|${page.rot90}|${page.tilt}`;
    if (cachedSrcKey !== key || !cachedSrcCanvas) {
      cachedSrcCanvas = getRotatedSourceCanvas(page.img, page.rot90, page.tilt);
      cachedSrcKey = key;
    }
    return cachedSrcCanvas;
  }

  function redrawCanvas() {
    const page = getActivePage();
    if (!page) return;

    const wrap = canvas.parentElement;
    const availW = Math.max(260, wrap.clientWidth - 16);
    const availH = Math.max(280, wrap.clientHeight - 16);

    if (previewMode) {
      const warped = renderWarpedPageCanvas(page, 1100);
      const scale = Math.min(availW / warped.width, availH / warped.height);
      const dw = Math.max(1, Math.round(warped.width * scale));
      const dh = Math.max(1, Math.round(warped.height * scale));
      canvas.width = dw;
      canvas.height = dh;
      ctx.clearRect(0, 0, dw, dh);
      ctx.drawImage(warped, 0, 0, dw, dh);
      return;
    }

    const src = getCachedSource(page);
    const scale = Math.min(availW / src.width, availH / src.height);
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));

    canvas.width = dw;
    canvas.height = dh;
    ctx.clearRect(0, 0, dw, dh);
    ctx.drawImage(src, 0, 0, dw, dh);

    const pts = page.corners.map((c) => ({ x: c.x * dw, y: c.y * dh }));

    // 선택 영역 바깥 어둡게 처리
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.45)';
    ctx.beginPath();
    ctx.rect(0, 0, dw, dh);
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();

    // 4모서리 테두리선
    ctx.save();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    ctx.lineTo(pts[1].x, pts[1].y);
    ctx.lineTo(pts[2].x, pts[2].y);
    ctx.lineTo(pts[3].x, pts[3].y);
    ctx.closePath();
    ctx.stroke();

    // 모서리 드래그 핸들
    for (let i = 0; i < 4; i++) {
      const active = i === draggingCorner;
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, active ? 14 : 11, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#1d4ed8' : '#2563eb';
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
    ctx.restore();
  }

  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: ((clientX - rect.left) / rect.width) * canvas.width,
      y: ((clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function handlePointerDown(e) {
    if (previewMode) return;
    const page = getActivePage();
    if (!page) return;
    const pos = getCanvasCoords(e);
    let bestIdx = -1;
    let bestDist = 38; // 모바일 손가락 터치 친화적 반경
    page.corners.forEach((c, i) => {
      const d = Math.hypot(c.x * canvas.width - pos.x, c.y * canvas.height - pos.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    if (bestIdx !== -1) {
      e.preventDefault();
      draggingCorner = bestIdx;
      redrawCanvas();
    }
  }

  function handlePointerMove(e) {
    if (draggingCorner === -1 || previewMode) return;
    const page = getActivePage();
    if (!page) return;
    e.preventDefault();
    const pos = getCanvasCoords(e);
    page.corners[draggingCorner] = {
      x: Math.min(0.99, Math.max(0.01, pos.x / canvas.width)),
      y: Math.min(0.99, Math.max(0.01, pos.y / canvas.height)),
    };
    redrawCanvas();
  }

  function handlePointerUp() {
    if (draggingCorner !== -1) {
      draggingCorner = -1;
      redrawCanvas();
    }
  }

  canvas.addEventListener('mousedown', handlePointerDown);
  window.addEventListener('mousemove', handlePointerMove);
  window.addEventListener('mouseup', handlePointerUp);
  canvas.addEventListener('touchstart', handlePointerDown, { passive: false });
  canvas.addEventListener('touchmove', handlePointerMove, { passive: false });
  canvas.addEventListener('touchend', handlePointerUp);
  canvas.addEventListener('touchcancel', handlePointerUp);

  async function addImageFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|heic)$/i.test(f.name));
    if (!files.length) return;

    for (const file of files) {
      try {
        const img = await loadImageFromFile(file);
        const thumbCanvas = document.createElement('canvas');
        const tw = 96;
        const th = Math.round((img.naturalHeight / img.naturalWidth) * tw) || 128;
        thumbCanvas.width = tw;
        thumbCanvas.height = th;
        thumbCanvas.getContext('2d').drawImage(img, 0, 0, tw, th);

        pages.push({
          id: `${Date.now()}-${Math.random()}`,
          img,
          thumbUrl: thumbCanvas.toDataURL('image/jpeg', 0.7),
          rot90: 0,
          tilt: 0,
          filter: 'enhance',
          corners: defaultCorners(),
        });
        activeIdx = pages.length - 1;
        previewMode = false;
      } catch (err) {
        showToast(err.message || '사진을 불러오지 못했습니다.', 'error');
      }
    }
    updateUIState();
  }

  btnCamera.addEventListener('click', () => cameraInput.click());
  btnGallery.addEventListener('click', () => galleryInput.click());
  btnAddCamera.addEventListener('click', () => cameraInput.click());
  btnAddGallery.addEventListener('click', () => galleryInput.click());

  cameraInput.addEventListener('change', async () => {
    if (cameraInput.files?.length) {
      await addImageFiles(cameraInput.files);
      cameraInput.value = '';
    }
  });
  galleryInput.addEventListener('change', async () => {
    if (galleryInput.files?.length) {
      await addImageFiles(galleryInput.files);
      galleryInput.value = '';
    }
  });

  btnRotateLeft.addEventListener('click', () => {
    const page = getActivePage();
    if (!page) return;
    page.rot90 = (page.rot90 - 90 + 360) % 360;
    cachedSrcKey = '';
    redrawCanvas();
  });

  btnRotateRight.addEventListener('click', () => {
    const page = getActivePage();
    if (!page) return;
    page.rot90 = (page.rot90 + 90) % 360;
    cachedSrcKey = '';
    redrawCanvas();
  });

  tiltRange.addEventListener('input', () => {
    const page = getActivePage();
    if (!page) return;
    page.tilt = parseFloat(tiltRange.value) || 0;
    tiltValue.textContent = `${page.tilt > 0 ? '+' : ''}${page.tilt.toFixed(1)}°`;
    cachedSrcKey = '';
    redrawCanvas();
  });

  btnResetCorners.addEventListener('click', () => {
    const page = getActivePage();
    if (!page) return;
    page.corners = defaultCorners();
    page.tilt = 0;
    page.rot90 = 0;
    cachedSrcKey = '';
    previewMode = false;
    updateUIState();
  });

  btnPreviewToggle.addEventListener('click', () => {
    if (!getActivePage()) return;
    previewMode = !previewMode;
    updateUIState();
  });

  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const page = getActivePage();
      if (!page) return;
      page.filter = btn.dataset.scanFilter;
      previewMode = true;
      updateUIState();
    });
  });

  btnDeletePage.addEventListener('click', () => {
    if (activeIdx < 0) return;
    pages.splice(activeIdx, 1);
    activeIdx = Math.min(activeIdx, pages.length - 1);
    previewMode = false;
    cachedSrcKey = '';
    updateUIState();
  });

  btnSavePdf.addEventListener('click', async () => {
    if (!pages.length) return;
    btnSavePdf.disabled = true;
    const originalLabel = btnSavePdf.textContent;
    try {
      const pdfPages = [];
      for (let i = 0; i < pages.length; i++) {
        btnSavePdf.textContent = `PDF 변환 중... (${i + 1}/${pages.length})`;
        await new Promise((r) => setTimeout(r, 15));
        const warped = renderWarpedPageCanvas(pages[i], 1654);
        const dataUrl = warped.toDataURL('image/jpeg', 0.9);
        const jpegBytes = dataUrlToUint8Array(dataUrl);
        const isLandscape = warped.width > warped.height;
        const widthPt = isLandscape ? 841.89 : 595.28;
        const heightPt = widthPt * (warped.height / warped.width);
        pdfPages.push({
          jpegBytes,
          widthPx: warped.width,
          heightPx: warped.height,
          widthPt,
          heightPt,
        });
      }

      const pdfBytes = buildPdfFromJpegs(pdfPages);
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      onSavePdf(pdfBytes, `스캔문서_${stamp}.pdf`);
      modal.classList.add('hidden');
    } catch (err) {
      showToast(`스캔 PDF 저장 실패: ${err.message || err}`, 'error', 4800);
    } finally {
      btnSavePdf.disabled = pages.length === 0;
      btnSavePdf.textContent = originalLabel;
    }
  });

  window.addEventListener('resize', () => {
    if (!modal.classList.contains('hidden') && getActivePage()) {
      redrawCanvas();
    }
  });

  return {
    open() {
      modal.classList.remove('hidden');
      updateUIState();
    },
    close() {
      modal.classList.add('hidden');
    },
  };
}
