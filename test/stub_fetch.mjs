// Preloaded into a server subprocess (NODE_OPTIONS=--import) by tests that need SKKG's servers:
// nothing reaches the network. Each request prints {"stub_fetch": url} on stderr and is answered
// after SKKG_TEST_FETCH_DELAY_MS: a IIIF image URL with a JPEG of the size it asks for, any
// other URL with HTTP 503.

const delay = Number(process.env.SKKG_TEST_FETCH_DELAY_MS ?? 0);

function jpeg(width, height) {
  const sof = Buffer.from([0xFF, 0xC0, 0x00, 0x11, 0x08, height >> 8, height & 0xFF, width >> 8, width & 0xFF,
    0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), sof, Buffer.from([0xFF, 0xD9])]);
}

globalThis.fetch = async (url, { signal } = {}) => {
  const u = String(url);
  console.error(JSON.stringify({ stub_fetch: u }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  const size = /\/iiif\/3\/[^/]+\/[^/]+\/(\d+),(\d+)\/0\/default\.jpg$/.exec(u);
  if (size) return new Response(jpeg(Number(size[1]), Number(size[2])), { headers: { 'content-type': 'image/jpeg' } });
  return new Response('busy', { status: 503 });
};
