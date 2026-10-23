// Images a member attaches when talking to 小吉 (a chat or a /student answer), checked and read for the model.
//
// Only real attachments of the message count: an image link in the text, a sticker or an embed preview is never
// fetched, so a message cannot make 小吉 open an address of its choosing. An attachment is used when Discord says it
// is png, jpeg, gif or webp, it is at most 5 MB, and its address is on Discord's own media hosts. It is downloaded
// with a time limit, its real size is checked again, and its first bytes must show png, jpeg, gif or webp (that
// format is what is sent, whatever the label said). At most three are used per message; the image itself is never
// stored (only "附圖 N 張" goes into the text history).

const { createHash } = require('node:crypto');

const MAX_IMAGES_PER_MESSAGE = 3;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Guild AI quota units each image takes, on top of the one unit of the model call.
const IMAGE_QUOTA_UNITS = 10;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const SUPPORTED_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MEDIA_HOSTS = Object.freeze(['cdn.discordapp.com', 'media.discordapp.net']);

const EXTRA_IMAGES_NOTE = `小吉只看了前 ${MAX_IMAGES_PER_MESSAGE} 張圖喔。`;
const UNSUPPORTED_FILE_REPLY = '小吉目前只看得懂圖片（png、jpg、gif、webp）喔。';
const NO_VISION_REPLY = '小吉現在看不到圖片，可以用文字跟我說嗎？';
const NO_VISION_NOTE = '小吉現在看不到圖片，只看了你的文字喔。';
const UNREADABLE_IMAGE_REPLY = '小吉打不開這張圖片，可以換一張或用文字說說看嗎？';

function normalizedType(value) {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  return type === 'image/jpg' ? 'image/jpeg' : type;
}

function isMediaHostUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && MEDIA_HOSTS.includes(url.hostname.toLowerCase()) && !url.username && !url.password &&
      (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
}

// What the message carries: the images to read (at most three), how many more images were left out, and how many
// attachments are not images 小吉 reads (other files, too large, or not on Discord's media hosts).
function selectImageAttachments(message) {
  const attachments = [...(message?.attachments?.values?.() || [])];
  const usable = [];
  let unsupported = 0;
  for (const attachment of attachments) {
    const contentType = normalizedType(attachment?.contentType);
    const size = Number(attachment?.size);
    if (SUPPORTED_TYPES.includes(contentType) && Number.isFinite(size) && size > 0 && size <= MAX_IMAGE_BYTES &&
        isMediaHostUrl(attachment?.url)) {
      usable.push({ url: String(attachment.url), contentType, size });
    } else {
      unsupported += 1;
    }
  }
  return {
    images: usable.slice(0, MAX_IMAGES_PER_MESSAGE),
    extraImages: Math.max(0, usable.length - MAX_IMAGES_PER_MESSAGE),
    unsupported,
    hasAttachments: attachments.length > 0,
  };
}

// The format the first bytes show, or null.
function sniffImageType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('latin1').match(/^GIF8[79]a$/u)) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
      bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// Reads the body without ever holding more than MAX_IMAGE_BYTES (plus one chunk) of it.
async function readLimitedBody(response) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > MAX_IMAGE_BYTES ? null : buffer;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// One image as { mediaType, data (base64) }, or null when it cannot be used.
async function downloadImage(image, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  if (!isMediaHostUrl(image?.url)) return null;
  try {
    const response = await fetchImpl(image.url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response?.ok) return null;
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) return null;
    const bytes = await readLimitedBody(response);
    if (!bytes || bytes.length === 0) return null;
    // The bytes decide the format: Discord's label can differ from the file (a png labelled image/webp), so the
    // label only chose the attachment; what is sent must really be png, jpeg, gif or webp, and is sent as that.
    const actualType = sniffImageType(bytes);
    if (!actualType) return null;
    return { mediaType: actualType, data: bytes.toString('base64') };
  } catch {
    return null;
  }
}

// The images of a message, read: { images: [{ mediaType, data }], extraImages, unsupported, failed, hasAttachments }.
async function readMessageImages(message, options = {}) {
  const selected = selectImageAttachments(message);
  const downloaded = await Promise.all(selected.images.map((image) => downloadImage(image, options)));
  const images = downloaded.filter(Boolean);
  return {
    images,
    extraImages: selected.extraImages,
    unsupported: selected.unsupported,
    failed: selected.images.length - images.length,
    hasAttachments: selected.hasAttachments,
  };
}

// A short digest that tells images apart in the repeat checks, where the marker alone reads the same for any
// image: of the attachment paths before the download, of the image bytes after it. Empty without images.
function imageFingerprint(values) {
  if (!values.length) return '';
  const hash = createHash('sha256');
  for (const value of values) hash.update(String(value)).update('\u0000');
  return hash.digest('hex').slice(0, 16);
}

// The repeat-check topic of a selection (selectImageAttachments): images sent with the same words are a different
// request from the same words without images, or with other images.
function attachmentTopic(selection) {
  return selection.images.length ? `images:${imageFingerprint(selection.images.map((image) => new URL(image.url).pathname))}` : '';
}

// The text history keeps only that there were images.
function withImageMarker(text, count) {
  const value = String(text || '');
  return count > 0 ? `${value}${value ? ' ' : ''}[附圖 ${count} 張]` : value;
}

module.exports = {
  EXTRA_IMAGES_NOTE,
  IMAGE_QUOTA_UNITS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  NO_VISION_NOTE,
  NO_VISION_REPLY,
  UNREADABLE_IMAGE_REPLY,
  UNSUPPORTED_FILE_REPLY,
  attachmentTopic,
  downloadImage,
  imageFingerprint,
  isMediaHostUrl,
  readMessageImages,
  selectImageAttachments,
  sniffImageType,
  withImageMarker,
};
