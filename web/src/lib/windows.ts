export function windowSearchParams(): URLSearchParams {
  if (typeof window === "undefined") return new URLSearchParams();
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : window.location.search.slice(1);
  return new URLSearchParams(query);
}

export function isSecondarySessionWindow(): boolean {
  return windowSearchParams().get("window") === "session";
}

export function isWatchSessionWindow(): boolean {
  return isSecondarySessionWindow() && windowSearchParams().get("watch") === "1";
}

export function isNewSessionWindow(): boolean {
  return isSecondarySessionWindow() && windowSearchParams().get("new") === "1";
}
