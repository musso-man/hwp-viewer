# 한글 뷰어 (HWPX · HWP Web Viewer)

별도의 프로그램 설치나 서버 업로드 없이 웹 브라우저에서 **`.hwpx`**, **`.hwp` (HWP 5.0 / 3.0)**, **`.hml`** 문서를 바로 읽을 수 있는 100% 클라이언트 사이드 한글 문서 뷰어입니다.

> **100% Client-Side Hangul Document Viewer** — Paste (`Ctrl+V`), drag & drop, pick local files, or open GitHub/web `.hwpx` and `.hwp` URLs directly in your browser using WebAssembly (`@rhwp/core`), with zero server uploads.

## 주요 기능

- **간편한 붙여넣기(`Ctrl+V`) & 드래그 앤 드롭**
  - Windows 탐색기 / macOS Finder에서 한글 파일을 복사(`Ctrl+C`)한 뒤 화면 어디서나 `Ctrl+V`로 즉시 열기
  - GitHub 파일 URL(`github.com/.../blob/...`) 또는 직접 파일 URL을 `Ctrl+V`로 붙여넣어 바로 열기 (`raw.githubusercontent.com` 자동 변환)
  - 여러 파일을 한 번에 드래그 앤 드롭하여 다중 탭으로 비교·열람
- **폭넓은 포맷 및 요소 지원**
  - `.hwpx` (OWPML), `.hwp` (HWP 5.0 / 압축 HWP3), `.hml` (HWPML) 지원
  - **암호로 잠긴 문서** 비밀번호 입력 열기 지원
  - 문단, 표(셀 병합/중첩 표), 이미지, 수식, 머리말/꼬리말, 다단, 각주/미주 벡터 SVG 렌더링
- **편의 기능**
  - 좌측 사이드바: 페이지 미리보기 썸네일, 개요 목차 탐색, 문서 정보 확인
  - 본문 및 표 내부 텍스트 검색 (`Ctrl+F`)
  - 전체 텍스트 추출·클립보드 복사 및 `.txt` / `.hwpx` 파일 저장
  - 인쇄 및 브라우저 PDF 저장 (`Ctrl+P`)
  - 확대/축소(`50%`~`200%`, `폭 맞춤`, `쪽 맞춤`) 및 라이트/다크 테마 전환
- **완벽한 보안과 개인정보 보호**
  - 모든 파일 파싱과 렌더링은 브라우저 내부(WebAssembly)에서만 실행되며 외부 서버로 전송되지 않습니다.

## 사용 방법

1. **파일 붙여넣기**: 탐색기에서 `.hwpx` / `.hwp` 파일을 선택해 `Ctrl+C`로 복사한 뒤, 뷰어 화면에서 `Ctrl+V`를 누릅니다.
2. **링크로 바로 열기**: 뷰어 주소 뒤에 `?url=` 파라미터를 붙여 문서를 바로 공유할 수 있습니다.
   ```text
   https://<username>.github.io/hwp-viewer/?url=https://github.com/owner/repo/blob/main/sample.hwpx
   ```
   *(브라우저 보안 정책상 CORS를 허용하는 공개 URL만 직접 불러올 수 있습니다.)*

### 단축키

| 단축키 | 동작 |
| :--- | :--- |
| `Ctrl+V` / `Cmd+V` | 복사한 한글 파일 또는 파일 URL 바로 열기 |
| `Ctrl+O` / `Cmd+O` | 파일 선택 창 열기 |
| `Ctrl+F` / `Cmd+F` | 본문 및 표 내용 검색 |
| `+` / `-` / `0` | 확대 / 축소 / 100% 초기화 |
| `←` / `→` / `PageUp` / `PageDown` | 이전 / 다음 페이지 이동 |
| `Esc` | 검색 바 및 열린 모달 닫기 |

## 기술 스택 및 구성

- **빌드 없는 정적 웹 앱**: `index.html`, `style.css`, `app.js`로 구성되어 GitHub Pages 등에서 별도 빌드 과정 없이 바로 호스팅됩니다.
- **렌더링 엔진**: [`@rhwp/core`](https://www.npmjs.com/package/@rhwp/core) (Rust + WebAssembly 기반 HWP/HWPX 파서 및 SVG 렌더러)
- **폰트 폴백**: Pretendard, Noto Sans KR, Noto Serif KR, 나눔고딕, 나눔명조 웹폰트를 로드해 원본과 유사한 줄바꿈과 가독성을 제공합니다.

## 라이선스 및 고지

- 본 프로젝트는 **MIT License**를 따릅니다.
- 문서 파싱·렌더링에 사용된 오픈소스 엔진 [`@rhwp/core`](https://github.com/edwardkim/rhwp) (MIT License)는 한글과컴퓨터의 한/글 문서 파일(`.hwp`) 공개 문서를 참고하여 개발되었습니다.
- "한글", "한컴", "HWP", "HWPX"는 주식회사 한글과컴퓨터의 등록 상표이며, 본 프로젝트는 주식회사 한글과컴퓨터와 제휴, 후원, 승인 관계가 없는 독립적인 오픈소스 웹 뷰어입니다.
