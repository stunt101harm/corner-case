# Demo video — shot list + narration (≤ 5:00)

Target: record the safety take from the replay flow as soon as the deployed
stack is verified; re-record with France v England live footage after the
Jul 18 match; final cut + upload (YouTube unlisted) morning of Jul 19.

Recording setup: 1080p+ screen capture, browser at 125% zoom, dark theme
everywhere, wallet extension ready with two profiles (Creator + Taker).
Cursor deliberate, no dead air — cut aggressively.

---

## 0:00–0:30 — Hook (slide + voice)

> "Every prop bet in crypto has the same dirty secret: somewhere, a wallet
> you don't control decides who won. Corner Case removes that wallet. Every
> market stores its winning condition as a TxLINE validation strategy at
> creation — and settlement is only possible with a Merkle proof that
> TxLINE's on-chain program verifies. No oracle account, no bookie,
> no admin key. Let me show you."

Slide: logo + one-liner + "TxLINE World Cup Hackathon".

## 0:30–1:20 — Create + accept ("what you sign is what settles")

Screen: deployed app, /new.
- Pick the demo fixture (England v Argentina). Pick "Total corners over 9.5".
- **Linger 3s on the strategy panel**: the human sentence, the 18 strategy
  bytes in hex, the pinned stat keys [7,8].
> "I'm betting there'll be more than nine corners. The app shows me the
> EXACT validation strategy being stored on-chain — corners of England plus
> corners of Argentina, greater than nine. What I sign is what settles.
> Nothing else can ever resolve this market."
- Sign create (Creator wallet). Switch to Taker profile, accept from the
  market page. Show the escrow account holding both stakes in the explorer
  (one tab pre-opened).
> "A second wallet takes the other side. Both stakes now sit in an escrow
> owned by the market account itself — a program address nobody has keys to."

## 1:20–2:50 — The match + permissionless settlement (replay)

Screen: market page, hit "Run demo match" (30× replay).
- Ticker fills: kickoff, corners, yellow cards, goals. Condition tracker
  climbs "corners 3… 5… 7 — needs > 9".
> "This is TxLINE's real recorded feed of the semifinal, replayed through
> the exact code path the live stream uses. Watch the condition tracker —
> the market only cares about provable stats."
- Full-time fires. Click **Settle now** — FROM THE TAKER WALLET.
> "The match is finalised. And here's the thesis: settlement is
> permissionless. ANYONE — the loser, a bot, one of the judges — can settle,
> because the caller brings only a Merkle proof. The proof either satisfies
> the stored strategy against TxLINE's on-chain daily root, or the
> transaction fails."
- Tx confirms; balance updates on the winning side.

## 2:50–3:50 — The receipt (the money shot)

Screen: receipt page of that settlement.
- Banner: "PROVEN TRUE/FALSE", winner, payout. Badge: "TxLINE validateStatV2
  ran on-chain in this tx" → click the explorer link, point at the inner
  CPI to TxLINE's program (pre-scrolled tab).
- Back to receipt → click **Re-verify in this browser**. Let the hash chain
  animate to completion.
> "Every settlement produces a receipt. This isn't a screenshot of an API —
> your browser just recomputed fourteen sha256 hashes from the raw stat
> leaves up TxLINE's Merkle tree, and every node matches. The final link —
> the daily root — was verified on-chain by TxLINE's own program inside the
> settlement transaction. Trust nobody, verify everything."

## 3:50–4:20 — Adversarial beat (check gates)

Screen: terminal, pre-staged command; then a slide.
- Run the prepared early-settle attempt against a mid-match proof (halftime
  seq 425) → on-chain rejection `ProofNotFinal`.
> "Can a keeper settle early with a mid-match proof, while 'no red cards so
> far' is still true? No — proof leaves carry the match status; our finality
> gate requires the game-finalised period on every leaf. Five check gates
> like this one guard settlement — including stat-key binding, which stops a
> valid proof of the WRONG stat from flipping a payout."
Slide: 5 gates table (one line each + the failure it prevents).

## 4:20–4:45 — Live-match proof (France v England footage)

B-roll: live ticker during the real 3rd-place match + the settle landing.
> "This wasn't just replays — during the third-place match, markets settled
> live, minutes after the final whistle, from TxLINE's real-time feed."
(If the live capture failed: cut this beat, extend the demo-mode framing.)

## 4:45–5:00 — Close (slide)

Architecture diagram mapped to the three judging criteria + links.
> "Two market templates today; any provable stat is one strategy away.
> Corner Case — prop bets where the pitch settles the bet, not a bookie.
> Everything you saw is live on devnet — links below. Go settle a market
> yourself."

---

## Pre-record checklist
- [ ] Two funded wallet profiles (use the deployed faucet on camera? — yes,
      show "Get test funds" briefly during 0:30 beat if pacing allows)
- [ ] Explorer tabs pre-opened: escrow account, settle tx (inner CPI visible)
- [ ] Demo market pre-created for backup; fresh one created on camera
- [ ] Early-settle rejection command staged in terminal
- [ ] Slides: hook, gates table, close (3 total, same theme as the app)
- [ ] Timer visible while recording; hard stop 5:00
