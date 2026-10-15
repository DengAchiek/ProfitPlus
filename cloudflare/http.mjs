// Bridge the shared Node-style handler without opening a socket in a Worker.
export async function fetchResponse(handleRequest, request) {
  const reader = request.body?.getReader();
  let finished = !reader;
  const read = async () => {
    const chunk = await reader.read();
    finished = chunk.done;
    return chunk;
  };
  const incoming = {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers),
    socket: { remoteAddress: request.headers.get('cf-connecting-ip') || 'local' },
    async *[Symbol.asyncIterator]() {
      while (!finished) {
        const { value, done } = await read();
        if (!done) yield Buffer.from(value);
      }
    },
  };
  let status = 200, headers = {}, bytes;
  const outgoing = {
    headersSent: false,
    writeHead(code, values) { status = code; headers = values; this.headersSent = true; },
    end(body) { bytes = body; },
  };
  try {
    await handleRequest(incoming, outgoing);
  } finally {
    // A guard or size limit can reject before consuming the whole body. Drain
    // the upload without buffering it before the forwarding Worker responds.
    try { while (!finished) await read(); }
    finally { reader?.releaseLock(); }
  }
  return new Response(request.method === 'HEAD' ? null : bytes ?? null, { status, headers });
}
