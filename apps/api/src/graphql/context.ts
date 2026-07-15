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

/** Resolves the current user and confirms they belong to the given company (any role). */
export async function requireCompanyMember(
  ctx: GqlContext,
  companyId: string,
): Promise<{ user: User; role: 'owner' | 'member' }> {
  const user = await requireUser(ctx);
  const { data } = await ctx.supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!data) {
    throw new GraphQLError('Not a member of this company.', { extensions: { code: 'FORBIDDEN' } });
  }
  return { user, role: data.role as 'owner' | 'member' };
}

/** Resolves the current user and confirms they own the given company. */
export async function requireCompanyOwner(ctx: GqlContext, companyId: string): Promise<User> {
  const { user, role } = await requireCompanyMember(ctx, companyId);
  if (role !== 'owner') {
    throw new GraphQLError('Owner permission required.', { extensions: { code: 'FORBIDDEN' } });
  }
  return user;
}
