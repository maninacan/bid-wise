import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { myCompanies, setActiveCompanyIdForRequests, type CompanyMembership } from './supabase';

interface CompanyContextValue {
  companies: CompanyMembership[];
  activeCompanyId: string | null;
  activeCompany: CompanyMembership | null;
  setActiveCompanyId: (companyId: string) => void;
  loading: boolean;
  /** Re-fetches myCompanies. Pass preferCompanyId to make it the active one afterwards
   *  (e.g. right after createCompany/acceptInvite), overriding whatever was persisted. */
  refresh: (preferCompanyId?: string) => Promise<void>;
}

const CompanyContext = createContext<CompanyContextValue | null>(null);

function storageKey(userId: string): string {
  return `bidwise:activeCompanyId:${userId}`;
}

export function CompanyProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [companies, setCompanies] = useState<CompanyMembership[]>([]);
  const [activeCompanyId, setActiveCompanyIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const applyActiveCompanyId = useCallback((id: string | null) => {
    setActiveCompanyIdState(id);
    setActiveCompanyIdForRequests(id);
    if (id) localStorage.setItem(storageKey(userId), id);
  }, [userId]);

  const setActiveCompanyId = useCallback((id: string) => {
    applyActiveCompanyId(id);
  }, [applyActiveCompanyId]);

  const refresh = useCallback(async (preferCompanyId?: string) => {
    const list = await myCompanies().catch(() => []);
    setCompanies(list);
    const stored = preferCompanyId ?? localStorage.getItem(storageKey(userId));
    const match = list.find((m) => m.company.id === stored);
    applyActiveCompanyId(match ? match.company.id : (list[0]?.company.id ?? null));
    setLoading(false);
  }, [userId, applyActiveCompanyId]);

  useEffect(() => {
    setLoading(true);
    refresh();
    // Only re-run when the signed-in user changes, not on every refresh identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const activeCompany = companies.find((m) => m.company.id === activeCompanyId) ?? null;

  return (
    <CompanyContext.Provider
      value={{ companies, activeCompanyId, activeCompany, setActiveCompanyId, loading, refresh }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(CompanyContext);
  if (!ctx) throw new Error('useCompany must be used within a CompanyProvider');
  return ctx;
}
