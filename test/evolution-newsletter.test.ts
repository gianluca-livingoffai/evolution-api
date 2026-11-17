import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { generateWAMessageFromContent, isJidGroup, isJidNewsletter, isPnUser } from 'baileys';
import express, { Router } from 'express';
import ts from 'typescript';

import { createJid } from '../src/utils/createJid';

const channel = '120363172208310091@newsletter';
const group = '120363123456789012@g.us';
const source = ts.createSourceFile(
  'service.ts',
  readFileSync('src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const service = source.statements.find(ts.isClassDeclaration)!;
const logger = { verbose() {}, error() {} };

// Execute the real methods without importing the service's DB/server bootstrap graph.
function method(name: string, dependencies: Record<string, unknown> = {}) {
  const node = service.members.find((member) => member.name?.getText(source) === name)!;
  assert.ok(node, `Method ${name} exists`);
  const js = ts.transpileModule(
    `class Subject { ${node.getText(source)} }; module.exports = Subject.prototype.${name};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  const module = { exports: undefined as any };
  const globals = {
    createJid,
    isJidNewsletter,
    isJidGroup,
    isPnUser,
    generateWAMessageFromContent,
    BadRequestException: Error,
    NotFoundException: Error,
    InternalServerErrorException: Error,
    ...dependencies,
  };
  new Function(...Object.keys(globals), 'module', js)(...Object.values(globals), module);
  return module.exports;
}

test('channel metadata performs one read and returns only aggregate fields for nested WhatsApp responses', async () => {
  const read = method('baileysNewsletterMetadata');
  const calls: unknown[][] = [];
  const result = await read.call(
    {
      connectionStatus: { state: 'open' },
      client: {
        newsletterMetadata: async (...args: unknown[]) => {
          calls.push(args);
          return {
            id: channel,
            state: { type: 'ACTIVE' },
            thread_metadata: {
              name: { text: ' StandWithUs Brasil ' },
              subscribers_count: '35702',
              invite: 'private-invite',
            },
            viewer_metadata: { role: 'ADMIN' },
            owner: 'private-owner',
            subscribers_list: ['private-subscriber'],
          };
        },
      },
    },
    channel,
  );
  assert.deepEqual(calls, [['jid', channel]]);
  assert.deepEqual(Object.keys(result).sort(), [
    'id',
    'name',
    'observed_at',
    'state',
    'subscriber_count',
    'subscriber_count_available',
  ]);
  assert.equal(result.name, 'StandWithUs Brasil');
  assert.equal(result.subscriber_count, 35702);
  assert.equal(result.subscriber_count_available, true);
  assert.equal(result.state, 'ACTIVE');
  assert.equal(new Date(result.observed_at).toISOString(), result.observed_at);
});

test('channel metadata preserves real zero and handles normalized Baileys responses', async () => {
  const read = method('baileysNewsletterMetadata');
  const result = await read.call(
    {
      connectionStatus: { state: 'open' },
      client: { newsletterMetadata: async () => ({ id: channel, name: 'Channel', subscribers: 0 }) },
    },
    channel,
  );
  assert.equal(result.subscriber_count, 0);
  assert.equal(result.subscriber_count_available, true);
  assert.equal(result.state, null);
});

test('missing or invalid subscriber counts remain unknown instead of becoming zero', async () => {
  const read = method('baileysNewsletterMetadata');
  for (const subscribers of [undefined, null, '', 'unknown', '12members', -1, 2.5, Infinity, 9007199254740992]) {
    const result = await read.call(
      {
        connectionStatus: { state: 'open' },
        client: { newsletterMetadata: async () => ({ id: channel, subscribers }) },
      },
      channel,
    );
    assert.equal(result.subscriber_count, null);
    assert.equal(result.subscriber_count_available, false);
  }
});

test('channel metadata rejects invalid JIDs and disconnected instances before querying WhatsApp', async () => {
  const read = method('baileysNewsletterMetadata');
  const ctx = { connectionStatus: { state: 'open' }, client: {} };
  for (const jid of [undefined, '', group, '+123@newsletter', '1@newsletter ', ['1@newsletter'], { jid: channel }]) {
    await assert.rejects(read.call(ctx, jid), /JID completo/);
  }
  await assert.rejects(read.call({}, channel), /conectada/);
});

test('channel metadata fails on unavailable or mismatched responses and preserves query failure', async () => {
  const read = method('baileysNewsletterMetadata');
  for (const [metadata, expected] of [
    [null, /indisponíveis/],
    [{ id: '123@newsletter', subscribers: 100 }, /não corresponde/],
  ] as const) {
    await assert.rejects(
      read.call(
        { connectionStatus: { state: 'open' }, client: { newsletterMetadata: async () => metadata } },
        channel,
      ),
      expected,
    );
  }
  const failure = new Error('Offline query failure');
  await assert.rejects(
    read.call(
      {
        connectionStatus: { state: 'open' },
        client: {
          newsletterMetadata: async () => {
            throw failure;
          },
        },
      },
      channel,
    ),
    (error) => error === failure,
  );
});

test('metadata GET keeps the supplied guards, exact instance path and no-store response', async (t) => {
  const routerSource = ts.createSourceFile(
    'router.ts',
    readFileSync('src/api/integrations/channel/whatsapp/baileys.router.ts', 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = routerSource.statements.find(ts.isClassDeclaration)!;
  const js = ts.transpileModule(declaration.getText(routerSource), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  const calls: unknown[][] = [];
  const guards: string[] = [];
  new Function('exports', 'RouterBroker', 'Router', 'HttpStatus', 'baileysController', js)(
    exports,
    class {
      routerPath(path: string) {
        return `/${path}/:instanceName`;
      }
    },
    Router,
    { OK: 200 },
    {
      newsletterMetadata: async (...args: unknown[]) => {
        calls.push(args);
        return { subscriber_count: 123 };
      },
    },
  );
  const app = express();
  app.use(
    '/baileys',
    new exports.BaileysRouter(
      (_req: any, _res: any, next: () => void) => {
        guards.push('exists');
        next();
      },
      (_req: any, _res: any, next: () => void) => {
        guards.push('logged');
        next();
      },
      (req: any, res: any, next: () => void) => {
        guards.push('auth');
        if (req.get('apikey') !== 'offline-key') return res.sendStatus(401);
        next();
      },
    ).router,
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/baileys/newsletterMetadata/SWU%20BR%20UK?jid=${channel}&instanceName=other`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(calls.length, 0);
  const response = await fetch(url, { headers: { apikey: 'offline-key' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { subscriber_count: 123 });
  assert.deepEqual(calls, [[{ instanceName: 'SWU BR UK' }, channel]]);
  assert.deepEqual(guards, ['exists', 'logged', 'auth', 'exists', 'logged', 'auth']);
});

test('recipient normalization preserves channel and existing group/user JIDs', () => {
  for (const jid of [channel, group, '441234567890@s.whatsapp.net', '123456789@lid', 'status@broadcast']) {
    assert.equal(createJid(jid), jid);
  }
  assert.equal(createJid('+44 1234 567890'), '441234567890@s.whatsapp.net');
});

test('channel lookup never resolves as phone number or pollutes phone cache', async () => {
  const lookup = method('whatsappNumber', {
    OnWhatsAppDto: class {
      constructor(
        public jid: string,
        public exists: boolean,
        public number: string,
      ) {}
    },
    getOnWhatsappCache: async (jids: string[]) => {
      assert.deepEqual(jids, []);
      return [];
    },
    saveOnWhatsappCache: async () => assert.fail('Channel must not be saved as a phone'),
  });
  const result = await lookup.call(
    {
      logger,
      instanceId: 'test',
      prismaRepository: { contact: { findMany: async () => [] } },
      client: { onWhatsApp: async () => assert.fail('Channel must not be queried as a phone') },
    },
    { numbers: [channel] },
  );
  assert.equal(result[0].jid, channel);
  assert.equal(result[0].exists, true);
  await assert.rejects(lookup.call({}, { numbers: ['invalid@newsletter'] }), /ID de canal inválido/);
});

test('text/image/video channel sends relay raw content and return the actual generated message ID', async () => {
  const send = method('sendMessage');
  for (const content of [
    { conversation: 'Channel test' },
    { imageMessage: { directPath: '/m1/image', caption: 'Image' } },
    { videoMessage: { directPath: '/m1/video', caption: 'Video' } },
  ]) {
    const calls: any[] = [];
    const result = await send.call(
      {
        instance: { wuid: '441234567890@s.whatsapp.net' },
        client: {
          relayMessage: async (...args: any[]) => calls.push(args),
          sendMessage: async () => assert.fail('Prepared channel content must not be forwarded'),
        },
      },
      channel,
      content,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], channel);
    assert.equal(calls[0][2].messageId, result.key.id);
    assert.ok(result.key.id);
    assert.equal(result.key.remoteJid, channel);
    assert.equal(result.key.fromMe, true);
    assert.ok(!result.message.ephemeralMessage);
    assert.ok(!result.message.viewOnceMessage);
  }
  await assert.rejects(send.call({}, channel, { poll: { name: 'Unsupported' } }), /Canais aceitam/);
  await assert.rejects(
    send.call(
      {
        instance: { wuid: '441234567890@s.whatsapp.net' },
        client: {
          relayMessage: async () => {
            throw new Error('Permission denied');
          },
        },
      },
      channel,
      { conversation: 'Text' },
    ),
    /Permission denied/,
  );
});

test('ordinary group text still uses the existing Baileys send path', async () => {
  const calls: any[] = [];
  const send = method('sendMessage');
  const result = await send.call(
    {
      client: {
        sendMessage: async (...args: any[]) => {
          calls.push(args);
          return 'sent';
        },
      },
    },
    group,
    { conversation: 'Group test' },
  );
  assert.equal(result, 'sent');
  assert.equal(calls[0][0], group);
  assert.equal(calls[0][1].text, 'Group test');
  assert.equal(calls[0][2].useCachedGroupMetadata, true);
});

test('media entry point passes channel destination into preparation, rejects unsupported media before upload', async () => {
  const media = method('mediaMessage');
  const ctx = {
    prepareMediaMessage: async (input: any, jid: string) => {
      assert.equal(jid, channel);
      assert.equal(input.media, Buffer.from('bytes').toString('base64'));
      return { message: { imageMessage: { directPath: '/m1/image' } } };
    },
    sendMessageWithTyping: async (number: string) => {
      assert.equal(number, channel);
      return 'queued';
    },
  };
  assert.equal(
    await media.call(ctx, { number: channel, mediatype: 'image' }, { buffer: Buffer.from('bytes') }),
    'queued',
  );
  await assert.rejects(media.call({}, { number: channel, mediatype: 'document' }), /Canais aceitam/);
});

test('media preparation supplies the destination to Baileys raw/encrypted upload selection', async () => {
  const destinations: string[] = [];
  const prepare = method('prepareMediaMessage', {
    isURL: () => false,
    mimeTypes: { lookup: () => 'video/mp4' },
    prepareWAMessageMedia: async (_content: unknown, options: { jid: string }) => {
      destinations.push(options.jid);
      return { videoMessage: { directPath: '/m1/video' } };
    },
  });
  for (const jid of [channel, group]) {
    await prepare.call(
      { instance: { wuid: '441234567890@s.whatsapp.net' }, client: { waUploadToServer() {} } },
      { mediatype: 'video', media: Buffer.from('bytes').toString('base64') },
      jid,
    );
  }
  assert.deepEqual(destinations, [channel, group]);
});

test('channel delay is preserved without typing/presence, and send status is not forced to delivered', async () => {
  const delays: number[] = [];
  const send = method('sendMessageWithTyping', {
    delay: async (ms: number) => delays.push(ms),
    Long: { isLong: () => false },
    Events: { SEND_MESSAGE: 'send' },
  });
  const result = await send.call(
    {
      logger,
      whatsappNumber: async () => [{ jid: channel, exists: true }],
      client: {
        presenceSubscribe: async () => assert.fail('Channels have no typing presence'),
        sendPresenceUpdate: async () => assert.fail('Channels have no typing presence'),
      },
      sendMessage: async () => ({ message: { conversation: 'Text' } }),
      prepareMessage: () => ({ status: 'PENDING', key: { remoteJid: channel }, message: { conversation: 'Text' } }),
      configService: {
        get: (name: string) => (name === 'DATABASE' ? { SAVE_DATA: { NEW_MESSAGE: false } } : { ENABLED: false }),
      },
      localWebhook: { enabled: false },
      sendDataWebhook() {},
    },
    channel,
    { conversation: 'Text' },
    { delay: 25 },
  );
  assert.deepEqual(delays, [25]);
  assert.equal(result.status, 'PENDING');
});

test('existing 15-minute retry guard rejects stale/missing messages and preserves poll/event exceptions', async () => {
  const retry = method('getMessageForRetry', { RETRY_RESEND_MAX_AGE_MS: 15 * 60 * 1000 });
  const key = { id: 'test' };
  async function get(message: any, age: number) {
    return retry.call(
      {
        logger,
        getMessage: async (_key: unknown, full: boolean) =>
          full ? { message, messageTimestamp: (Date.now() - age) / 1000 } : message,
      },
      key,
    );
  }
  const text = { conversation: 'Recent' };
  assert.deepEqual(await get(text, 60_000), text);
  assert.equal(await get(text, 16 * 60_000), undefined);
  assert.equal(await get(text, Number.NaN), undefined);
  assert.equal(await get(undefined, 0), undefined);
  for (const type of ['pollCreationMessage', 'pollCreationMessageV2', 'pollCreationMessageV3', 'eventMessage']) {
    const content = { [type]: {} };
    assert.deepEqual(await get(content, 7 * 24 * 60 * 60_000), content);
  }
  assert.equal(
    await retry.call(
      {
        getMessage: async () => {
          throw new Error('Missing');
        },
      },
      key,
    ),
    undefined,
  );
});
