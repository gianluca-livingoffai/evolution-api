import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { applyPatch, patches } from '../scripts/apply-baileys-newsletter-patch.cjs';

const baileysRoot = dirname(require.resolve('baileys/package.json'));
const channel = '120363172208310091@newsletter';
const payload = Buffer.from('Offline newsletter media regression fixture');
const digest = createHash('sha256').update(payload).digest();
const thumbnail = Buffer.alloc(32, 17);
const logger = { debug() {}, warn() {}, info() {} };
const owns = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

for (const mediaType of ['image', 'video'] as const) {
  test(`newsletter ${mediaType} uploads raw bytes, retains server thumbnail and removes temp file`, async () => {
    const { prepareWAMessageMedia } = await import('baileys');
    let uploadPath = '';
    const result = await prepareWAMessageMedia(
      { [mediaType]: payload, caption: 'Channel caption' },
      {
        jid: channel,
        upload: async (path, options) => {
          uploadPath = path;
          assert.deepEqual(await readFile(path), payload);
          assert.equal(options.mediaType, mediaType);
          assert.equal(options['newsletter'], true);
          assert.equal(options.fileEncSha256B64, digest.toString('base64'));
          return {
            mediaUrl: 'https://upload.invalid/must-not-be-published',
            directPath: '/m1/channel-media',
            thumbnailDirectPath: '/m1/channel-thumbnail',
            thumbnailSha256: thumbnail.toString('base64'),
          };
        },
      },
    );
    const message = result[`${mediaType}Message`];
    assert.equal(message.directPath, '/m1/channel-media');
    assert.equal(message.caption, 'Channel caption');
    assert.equal(Number(message.fileLength), payload.length);
    assert.deepEqual(message.fileSha256, digest);
    assert.equal(message.thumbnailDirectPath, '/m1/channel-thumbnail');
    assert.deepEqual(message.thumbnailSha256, thumbnail);
    for (const field of ['url', 'mediaKey', 'fileEncSha256']) assert.equal(owns(message, field), false, field);
    await assert.rejects(access(uploadPath), { code: 'ENOENT' });
  });
}

test('newsletter upload failure preserves the error and removes the raw temp file', async () => {
  const { prepareWAMessageMedia } = await import('baileys');
  let uploadPath = '';
  const failure = new Error('Offline upload failure');
  await assert.rejects(
    prepareWAMessageMedia(
      { image: payload },
      {
        jid: channel,
        upload: async (path) => {
          uploadPath = path;
          assert.deepEqual(await readFile(path), payload);
          throw failure;
        },
      },
    ),
    (error) => error === failure,
  );
  assert.ok(uploadPath);
  await assert.rejects(access(uploadPath), { code: 'ENOENT' });
});

test('ordinary group image uploads remain encrypted and keep their media URL and keys', async () => {
  const { prepareWAMessageMedia } = await import('baileys');
  let uploadPath = '';
  const result = await prepareWAMessageMedia(
    { image: payload, jpegThumbnail: Buffer.from('provided thumbnail') },
    {
      jid: '120363000000000000@g.us',
      upload: async (path, options) => {
        uploadPath = path;
        // rc9 returns before the ciphertext writer finishes; the real uploader first awaits its media connection.
        let encrypted = Buffer.alloc(0);
        for (let attempt = 0; attempt < 40; attempt++) {
          encrypted = await readFile(path).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return Buffer.alloc(0);
          });
          if (createHash('sha256').update(encrypted).digest('base64') === options.fileEncSha256B64) break;
          await delay(5);
        }
        assert.notDeepEqual(encrypted, payload);
        assert.equal(options['newsletter'], undefined);
        assert.equal(options.fileEncSha256B64, createHash('sha256').update(encrypted).digest('base64'));
        return { mediaUrl: 'https://upload.invalid/group-media', directPath: '/m1/group-media' };
      },
    },
  );
  assert.equal(result.imageMessage.url, 'https://upload.invalid/group-media');
  assert.equal(result.imageMessage.mediaKey.length, 32);
  assert.equal(result.imageMessage.fileEncSha256.length, 32);
  assert.deepEqual(result.imageMessage.fileSha256, digest);
  await assert.rejects(access(uploadPath), { code: 'ENOENT' });
});

test('raw newsletter and encrypted group media cannot share a cache entry', async () => {
  const { prepareWAMessageMedia, proto } = await import('baileys');
  const url = 'https://upload.invalid/cached-image';
  for (const [jid, expectedKey] of [
    [channel, `newsletter:image:${url}`],
    ['120363000000000000@g.us', `image:${url}`],
  ]) {
    const keys: string[] = [];
    const result = await prepareWAMessageMedia(
      { image: { url } },
      {
        jid,
        mediaCache: {
          get: async (key) => {
            keys.push(key);
            return proto.Message.encode({ imageMessage: { directPath: '/m1/cached' } }).finish();
          },
          set: async () => {},
          del: async () => {},
          flushAll: async () => {},
        },
        upload: async () => {
          throw new Error('Cache hit must not upload');
        },
      },
    );
    assert.deepEqual(keys, [expectedKey]);
    assert.equal(result.imageMessage.directPath, '/m1/cached');
  }
});

