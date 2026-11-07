const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

// Backport https://github.com/WhiskeySockets/Baileys/pull/2434 without changing the pinned protocol version.
const version = '7.0.0-rc.9';
const hash = (text) => createHash('sha256').update(text).digest('hex');
function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unexpected Baileys source; refusing a partial patch');
  return source.replace(before, after);
}

const patches = [
  {
    file: 'Utils/messages.js',
    beforeHash: 'cab3c1d0f2bd87d8b7c735eaf4e149254c9bffe26dba5ed94ff50f653fb09762',
    afterHash: '2ffdd0bb634ff1aa1a9e837cc70fd98d8c4fc83f39028e5f604c9466760462c2',
    changes: [
      [
        '    // check if cacheable + generate cache key',
        '    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);\n    // Keep raw channel media separate from encrypted chat media in the cache.',
      ],
      [
        "        mediaType + ':' + uploadData.media.url.toString();",
        "        (isNewsletter ? 'newsletter:' : '') + mediaType + ':' + uploadData.media.url.toString();",
      ],
      [
        '    const isNewsletter = !!options.jid && isJidNewsletter(options.jid);\n    if (isNewsletter) {',
        '    if (isNewsletter) {',
      ],
      [
        `        const { mediaUrl, directPath } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        });
        await fs.unlink(filePath);`,
        `        let uploaded;
        try {
            uploaded = await options.upload(filePath, {
                fileEncSha256B64: fileSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs,
                newsletter: true
            });
        } finally {
            await fs.unlink(filePath).catch((error) => logger?.warn({ error }, 'Failed to remove newsletter temp file'));
        }
        const { directPath, thumbnailDirectPath, thumbnailSha256 } = uploaded;`,
      ],
      [
        `                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,`,
        `                directPath,
                fileSha256,
                fileLength,
                thumbnailDirectPath,
                thumbnailSha256: thumbnailSha256 ? Buffer.from(thumbnailSha256, 'base64') : undefined,
                ...uploadData,`,
      ],
    ],
  },
  {
    file: 'Utils/messages-media.js',
    beforeHash: '087222aab9167a7984d8255263094f5e7f82724c5a1e98913e26009ec70b664a',
    afterHash: '8d4dc3c0105b61e7e7f1e3221d73596087642270918eddb9e39ec7941be2fb4b',
    changes: [
      [
        'export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {',
        `const NEWSLETTER_MEDIA_PATH_MAP = {
    image: '/newsletter/newsletter-image',
    video: '/newsletter/newsletter-video',
    document: '/newsletter/newsletter-document',
    audio: '/newsletter/newsletter-audio',
    gif: '/newsletter/newsletter-gif',
    ptt: '/newsletter/newsletter-ptt',
    ptv: '/newsletter/newsletter-ptv',
    sticker: '/newsletter/newsletter-sticker-pack',
    'thumbnail-link': '/newsletter/newsletter-image'
};
export const getWAUploadToServer = ({ customUploadHosts, fetchAgent, logger, options }, refreshMediaConn) => {`,
      ],
      [
        '    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs }) => {',
        '    return async (filePath, { mediaType, fileEncSha256B64, timeoutMs, newsletter }) => {',
      ],
      [
        '            const url = `https://${hostname}${MEDIA_PATH_MAP[mediaType]}/${fileEncSha256B64}?auth=${auth}&token=${fileEncSha256B64}`;',
        `            const mediaPath = newsletter ? NEWSLETTER_MEDIA_PATH_MAP[mediaType] : MEDIA_PATH_MAP[mediaType];
            if (!mediaPath) throw new Error('Unsupported media upload type: ' + mediaType);
            let url = \`https://\${hostname}\${mediaPath}/\${fileEncSha256B64}?auth=\${auth}&token=\${fileEncSha256B64}\`;
            if (newsletter) {
                url += '&server_thumb_gen=1';
                if (mediaType === 'video' || mediaType === 'gif' || mediaType === 'ptv') url += '&server_transcode=1';
            }`,
      ],
      [
        '                if (result?.url || result?.directPath) {',
        '                if (result?.url || result?.direct_path) {',
      ],
      [
        '                        mediaUrl: result.url,',
        '                        mediaUrl: result.url || result.direct_path,',
      ],
      [
        '                        ts: result.ts\n',
        `                        ts: result.ts,
                        thumbnailDirectPath: result.thumbnail_info?.thumbnail_direct_path,
                        thumbnailSha256: result.thumbnail_info?.thumbnail_sha256
`,
      ],
    ],
  },
  {
    file: 'Socket/messages-send.js',
    beforeHash: 'd292175b0a148a44bfc3a42bf8e26e5b96fa3dce83415df96cc65147d8f56b8b',
    afterHash: '6a4a70e255fc46c089871967c9d158294f7141d87d080d2255ec78880b4226df',
    changes: [
      [
        "                    tag: 'plaintext',\n                    attrs: {},\n                    content: bytes",
        "                    tag: 'plaintext',\n                    attrs: mediaType ? { mediatype: mediaType } : {},\n                    content: bytes",
      ],
    ],
  },
];

function applyPatch(root = dirname(require.resolve('baileys/package.json'))) {
  const installed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (installed !== version) throw new Error(`Newsletter patch requires Baileys ${version}; found ${installed}`);
  const files = patches.map((patch) => {
    const path = join(root, 'lib', patch.file);
    const source = readFileSync(path, 'utf8');
    if (hash(source) === patch.afterHash) return { path, source, changed: false };
    if (hash(source) !== patch.beforeHash) throw new Error(`Unexpected Baileys source: ${patch.file}`);
    const patched = patch.changes.reduce((text, [before, after]) => replaceOnce(text, before, after), source);
    if (hash(patched) !== patch.afterHash) throw new Error(`Patch checksum mismatch: ${patch.file}`);
    return { path, source: patched, changed: true };
  });
  for (const file of files) if (file.changed) writeFileSync(file.path, file.source);
  return files.filter((file) => file.changed).length;
}

module.exports = { applyPatch, patches };
if (require.main === module) console.log(`Baileys newsletter patch: ${applyPatch()} file(s) updated`);
