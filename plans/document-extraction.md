# Document Extraction — Python → TypeScript Rewrite Plan

## 1. Summary

`read_file` in the Python backend auto-converts structured documents to text so the
agent can inspect a PDF or spreadsheet the same way it reads source code. Built-in
(stdlib, always available): `.ipynb`, `.docx`, `.xlsx`. Optional (lazy-installed
`firecrawl-anydoc`, Rust core, imports as `anydoc`): PDF, legacy Office (`.doc/.ppt/
.xls/.pptx` + variants), OpenDocument (`.odt/.ods/.odp`), `.rtf`, `.epub`. All paths
enforce a 50 MB input cap; PDF text layers are additionally scanned per page so
scanned-image pages trigger a "coverage warning" that guides the agent toward
targeted recovery (`pdftoppm` render + `vision_analyze`, or bulk OCR via the
`ocr-and-documents` skill / marker-pdf).

This plan ports the extraction pipeline into the TypeScript desktop runtime so the
agent's `read_file` works without the Python backend / WebSocket link. The core
design decision: **implement the three built-in formats from scratch in TS**
(zip + XML parsing, mirroring the Python stdlib output exactly — the Python output
format is the parity contract), **use `pdfjs-dist` for the PDF text layer**, and
**keep an optional converter path for legacy Office / ODF / RTF / EPUB** that is
initially satisfied by calling the Python runtime's `anydoc` converter during the
migration window, later by a bundled Rust sidecar or reduced coverage. kimi-code has
**no document-extraction equivalent** (its `Read` tool explicitly refuses these
formats), but it does prove the zip-handling dependency (`yauzl`) we need for OOXML.

## 2. Current Python implementation

Source of truth: `D:/hermes-agent-cn`.

- **`tools/read_extract.py`** (699 lines) — the whole extractor:
  - `EXTRACTABLE_EXTENSIONS = {".ipynb", ".docx", ".xlsx"}`; `ANYDOC_EXTENSIONS`
    covers `.doc .docm .ppt .pps .pot .pptx .pptm .ppsx .ppsm .xls .xlsm .xlsb
    .odt .ods .odp .rtf .epub .pdf` (lines 38–46).
  - Caps: `MAX_XLSX_BYTES = MAX_ANYDOC_BYTES = MAX_DOCUMENT_BYTES = 50 * 1024 * 1024`
    (lines 47–52); `_MAX_XLSX_ROWS_PER_SHEET = 5000`, `_MAX_XLSX_COLS = 256`
    (lines 53–54); `_MAX_OUTPUT_CHARS = 20_000` per notebook output block (line 421).
  - `extract_document_text(path)` / `extract_document_bytes(data, path)` — the bytes
    variant materializes backend-transferred bytes into a host temp file, then calls
    the path variant (lines 124–162). `ExtractionError` on malformed / oversized /
    no-text documents.
  - `.ipynb` (`_extract_notebook`, lines 505–546): orjson parse, nbformat v4 cells
    and legacy v3 `worksheets`; per-cell rendering with `# ── Markdown/Code cell N ──`
    headers and `# ── Output (cell N) ──` blocks; output mime preference
    `text/plain` > `text/markdown` > image-size placeholder > `text/html` size
    placeholder > widget placeholder; ANSI stripping and `\r` progress-bar collapse
    (`_clean_stream_text`); 20k-char tail truncation with a `jq -r` hint naming the
    cell pointer.
  - `.docx` (`_extract_docx`, lines 558–581): zip-open `word/document.xml`, iterate
    `w:p` paragraphs collecting `w:t` text, `w:tab` → `\t`, `w:br`/`w:cr` → `\n`.
  - `.xlsx` (`_extract_xlsx` + helpers, lines 584–699): `xl/sharedStrings.xml`,
    `xl/workbook.xml` sheet list + `state` (hidden/veryHidden sheets skipped),
    `xl/_rels/workbook.xml.rels` target resolution, per-sheet `c r="A1"` column
    indexing, cell types `s` (shared), `inlineStr`, `b`, `e`; rows joined with `\t`,
    sheet headers `# ── Sheet: name ──`, `(empty)` for blank sheets.
  - `anydoc` bridge (`_anydoc`, lines 85–117): lazy `importlib.import_module("anydoc")`
    after `tools.lazy_deps.ensure("tool.doc_extract", prompt=False)`; failed loads
    retried after `ANYDOC_RETRY_SECONDS = 300`; `to_markdown(path)` /
    `to_markdown_bytes(data)` return Markdown; output normalized to trailing `\n`.
  - Scanned-PDF coverage (`_pdf_coverage_note` etc., lines 199–380): shells out to
    poppler `pdftotext path -`, splits on `\f` for per-page char counts
    (`PDF_PAGE_SCAN_TIMEOUT = 20s`); warns when ≥ `PDF_COVERAGE_MIN_EMPTY = 2` empty
    pages and (ratio ≥ 0.2 or absolute ≥ 10); empty pages are grouped into ranges,
    each labeled with the last preceding text snippet (60 chars); the warning is
    **prepended** to the extraction (footer would land on an unread page); recovery
    text names `pdftoppm -jpeg -r 150 -f <first> -l <last> '<path>' /tmp/page` +
    `vision_analyze`, and the `ocr-and-documents` skill (marker-pdf). Skips silently
    when `pdftotext` is not installed.
