# Keeping VTube Pro free: finding and reporting paid copies

VTube Pro is free, for everyone, for good. The [licence](../LICENSE) lets anyone run, change and share it for
noncommercial purposes and use it on their own streams. It does **not** let anyone sell it or run it as a paid,
subscription or ad-funded service. This page explains how a hosted copy identifies itself, how to find one, and what to
do about a copy that charges money.

## What VTube Pro does by itself

VTube Pro never reports anything to anyone. There is no tracking and no "phone home". Instead, every copy carries its
licence openly, so a hosted copy is easy to recognise:

| Where | What it says |
|---|---|
| Every page | `<meta name="vtube-pro-licence" content="…">` with the licence and the project address |
| Every answer of the server | The header `X-VTube-Pro-Licence: PolyForm-Noncommercial-1.0.0+streaming; not-for-sale; …` |
| `/licence.txt` and `/.well-known/vtube-pro-licence.txt` | The licence notice as plain text |
| Any page opened from a public address | A bar at the bottom: *"This copy of VTube Pro is hosted at … VTube Pro is free: nobody may charge you for it …"* |

A normal install only answers your own PC (and, if you switch it on, a second PC on your home network), so none of this
shows there. The bar appears only when a page is served from a public internet address.

These notices are part of the project's licence information. Removing or hiding them is itself outside the licence.
Somebody determined can still strip them from a fork; the steps below also work then, because the code, the page
structure and the file names stay recognisable.

## How to find hosted copies

Search for the fixed sentence that every copy carries:

> VTube Pro is free software for noncommercial use (PolyForm Noncommercial License 1.0.0). It may not be sold or
> offered as a paid, subscription or ad-funded service.

- **Web search:** put the sentence in quotes in a search engine.
- **Page-source search engines** (they index the HTML and headers of public websites): search for
  `vtube-pro-licence` or `X-VTube-Pro-Licence`.
- **Check one site:** open `https://<the site>/licence.txt`, or look at the page source for `vtube-pro-licence`.
- **Code hosts:** search GitHub and similar sites for distinctive file names such as `build_relay.mjs`,
  `licenseNotice.ts` or `Start VTube Pro.cmd` to find forks, then check what they do with them.

## Is it a violation?

Hosting a copy is fine. It becomes a violation when money is involved in the software itself, for example:

- a price, a subscription, a "pro" tier, a licence key or a paywall;
- advertising inside it or around it;
- it is bundled into a paid product or service;
- the `LICENSE` file or the licence notices were removed.

Streaming with VTube Pro on a monetised channel is **not** a violation: the licence allows it.

## What to do

1. **Save the evidence.** Screenshots of the pricing page and of the app, the address, the date, and the output of
   `/licence.txt` or the page source if the notices are still there.
2. **Tell the project.** Open an issue at <https://github.com/vtubepro/VTube-Pro-Public/issues> with the evidence.
3. **The copyright holder can act.** Only the copyright holder (and contributors, for their own contributions) can
   enforce the licence. The usual steps, in order:
   - write to the operator, quote the licence and give them 32 days to stop (the licence's own grace period for a
     first violation);
   - send a copyright takedown notice (DMCA or the local equivalent) to the hosting company, the domain registrar, the
     payment provider and any app store or marketplace carrying it. These companies act on such notices routinely;
   - for a fork on GitHub, use GitHub's DMCA takedown form.
4. **Warn people.** If you paid for a copy, ask for your money back and tell others where the free original is.

This page is practical guidance, not legal advice.
