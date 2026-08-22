/**
 * Image Generation — minimal FAL queue REST client.
 *
 * Mirrors Python `fal_client.submit(...).get()`:
 * - POST queue.fal.run/<model> (idempotency key)
 * - poll status_url
 * - fetch response_url on COMPLETED
 */

export interface FalSubmitResponse {
  request_id: string;
  status_url: string;
  response_url: string;
  status?: string;
}

export interface FalPollOptions {
  maxAttempts?: number;
  intervalMs?: number;
  fetchImpl?: typeof fetch;
}

export async function falSubmit(
  model: string,
  payload: Record<string, unknown>,
  apiKey: string,
  options?: { fetchImpl?: typeof fetch },
): Promise<FalSubmitResponse> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const idempotencyKey = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const response = await fetchImpl(`https://queue.fal.run/${model}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${apiKey}`,
      "x-idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`FAL submit failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as FalSubmitResponse;
  return data;
}

export async function falPollStatus(
  statusUrl: string,
  apiKey: string,
  options?: FalPollOptions,
): Promise<{ status: string } & Record<string, unknown>> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const maxAttempts = options?.maxAttempts ?? 120;
  const intervalMs = options?.intervalMs ?? 5000;

  for (let i = 0; i < maxAttempts; i++) {
    const response = await fetchImpl(statusUrl, {
      headers: { Authorization: `Key ${apiKey}` },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`FAL status poll failed: ${response.status} ${text}`);
    }
    const data = (await response.json()) as { status: string } & Record<string, unknown>;
    if (data.status === "COMPLETED") return data;
    if (data.status === "FAILED") throw new Error("FAL job failed");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("FAL job poll timed out");
}

export async function falFetchResult(responseUrl: string, apiKey: string, options?: { fetchImpl?: typeof fetch }) {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const response = await fetchImpl(responseUrl, {
    headers: { Authorization: `Key ${apiKey}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`FAL result fetch failed: ${response.status} ${text}`);
  }
  return (await response.json()) as Record<string, unknown>;
}
