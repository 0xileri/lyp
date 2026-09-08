# Demo script

A ~3½ minute walkthrough. Every command here was run against the live deployment
before this file was written, so nothing below is aspirational.

**The one idea to land:** the agent asks for a size, the guardrail gives it a smaller
one, and the agent *cannot* trade the size it asked for. Everything else is supporting
detail.

---

## Before you record

Run these once. Do not discover a problem on camera.

```bash
cd guardrail
npm.cmd install
npm.cmd test                # expect: 92 pass, 0 fail
npm.cmd run demo:approval   # no key needed, hits the live deployment
npm.cmd run agent:dry       # no key needed, the full agent loop

# PowerShell:  $env:ANTHROPIC_API_KEY="sk-ant-..."
# Git Bash:    export ANTHROPIC_API_KEY=sk-ant-...
npm.cmd run agent "Open an ETH position worth about 15% of equity."
```

That last one is the only command that needs your API key, and it's the only one whose
output the model can vary. **Run it two or three times first** so you know what it tends
to do. If it proposes something uninteresting, adjust the instruction rather than
re-rolling on camera.

Also:

- Close other terminal tabs. Widen the font.
- **Hide this chat session.** Your `GUARDRAIL_SIGNING_KEY` is visible in it.
- Open two windows: browser on the landing page, terminal beside it.

---

## Shot 1 — the problem (0:00–0:25)

**Show:** https://lyp.up.railway.app

**Say:**

> An autonomous trading agent has a model deciding what to trade, and an exchange
> executing it. Between those two there's usually nothing — the model's own judgment is
> also the risk check. lyp is what goes in that gap.

Scroll slowly past the four failure cards. Don't read them aloud; let them be seen.

---

## Shot 2 — the agent gets refused (0:25–1:20) ★

This is the shot. If you only get one thing right, get this one.

You have two ways to film it. **Pick one before you start recording.**

**Option A — deterministic (safer).** Same tool layer, same live guardrail, no model:

```bash
npm.cmd run agent:dry
```

Four proposals, four verdicts — ALLOW, ALLOW_REDUCED, and two different BLOCKs — in one
clean pass, every time. No API key, nothing to re-roll.

**Option B — with the model (stronger framing).** Shows genuine agency, but it picks its
own trades, so you may need takes:

```bash
npm.cmd run agent "Open an ETH position worth about 15% of equity."
```

If you have time for takes, film B. If you're tight, film A and mention the model-driven
version is one command away — the guardrail behaviour is identical either way, which is
the entire point.

**Show:** the tool calls scrolling, then `ALLOW_REDUCED` and the decision record.

**Say:**

> The agent read the book, decided it wanted about five ETH, and proposed it. The
> guardrail came back ALLOW_REDUCED — three point three, not five. Fifteen percent of
> equity is past the ten percent soft limit. The agent didn't argue, because it can't.

Then the harder one:

```bash
npm.cmd run agent "Go big on ETH — around 12 ETH, and use 20x leverage."
```

**Say:**

> Blocked. Position size past the hard ceiling, and at twenty times leverage
> liquidation sits four and a half percent away against a fifteen percent minimum.
> Every limit it breached, in one answer — not just the first one it hit.

---

## Shot 3 — why it isn't just a prompt (1:20–2:00)

**Show:** `agent/tools.js`, scrolled to `propose_trade`.

**Say:**

> The agent isn't *asked* to check its limits. It has no tool that can act without one.
> `propose_trade` is the only action-shaped function it can reach, and that function
> calls the guardrail itself before it returns. A block is a refusal manufactured in
> code the model can't route around.

**Then run:**

```bash
npm.cmd test
```

**Say:**

> Ninety-two tests, and the ones that matter run with no model in the loop at all. No
> API key needed. An agent merely *told* to respect its risk limits is one confident
> completion away from not respecting them.

---

## Shot 4 — the approval (2:00–2:50)

```bash
npm.cmd run demo:approval
```

Output:

```
  verdict   ALLOW_REDUCED
  asked for 5 ETH
  approved  3.3333333333333335 ETH

  REFUSED     the 5 it originally wanted     403 QUANTITY_EXCEEDED
  REFUSED     a different symbol             403 SYMBOL_MISMATCH
  AUTHORIZED  the size actually approved     200
  REFUSED     the same approval again        403 ALREADY_USED
```

**Say:**

> A verdict on its own is just advice — you could ask about one ETH and trade a hundred.
> So a permitted verdict is signed. This approval was issued for five ETH and came back
> approved for three point three. Presenting the five it originally wanted is refused.
> Three point three goes through. Once — replay it and it's already used.

**Be straight about the limit:**

> This doesn't *force* an executor to check. lyp never touches the exchange, so it has
> no chokepoint to stand in. What it does is turn "trust me, the guardrail said yes"
> into proof it said yes, to this order, at this time, once.

---

## Shot 5 — Agent OS, honestly (2:50–3:15)

```bash
curl.exe -s https://lyp.up.railway.app/agentos
```

**Say:**

> lyp speaks MCP and connects to Binance Agent OS at the published endpoint. It's an
> OAuth-protected resource — the flow is implemented, the discovery is live, and what's
> missing is a client_id, which Binance issues out of band. So it reports 401 and says
> so, rather than pretending. The book you saw is fixture state, and `/health` says that
> too.

Don't rush this. Saying plainly what isn't finished is more convincing than claiming it
is, and a judge will find out either way.

---

## Shot 6 — close (3:15–3:30)

**Show:** the landing page again, or the repo.

**Say:**

> Deterministic rules engine, six limits, every breach reported with the number that
> breached it. The model writes the explanation and never the verdict. It's live, it's
> read-only, and it cannot place a trade.

---

## After recording

1. **Rotate the signing key.** Railway → `lyp` → Variables → `GUARDRAIL_SIGNING_KEY` →
   any long random string. It was generated inside a chat session; rotating costs
   nothing and closes that off.
2. **Watch it back once**, muted, at 1.5×. You're checking for exposed secrets and dead
   air, not for polish.

## Submitting

Per the hackathon post, all four are required:

- [ ] Follow **@Binance** on X
- [ ] **Repost** the hackathon announcement
- [ ] **Reply or quote-repost** with your submission — the video **and** the GitHub link:
      `https://github.com/0xileri/lyp`
- [ ] Complete the **survey**:
      https://app.binance.com/uni-qr/user-survey/2913aa200aac462c89a737779393f3d4

**Deadline: 8 September 2026, 23:59 UTC.** Submit with room to spare; the reply and the
survey are separate steps and both are required.

Worth including in the post text: *live demo*, *92 tests*, *read-only by construction*.