- **`tools/file_tools.py`** — `read_file_tool` (line 1622) integration:
  - Structured-document branch (lines 1657–1754) runs **before** the binary-extension
    guard; reads bytes via `file_ops.read_file_bytes(path, max_bytes=MAX_DOCUMENT_BYTES)`
    (base64 across the backend boundary), calls `extract_document_bytes`, then returns
    `{content (line-numbered via _add_line_numbers), total_lines, file_size, truncated,
    extracted_document: true, hint}` with normal `offset/limit` pagination and the
    100k-char read budget (`_get_max_read_chars`) with `next_offset`.
  - Error-surfacing policy (lines 1683–1707): `.ipynb` failures fall through to the raw
    text read (JSON is still useful); binary doc formats surface
    `Cannot read '<path>' (<ext>): document extraction failed — <reason>. Use terminal
    utilities...`; converter-missing PDF falls through to the raw read (tests assert
    the raw `%PDF-1.4 fake` bytes come back).
- **`tools/binary_extensions.py`** — `BINARY_EXTENSIONS` lists `.doc .docx .xls .xlsx
  .ppt .pptx .odt .ods .odp` but **deliberately not `.pdf`** ("exclude .pdf — text-based,
  agents may want to inspect"); `has_binary_extension()` is the fallback guard after the
  document branch.
- **`tools/lazy_deps.py`** — `"tool.doc_extract": ("firecrawl-anydoc==0.1.6",)` (line 298);
  the only place `anydoc` is installed, pinned and lazy (comment notes it is not yet a
  pyproject extra).
- **Docs**: `D:/hermes-agent-cn/website/docs/user-guide/features/document-extraction.md`
  — supported-format table, 50 MB cap, the coverage-warning contract and both recovery
  paths. User-facing contract to reproduce in the desktop docs.
- **Tests** (parity source): `D:/hermes-agent-cn/tests/tools/test_read_extract.py`
  (911 lines). Note the inventory in `features_report.md` cites
  `tests/tools/test_document_extraction*.py` and `tests/test_fast_safe_load.py`; the
  former glob does not exist (the real file is `test_read_extract.py`) and
  `test_fast_safe_load.py` is about YAML `fast_safe_load`, unrelated to extraction —
  both citations look stale and should be corrected in the inventory. The real parity
  tests cover: extension detection incl. anydoc-availability gating; fake-binding size
  caps (reject before convert, at-limit converts); anydoc absent → `_extract_anydoc`
  raises "Unsupported document type"; lazy lifecycle (single import, cooldown retry,
  concurrent-first-load); ipynb ordering/placeholders/truncation/v3; docx; xlsx hidden
  sheets + shared strings; `read_file_tool` line-numbered output, corrupt-docx error
  surfacing, oversized anydoc error, converter-missing raw fallback, backend-bytes path;
  coverage-note thresholds, gap labels, gap-map cap, pdftotext form-feed parsing.

## 3. Target TypeScript design

New in-process module tree (no Python, no WS):

```
web/src/lib/document-extract/          # pure TS extraction library
  types.ts                             # ExtractionError, ExtractResult, caps/constants
  detect.ts                            # isExtractableDocument(ext, {anydocAvailable})
  notebook.ts                          # .ipynb renderer (JSON.parse based)
  docx.ts                              # .docx via yauzl + XML walk
  xlsx.ts                              # .xlsx via yauzl + XML walk (shared strings, rels)
  pdf.ts                               # PDF text layer via pdfjs-dist + coverage scan
  anydoc.ts                            # optional converter adapter (see §5)
  index.ts                             # extractDocumentBytes(bytes, path) dispatch
web/src/workers/document-extract.ts    # Web Worker wrapper (extraction off the UI thread)
```

Interfaces (sketch; not implementation):

```ts
class ExtractionError extends Error {}

interface ExtractOptions {
  maxBytes?: number;              // default 50 MiB
  anydoc?: AnyDocConverter;       // optional; undefined => optional formats unsupported
}
interface ExtractResult { text: string; }          // normalized, trailing "\n"

function isExtractableDocument(path: string, anydocAvailable?: boolean): boolean;
function extractDocumentBytes(bytes: Uint8Array, path: string, opts?: ExtractOptions): Promise<ExtractResult>;
```

Data flow inside the agent loop (in-process): `read_file` tool receives `{path, offset,
limit}` → resolves path against workspace (reuse `web/src/lib/...` workspace logic and
Rust containment) → checks size (metadata, then `readFileBytes` cap) → dispatch by
extension → paginate the extracted text with the existing `offset/limit` window → return
the frozen tool-result shape (see §7). The worker keeps zip/XML/PDF parsing off the
renderer main thread; the Rust preview path (§6) can call the same module via IPC when
the preview rail needs the rendered text, or Rust can extract natively using the already
present `zip = "2"` crate for OOXML (decision left open — see §9).

PDF coverage detection in TS needs no poppler: `pdfjs-dist` `getTextContent({page})`
yields per-page char counts directly; the threshold constants, range grouping, gap
labels (last preceding text snippet), and warning text mirror Python
(`PDF_EMPTY_PAGE_CHARS=20`, `MIN_EMPTY=2`, `RATIO=0.2`, `ABSOLUTE_EMPTY=10`,
`GAP_MAP_MAX_ENTRIES=20`, `_GAP_CONTEXT_CHARS=60`).

## 4. Data models & persistence

- **No new persistent schema.** Extracted text is derived data — it must never be stored
  in SQLite/IndexedDB (staleness + privacy: documents may contain sensitive content that
  should not outlive the session). It is recomputed on each `read_file` call, same as
  Python.
- In-memory only:
  - `ExtractResult { text }` inside the worker; pagination state lives in the existing
    per-session read tracker (Desktop mirror of Python's `_read_tracker` dedup — same
    `(path, offset, limit)` + mtime stub semantics, and **extracted documents must be
    deduped exactly like normal reads**).
  - Optional converter availability is cached like Python's `_anydoc_module` +
    `ANYDOC_RETRY_SECONDS` cooldown (`{available: boolean, retryAt: number}`), so a
    failed sidecar/install probe is not retried on every read.
- Chat/session messages keep the existing tool-call records (the `read_file` result
  object already flows through `HermesToolMessagePart.output` in
  `packages/protocol/src/hermes-api.ts`); no schema migration. If the coverage warning
  must be visible in the UI, render it as part of the tool output text (it already is a
  text prefix in Python).

## 5. Third-party library strategy

The most important section. Python dep → TS equivalent, with kimi-code evidence.

| Python (feature) | TS equivalent | Evidence / plan |
|---|---|---|
| stdlib `zipfile` (.docx/.xlsx containers) | **`yauzl`** (npm, already used in kimi-code) or `jszip` | kimi-code `packages/agent-core/package.json` deps: `"yauzl": "^3.3.0"` (line 103), `"tar": "^7.5.13"` (line 100); `packages/agent-core/src/tools/support/rg-locator.ts` and `src/plugin/archive.ts` use `fromBuffer` from `yauzl` with `lazyEntries`. Prefer `yauzl` (proven, streaming, lazy) over `jszip` (not in kimi-code) to match repo precedent. |
| stdlib `xml.etree` (OOXML XML walk) | **`fast-xml-parser`** or **`@xmldom/xmldom`** | Neither in kimi-code; but XML parsing is generic infrastructure, not document-specific. Choose `fast-xml-parser` (no DOM, streaming-friendly, small). If exact namespace-aware iteration over `w:p/w:t` is simpler with a DOM, `@xmldom/xmldom` is the fallback. No kimi-code precedent — flag as new dependency. |
| stdlib `orjson`/`json` (.ipynb) | **none — implement from scratch** | `.ipynb` is plain JSON: `JSON.parse` + a ~150-line renderer reproducing `_extract_notebook` semantics (v3/v4 cells, `_source_text`, mime preference, placeholders, 20k truncation + jq hint). No ipynb TS lib exists in kimi-code or the npm mainstream for this exact "compact text" rendering. |
| stdlib .docx text walk | **implement from scratch** (zip+XML), optional **`mammoth`** | kimi-code has **no** mammoth (`grep` over package.jsons: zero hits). Python's stdlib extractor is deliberately minimal (only `w:t/w:tab/w:br/w:cr` inside `w:p`); a from-scratch yauzl+XML walk reproduces byte-identical output and keeps parity tests simple. `mammoth` would be an optional richer path but its output would diverge from Python — not recommended for the parity contract. |
| stdlib .xlsx extraction | **implement from scratch** (zip+XML), optional **`exceljs`/`xlsx` (SheetJS)** | kimi-code has **no** exceljs/xlsx. The Python behavior (shared strings, rels, hidden-sheet skip, 5000×256 caps, `\t` rows, `# ── Sheet` headers) is the contract; from-scratch is ~200 lines. SheetJS `xlsx` would give richer parsing but different output framing — use only if a later feature needs cell metadata. |
| `firecrawl-anydoc` (PDF, legacy Office, ODF, RTF, EPUB → Markdown) | **no TS equivalent in kimi-code**; plan: (1) during migration keep calling Python runtime's `anydoc` through the same WS/REST interface; (2) standalone: **`pdfjs-dist`** for PDF text layer (not in kimi-code — new dependency; standard Mozilla lib, main thread + worker support); (3) for `.doc/.ppt/.xls/.pptx/ODF/RTF/EPUB` either bundle the anydoc Rust core as a Tauri sidecar binary (same engine Python uses) or mark unsupported in standalone with the binary-guard message + terminal hint. | Verified: kimi-code `packages/agent-core/src/tools/builtin/file/read.ts` refuses these via `detectFileType` (`NON_TEXT_SUFFIXES` in `packages/agent-core/src/tools/support/file-type.ts` lists `.pdf .doc .docx .xls .xlsx .ppt .pptx .rtf .odt .ods .odp`), with output "For other binary formats, use Bash or an MCP tool if available." No `pdf-parse`, `pdfjs-dist`, `mammoth`, `exceljs`, `unzipper`, `officeparser` in any kimi-code package.json (grep-verified). |
| poppler `pdftotext`/`pdftoppm` (coverage scan / render) | **`pdfjs-dist` text extraction** replaces `pdftotext`; recovery render stays **terminal-side** (`pdftoppm` + `vision_analyze`) | The coverage *detection* moves into pdfjs-dist `getTextContent` (per-page char counts, no external binary). The recovery *commands* in the warning text still assume the agent has poppler in its terminal environment — unchanged, and only reachable from the warning text. |
| lazy-deps install machinery (`tools.lazy_deps`) | **optional-converter registry** in TS: `{available, retryAt}` probe + Tauri sidecar discovery; no pip | Desktop never `pip install`s at runtime. Converter availability = sidecar binary present / Python runtime connected. Do not auto-install; surface "install the converter for X format" hint instead. |

**Where no TS lib exists** (the explicit risks): there is no TS equivalent for the
`firecrawl-anydoc` markdown conversion of legacy binary Office / ODF / RTF / EPUB, and
kimi-code proves nothing in that space exists in-repo. The plan therefore splits the
optional tier: PDF gets a real in-process path (`pdfjs-dist`); the rest stay on the
migration-time Python bridge or a future Rust sidecar (§9).

## 6. Integration with existing Hermes-CN-Desktop frontend

Existing pieces to reuse/extend (all verified):

- **Rust preview commands** — `D:/Hermes-CN-Desktop/src/commands/preview.rs`
  (`read_workspace_file`, `read_file_data_url`, `write_workspace_file`,
  `watch_preview_file`, `stop_preview_file_watch`; registered in `src/main.rs` lines
  722–726). `FilePreview` (lines 72–91) currently has `text/data_url/byte_size/binary/
  truncated/lossy_utf8`; `TEXT_PREVIEW_MAX_BYTES = 512 KB` (line 42), binary sniff over
  4096 bytes (line 48). Extend `FilePreview` with
  `{ extractedDocument?: boolean; documentText?: string; extractionWarning?: string }`
  (or a separate `extract_workspace_document` command) so the preview rail can render
  `.docx/.xlsx/.pdf` instead of "二进制文件…暂不支持预览". The 50 MB document cap
  (50 MiB) is **larger** than the 512 KB text cap — extraction reads the file
  independently of the text preview cap and paginates like Python.
- **Bridge + types** — `web/src/lib/runtime.ts` `FilePreview` (lines 249–267) and
  `hermesDesktop` interface (`readWorkspaceFile` line 541);
  `web/src/lib/tauri-bridge.ts` (`readWorkspaceFile` line 681, `watchPreviewFile` line
  722). Mirror the new fields through both layers.
- **Preview rail UI** — `web/src/components/chat/preview-rail/file-preview-tab.tsx`
  (`FileContent` renders dataUrl image / binary notice / markdown / `<pre>`; live
  fs-watch with 200 ms debounce) and `web/src/lib/preview-rail.ts` (`canEditPreview`
  must **block editing extracted documents**: `extractedDocument` implies
  `!canEditPreview`, mirroring how `lossyUtf8` blocks write-back; `formatBytes`,
  `fileExtension`, `isMarkdownPath` are reusable). New render branch: extracted text in
  `<pre>` (or markdown when the source is Markdown-ish), plus the coverage warning
  shown as a styled banner.
- **Tool layer (agent runtime)** — the in-process `read_file` tool implementation will
  call the `document-extract` module directly; the WS/REST bridge
  (`web/src/lib/transport.ts`, `gateway-client.ts`) is the fallback during migration
  (§7). Dedup/tracker and redaction behavior should be ported alongside (Python:
  `file_tools.py` `_read_tracker`, `redact_sensitive_text`).
- **Rust deps** — `Cargo.toml` already has `zip = "2"` (line 34) and no PDF/docx crate.
  If the Rust-native OOXML path is chosen over the TS worker, only `zip` (present) plus
  an XML crate (`quick-xml` or `roxmltree`) need adding; PDF in Rust would need
  `pdf-extract`/`lopdf` (new, unproven in repo).

## 7. Removing the WebSocket dependency (migration path)

Freeze this interface now (it is the parity contract):

```ts
interface ReadFileResult {
  content: string;            // line-numbered page text (gutter format)
  total_lines: number;
  file_size: number;
  truncated: boolean;
  extracted_document: boolean; // NEW for extracted reads (Python already returns it)
  hint?: string;              // continuation hint
  next_offset?: number;       // char-budget truncation
  error?: string;             // error path (e.g. "document extraction failed — …")
}
```

Phases:
1. **Keep backend call today.** `read_file` still goes through WS JSON-RPC; the desktop
   only *displays* the result (preview rail already consumes Python-side extractions
   through the API). Freeze and document the result shape above.
2. **In-process module behind the same interface.** Implement `web/src/lib/document-extract`
   + worker; register it as the `read_file` implementation when the session is local;
   return the exact same `ReadFileResult` shape. The WS path stays as a fallback for
   optional-anydoc formats until the converter story lands. Rust preview command can
   switch to the TS module or its own Rust extractor; the renderer cannot tell the
   difference.
3. **Delete WS/REST path.** Once standalone coverage matches (PDF via pdfjs-dist; legacy
   Office/ODF/RTF/EPUB via sidecar or explicit "unsupported + terminal hint"), remove
   the `read_file` WS/REST branch and the `extracted_document`-related Python calls from
   the desktop transport. The `FilePreview.extractedDocument` fields are the UI-facing
   equivalent of the frozen `ReadFileResult` and should not change after phase 2.

## 8. Migration phases & task breakdown

- **P0 — parity foundation**
  - Port constants/caps (`MAX_DOCUMENT_BYTES=50MiB`, XLSX 5000×256, `_MAX_OUTPUT_CHARS=20k`,
    PDF thresholds) into `document-extract/types.ts`; add `ExtractionError`.
  - Implement `detect.ts` (`EXTRACTABLE_EXTENSIONS`, `ANYDOC_EXTENSIONS`,
    `isExtractableDocument(ext, anydocAvailable)`); port `binary_extensions.ts` behavior
    to TS (`hasBinaryExtension`, `.pdf` excluded).
  - Implement `.ipynb` renderer (v3/v4, placeholders, ANSI strip, CR collapse, 20k
    truncation + jq hint) — highest-value, zero deps.
- **P1 — OOXML built-ins (from scratch, exact parity)**
  - Implement `docx.ts` (yauzl + fast-xml-parser, `w:t/w:tab/w:br/w:cr` walk).
  - Implement `xlsx.ts` (shared strings, workbook rels, hidden-sheet skip, `\t` rows,
    `# ── Sheet` headers, caps).
  - Wire `index.ts` + Web Worker; port `read_file_tool` pagination/gutter/char-budget/
    dedup into the in-process `read_file` tool.
- **P2 — PDF (in-process)**
  - Add `pdfjs-dist` (new dep; document in §5 risk table); implement `pdf.ts` text-layer
    extraction + per-page counts + coverage warning (no poppler).
  - Reproduce the exact warning format incl. gap labels and recovery commands.
- **P3 — optional converter tier**
  - Implement `anydoc.ts` adapter: (a) migration-time bridge to Python runtime via the
    existing WS/REST API; (b) sidecar discovery hook for a future bundled Rust core;
    probe with `{available, retryAt}` cooldown.
  - Decide standalone behavior for legacy Office/ODF/RTF/EPUB: sidecar or "unsupported"
    message with terminal hint (Python parity: converter-missing PDF falls back to raw
    read; other formats hit the binary guard).
- **P4 — UI + docs**
  - Extend Rust `FilePreview` + `runtime.ts` + `tauri-bridge.ts` with
    `extractedDocument` fields; render extracted text and the coverage-warning banner in
    `file-preview-tab.tsx`; make `canEditPreview` reject extracted docs.
  - Port the user-guide page content into the desktop docs and update
    `features_report.md`'s stale test citations (`test_document_extraction*.py` →
    `tests/tools/test_read_extract.py`; drop/relabel `test_fast_safe_load.py`).

