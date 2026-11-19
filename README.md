# Creative Endeavors

The site at [creativeendeavors.xyz](https://creativeendeavors.xyz), served by GitHub Pages from this repository.
Plain HTML pages, plus the community pages (`/introductions/`, `/partners/`, `/sign-in/`), which are a prebuilt app in `community-assets/`.
Data lives in the site's Supabase project.

## Manage (`/manage/`)

The admin side of the site. Admins sign in with their site account and land on a Start screen with the common jobs:

- **Add an upcoming event** or **write up a past event**: name, date, place, a cover photo, a one-line summary, the story (what happened, or what to expect), a photo gallery and an RSVP link. Save as a draft, or put it on the website with one button. Each published event gets its own page at `/events/event/?e=<name-and-date>` with the story and photos.
- **Photos**: drag photos in or pick several at once; they're shrunk in the browser before upload, so phone photos are quick. Any photo can be made the cover.
- **Who was there**: type names separated by commas; anyone new is added to People automatically. Change each person's role in place, and connect everyone at an event in one click.
- **People**: add one person (with a photo), or paste a whole list of names and emails. Each person shows their events, their connections and the people they should meet (suggested from shared events and interests). Private notes are only ever seen by admins.
- **Connections**, **Website words** (the homepage and events page text), **Partners** and **Admins**.

The Start screen also lists past events that still need a write-up or photos.

## Setting up the back end (once)

1. In the Supabase dashboard for this project, open **SQL Editor**, paste in
   [`supabase/migrations/20261119000000_manage.sql`](supabase/migrations/20261119000000_manage.sql) and run it.
   It's safe to run again. It creates the `ce_` tables, the `ce-photos` storage bucket, the rules for who can see what, and the functions behind connections and admins.
2. Make yourself the first admin. Sign up on the site if you haven't, then in the SQL Editor:

   ```sql
   insert into ce_admins (user_id, email)
   select id, email from auth.users where email = 'you@example.com';
   ```

   (Anyone already marked `is_admin` in `ce_members` is made an admin automatically by step 1.)
3. Go to `/manage/` and sign in. Add further admins from the Admins tab.

## Who can see what

Enforced by row-level security in the database, not by the page:

| | Public | Signed-in non-admin | Admin |
|---|---|---|---|
| Published events, published partners, site text | read | read | read and change |
| Draft events, hidden partners | – | – | read and change |
| People, attendance, connections, admins | – | – | read and change |

The key in `assets/ce.js` is Supabase's public "anon" key, the same one the community pages already use; it can only do what the public column allows.

## Tests

`supabase/tests/manage_test.sql` checks those rules and the connection functions. Run it against a test database with the migration applied
(see the comment at the top of the file); it rolls back and prints `All manage checks passed`.

## Wiring more text to Site text

Add `data-content="some.key"` to an element on a page that loads `/assets/ce.js` and calls `CE.applyContent()`; then add `some.key` under Site text.
The page keeps its built-in words until the key is set.
