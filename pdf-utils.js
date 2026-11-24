// 순수 JS 기반 오프라인 다중 페이지 PDF 1.4 생성기 (외부 라이브러리 없음)

function concatUint8Arrays(arrays) {
  let total = 0;
  for (const arr of arrays) total += arr.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

export function dataUrlToUint8Array(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * JPEG 이미지 배열을 표준 PDF 1.4 바이트 배열로 조립한다.
 * @param {Array<{jpegBytes: Uint8Array, widthPx: number, heightPx: number, widthPt?: number, heightPt?: number}>} pages
 * @returns {Uint8Array}
 */
export function buildPdfFromJpegs(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('PDF로 저장할 페이지가 없습니다.');
  }

  // Object numbering:
  // 1: Catalog
  // 2: Pages
  // For page i (0..n-1):
  //   pageObjId    = 3 + i * 3
  //   contentObjId = 4 + i * 3
  //   imageObjId   = 5 + i * 3
  const objects = [];
  const pageRefs = [];

  for (let i = 0; i < pages.length; i++) {
    pageRefs.push(`${3 + i * 3} 0 R`);
  }

  objects.push(asciiBytes(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`));
  objects.push(
    asciiBytes(`2 0 obj\n<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>\nendobj\n`)
  );

  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    const pageId = 3 + i * 3;
    const contentId = 4 + i * 3;
    const imageId = 5 + i * 3;

    // 기본 A4 폭(595.28pt) 기준 비율 유지
    const wPt = Number((p.widthPt || 595.28).toFixed(2));
    const hPt = Number((p.heightPt || (wPt * (p.heightPx / p.widthPx))).toFixed(2));

    const contentStream = `q\n${wPt} 0 0 ${hPt} 0 0 cm\n/Im0 Do\nQ\n`;
    const contentBytes = asciiBytes(contentStream);

    objects.push(
      asciiBytes(
        `${pageId} 0 obj\n` +
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wPt} ${hPt}] ` +
          `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>\n` +
          `endobj\n`
      )
    );

    objects.push(
      concatUint8Arrays([
        asciiBytes(`${contentId} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`),
        contentBytes,
        asciiBytes(`\nendstream\nendobj\n`),
      ])
    );

    objects.push(
      concatUint8Arrays([
        asciiBytes(
          `${imageId} 0 obj\n` +
            `<< /Type /XObject /Subtype /Image /Width ${Math.round(p.widthPx)} /Height ${Math.round(p.heightPx)} ` +
            `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpegBytes.length} >>\nstream\n`
        ),
        p.jpegBytes,
        asciiBytes(`\nendstream\nendobj\n`),
      ])
    );
  }

  const header = asciiBytes('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const chunks = [header];
  const offsets = [0];
  let cursor = header.length;

  for (const obj of objects) {
    offsets.push(cursor);
    chunks.push(obj);
    cursor += obj.length;
  }

  const xrefStart = cursor;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`;

  chunks.push(asciiBytes(xref + trailer));
  return concatUint8Arrays(chunks);
}

/**
 * SVG 문자열을 고해상도 캔버스 JPEG 페이지로 변환한다.
 * @param {string} svgString
 * @param {number} targetWidthPx
 * @returns {Promise<{jpegBytes: Uint8Array, widthPx: number, heightPx: number, widthPt: number, heightPt: number}>}
 */
export async function svgStringToJpegPage(svgString, targetWidthPx = 1488) {
  let vbW = 595.28;
  let vbH = 841.89;
  const vbMatch = svgString.match(/viewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)\s*["']/i);
  if (vbMatch) {
    const w = parseFloat(vbMatch[1]);
    const h = parseFloat(vbMatch[2]);
    if (w > 0 && h > 0) {
      vbW = w;
      vbH = h;
    }
  }

  const ratio = vbH / vbW;
  const widthPx = Math.round(targetWidthPx);
  const heightPx = Math.round(widthPx * ratio);

  // xmlns 및 명시적 width/height 보장
  let prepared = svgString;
  if (!/xmlns=/.test(prepared)) {
    prepared = prepared.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  prepared = prepared.replace(/<svg\b([^>]*)>/i, (_, attrs) => {
    const cleaned = attrs
      .replace(/\s+width=["'][^"']*["']/gi, '')
      .replace(/\s+height=["'][^"']*["']/gi, '');
    return `<svg${cleaned} width="${widthPx}" height="${heightPx}">`;
  });

  const blob = new Blob([prepared], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('SVG 이미지 변환 실패'));
      el.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, widthPx, heightPx);
    ctx.drawImage(img, 0, 0, widthPx, heightPx);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const jpegBytes = dataUrlToUint8Array(dataUrl);

    // 가로/세로 방향에 맞춘 A4 포인트 크기
    const isLandscape = vbW > vbH;
    const widthPt = isLandscape ? 841.89 : 595.28;
    const heightPt = widthPt * ratio;

    return { jpegBytes, widthPx, heightPx, widthPt, heightPt };
  } finally {
    URL.revokeObjectURL(url);
  }
}
