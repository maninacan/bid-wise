import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import {
  supabase,
  signOut,
  listHousePlans,
  listSubcontractors,
  loadSettings,
  getLinkedSubcontractorCount,
  getMyLinkedSubIds,
  dismissNotice,
  acceptInvite,
  type HousePlan,
  type Subcontractor,
  type UserSettings,
} from '../lib/supabase';
import { CompanyProvider, useCompany } from '../lib/company-context';
import { AuthScreen } from './auth-screen';
import { AppLogo } from './logo';
import { UploadScreen } from './upload-screen';
import { ProjectsScreen } from './projects-screen';
import { TakeoffsScreen } from './takeoffs-screen';
import { TakeoffDetailScreen } from './takeoff-detail-screen';
import { Questionnaire, QuestionnaireForPlan } from './questionnaire';
import { SettingsPanel } from './settings-panel';
import { SubsScreen } from './subs-screen';
import { SubLinkNoticeModal } from './sub-link-notice-modal';
import { MyWorkScreen } from './my-work-screen';
import { TradesOnboardingModal } from './trades-onboarding-modal';
import { BillingScreen, CreditsChip } from './billing-screen';
import { TeamScreen } from './team-screen';
import { CompaniesScreen } from './companies-screen';
import { AvatarMenu } from './avatar-menu';
import { CompanyOnboardingScreen } from './company-onboarding-screen';

const DEFAULT_SETTINGS: UserSettings = {
  pricingMatrix: { unitDefaults: {}, tradeOverrides: [] },
  trades: [],
  dismissedNotices: [],
  bidSharingMode: 'summary',
};

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [hasAnonymousData, setHasAnonymousData] = useState(false);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Initial session check
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (cancelled) return;
      if (s && !s.user.is_anonymous) {
        setSession(s);
      } else {
        setHasAnonymousData(!!s?.user.is_anonymous);
      }
      setCheckingSession(false);
    }).catch(() => {
      if (!cancelled) setCheckingSession(false);
    });

    // Auth state changes (sign in, sign out, email confirmation) — covers both the normal
    // signUp() path and the anonymous-session-upgrade path (updateUser({email,password})).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (cancelled) return;
      if (s && !s.user.is_anonymous && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
        setSession(s);
        setCheckingSession(false);
      } else if (event === 'SIGNED_OUT') {
        setSession(null);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (!checkingSession && !session) {
    return <AuthScreen hasAnonymousData={hasAnonymousData} />;
  }

  if (checkingSession || !session) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <p className="mt-10 text-center text-sm text-slate-500">Loading…</p>
      </main>
    );
  }

  return (
    <CompanyProvider userId={session.user.id}>
      <AppShell session={session} />
    </CompanyProvider>
  );
}

