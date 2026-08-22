/**
 * Argument validation helpers for x_search.
 */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeHandles(input: string[] | undefined, label: string): { handles?: string[]; error?: string } {
  if (!input) return {};
  if (!Array.isArray(input)) return { error: `${label} must be an array of strings` };
  if (input.length > 10) return { error: `${label} may contain at most 10 handles` };
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") return { error: `${label} must contain only strings` };
    const clean = raw.trim().replace(/^@/, "");
    if (!clean) return { error: `${label} contains an empty handle` };
    if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) {
      return { error: `${label} contains an invalid X handle: ${raw}` };
    }
    out.push(clean);
  }
  return { handles: out };
}

function parseIsoDate(raw: string): { ok: true; date: Date } | { ok: false; error: string } {
  if (!ISO_DATE_RE.test(raw)) {
    return { ok: false, error: `Date must be YYYY-MM-DD: ${raw}` };
  }
  const [year, month, day] = [Number(raw.slice(0, 4)), Number(raw.slice(5, 7)), Number(raw.slice(8, 10))];
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, error: `Invalid date: ${raw}` };
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (isNaN(date.getTime()) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, error: `Invalid date: ${raw}` };
  }
  return { ok: true, date };
}

export function validateDateRange(from?: string, to?: string): { ok: true } | { ok: false; error: string } {
  let fromDate: Date | undefined;
  let toDate: Date | undefined;

  if (from) {
    const parsed = parseIsoDate(from);
    if (!parsed.ok) return parsed;
    fromDate = parsed.date;
    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    if (fromDate.getTime() > today.getTime()) {
      return { ok: false, error: "from_date cannot be in the future" };
    }
  }

  if (to) {
    const parsed = parseIsoDate(to);
    if (!parsed.ok) return parsed;
    toDate = parsed.date;
  }

  if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
    return { ok: false, error: "from_date must be before or equal to to_date" };
  }

  return { ok: true };
}