// Ссылка-приглашение: оба плана, сжатые deflate и записанные в хеш адреса. На сервер ничего не отправляется.

const PREFIX = 'v1.';
/** Предел распакованного размера: защита от «бомбы» в чужой ссылке. */
export const MAX_SHARED_BYTES = 2 * 1024 * 1024;

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream, limit?: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // запись не ждём до чтения: поток начнёт отдавать данные только после того, как читатель заберёт их
  const written = writer.write(data as unknown as BufferSource).then(() => writer.close());
  written.catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (limit !== undefined && size > limit) {
      await reader.cancel();
      throw new Error('распакованные данные слишком велики');
    }
    chunks.push(value);
  }
  await written;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Кодирует два плана (как вставил пользователь) в строку для хеша адреса. */
export async function encodeShare(a: string, b: string): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify([a, b]));
  const packed = await pipe(raw, new CompressionStream('deflate-raw'));
  return PREFIX + toBase64Url(packed);
}

export async function decodeShare(s: string): Promise<{ a: string; b: string }> {
  const t = s.replace(/^#/, '');
  if (!t.startsWith(PREFIX)) throw new Error('это не ссылка plan-postcard');
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(t.slice(PREFIX.length));
  } catch {
    throw new Error('ссылка повреждена: неверная запись данных');
  }
  let raw: Uint8Array;
  try {
    raw = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_SHARED_BYTES);
  } catch (e) {
    throw new Error((e as Error).message.includes('велики') ? 'ссылка слишком велика' : 'ссылка повреждена: не удалось распаковать');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new Error('ссылка повреждена: внутри не JSON');
  }
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new Error('ссылка повреждена: ожидались два плана');
  return { a: parsed[0], b: parsed[1] };
}
