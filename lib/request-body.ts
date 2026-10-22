/** Limits bytes while reading, including requests without a Content-Length header. */
export class RequestBodyError extends Error {
  readonly status: 400 | 413 | 415;
  constructor(message: string, status: 400 | 413 | 415) { super(message); this.status = status; }
}

export async function readLimitedText(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyError("Request is too large.", 413);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyError("Request is too large.", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

export async function readLimitedJson(request: Request, maximumBytes: number): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new RequestBodyError("Use application/json.", 415);
  }
  const text = await readLimitedText(request, maximumBytes);
  try { return JSON.parse(text); }
  catch { throw new RequestBodyError("Check your request details.", 400); }
}
