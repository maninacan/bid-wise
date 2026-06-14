import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: 'http://localhost:4000/graphql',
  documents: ['libs/data/src/**/*.graphql'],
  generates: {
    'libs/data/src/generated/graphql.ts': {
      plugins: ['typescript', 'typescript-operations', 'typescript-react-apollo'],
      config: {
        withHooks: true,
        apolloClientVersion: 4,
      },
    },
  },
};

export default config;
