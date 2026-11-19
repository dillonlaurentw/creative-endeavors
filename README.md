# Creative Endeavors

The site at [creativeendeavors.xyz](https://creativeendeavors.xyz), served by GitHub Pages from this repository.
Plain HTML pages, plus the community pages (`/introductions/`, `/partners/`, `/sign-in/`), which are a prebuilt app in `community-assets/`.
Data lives in the site's Supabase project.

## Manage (`/manage/`)

The admin side of the site. Admins sign in with their site account and land on a Start screen with a box for the assistant and the common jobs.

- **Assistant**: tell it what happened in plain words, paste notes or guest lists, add photos. It finds or creates the event and the people, writes the summary and the story in Creative Endeavors' voice (from your notes and photos only, never invented), records who was there, attaches photos, makes connections and suggests who should meet. Anything that changes the public website (publishing, website words, deleting) waits for you to press **Approve**. Every step it takes is listed with a link.

- **Add an upcoming event** or **write up a past event**: name, date, place, a cover photo, a one-line summary, the story (what happened, or what to expect), a photo gallery and an RSVP link. Save as a draft, or put it on the website with one button. Each published event gets its own page at `/events/event/?e=<name-and-date>` with the story and photos.
- **Photos**: drag photos in or pick several at once; they're shrunk in the browser before upload, so phone photos are quick. Any photo can be made the cover.
- **Who was there**: type names separated by commas; anyone new is added to People automatically. Change each person's role in place, and connect everyone at an event in one click.
- **People**: add one person (with a photo), or paste a whole list of names and emails. Each person shows their events, their connections and the people they should meet (suggested from shared events and interests). Private notes are only ever seen by admins.
- **Connections**, **Website words** (the homepage and events page text), **Partners** and **Admins**.

The Start screen also lists past events that still need a write-up or photos.

## Setting up the database (once)

The site's data lives in a Supabase project that you own and sign in to at supabase.com.
Its address and public key are in one place: [`assets/ce.js`](assets/ce.js).

1. **Create the tables.** In the Supabase dashboard, open **SQL Editor → New query**, paste in all of
   [`supabase/setup.sql`](supabase/setup.sql) and press **Run**. It's safe to run again whenever that file changes; it never deletes data.
2. **Tell Supabase where the site is**, so sign-up and password emails link back to it:
   **Authentication → URL Configuration** → set **Site URL** to `https://creativeendeavors.xyz` and add
   `https://creativeendeavors.xyz/**` under **Redirect URLs**.
3. **Create your admin account.** Go to [creativeendeavors.xyz/manage/](https://creativeendeavors.xyz/manage/) → **Create an account**,
   using an email from the admin list at the top of `setup.sql`, and choose a password. Open the confirmation email, and you're in.
4. **More admins:** add their email in **/manage/ → Admins**. They create their account the same way.

Forgot your password? **/manage/ → Forgot your password?** emails you a link to choose a new one.

Keep **Authentication → Sign In / Providers → Email → Confirm email** switched on (it is by default):
admin access depends on people confirming they own their email address.

## Switching on the assistant (once)

The assistant runs on Claude through a small Supabase Edge Function, [`supabase/functions/ce-assistant`](supabase/functions/ce-assistant/index.ts), which keeps the Anthropic API key secret and only answers signed-in admins. The tools it uses run in the admin's browser with their own permissions.

1. Get an API key at [console.anthropic.com](https://console.anthropic.com) → API Keys.
2. In the Supabase dashboard: **Edge Functions → Secrets** → add `ANTHROPIC_API_KEY` with that key.
3. **Edge Functions → Deploy a new function → Via editor**, name it `ce-assistant`, paste in `supabase/functions/ce-assistant/index.ts`, and deploy.
   (Or with the Supabase CLI: `supabase functions deploy ce-assistant --project-ref <your project ref>`.)

Until then the Assistant tab says it isn't switched on yet; everything else works without it.
Each message costs a few cents of Claude usage (Claude Opus 5.5), billed to that API key.

## Who can see what

Enforced by row-level security in the database, not by the page:

| | Public | Signed-in non-admin | Admin |
|---|---|---|---|
| Published events, published partners, site text | read | read | read and change |
| Draft events, hidden partners | – | – | read and change |
| People, attendance, connections, admins | – | – | read and change |

The key in `assets/ce.js` is Supabase's public "publishable" key; it can only do what the public column allows. Never put the secret key in the site.

## Tests

- `supabase/tests/manage_test.sql` checks those rules and the connection functions, and `supabase/tests/members_test.sql` checks admins-by-email,
  members and introductions. Run them against a test database with `setup.sql` applied (see the comment at the top of each file);
  on a plain Postgres, run `supabase/tests/local_supabase_stub.sql` first. Both roll back.
- `tests/manage-ui.cjs` drives `/manage/` (including the assistant, with a scripted stand-in for Claude) and the public pages in a browser; see the comment at its top.

## Wiring more text to Site text

Add `data-content="some.key"` to an element on a page that loads `/assets/ce.js` and calls `CE.applyContent()`; then add `some.key` under Site text.
The page keeps its built-in words until the key is set.
