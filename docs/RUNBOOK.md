# Daily run

Twice a day: the **morning run** at about 09:00 IST writes the day's edition, and the **evening run** at about
21:00 IST adds what came in since. Each has a retry 29 minutes later. Run these steps in order and obey the daily-run
rules in `CLAUDE.md`. All dates and times are IST: `TZ=Asia/Kolkata date '+%F %H:%M'`.

1. **Which run, and is it done?** `git checkout main && git pull`, then read `content/latest.json`.
   - Before 15:00 IST it is the **morning run**. If `"edition"` is today and `published_at` is 08:30 or later, stop:
     the run is done. (An edition published earlier that day, an overnight refresh, is redone with the morning's
     news.)
   - From 15:00 IST it is the **evening run**. If `"edition"` is today and `updated_at` is 20:30 or later, stop: the
     run is done. If `"edition"` is not today (the morning run failed), write a full edition as in the morning.

2. **Fetch.** `npm ci`, then `node scripts/fetch.mjs`. It writes `pool/YYYY-MM-DD.json`, prints one line per source,
   and ends with the **brand check**: every brand we follow and what was found for it. A source that fails is listed
   as failed; carry on. In the evening the pool also holds `this_morning`, the morning's edition.

3. **Read** `docs/DESK.md` and `pool/YYYY-MM-DD.json`. Nothing else.

4. **Choose and write** `content/editions/YYYY-MM-DD.json`, following `docs/DESK.md`.
   - **Morning:** the news, the trending picks, new events, upcoming launches, brand videos and aftermarket
     accessories. Set `published_at` to the time now in IST.
   - **Evening:** start from the morning's file as it is. Keep every item exactly as it is and add only what is new
     since the morning (see "The evening run" in `docs/DESK.md`). Replace `trends_summary` and `trending` with the
     evening's figures. Keep `published_at`; set `updated_at` to the time now in IST.

5. **Validate.** `node scripts/validate.mjs content/editions/YYYY-MM-DD.json`. Fix only what it reports and run it
   again. If the same error survives three fixes, stop without pushing and say what failed; the retry runs 29 minutes
   later.

6. **Publish.** `node scripts/publish.mjs content/editions/YYYY-MM-DD.json`. It also updates `content/events.json`,
   `content/trends.json`, `content/upcoming.json` and `content/brands.json`, and deletes editions older than 30 days.
   Then one commit and push:
   ```
   git add content pool
   git commit -m "Edition YYYY-MM-DD"            # evening: "Edition YYYY-MM-DD (evening)"
   git push origin main
   ```
   If `main` moved: `git pull --rebase origin main` and push again.

7. **Verify.** Fetch `https://bikenews.vercel.app/content/latest.json` every 30 seconds until it shows today's
   `edition` (and, in the evening, the new `updated_at`), for up to 5 minutes. Report the outcome: the number of
   stories (added this run, and in all), the lead, the brand check (brands with something new, and any that could not
   be read), and any failed sources.

## Dry run (for tuning DESK.md)

Steps 2 to 5 only, on any branch, with no publish, commit or push. Delete the edition file afterwards, or keep it out
of the commit.
