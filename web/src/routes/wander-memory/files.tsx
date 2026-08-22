// ─────────────────────────────────────────────────────────────────────────────
// routes/wander-memory/files.tsx — #/wander-memory/files: file-system explorer
// + custom ingest editor. Ported from WanderMemory
// `web/app/src/views/FilesView.tsx` onto the MemOsFileSystemClient
// (mem_filesys service, default http://127.0.0.1:18402).
//
// The FS client is NOT exposed by the lib singleton accessors — it is
// constructed here from resolveEndpoints().fsOrigin (env → ui-store → defaults;
// the client is re-created when the status view rediscovery swaps endpoints).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, EmptyState, Input, LoadingState, Textarea } from "@hermes/shared-ui";
import { CollisionLine } from "@/components/wander-memory/collision-line";
import { MemoryCard } from "@/components/wander-memory/memory-card";
import {
  WanderMemoryLayout,
  WanderMemorySection,
} from "@/components/wander-memory/layout";
import {
  WanderMemoryToastProvider,
  useWanderMemoryToast,
} from "@/components/wander-memory/toast";
import { getWanderMemoryClient, toApiError } from "@/lib/wander-memory";
import type { ApiError } from "@/lib/wander-memory";
import { resolveEndpoints } from "@/lib/wander-memory/endpoints";
import { MemOsFileSystemClient } from "@/lib/wander-memory/fs-client";
import type { ScannedFile, UpdateIngestResponse } from "@/lib/wander-memory/types";
import type { CollisionSummary, MemoryItem } from "@/lib/wander-memory";
import s from "./files.module.css";

function formatBytes(n: number): string {
  return `${n.toLocaleString()} bytes`;
}

function fileHasMemory(file: ScannedFile, memories: MemoryItem[]): boolean {
  return memories.some((m) => m.metadata.path === file.rel_path);
}

interface FsHealth {
  status: string;
  service?: string;
}

