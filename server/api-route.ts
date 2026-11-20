import type { RouteHandler } from 'fastify';
import type { RouteHandlers } from '../api/generated/sdk/fastify.gen.ts';

export type ApiRoute<Operation extends keyof RouteHandlers> =
  RouteHandlers[Operation] extends RouteHandler<infer Contract> ? Contract : never;
