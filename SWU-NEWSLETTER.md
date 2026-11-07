# SWU WhatsApp channel release

Version: `2.3.7-swu-newsletter.1`, based on fork commit `2a77692` (`retryfix-2.3.7`).
Baileys remains pinned to `7.0.0-rc.9`. The existing 15-minute retry guard and
poll/event retry exceptions remain unchanged. No schema migration is introduced.

## Supported requests

Use the existing `POST /message/sendText/{instance}` and
`POST /message/sendMedia/{instance}` endpoints. Set `number` to the full numeric
channel JID, for example `120363172208310091@newsletter` for StandWithUs Brasil.
The media endpoint supports `mediatype: "image"` or `"video"` with the existing
URL/base64 payload and caption fields. Other channel message types are rejected.
Text is sent as plain channel text, without generating a link preview.

The WhatsApp account connected to the Evolution instance must be a channel
administrator. The owner must invite that exact number and the number must accept
the invitation. An invite/subscription link alone does not grant publishing access.

## Compatibility patch

`scripts/apply-baileys-newsletter-patch.cjs` applies at `npm ci`/`npm install` and
before the focused tests. It accepts only the pinned version and exact original or
patched file hashes, and fails rather than patching an unknown dependency build.
Repeated runs are safe. Do not disable install scripts in a release build without
explicitly running this patch afterwards.

The patch uses raw channel uploads, the newsletter media paths, server thumbnail
generation, video transcoding flags and plaintext media attributes. Raw channel
uploads and encrypted chat uploads use separate cache entries. Normal chat/group
media continues to use encrypted uploads. The patch also removes raw temporary
files on upload failure. It is a targeted adaptation of upstream work, not an
upgrade to the 2.4 prerelease:

- [Evolution channel PR #2296](https://github.com/evolution-foundation/evolution-api/pull/2296)
- [Baileys channel media PR #2434](https://github.com/WhiskeySockets/Baileys/pull/2434)

## Local verification

```sh
npm ci
npm exec -- prisma generate --schema ./prisma/postgresql-schema.prisma
npm run test:newsletter
npm run build
npm exec -- eslint src/utils/createJid.ts src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts
git diff --check
```

The tests use mocked transport and temporary fixtures. They cover the Evolution
send path, the real Baileys media preparation/upload/relay functions, ordinary
encrypted media, and the original retry guard. They perform no WhatsApp sends.
Passing them establishes local protocol behavior, not delivery to a live channel.
The generated message ID and pending status do not prove publication; no delivered
status is fabricated. A controlled test channel check is still required before
enabling scheduled publication, including text, image, video and an account
without administrator rights.

Automatic media download, S3 export and webhook base64 conversion still use the
existing encrypted-chat download path. They may log a caught conversion error
for raw channel media after the send; this release does not add raw-media export.

## Build, release and rollback

The existing GitHub Actions image workflow builds `linux/amd64`, runs the focused
tests and full build inside Docker, then publishes:

- `ghcr.io/gianluca-livingoffai/evolution-api:2.3.7-swu-newsletter.1`
- `ghcr.io/gianluca-livingoffai/evolution-api:2.3.7-swu-newsletter.1-<commit>`

It runs on a push to `codex/newsletter-2.3.7` or manual dispatch on that branch.
Pushing that branch therefore publishes an image. Deployment remains a separate
operation. Prefer the resulting image digest in the production service definition.

A local Docker host can run the same build with:

```sh
docker buildx build --platform linux/amd64 --load -t evolution-api:2.3.7-swu-newsletter.1 .
```

Before deployment, record the running image digest and preserve the existing
environment, database and Redis volumes. Deploy the new image without resetting
sessions. Roll back by restoring the recorded digest (or the existing
`ghcr.io/gianluca-livingoffai/evolution-api:2.3.7-retryfix` image) and restarting the
same service. The workflow does not overwrite that previous tag.
