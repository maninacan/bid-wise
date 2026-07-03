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
import { stripeWebhookHandler } from './stripe-webhook';

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  const server = new ApolloServer<GqlContext>({
    typeDefs,
    resolvers,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await server.start();

  // Stripe webhook — must see the RAW request body for signature verification, so it's
  // mounted with express.raw() before any JSON parser. It's a server-to-server call
  // (no browser), so it sits outside CORS.
  app.post('/webhook/stripe', express.raw({ type: 'application/json' }), stripeWebhookHandler);

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

  // Bind a specific host only when explicitly set (e.g. prod behind a proxy). Otherwise
  // omit it so Node listens dual-stack on all interfaces — reachable via both 127.0.0.1
  // and ::1. Binding the literal 'localhost' resolves to a single stack (often ::1 only),
  // which makes the browser's IPv4 localhost requests fail with ERR_CONNECTION_REFUSED.
  const host = process.env.HOST;
  const port = process.env.PORT ? Number(process.env.PORT) : 4000;

  await new Promise<void>((resolve) =>
    host ? httpServer.listen({ port, host }, resolve) : httpServer.listen(port, resolve),
  );
  console.log(`Server ready at http://localhost:${port}/graphql`);
}

startServer();
