/**
 * Long-page truncation + full-text cache helpers for web_extract.
 */

export function convertBase64ImagesToLinks(html: string): string {
  // Replace <img src="data:image/...;base64,..."> with a placeholder.
  return html.replace(
    /<img\b[^>]*?\bsrc=["']data:image\/[^;]+;base64,[A-Za-z0-9+/=]+["'][^>]*>/gi,
    (match) => {
      const alt = match.match(/\balt=["']([^"']*)["']/i)?.[1];
      return alt ? `[IMAGE: ${alt}]` : "[IMAGE]";
    },
  );
}

function simpleHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i += 1) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(10, "0").slice(0, 10);
}

function sanitizeHost(host: string): string {
  return host
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function getDesktopBridge(): typeof window.hermesDesktop | undefined {
  if (typeof window !== "undefined" && window.hermesDesktop) {
    return window.hermesDesktop;
  }
  const globalDesktop = (globalThis as Record<string, unknown>).hermesDesktop as typeof window.hermesDesktop | undefined;
  return globalDesktop;
}

export async function storeFullText(url: string, content: string): Promise<string | null> {
  const bridge = getDesktopBridge();
  if (!bridge?.webStoreFullText) {
    return null;
  }
  let host: string;
  try {
    host = sanitizeHost(new URL(url).hostname);
  } catch {
    host = "unknown";
  }
  const fileName = `${host}-${simpleHash(url)}.md`;
  try {
    const result = await bridge.webStoreFullText({ fileName, content });
    return result.path;
  } catch {
    return null;
  }
}

export interface TruncateResult {
  text: string;
  wasTruncated: boolean;
  storedPath?: string;
}

export async function truncateWithFooter(
  content: string,
  charLimit: number,
  url?: string,
): Promise<TruncateResult> {
  if (content.length <= charLimit) {
    return { text: content, wasTruncated: false };
  }

  const headTarget = Math.floor(charLimit * 0.75);
  const tailTarget = charLimit - headTarget;

  let head = content.slice(0, headTarget);
  const headNewline = head.lastIndexOf("\n");
  if (headNewline > 0) {
    head = head.slice(0, headNewline);
  }

  let tail = content.slice(-tailTarget);
  const tailNewline = tail.indexOf("\n");
  if (tailNewline >= 0) {
    tail = tail.slice(tailNewline + 1);
  }

  const storedPath = url ? await storeFullText(url, content) : null;
  const readHint = storedPath
    ? `read_file path="${storedPath}" offset=${head.split("\n").length + 1}`
    : "stored copy unavailable";

  const text =
    `${head}\n\n[TRUNCATED — ${content.length} chars; middle omitted]\n\n${tail}\n\n` +
    `[Full text stored at: ${storedPath ?? "(unavailable)"}; ${readHint}]`;

  return { text, wasTruncated: true, storedPath: storedPath ?? undefined };
}

export function clampExtractCharLimit(raw?: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return 15_000;
  return Math.max(2000, Math.min(500_000, raw));
}