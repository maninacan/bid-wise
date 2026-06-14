import { ApolloClient, InMemoryCache } from '@apollo/client/core';
import { HttpLink } from '@apollo/client/link/http';

export const apolloClient = new ApolloClient({
  link: new HttpLink({
    uri: (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GRAPHQL_URL) || 'http://localhost:4000/graphql',
  }),
  cache: new InMemoryCache(),
});