function FilesPage() {
  const toast = useWanderMemoryToast();

  const fsClient = useMemo(() => new MemOsFileSystemClient(resolveEndpoints().fsOrigin), []);

  const [directory, setDirectory] = useState("");
  const [root, setRoot] = useState("");
  const [files, setFiles] = useState<ScannedFile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<ApiError | null>(null);

  const [selected, setSelected] = useState<ScannedFile | null>(null);

  const [allMemories, setAllMemories] = useState<MemoryItem[] | null>(null);
  const [loadingMemories, setLoadingMemories] = useState(false);
  const [memoriesError, setMemoriesError] = useState<ApiError | null>(null);

  const [customText, setCustomText] = useState("");
  const [storing, setStoring] = useState(false);
  const [storeCollision, setStoreCollision] = useState<CollisionSummary | null>(null);
  const [storeError, setStoreError] = useState<ApiError | null>(null);

  const [fsHealth, setFsHealth] = useState<FsHealth | null>(null);
  const [fsHealthError, setFsHealthError] = useState<ApiError | null>(null);

  const loadMemories = useCallback(async () => {
    setLoadingMemories(true);
    setMemoriesError(null);
    try {
      const res = await getWanderMemoryClient().list();
      setAllMemories(res.results);
    } catch (err) {
      setMemoriesError(toApiError(err));
    } finally {
      setLoadingMemories(false);
    }
  }, []);

  const doScan = useCallback(async () => {
    const dir = directory.trim();
    if (!dir) return;
    setScanning(true);
    setScanError(null);
    setSelected(null);
    setAllMemories(null);
    setCustomText("");
    setStoreCollision(null);
    setStoreError(null);
    try {
      const res = await fsClient.scan(dir);
      setRoot(res.root);
      setFiles(res.files);
      void loadMemories();
    } catch (err) {
      setScanError(toApiError(err));
    } finally {
      setScanning(false);
    }
  }, [directory, fsClient, loadMemories]);

  const doReload = useCallback(async () => {
    if (!root) return;
    setDirectory(root);
    setScanning(true);
    setScanError(null);
    setAllMemories(null);
    setCustomText("");
    setStoreCollision(null);
    setStoreError(null);
    try {
      const res = await fsClient.scan(root);
      setRoot(res.root);
      setFiles(res.files);
      void loadMemories();
    } catch (err) {
      setScanError(toApiError(err));
    } finally {
      setScanning(false);
    }
  }, [root, fsClient, loadMemories]);

  // FS API health — probed once on mount (status line only).
  useEffect(() => {
    let alive = true;
    fsClient
      .health()
      .then((h) => {
        if (alive) setFsHealth(h);
      })
      .catch((err) => {
        if (alive) setFsHealthError(toApiError(err));
      });
    return () => {
      alive = false;
    };
  }, [fsClient]);

  // Reset per-file editor state when the selection changes.
  useEffect(() => {
    setCustomText("");
    setStoreCollision(null);
    setStoreError(null);
  }, [selected]);

  const fileMemories = useMemo(() => {
    if (!selected || !allMemories) return [];
    return allMemories.filter((m) => m.metadata.path === selected.rel_path);
  }, [selected, allMemories]);

  const selectedHasMemories = useMemo(() => {
    if (!selected || !allMemories) return false;
    return fileHasMemory(selected, allMemories);
  }, [selected, allMemories]);

  const doStore = async () => {
    if (!selected || !root) return;
    const text = customText.trim();
    if (!text) return;
    setStoring(true);
    setStoreError(null);
    setStoreCollision(null);
    try {
      const res: UpdateIngestResponse = await fsClient.updateIngest(root, selected.rel_path, text);
      toast.push("success", `已存储 ${selected.rel_path} 的 ingest`);
      setStoreCollision(res.collision);
      setAllMemories((prev) => (prev ? [res.memory, ...prev] : [res.memory]));
      setCustomText("");
    } catch (err) {
      setStoreError(toApiError(err));
    } finally {
      setStoring(false);
    }
  };

  const modeBadge =
    fsClient.mode === "live" ? (
      <Badge tone="success" variant="outline" size="sm">
        live
      </Badge>
    ) : (
      <Badge tone="warning" variant="outline" size="sm">
        demo
      </Badge>
    );

  const healthBadge =
    fsHealthError !== null ? (
      <Badge tone="danger" variant="outline" size="sm" title={fsHealthError.message}>
        fs api: unreachable
      </Badge>
    ) : fsHealth === null ? (
      <Badge tone="neutral" variant="outline" size="sm">
        fs api: probing…
      </Badge>
    ) : (
      <Badge tone="success" variant="outline" size="sm">
        fs api: {fsHealth.status}
      </Badge>
    );

  return (
    <div className={s.page}>
      <div className={s.headRow}>
        <span className={s.title}>file explorer</span>
        {modeBadge}
        {healthBadge}
      </div>

      <div className={s.scanArea}>
        <div className={s.scanRow}>
          <Input
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void doScan();
            }}
            placeholder="directory path…"
            mono
            className={s.scanInput}
          />
          <Button
            type="button"
            variant="outline"
            tone="accent"
            onClick={() => void doScan()}
            loading={scanning}
            disabled={!directory.trim()}
          >
            {scanning ? "…" : "open"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => void doReload()}
            disabled={scanning || !root}
          >
            reload
          </Button>
        </div>
        {scanError ? (
          <Alert tone="danger" size="sm">
            {scanError.code}: {scanError.message}
          </Alert>
        ) : null}
      </div>

      <div className={s.fileGrid}>
        {/* ── left: file list ── */}
        <section className={s.panel}>
          {files.length === 0 ? (
            <p className={s.panelEmpty}>
              {root ? "no files found" : "open a directory to browse files"}
            </p>
          ) : (
            <div className={s.fileList}>
              {files.map((file) => {
                const active = selected?.rel_path === file.rel_path;
                const hasMemory = allMemories ? fileHasMemory(file, allMemories) : false;
                return (
                  <button
                    key={file.rel_path}
                    type="button"
                    onClick={() => setSelected(file)}
                    className={s.fileRow}
                    data-active={active ? "true" : undefined}
                  >
                    <div className={s.fileRowHead}>
                      <span className={s.filePath} title={file.rel_path}>
                        {file.rel_path}
                      </span>
                      {hasMemory ? (
                        <span className={s.ingestDot} title="has ingested memories" />
                      ) : null}
                    </div>
                    <div className={s.fileRowMeta}>
                      <span className={s.fileCategory}>{file.category}</span>
                      <span className={s.fileSize}>{formatBytes(file.size)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* ── right: file detail / ingest editor ── */}
        <section className={s.panel}>
          {!selected ? (
            <p className={s.panelEmpty}>select a file to view details and ingest</p>
          ) : (
            <div className={s.detail}>
              <div>
                <h3 className={s.detailPath} title={selected.rel_path}>
                  {selected.rel_path}
                </h3>
                <div className={s.detailMeta}>
                  <span className={s.fileCategory}>{selected.category}</span>
                  <span className={s.fileSize}>{formatBytes(selected.size)}</span>
                  {selectedHasMemories ? (
                    <Badge tone="success" variant="outline" size="sm">
                      ingested
                    </Badge>
                  ) : null}
                </div>
              </div>

              <WanderMemorySection title="ingested memories">
                <div className={s.memoriesHead}>
                  <span className={s.memoriesHint}>
                    {fileMemories.length} 条 · 按 metadata.path 匹配
                  </span>
                  <Button
                    type="button"
                    variant="plain"
                    size="xs"
                    onClick={() => void loadMemories()}
                    loading={loadingMemories}
                  >
                    {loadingMemories ? "loading…" : "load memories"}
                  </Button>
                </div>
                {memoriesError ? (
                  <Alert tone="danger" size="sm">
                    {memoriesError.code}: {memoriesError.message}
                  </Alert>
                ) : loadingMemories ? (
                  <LoadingState label="loading memories…" variant="block" />
                ) : fileMemories.length === 0 ? (
                  <EmptyState
                    title="no ingested memories for this file"
                    description="use the custom ingest editor below to store a memory bound to this path."
                  />
                ) : (
                  <div className={s.memoryList}>
                    {fileMemories.map((m) => (
                      <MemoryCard key={m.id} item={m} />
                    ))}
                  </div>
                )}
              </WanderMemorySection>

              <div className={s.ingestEditor}>
                <label htmlFor="custom-ingest" className={s.ingestLabel}>
                  custom ingest
                </label>
                {storeError ? (
                  <Alert tone="danger" size="sm">
                    {storeError.code}: {storeError.message}
                  </Alert>
                ) : null}
                <Textarea
                  id="custom-ingest"
                  value={customText}
                  onChange={(e) => setCustomText(e.target.value)}
                  rows={5}
                  placeholder="type customized memory text for this file…"
                  className={s.ingestTextarea}
                />
                <div className={s.ingestActions}>
                  <Button
                    type="button"
                    variant="outline"
                    tone="accent"
                    onClick={() => void doStore()}
                    loading={storing}
                    disabled={!customText.trim()}
                  >
                    {storing ? "storing…" : "store ingest"}
                  </Button>
                </div>
                {storeCollision ? (
                  <div className={s.collisionBox}>
                    <CollisionLine collision={storeCollision} />
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function WanderMemoryFilesRoute() {
  return (
    <WanderMemoryLayout title="文件" sub="MemOS · Files">
      <WanderMemoryToastProvider>
        <FilesPage />
      </WanderMemoryToastProvider>
    </WanderMemoryLayout>
  );
}