function AppShell({ session }: { session: Session }) {
  const navigate = useNavigate();
  const {
    companies,
    activeCompanyId,
    activeCompany,
    setActiveCompanyId,
    loading: companiesLoading,
  } = useCompany();

  const [existingPlans, setExistingPlans] = useState<HousePlan[]>([]);
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [mySubIds, setMySubIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSubLinkNotice, setShowSubLinkNotice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Reloads company-scoped state whenever the active company changes (including on switch).
  useEffect(() => {
    if (!activeCompanyId) return;
    let cancelled = false;
    setLoading(true);
    setError(false);

    const loadData = async () => {
      const [loaded, plans, subs, linkedCount, subIds] = await Promise.all([
        loadSettings(activeCompanyId).catch(() => DEFAULT_SETTINGS),
        listHousePlans(activeCompanyId).catch(() => []),
        listSubcontractors(activeCompanyId).catch(() => []),
        getLinkedSubcontractorCount().catch(() => 0),
        getMyLinkedSubIds().catch(() => [] as string[]),
      ]);
      if (cancelled) return;
      setSettings(loaded);
      setExistingPlans(plans);
      setSubcontractors(subs);
      setMySubIds(subIds);
      if (linkedCount > 0 && !loaded.dismissedNotices.includes('sub-link')) {
        setShowSubLinkNotice(true);
      }
      setLoading(false);
    };

    loadData().catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [activeCompanyId]);

  if (companiesLoading) {
    return (
      <main className="min-h-screen bg-slate-50 px-6 py-12">
        <p className="mt-10 text-center text-sm text-slate-500">Loading…</p>
      </main>
    );
  }

  // Zero-company is a legitimate, potentially long-lived state (e.g. invited but hasn't
  // accepted yet) — never auto-create one. Nothing else is reachable until they have one.
  if (companies.length === 0) {
    return <CompanyOnboardingScreen />;
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto flex max-w-7xl flex-col items-center">
        {/* Header */}
        <div className="flex w-full items-center justify-between">
          <AppLogo />
          <div className="flex items-center gap-2">
            {companies.length > 1 ? (
              <select
                value={activeCompanyId ?? ''}
                onChange={(e) => setActiveCompanyId(e.target.value)}
                aria-label="Active company"
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-medium text-slate-600"
              >
                {companies.map((m) => (
                  <option key={m.company.id} value={m.company.id}>{m.company.name}</option>
                ))}
              </select>
            ) : (
              activeCompany && (
                <span className="text-xs font-medium text-slate-500">{activeCompany.company.name}</span>
              )
            )}
            <button
              type="button"
              onClick={() => navigate('/projects')}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              Home
            </button>
            {mySubIds.length > 0 && (
              <button
                type="button"
                onClick={() => navigate('/my-work')}
                className="rounded-lg px-3 py-2 text-sm font-medium text-violet-600 transition-colors hover:bg-violet-50 hover:text-violet-700"
              >
                My Work
              </button>
            )}
            <button
              type="button"
              onClick={() => navigate('/subs')}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              Subs
            </button>
            <button
              type="button"
              onClick={() => navigate('/team')}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              Team
            </button>
            <button
              type="button"
              onClick={() => navigate('/companies')}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              Companies
            </button>
            <CreditsChip />
            <AvatarMenu
              email={session.user.email ?? ''}
              onOpenSettings={() => setSettingsOpen(true)}
              onSignOut={() => signOut().catch(() => {})}
            />
          </div>
        </div>

        {loading && (
          <p className="mt-10 text-sm text-slate-500">Loading…</p>
        )}

        {error && (
          <p role="alert" className="mt-10 text-sm text-red-600">
            Something went wrong connecting to the server. Please refresh to try again.
          </p>
        )}

        {!loading && !error && (
          <Routes>
            <Route path="/" element={<Navigate to="/projects" replace />} />

            <Route
              path="/upload"
              element={
                <UploadScreen
                  userId={session.user.id}
                  onContinue={(plans) => {
                    setExistingPlans(plans);
                    navigate('/projects');
                  }}
                />
              }
            />

            <Route
              path="/projects"
              element={
                <ProjectsScreen
                  plans={existingPlans}
                  onPlanRenamed={(updated) =>
                    setExistingPlans((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
                  }
                />
              }
            />

            <Route
              path="/projects/:planId"
              element={<TakeoffsScreen plans={existingPlans} />}
            />

            <Route
              path="/projects/:planId/takeoffs/:id"
              element={
                <TakeoffDetailScreen
                  plans={existingPlans}
                  pricingMatrix={settings.pricingMatrix}
                  bidSharingMode={settings.bidSharingMode}
                  subcontractors={subcontractors}
                  mySubIds={mySubIds}
                  onSubcontractorAdded={(sub) =>
                    setSubcontractors((prev) =>
                      [...prev, sub].sort((a, b) => a.name.localeCompare(b.name))
                    )
                  }
                />
              }
            />

            <Route
              path="/questionnaire"
              element={<Questionnaire pricingMatrix={settings.pricingMatrix} />}
            />

            <Route
              path="/projects/:planId/questionnaire"
              element={<QuestionnaireForPlan plans={existingPlans} pricingMatrix={settings.pricingMatrix} trades={settings.trades} />}
            />

            <Route
              path="/subs"
              element={
                <SubsScreen
                  subcontractors={subcontractors}
                  onChanged={setSubcontractors}
                />
              }
            />

            <Route path="/team" element={<TeamScreen />} />

            <Route path="/companies" element={<CompaniesScreen />} />

            <Route path="/accept-invite" element={<AcceptInviteRoute />} />

            <Route path="/my-work" element={<MyWorkScreen />} />

            <Route path="/billing" element={<BillingScreen />} />

            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        )}
      </div>

      {!loading && settings.trades.length === 0 && (
        <TradesOnboardingModal
          settings={settings}
          onSaved={(updated) => setSettings(updated)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onClose={() => setSettingsOpen(false)}
          onSaved={(updated) => {
            setSettings(updated);
            setSettingsOpen(false);
          }}
        />
      )}

      {showSubLinkNotice && (
        <SubLinkNoticeModal
          onClose={(permanent) => {
            setShowSubLinkNotice(false);
            if (permanent) {
              dismissNotice('sub-link').catch(() => {});
              setSettings((prev) => ({
                ...prev,
                dismissedNotices: [...prev.dismissedNotices, 'sub-link'],
              }));
            }
          }}
        />
      )}
    </main>
  );
}

/** Handles the `${appUrl}/accept-invite?token=...` link sent in invite emails. Only reachable
 *  once signed in (an unauthenticated visitor hits AuthScreen first; the token survives in the
 *  URL and this route then processes it once a session exists). New invitees who haven't signed
 *  up yet instead land on the zero-company onboarding gate, which lists the same invite via
 *  myPendingInvites (matched by email) rather than depending on this URL param. */
function AcceptInviteRoute() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { refresh } = useCompany();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = searchParams.get('token');
    if (!token) {
      navigate('/projects', { replace: true });
      return;
    }
    acceptInvite(token)
      .then(async (company) => {
        await refresh(company.id);
        navigate('/projects', { replace: true });
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Could not accept invite.');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <div className="mt-10 max-w-md text-center">
        <p className="text-sm text-red-600">{error}</p>
        <button
          type="button"
          onClick={() => navigate('/projects')}
          className="mt-4 text-sm font-medium text-blue-600 hover:underline"
        >
          Back to projects
        </button>
      </div>
    );
  }
  return <p className="mt-10 text-sm text-slate-500">Joining…</p>;
}

export default App;