## 9. Risks & open questions

- **No TS equivalent for anydoc (biggest risk).** Legacy Office (`.doc/.ppt/.xls/...`),
  ODF, RTF, EPUB → Markdown has no kimi-code precedent and no obvious drop-in npm lib
  matching Python output. Open: bundle the `firecrawl-anydoc` Rust core as a Tauri
  sidecar (same engine, best parity; build/release burden + platform matrix), or keep a
  Python-runtime bridge for these formats while standalone PDF works, or ship reduced
  coverage with an explicit "use terminal to convert" message.
- **New npm deps unproven in kimi-code**: `pdfjs-dist` (PDF text), `fast-xml-parser`
  (XML). Both are mainstream, but they are additions the repo has no precedent for —
  vet bundle size, worker compatibility, and licensing before phase P2.
- **Parity risk on from-scratch OOXML.** The Python output (headers, `\t` joins, `(empty)`,
  hidden-sheet skip, line-number gutter, error strings) must be byte-stable for the
  parity test suite. Small divergences (whitespace, empty-row trimming) will fail tests —
  plan a fixture-based golden diff harness instead of hand-assertions.
- **50 MB cap vs preview caps.** Desktop preview currently caps text at 512 KB; the
  document extraction cap is 50 MB and paginates. The preview rail must not silently
  conflate the two (an extracted 40 MB xlsx should preview the first page and offer
  continuation, not "truncated binary").
