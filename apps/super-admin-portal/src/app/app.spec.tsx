import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';

import App from './app';
import { supabase, isSuperAdmin } from '../lib/supabase';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
  signIn: vi.fn(),
  signOut: vi.fn(),
  isSuperAdmin: vi.fn().mockReturnValue(false),
  authContext: vi.fn().mockResolvedValue({ headers: {} }),
}));

vi.mock('@bid-wise/data', () => ({
  apolloClient: { query: vi.fn().mockRejectedValue(new Error('network disabled in tests')) },
}));

function renderApp() {
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

describe('App', () => {
  it('shows the admin sign-in screen when signed out', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    } as never);

    const { findByText } = renderApp();
    expect(await findByText('Super Admin Console')).toBeTruthy();
  });

  it('shows a not-authorized screen for a signed-in non-super-admin', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { user: { email: 'user@example.com', app_metadata: {} } } },
      error: null,
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(false);

    const { findByText } = renderApp();
    expect(await findByText('Not a Super Admin')).toBeTruthy();
  });

  it('shows the admin shell for a signed-in super admin', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { user: { email: 'admin@example.com', app_metadata: { roles: ['SuperAdmin'] } } },
      },
      error: null,
    } as never);
    vi.mocked(isSuperAdmin).mockReturnValue(true);

    const { findByText } = renderApp();
    await waitFor(async () => expect(await findByText('Dashboard')).toBeTruthy());
    expect(await findByText('Users')).toBeTruthy();
    expect(await findByText('Settings')).toBeTruthy();
  });
});
