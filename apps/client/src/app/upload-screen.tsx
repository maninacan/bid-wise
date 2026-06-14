import { useRef, useState } from 'react';
import { uploadHousePlan, type HousePlan } from '../lib/supabase';

interface UploadScreenProps {
  userId: string;
  onContinue: (plans: HousePlan[]) => void;
}

export function UploadScreen({ userId, onContinue }: UploadScreenProps) {
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | File[]) => {
    setError(null);
    setUploading(true);
    try {
      const uploaded: HousePlan[] = [];
      for (const file of Array.from(files)) {
        uploaded.push(await uploadHousePlan(userId, file));
      }
      onContinue(uploaded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <section className="mt-10 w-full max-w-2xl">
      <h1 className="text-center text-xl font-semibold text-slate-800">
        Upload your house plans
      </h1>
      <p className="mt-2 text-center text-sm text-slate-500">
        Add plan sets, drawings, or specs (PDF or images) to get started.
      </p>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
        }}
        className={`mt-8 flex flex-col items-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors ${
          dragging
            ? 'border-blue-500 bg-blue-50'
            : 'border-slate-300 bg-white hover:border-blue-400'
        }`}
      >
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-slate-400"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
          />
        </svg>
        <p className="mt-3 text-sm text-slate-600">
          Drag &amp; drop files here, or
        </p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="mt-3 rounded-lg bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {uploading ? 'Uploading…' : 'Browse files'}
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
          className="hidden"
          aria-label="Upload house plans"
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(e.target.files);
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-4 text-center text-sm text-red-600">
          {error}
        </p>
      )}
    </section>
  );
}