- **Scanned-PDF recovery depends on poppler in the agent's terminal.** Detection moves
  to pdfjs-dist, but the *recovery commands* still invoke `pdftoppm`; on Windows the
  user may not have poppler — keep the warning's fallback wording (vision_analyze can
  also read a rendered page only if the renderer exists; otherwise recommend OCR skill).
- **Redaction.** Python applies `redact_sensitive_text` to extracted content; the TS
  `read_file` must apply the equivalent redactor to document text too (do not regress
  prompt-injection/secret protection).
- Open questions: Rust-native OOXML (via existing `zip` crate) vs TS worker? Where does
  the PDF coverage scan run (worker)? Should `extractedDocument` be a new preview field
  or a separate Tauri command? Are `.xlsb`/`.docm` (binary OOXML) worth sidecar-only?

## 10. Test strategy

- **Vitest unit parity** — port `tests/tools/test_read_extract.py` fixtures verbatim:
  minimal `_write_notebook`, `_write_docx`, `_write_xlsx` builders; assert:
  - `isExtractableDocument` extension gating incl. anydoc-availability.
  - ipynb: order preservation, stream/error output, image placeholder ("[image/png
    output — 3 KB, omitted]"), `text/plain` over HTML, CR progress collapse, widget
    placeholder, 20k truncation + jq hint, v3 `worksheets`/`pyout`.
  - docx: paragraph/run concat, missing `word/document.xml` → ExtractionError.
  - xlsx: shared strings, `Name\tScore` rows, hidden-sheet omission, non-zip → error,
    5000-row/256-col caps.
  - size caps: over-limit rejected before converter call; at-limit converts.
  - PDF coverage: thresholds (ratio/absolute), gap labels ("pages 4-9 (6 pages) — after
    \"…\" (p3)"), gap-map cap (20 + summary line), silent on full-text/single-blank,
    warning **prepended** for `.pdf` only.
