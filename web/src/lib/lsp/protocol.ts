export function encodeJsonRpc(message: unknown): Uint8Array {
  const json = JSON.stringify(message);
  const payload = `Content-Length: ${new TextEncoder().encode(json).length}\r\n\r\n${json}`;
  return new TextEncoder().encode(payload);
}

export function decodeJsonRpcFrames(buffer: Uint8Array): { messages: unknown[]; remainder: Uint8Array } {
  const text = new TextDecoder().decode(buffer);
  const messages: unknown[] = [];
  let rest = text;
  while (true) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = rest.slice(0, headerEnd);
    const lenMatch = header.match(/Content-Length:\s*(\d+)/);
    if (!lenMatch) break;
    const len = parseInt(lenMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (rest.length < bodyStart + len) break;
    const body = rest.slice(bodyStart, bodyStart + len);
    try {
      messages.push(JSON.parse(body));
    } catch {
      // ignore malformed frame
    }
    rest = rest.slice(bodyStart + len);
  }
  return { messages, remainder: new TextEncoder().encode(rest) };
}
