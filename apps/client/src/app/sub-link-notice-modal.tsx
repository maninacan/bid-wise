import { useState } from 'react';

interface SubLinkNoticeModalProps {
  onClose: (permanent: boolean) => void;
}

export function SubLinkNoticeModal({ onClose }: SubLinkNoticeModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        {/* Icon + title */}
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-600" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 0 0-5.656 0l-4 4a4 4 0 1 0 5.656 5.656l1.102-1.101" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 0 0 5.656 0l4-4a4 4 0 1 0-5.656-5.656l-1.1 1.1" />
            </svg>
          </div>
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Your account has been linked
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">Account connection notice</p>
          </div>
        </div>

        {/* Body */}
        <div className="mt-4 space-y-3 text-sm text-slate-600">
          <p>
            One or more contractors already had your email address in their subcontractor list before you created your BidWise account. Your new account has been automatically connected to those records.
          </p>
          <p>
            This means contractors who have you on file can delegate work to you directly — you may see bid items, pricing requests, and project details they've shared with you.
          </p>
          <p className="text-slate-500">
            If you believe this connection is incorrect, contact the contractor directly or reach out to BidWise support.
          </p>
        </div>

        {/* Don't show again */}
        <label className="mt-5 flex cursor-pointer items-center gap-2.5">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={(e) => setDontShowAgain(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300 accent-blue-600"
          />
          <span className="text-sm text-slate-600">Don't show this again</span>
        </label>

        {/* Action */}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={() => onClose(dontShowAgain)}
            className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
