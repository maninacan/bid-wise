import express, { Router } from 'express';
import type { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { buildContext, type GqlContext } from '../graphql/context';

/** Router for the Apollo GraphQL endpoint. Takes an already-started ApolloServer. */
export function createGraphqlRouter(server: ApolloServer<GqlContext>): Router {
  const router = Router();
  router.use(
    express.json({ limit: '4mb' }),
    expressMiddleware(server, {
      context: async ({ req }) => buildContext({ req }),
    }),
  );
  return router;
}
