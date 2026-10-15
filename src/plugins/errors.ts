import fp from 'fastify-plugin';
import type { FastifyError } from 'fastify';
import { AppError, errorBody } from '../lib/errors.js';

function toAppError(err: FastifyError | AppError | Error): AppError {
  if (err instanceof AppError) return err;
  const e = err as FastifyError;
  switch (e.code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
      return new AppError('INVALID_INPUT', { status: 413, message: 'La petición es demasiado grande.' });
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return new AppError('INVALID_INPUT', { status: 415, message: 'El cuerpo debe ser JSON.' });
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
      return new AppError('INVALID_INPUT', { message: 'El cuerpo JSON no es válido.' });
  }
  if (e.validation) {
    return new AppError('INVALID_INPUT', {
      details: e.validation.map((v) => ({
        path: v.instancePath || '/',
        keyword: v.keyword,
        message: v.message ?? 'inválido',
      })),
    });
  }
  if (err instanceof SyntaxError && (e.statusCode ?? 400) === 400) {
    return new AppError('INVALID_INPUT', { message: 'El cuerpo JSON no es válido.' });
  }
  const status = e.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return new AppError('INVALID_INPUT', { status });
  }
  return new AppError('INTERNAL', { cause: err });
}

export default fp(
  async (app) => {
    app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
      const appErr = toAppError(err);
      if (appErr.statusCode >= 500) {
        if (appErr.code === 'INTERNAL') req.log.error({ err }, 'unhandled_error');
        else req.log.warn({ code: appErr.code }, 'request_failed');
      }
      return reply.code(appErr.statusCode).type('application/json; charset=utf-8').send(errorBody(appErr, req.id));
    });

    app.setNotFoundHandler((req, reply) => {
      const appErr = new AppError('INVALID_INPUT', { status: 404, message: 'Ruta no encontrada.' });
      return reply.code(404).type('application/json; charset=utf-8').send(errorBody(appErr, req.id));
    });
  },
  { name: 'setube-errors' },
);
