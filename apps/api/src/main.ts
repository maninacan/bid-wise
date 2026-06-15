import express from 'express';
import http from 'http';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { typeDefs } from './graphql/schema';
import { resolvers } from './graphql/resolvers';
import type { GqlContext } from './graphql/context';
import { createGraphqlRouter } from './routes/graphql.route';
import { takeoffRouter, cancelTakeoffRouter } from './routes/takeoff.route';

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer<GqlContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  // Allowed browser origins. Defaults to the local client; override in prod via
  // CORS_ALLOWED_ORIGINS (comma-separated), e.g. "https://app.bidwise.com".
  // Applied globally so it also answers preflight (OPTIONS) for every route.
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:4200')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors<cors.CorsRequest>({ origin: allowedOrigins }));

  app.use('/graphql', createGraphqlRouter(server));
  app.use('/generate-takeoff', takeoffRouter);
  app.use('/cancel-takeoff', cancelTakeoffRouter);

  const host = process.env.HOST ?? 'localhost';
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;

  await new Promise<void>((resolve) => httpServer.listen({ port, host }, resolve));
  console.log(`Server ready at http://${host}:${port}/graphql`);
}

startServer();
