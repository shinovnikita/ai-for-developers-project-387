import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export const validationError = {
  code: 'VALIDATION_ERROR',
  message: 'Проверьте поля запроса',
} as const;

export function handleInvalidRequest(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  if (error.statusCode === 400) return reply.code(400).send(validationError);
  return reply.send(error);
}