test('real uploader selects newsletter endpoints/flags and accepts direct_path plus thumbnail metadata', async (t) => {
  const { getWAUploadToServer } = await import('baileys');
  const directory = await mkdtemp(join(tmpdir(), 'baileys-upload-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'fixture');
  await writeFile(file, payload);
  const requests: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push(new URL(url));
    const chunks: Buffer[] = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), payload);
    assert.equal(options.method, 'POST');
    return {
      json: async () => ({
        direct_path: '/m1/response-without-url',
        thumbnail_info: {
          thumbnail_direct_path: '/m1/server-thumb',
          thumbnail_sha256: thumbnail.toString('base64'),
        },
      }),
    };
  });
  const upload = getWAUploadToServer(
    { customUploadHosts: [], logger, options: {} } as Parameters<typeof getWAUploadToServer>[0],
    async () => ({
      hosts: [{ hostname: 'upload.invalid', maxContentLengthBytes: 1024 }],
      auth: 'offline/token',
      ttl: 3600,
      fetchDate: new Date(),
    }),
  );
  for (const [mediaType, newsletter] of [
    ['image', true],
    ['video', true],
    ['image', false],
  ] as const) {
    const options = {
      mediaType,
      newsletter,
      fileEncSha256B64: digest.toString('base64'),
    };
    const uploaded = await upload(file, options);
    const request = requests.at(-1);
    assert.ok(request.pathname.startsWith(newsletter ? `/newsletter/newsletter-${mediaType}/` : '/mms/image/'));
    assert.equal(request.searchParams.get('server_thumb_gen'), newsletter ? '1' : null);
    assert.equal(request.searchParams.get('server_transcode'), newsletter && mediaType === 'video' ? '1' : null);
    assert.equal(request.searchParams.get('auth'), 'offline/token');
    assert.equal(uploaded.directPath, '/m1/response-without-url');
    assert.equal(uploaded['thumbnailDirectPath'], '/m1/server-thumb');
    assert.equal(uploaded['thumbnailSha256'], thumbnail.toString('base64'));
  }
  assert.equal(requests.length, 3);
});

test('actual relay newsletter branch attaches media type to plaintext and preserves text sends', async () => {
  const { encodeNewsletterMessage } = await import('baileys');
  const source = await readFile(join(baileysRoot, 'lib/Socket/messages-send.js'), 'utf8');
  const start = source.indexOf('            if (isNewsletter) {');
  const end = source.indexOf('            if (normalizeMessageContent(message)?.pinInChatMessage)', start);
  assert.ok(start > 0 && end > start);
  // Execute the installed relay branch with only its socket effects stubbed; no WhatsApp connection is created.
  const relay = new Function(
    'scope',
    `return (async () => {
      const { isNewsletter, message, mediaType, encodeNewsletterMessage, sendNode, logger } = scope;
      const patchMessageBeforeSending = undefined, binaryNodeContent = [], additionalAttributes = {};
      const jid = '${channel}', msgId = 'offline-message-id', getMessageType = () => mediaType ? 'media' : 'text';
      ${source.slice(start, end)}
    })();`,
  );
  for (const mediaType of ['image', 'video', undefined]) {
    const message = mediaType
      ? { [`${mediaType}Message`]: { directPath: '/m1/test' } }
      : { conversation: 'Offline text' };
    let sent;
    await relay({
      isNewsletter: true,
      message,
      mediaType,
      encodeNewsletterMessage,
      sendNode: async (node) => {
        sent = node;
      },
      logger,
    });
    assert.equal(sent.attrs.to, channel);
    assert.equal(sent.content[0].tag, 'plaintext');
    assert.deepEqual(sent.content[0].attrs, mediaType ? { mediatype: mediaType } : {});
    assert.deepEqual(sent.content[0].content, encodeNewsletterMessage(message));
  }
});

test('patch is reproducible, idempotent and fails closed on dependency drift before writing any file', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'baileys-patch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '7.0.0-rc.9' }));
  const originals = new Map<string, string>();
  for (const patch of patches) {
    const patched = await readFile(join(baileysRoot, 'lib', patch.file), 'utf8');
    assert.equal(createHash('sha256').update(patched).digest('hex'), patch.afterHash);
    const original = [...patch.changes]
      .reverse()
      .reduce((text, [before, after]) => text.replace(after, before), patched);
    assert.equal(createHash('sha256').update(original).digest('hex'), patch.beforeHash);
    const path = join(directory, 'lib', patch.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, original);
    originals.set(path, original);
  }
  assert.equal(applyPatch(directory), 3);
  assert.equal(applyPatch(directory), 0);
  for (const [path, original] of originals) await writeFile(path, original);
  await writeFile(join(directory, 'lib', patches.at(-1).file), 'Unexpected upstream source');
  assert.throws(() => applyPatch(directory), /Unexpected Baileys source/);
  const firstPath = join(directory, 'lib', patches[0].file);
  assert.equal(await readFile(firstPath, 'utf8'), originals.get(firstPath));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ version: '7.0.0-rc.10' }));
  assert.throws(() => applyPatch(directory), /requires Baileys 7.0.0-rc.9/);
});