- **Integration tests** — in-process `read_file` returns the frozen `ReadFileResult`
  (line gutter, `extracted_document: true`, `total_lines`, `hint`); corrupt `.docx`
  surfaces "document extraction failed"; converter-missing `.pdf` falls back to raw read;
  backend-bytes path (bytes → temp → extract) for remote sessions.
- **Rust tests** — extend `src/commands/preview.rs` unit tests for the new
  `extractedDocument` fields: `.docx` preview returns text + `binary: false` +
  `extractedDocument: true`; oversize returns the 50 MB error; spot-editor save is
  rejected for extracted docs.
- **Playwright E2E** — preview rail: select `report.docx`/`sheet.xlsx`/`scan.pdf` in the
  file browser, assert extracted text renders, binary notice is gone, coverage-warning
  banner appears for the scanned PDF, and editing is disabled for extracted docs.
- **Parity harness** — golden outputs captured from the Python extractor
  (`tests/tools/test_read_extract.py`-style fixtures run against
  `D:/hermes-agent-cn/tools/read_extract.py`) diffed against the TS module in CI.

## 11. Reference links

- Python impl: `D:/hermes-agent-cn/tools/read_extract.py`,
  `D:/hermes-agent-cn/tools/file_tools.py` (read_file_tool, lines 1622–1754),
  `D:/hermes-agent-cn/tools/binary_extensions.py`,
  `D:/hermes-agent-cn/tools/lazy_deps.py` (line 298).
