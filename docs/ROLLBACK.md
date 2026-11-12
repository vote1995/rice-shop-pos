# Rolling back: the version without หมวด (category)

Production history of the owner menu page:

| What | Git ref | Notes |
|---|---|---|
| Before หมวด (type) existed | tag `backup-pre-category-v0.1.5` (commit `2551bb1`) | exactly what ran on production as v0.1.5 |
| Ready-to-deploy rollback | branch `rollback/pre-category-v0.1.5` (commit `c00cd19`) | v0.1.5 + the two CI fixes (`worker-build` pin) that the old workflow needs to deploy at all |
| With หมวด | tag `v0.1.6` (commit `f59e0d7`) | the current production version |

The หมวด value lives in the existing `menu_items.category` column, so rolling the code back loses nothing:
categories the owner typed stay in the database and simply stop being shown (every menu is then its own
group, as before). Rolling forward again restores the grouping.

## To roll production back
(Production release gate: an independent Opus review of the range must pass first.)

```
git fetch origin
git tag v0.1.7 c00cd19          # next free version number; the commit is reachable from main
git push origin v0.1.7          # CI + deploy run on the tag
```

Do NOT tag `2551bb1` / `v0.1.5` itself: its workflow installs the latest `worker-build`, which no longer builds
this project, so that deploy would fail.

## Stable markers
- `stable-v0.1.6` (commit `f59e0d7`, production v0.1.6) and branch `release/stable` — the current stable version.
- `stable-v1.0.0` / `release/1.0-stable` (commit `2551bb1`, v0.1.5) — the earlier marker, i.e. the version WITHOUT หมวด; same commit as `backup-pre-category-v0.1.5`.

## Cloudflare Access notes (operational)
- The only Access **Bypass** on `owner.*` is the exact path `/sw.js` (lets stuck devices fetch the self-destructing
  worker). Never widen it to a prefix/wildcard; never add bypasses for `/join*` or `/api/public/*` on the owner host.
- The member-join QR (owner console → สมาชิก) points at the **pos.\*** host, which is public.
- Add a WAF rate-limiting rule for `POST /api/public/join/*` on the pos hosts (generous per-IP: customers share the shop Wi-Fi).
