export const ERROR_CATALOG = {
  INVALID_INPUT: { status: 400, message: 'La petición no es válida.' },
  INVALID_URL: { status: 400, message: 'El enlace no es un enlace válido de YouTube.' },
  LIMIT_ITEMS: { status: 413, message: 'Hay demasiados elementos en la petición.' },
  LIMIT_DURATION: { status: 422, message: 'El video supera la duración máxima permitida.' },
  NO_VALID_ITEMS: { status: 422, message: 'Ningún elemento se puede convertir.' },
  JOB_NOT_FOUND: { status: 404, message: 'La conversión no existe o ya expiró.' },
  ITEM_NOT_FOUND: { status: 404, message: 'El elemento no existe en esta conversión.' },
  ITEM_INVALID: { status: 409, message: 'Este elemento no se puede convertir.' },
  JOB_BUSY: { status: 409, message: 'Ya hay una descarga en curso para esta conversión.' },
  JOB_CANCELED: { status: 409, message: 'La conversión fue cancelada.' },
  VIDEO_UNAVAILABLE: { status: 404, message: 'El video no está disponible.' },
  PRIVATE_VIDEO: { status: 403, message: 'El video es privado.' },
  AGE_RESTRICTED: { status: 451, message: 'El video tiene restricción de edad.' },
  LIVE_NOT_SUPPORTED: { status: 422, message: 'Las transmisiones en vivo no se pueden convertir.' },
  FORMAT_UNAVAILABLE: { status: 422, message: 'Este video no tiene una versión compatible con el formato elegido.' },
  PLAYLIST_UNAVAILABLE: { status: 404, message: 'La playlist no está disponible.' },
  PLAYLIST_EMPTY: { status: 422, message: 'La playlist no tiene videos disponibles.' },
  UPSTREAM_BLOCKED: { status: 503, message: 'YouTube bloqueó temporalmente la solicitud. Inténtalo más tarde.' },
  UPSTREAM_FORBIDDEN: { status: 502, message: 'YouTube rechazó la descarga.' },
  UPSTREAM_ERROR: { status: 502, message: 'YouTube respondió con un error.' },
  UPSTREAM_TIMEOUT: { status: 504, message: 'YouTube tardó demasiado en responder.' },
  RATE_LIMITED: { status: 429, message: 'Demasiadas solicitudes. Espera un momento.' },
  TOO_MANY_STREAMS: { status: 429, message: 'Tienes demasiadas descargas simultáneas.' },
  TOO_MANY_SUBSCRIBERS: { status: 429, message: 'Demasiadas conexiones de progreso para esta conversión.' },
  TOO_MANY_PREVIEWS: { status: 429, message: 'Tienes demasiadas reproducciones simultáneas.' },
  QUEUE_FULL: { status: 503, message: 'La cola de conversión está llena. Inténtalo más tarde.' },
  QUEUE_TIMEOUT: { status: 503, message: 'Se agotó la espera en la cola de conversión.' },
  INSTANCE_BUSY: { status: 503, message: 'El servidor está ocupado. Inténtalo más tarde.' },
  CONVERSION_TIMEOUT: { status: 504, message: 'La conversión tardó demasiado.' },
  STALLED: { status: 504, message: 'La conversión se detuvo sin avanzar.' },
  DOWNLOAD_INTERRUPTED: { status: 500, message: 'La descarga se interrumpió.' },
  SERVER_SHUTDOWN: { status: 503, message: 'El servidor se está reiniciando.' },
  CAPTCHA_REQUIRED: { status: 403, message: 'Falta la verificación anti-bots.' },
  CAPTCHA_FAILED: { status: 403, message: 'La verificación anti-bots no fue válida.' },
  CAPTCHA_UNAVAILABLE: { status: 503, message: 'La verificación anti-bots no está disponible.' },
  SERVICE_UNAVAILABLE: { status: 503, message: 'El servicio no está disponible en este momento.' },
  INTERNAL: { status: 500, message: 'Error interno del servidor.' },
} as const satisfies Record<string, { status: number; message: string }>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export function isErrorCode(v: unknown): v is ErrorCode {
  return typeof v === 'string' && Object.hasOwn(ERROR_CATALOG, v);
}

export interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
  message?: string;
  status?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ErrorCode, opts: AppErrorOptions = {}) {
    super(opts.message ?? ERROR_CATALOG[code].message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.statusCode = opts.status ?? ERROR_CATALOG[code].status;
    this.details = opts.details;
  }
}

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
  requestId: string;
}

export function errorBody(err: AppError, requestId: string): ErrorBody {
  const body: ErrorBody = { error: { code: err.code, message: err.message }, requestId };
  if (err.details !== undefined) body.error.details = err.details;
  return body;
}
