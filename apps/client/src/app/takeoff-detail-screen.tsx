import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { BidSharingMode, HousePlan, PricingMatrix, Subcontractor, Takeoff } from '../lib/supabase';
import { getTakeoff } from '../lib/supabase';
import { TakeoffView } from './takeoff-view';

interface TakeoffDetailScreenProps {
  plans: HousePlan[];
  pricingMatrix: PricingMatrix;
  bidSharingMode: BidSharingMode;
  subcontractors: Subcontractor[];
  mySubIds: string[];
  onSubcontractorAdded: (sub: Subcontractor) => void;
}

export function TakeoffDetailScreen({
  plans,
  pricingMatrix,
  bidSharingMode,
  subcontractors,
  mySubIds,
  onSubcontractorAdded,
}: TakeoffDetailScreenProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [takeoff, setTakeoff] = useState<Takeoff | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getTakeoff(id)
      .then(setTakeoff)
      .catch(() => navigate(-1))
      .finally(() => setLoading(false));
  }, [id, navigate]);

  const plan = takeoff ? plans.find((p) => p.id === takeoff.plan_id) : null;

  // For subs viewing a delegated takeoff, they won't own the plan —
  // fall back to the Claude-generated project name from the takeoff data.
  const planName = plan?.file_name ?? takeoff?.data.projectName ?? 'Plan';

  // Determine if this is a sub view so Back navigates correctly.
  const mySubIdSet = new Set(mySubIds);
  const isSubView = takeoff
    ? Object.values(takeoff.data.bid?.delegations ?? {}).some(
        (del) => mySubIdSet.has(del.subId),
      )
    : false;

  return (
    <section className="mt-10 w-full">
      <button
        type="button"
        onClick={() => (isSubView ? navigate('/my-work') : navigate(-1))}
        className="flex items-center gap-1.5 text-sm font-medium text-slate-500 transition-colors hover:text-slate-800"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
        Back
      </button>

      {loading && <p className="mt-10 text-sm text-slate-500">Loading…</p>}

      {!loading && takeoff && (
        <TakeoffView
          takeoff={takeoff}
          planName={planName}
          pricingMatrix={pricingMatrix}
          bidSharingMode={bidSharingMode}
          subcontractors={subcontractors}
          mySubIds={mySubIds}
          onSubcontractorAdded={onSubcontractorAdded}
        />
      )}
    </section>
  );
}
