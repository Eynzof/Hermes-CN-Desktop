/**
 * TTS / Voice Messages — text normalization for spoken output.
 *
 * Mirrors Python `tools/tts_text_normalize.py prepare_spoken_text`:
 * strip fenced code, inline code, markdown links/images, URLs, headings,
 * emphasis markers, bullets, emoji, think-blocks, then smooth whitespace.
 */

const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|[\u{FE0F}\u{200D}]|[\u{E0020}-\u{E007F}])+/gu;
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const PARAGRAPH_BREAK_RE = /[ \t]*\n{2,}[ \t]*/g;
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g;
const THINKING_PREFIX_RE =
  /^\s*(?:\([^)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.{2,}\s*/i;
const URL_RE = /\bhttps?:\/\/\S+/gi;

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{L})/gu, "$1$2")
    .replace(PARAGRAPH_BREAK_RE, "。 ")
    .replace(SOFT_BREAK_RE, " ");
}

/**
 * Strip non-spoken blocks (fenced code, inline code, markdown links/images,
 * URLs, headings, emphasis, bullets, emoji, think-blocks) and smooth whitespace.
 */
export function prepareSpokenText(text: string): string {
  return normalizeLineBreaks(text)
    .replace(FENCED_CODE_RE, " ")
    .replace(THINKING_PREFIX_RE, " ")
    .replace(MARKDOWN_IMAGE_RE, "$1")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(INLINE_CODE_RE, "$1")
    .replace(URL_RE, "链接")
    .replace(EMOJI_RE, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip fenced code blocks from text (useful for preview / voice stop phrase
 * matching where code should not be considered spoken).
 */
export function stripNonSpokenBlocks(text: string): string {
  return text.replace(FENCED_CODE_RE, "");
}