- Python docs: `D:/hermes-agent-cn/website/docs/user-guide/features/document-extraction.md`.
- Python tests: `D:/hermes-agent-cn/tests/tools/test_read_extract.py` (911 lines;
  note the stale `features_report.md` citation).
- Feature inventory: `D:/hermes-agent-cn/features_report.md` (Document extraction row).
- kimi-code TS reference (negative evidence + zip precedent):
  - `D:/kimi-code/packages/agent-core/src/tools/builtin/file/read.ts` (refuses non-text)
  - `D:/kimi-code/packages/agent-core/src/tools/builtin/file/read-media.ts` (media only)
  - `D:/kimi-code/packages/agent-core/src/tools/support/file-type.ts` (`NON_TEXT_SUFFIXES`)
  - `D:/kimi-code/packages/agent-core/src/tools/support/rg-locator.ts` + `src/plugin/archive.ts` (yauzl zip reading)
  - `D:/kimi-code/packages/agent-core/package.json` (`yauzl ^3.3.0`, `tar ^7.5.13`)
- Desktop integration:
  - `D:/Hermes-CN-Desktop/src/commands/preview.rs` (FilePreview, read_workspace_file; registered `src/main.rs:722-726`)
  - `D:/Hermes-CN-Desktop/web/src/lib/runtime.ts` (FilePreview lines 249–267)
  - `D:/Hermes-CN-Desktop/web/src/lib/tauri-bridge.ts` (readWorkspaceFile line 681)
  - `D:/Hermes-CN-Desktop/web/src/components/chat/preview-rail/file-preview-tab.tsx`
  - `D:/Hermes-CN-Desktop/web/src/lib/preview-rail.ts` (canEditPreview)
  - `D:/Hermes-CN-Desktop/Cargo.toml` (`zip = "2"` line 34)
- Plan conventions: `D:/Hermes-CN-Desktop/plans/README.md`,
  `D:/Hermes-CN-Desktop/plans/_PROMPT_TEMPLATE.md`.
