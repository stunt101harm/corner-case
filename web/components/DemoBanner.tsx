import Link from "next/link";
import { DEMO_FIXTURE_ID } from "@/lib/constants";

/**
 * Shown on the markets page once no tournament fixture can go live anymore —
 * the app's answer to "judging happens after the final whistle".
 */
export function DemoBanner(): React.ReactNode {
  return (
    <div className="card relative overflow-hidden border-turf-600/50 bg-gradient-to-r from-pitch-800 to-pitch-900 p-6">
      <div className="pointer-events-none absolute -right-10 -top-10 h-48 w-48 rounded-full border-2 border-chalk/5" />
      <div className="pointer-events-none absolute -right-2 top-16 h-24 w-24 rounded-full border-2 border-chalk/5" />
      <p className="label text-turf-400">Judge demo mode</p>
      <h2 className="mt-1 text-xl font-bold text-chalk">
        The tournament is over — run the demo match.
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-chalk/70">
        England v Argentina (the semi-final, 1–2) replays from a real recording at 30×, and its
        TxLINE Merkle proofs are live on devnet right now. Create a market on it, accept, hit
        <span className="text-turf-300"> Settle now</span> — and trigger a real on-chain
        settlement yourself. No live matches needed.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href="/demo" className="btn-primary">
          Run the demo match
        </Link>
        <Link href={`/new?fixture=${DEMO_FIXTURE_ID}`} className="btn-ghost">
          Create a demo market
        </Link>
      </div>
    </div>
  );
}
