import { useCompany } from '../lib/company-context';
import { PendingInvitesList } from './pending-invites-list';
import { CreateCompanyForm } from './create-company-form';

export function CompaniesScreen() {
  const { companies, activeCompanyId, setActiveCompanyId, refresh } = useCompany();

  return (
    <div className="mt-10 w-full max-w-2xl">
      <h2 className="text-lg font-semibold text-slate-900">Companies</h2>
      <p className="mt-1 text-sm text-slate-500">
        Switch between companies you belong to, or create a new one.
      </p>

      <table className="mt-6 w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-400">
            <th className="pb-2 font-medium">Name</th>
            <th className="pb-2 font-medium">Role</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {companies.map((m) => (
            <tr key={m.company.id} className="border-b border-slate-100">
              <td className="py-3 pr-4 font-medium text-slate-800">{m.company.name}</td>
              <td className="py-3 pr-4 capitalize text-slate-600">{m.role}</td>
              <td className="py-3 text-right">
                {m.company.id === activeCompanyId ? (
                  <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                    Current
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveCompanyId(m.company.id)}
                    className="rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                  >
                    Switch
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-8 empty:hidden">
        <PendingInvitesList onAccepted={(company) => refresh(company.id)} />
      </div>

      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-800">Create a company</h3>
        <p className="mt-1 text-xs text-slate-500">
          Running more than one business? Create another company — it gets its own projects,
          subs, and billing.
        </p>
        <div className="mt-4">
          <CreateCompanyForm onCreated={(company) => refresh(company.id)} />
        </div>
      </div>
    </div>
  );
}
