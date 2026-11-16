"use client";

export default function CombosError({ error, reset }) {
  return (
    <div className="m-4 rounded-lg border border-red-500/40 bg-red-500/10 p-4 text-sm">
      <h2 className="mb-2 font-semibold text-red-500">Combos page error</h2>
      <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-xs text-red-600 dark:text-red-300">
        {error?.stack || error?.message || String(error)}
      </pre>
      <button type="button" onClick={reset} className="mt-3 rounded bg-red-500 px-3 py-1 text-xs text-white">
        Retry
      </button>
    </div>
  );
}
