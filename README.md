# Creative Endeavors

The site at [creativeendeavors.xyz](https://creativeendeavors.xyz), served by GitHub Pages from this repository.
Plain HTML pages, plus the community pages (`/introductions/`, `/partners/`, `/sign-in/`), which are a prebuilt app in `community-assets/`.
Data lives in the site's Supabase project.

## Manage (`/manage/`)

The admin side of the site. Admins sign in with their site account and can:

- **Events**: add upcoming and past events, keep drafts, publish them to `/events/`, and record who was there and in what role (host, speaker, performer, artist, attendee, volunteer, partner).
- **People**: everyone in the community: contact details, what they do, disciplines, tags, links, bio, and private notes only admins see. Each person shows their events, their connections, and suggested connections.
- **Connections**: connect two people (met, collaborated, introduced, mentor, friends), optionally at an event. "Connect everyone who was there" on an event connects all its attendees at once. Suggestions rank people who were at the same events (strongest) or share disciplines and tags.
- **Partners**: saved and ready for the Partners page.
- **Site text**: change the words on the home and events pages without editing code.
- **Admins**: add admins by the email they sign in with; remove them (never yourself).

## Setting up the back end (once)

1. In the Supabase dashboard for this project, open **SQL Editor**, paste in
   [`supabase/migrations/20261119000000_manage.sql`](supabase/migrations/20261119000000_manage.sql) and run it.
   It's safe to run again. It creates the `ce_` tables, the rules for who can see what, and the functions behind connections and admins.
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
