import { useCompany } from '../lib/company-context';
import { AppLogo } from './logo';
import { PendingInvitesList } from './pending-invites-list';
import { CreateCompanyForm } from './create-company-form';

/** Shown when the signed-in user belongs to zero companies — a legitimate, potentially
 *  long-lived state (e.g. invited but hasn't accepted yet). Never auto-creates a company:
 *  the user either accepts a pending invite or explicitly creates their own. */
export function CompanyOnboardingScreen() {
  const { refresh } = useCompany();

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto flex max-w-md flex-col items-center">
        <AppLogo />

        <div className="w-full empty:hidden mt-10">
          <PendingInvitesList onAccepted={(company) => refresh(company.id)} />
        </div>

        <div className="mt-6 w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold text-slate-900">Create a company</h2>
          <p className="mt-1 text-sm text-slate-500">
            Set up your own company to start uploading plans and generating bids.
          </p>
          <div className="mt-4">
            <CreateCompanyForm onCreated={(company) => refresh(company.id)} />
          </div>
        </div>
      </div>
    </main>
  );
}
