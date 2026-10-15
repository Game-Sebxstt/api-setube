import { Type } from 'typebox';
import { ERROR_CODES } from '../lib/errors.js';
import { ItemId, JobId, Nullable, VideoId } from './common.js';

const Format = Type.Union([Type.Literal('mp3'), Type.Literal('m4a'), Type.Literal('wav'), Type.Literal('mp4')]);
const QualityValue = Type.Union([
  Type.Literal(128),
  Type.Literal(192),
  Type.Literal(320),
  Type.Literal(360),
  Type.Literal(480),
  Type.Literal(720),
  Type.Literal(1080),
  Type.Literal('best'),
]);
const ErrorCodeT = Type.Unsafe<string>(Type.Union(ERROR_CODES.map((c) => Type.Literal(c))));
const ItemErrorT = Type.Object({ code: ErrorCodeT, message: Type.String() }, { additionalProperties: false });
const ItemStatusT = Type.Union([
  Type.Literal('pending'),
  Type.Literal('queued'),
  Type.Literal('fetching'),
  Type.Literal('downloading'),
  Type.Literal('converting'),
  Type.Literal('done'),
  Type.Literal('error'),
  Type.Literal('canceled'),
]);
const ErrorKindT = Type.Union([Type.Literal('validation'), Type.Literal('runtime')]);

export const createJobBody = (maxItems: number) =>
  Type.Object(
    {
      items: Type.Array(Type.Object({ videoId: VideoId }, { additionalProperties: false }), { minItems: 1, maxItems }),
      format: Format,
      quality: Type.Optional(QualityValue),
      turnstileToken: Type.Optional(Type.String({ maxLength: 2048 })),
    },
    { additionalProperties: false },
  );

export const CreateJobResponse = Type.Object(
  {
    jobId: Type.String(),
    format: Format,
    quality: Nullable(QualityValue),
    expiresAt: Type.String(),
    items: Type.Array(
      Type.Object(
        {
          itemId: Type.String(),
          videoId: Type.String(),
          title: Nullable(Type.String()),
          duration: Nullable(Type.Number()),
          status: Type.Union([Type.Literal('pending'), Type.Literal('error')]),
          error: Type.Optional(ItemErrorT),
          errorKind: Type.Optional(Type.Literal('validation')),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const JobParams = Type.Object({ id: JobId }, { additionalProperties: false });
export const ItemParams = Type.Object({ id: JobId, itemId: ItemId }, { additionalProperties: false });

export const SnapshotItem = Type.Object(
  {
    itemId: Type.String(),
    videoId: Type.String(),
    title: Nullable(Type.String()),
    duration: Nullable(Type.Number()),
    durationVerified: Type.Boolean(),
    status: ItemStatusT,
    pct: Type.Number(),
    phase: Type.Optional(Type.Union([Type.Literal('download'), Type.Literal('convert')])),
    speedBps: Nullable(Type.Number()),
    etaSec: Nullable(Type.Number()),
    position: Nullable(Type.Number()),
    bytesSent: Type.Number(),
    attempt: Type.Number(),
    error: Type.Optional(ItemErrorT),
    errorKind: Type.Optional(ErrorKindT),
    stale: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

export const SnapshotResponse = Type.Object(
  {
    jobId: Type.String(),
    format: Format,
    quality: Nullable(QualityValue),
    status: Type.Union([Type.Literal('active'), Type.Literal('canceled')]),
    createdAt: Type.String(),
    expiresAt: Type.String(),
    seq: Type.Number(),
    overall: Type.Object(
      { pct: Type.Number(), done: Type.Number(), failed: Type.Number(), total: Type.Number(), active: Type.Boolean() },
      { additionalProperties: false },
    ),
    lastReject: Nullable(
      Type.Object(
        {
          code: ErrorCodeT,
          message: Type.String(),
          at: Type.String(),
          itemId: Type.Optional(Type.String()),
          details: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false },
      ),
    ),
    items: Type.Array(SnapshotItem),
  },
  { additionalProperties: false },
);

export const CancelResponse = Type.Object(
  { jobId: Type.String(), status: Type.Literal('canceled') },
  { additionalProperties: false },
);
