export async function downloadText(url: string, fetchImpl = fetch): Promise<string> {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  return res.text();
}
