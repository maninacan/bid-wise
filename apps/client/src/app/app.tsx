import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
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
  type HousePlan,
  type Subcontractor,
  type UserSettings,
} from '../lib/supabase';
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

const DEFAULT_SETTINGS: UserSettings = {
  pricingMatrix: { unitDefaults: {}, tradeOverrides: [] },
  trades: [],
  dismissedNotices: [],
  bidSharingMode: 'summary',
};

export function App() {
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [hasAnonymousData, setHasAnonymousData] = useState(false);
  const [existingPlans, setExistingPlans] = useState<HousePlan[]>([]);
  const [subcontractors, setSubcontractors] = useState<Subcontractor[]>([]);
  const [settings, setSettings] = useState<UserSettings>(DEFAULT_SETTINGS);
  const [mySubIds, setMySubIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSubLinkNotice, setShowSubLinkNotice] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadData = async () => {
      const [loaded, plans, subs, linkedCount, subIds] = await Promise.all([
        loadSettings().catch(() => DEFAULT_SETTINGS),
        listHousePlans().catch(() => []),
        listSubcontractors().catch(() => []),
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

    // Initial session check
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (cancelled) return;
      if (s && !s.user.is_anonymous) {
        setSession(s);
        loadData().catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
      } else {
        setHasAnonymousData(!!s?.user.is_anonymous);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) { setError(true); setLoading(false); }
    });

    // Auth state changes (sign in, sign out, email confirmation)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, s) => {
      if (cancelled) return;
      if (s && !s.user.is_anonymous && (event === 'SIGNED_IN' || event === 'USER_UPDATED')) {
        setSession(s);
        setLoading(true);
        loadData().catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
      } else if (event === 'SIGNED_OUT') {
        setSession(null);
        setExistingPlans([]);
        setSubcontractors([]);
        setSettings(DEFAULT_SETTINGS);
      }
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, []);

  if (!loading && !session) {
    return <AuthScreen hasAnonymousData={hasAnonymousData} />;
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto flex max-w-7xl flex-col items-center">
        {/* Header */}
        <div className="flex w-full items-center justify-between">
          <AppLogo />
          <div className="flex items-center gap-2">
            {session?.user.email && (
              <span className="text-xs text-slate-400">{session.user.email}</span>
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
              onClick={() => setSettingsOpen(true)}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              aria-label="Open settings"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
                <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => signOut().catch(() => {})}
              className="rounded-lg px-3 py-2 text-sm font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              Sign out
            </button>
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

        {!loading && !error && session && (
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
              element={<ProjectsScreen plans={existingPlans} />}
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

            <Route path="/my-work" element={<MyWorkScreen />} />

            <Route path="*" element={<Navigate to="/projects" replace />} />
          </Routes>
        )}
      </div>

      {!loading && session && settings.trades.length === 0 && (
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

export default App;
