# Daily run

Run these steps in order, once a day, at about 09:00 IST. Obey the daily-run rules in `CLAUDE.md`. All dates are the
IST date: `TZ=Asia/Kolkata date +%F`.

1. **Already done?** `git checkout main && git pull`. If `content/latest.json` has `"edition"` equal to today's IST
   date, stop: the run is done.

2. **Fetch.** `npm ci`, then `node scripts/fetch.mjs`. It writes `pool/YYYY-MM-DD.json` and prints one line per
   source. A source that fails is listed as failed; carry on.

3. **Read** `docs/DESK.md` and `pool/YYYY-MM-DD.json`. Nothing else.

4. **Choose and write** `content/editions/YYYY-MM-DD.json`, following `docs/DESK.md`: the news, the trending picks,
   new events and new aftermarket accessories. Set `published_at` to the time now in IST.

5. **Validate.** `node scripts/validate.mjs content/editions/YYYY-MM-DD.json`. Fix only what it reports and run it
   again. If the same error survives three fixes, stop without pushing and say what failed; the retry runs at 09:29.

6. **Publish.** `node scripts/publish.mjs content/editions/YYYY-MM-DD.json`. It also updates `content/events.json` and
   `content/trends.json`, and deletes editions older than 5 days. Then one commit and push:
   ```
   git add content pool
   git commit -m "Edition YYYY-MM-DD"
   git push origin main
   ```
   If `main` moved: `git pull --rebase origin main` and push again.

7. **Verify.** Fetch `https://bikenews.vercel.app/content/latest.json` every 30 seconds until it shows
   today's `edition`, for up to 5 minutes. Report the outcome: the number of stories, the lead, and any failed sources.

## Dry run (for tuning DESK.md)

Steps 2 to 5 only, on any branch, with no publish, commit or push. Delete the edition file afterwards, or keep it out
of the commit.
