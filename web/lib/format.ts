/**
 * format.ts — tiny display helpers shared across pages.
 */

import { USDC_DECIMALS } from "./constants";

export function shortAddr(addr: string, chars = 4): string {
  return addr.length <= chars * 2 + 1 ? addr : `${addr.slice(0, chars)}…${addr.slice(-chars)}`;
}

/** Base units → "25" / "0.5" USDC-dev. */
export function fmtUsdc(baseUnits: number | bigint | string): string {
  const n = typeof baseUnits === "string" ? Number(baseUnits) : Number(baseUnits);
  const v = n / 10 ** USDC_DECIMALS;
  return v % 1 === 0 ? v.toString() : v.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function fmtSol(lamports: number): string {
  return (lamports / 1e9).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function fmtKickoff(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function strategyHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function matchMinute(clockSeconds: number | undefined): string {
  if (clockSeconds === undefined) return "";
  return `${Math.floor(clockSeconds / 60)}'`;
}
