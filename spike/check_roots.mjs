import { Connection, PublicKey } from "@solana/web3.js";

const TXLINE = new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
const conn = new Connection("https://api.devnet.solana.com", "confirmed");

const prog = await conn.getAccountInfo(TXLINE);
console.log("TxLINE devnet program:", prog ? `EXISTS executable=${prog.executable}` : "MISSING");

const todayEpochDay = Math.floor(Date.now() / 86400000);
console.log("today epochDay:", todayEpochDay, new Date().toISOString());
const leU16 = d => { const b = Buffer.alloc(2); b.writeUInt16LE(d); return b; };
for (let back = 0; back <= 20; back++) {
  const day = todayEpochDay - back;
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("daily_scores_roots"), leU16(day)], TXLINE);
  const info = await conn.getAccountInfo(pda);
  const d = new Date(day * 86400000).toISOString().slice(0, 10);
  console.log(`day ${day} (${d}): ${info ? `EXISTS ${info.data.length}B` : "missing"}`);
}
