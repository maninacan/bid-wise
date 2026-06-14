import type { Request } from 'express';
import { GraphQLError } from 'graphql';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { supabaseAdmin, getUserFromAuthHeader } from '../lib/supabase-admin';

export interface GqlContext {
  supabase: SupabaseClient;
  /** Memoized current user lookup (null if unauthenticated/invalid token). */
  user: () => Promise<User | null>;
}

export function buildContext({ req }: { req: Request }): GqlContext {
  const authHeader = req.headers.authorization ?? '';
  let cached: Promise<User | null> | undefined;
  return {
    supabase: supabaseAdmin,
    user: () => (cached ??= getUserFromAuthHeader(authHeader)),
  };
}

/** Resolves the authenticated user or throws an UNAUTHENTICATED GraphQL error. */
export async function requireUser(ctx: GqlContext): Promise<User> {
  const user = await ctx.user();
  if (!user) {
    throw new GraphQLError('Not authenticated.', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  return user;
}
