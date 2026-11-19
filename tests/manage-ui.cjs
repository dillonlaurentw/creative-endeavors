// Drives /manage/ and the public pages in a browser against an in-memory
// stand-in for Supabase (a subset of PostgREST, Auth, Storage and the
// ce-assistant function, with a scripted stand-in for Claude). Database rules
// are tested separately in supabase/tests/manage_test.sql.
//
// Serve the site on port 8766 (python3 -m http.server 8766), then:
//   node tests/manage-ui.cjs <dir for screenshots> <path to supabase.js UMD>
const { chromium } = require('playwright');
const fs = require('fs');
const S = process.argv[2];
// The database address, read from the site's own settings file.
const SUPA = fs.readFileSync(__dirname + '/../assets/ce.js', 'utf8').match(/var URL = "([^"]+)"/)[1];
// The supabase-js browser build, pinned like manage/index.html: npm pack @supabase/supabase-js@2.45.4, untar, pass package/dist/umd/supabase.js.
const UMD = fs.readFileSync(process.argv[3]);
const ADMIN = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com', aud: 'authenticated', role: 'authenticated' };
let n = 0; const uid = () => '00000000-0000-4000-8000-' + String(++n).padStart(12, '0');
const db = { ce_events: [], ce_people: [], ce_event_people: [], ce_connections: [], ce_partners: [], ce_site_content: [], ce_admins: [{ email: ADMIN.email, created_at: new Date().toISOString() }] };
const keyOf = { ce_event_people: ['event_id', 'person_id'], ce_site_content: ['key'], ce_admins: ['email'] };
const calls = [];
function filt(rows, q) {
  for (const [k, v] of q) {
    if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
    if (k === 'or') { const m = v.match(/person_a\.eq\.([^,]+),person_b\.eq\.([^)]+)/); rows = rows.filter(r => r.person_a === m[1] || r.person_b === m[2]); continue; }
    const [op, ...rest] = v.split('.'); const val = rest.join('.');
    if (op === 'eq') rows = rows.filter(r => String(r[k]) === val);
    if (op === 'is') rows = rows.filter(r => String(r[k]) === val);
  }
  return rows;
}
function rpc(fn, a) {
  if (fn === 'ce_is_admin') return true;
  if (fn === 'ce_connect_event') {
    const ids = db.ce_event_people.filter(x => x.event_id === a.p_event).map(x => x.person_id).sort(); let made = 0;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (!db.ce_connections.some(c => c.person_a === ids[i] && c.person_b === ids[j] && c.kind === 'met')) { db.ce_connections.push({ id: uid(), person_a: ids[i], person_b: ids[j], kind: 'met', event_id: a.p_event, created_at: new Date().toISOString() }); made++; }
    return made;
  }
  if (fn === 'ce_connection_suggestions') {
    const me = db.ce_people.find(p => p.id === a.p_person); const myEv = db.ce_event_people.filter(x => x.person_id === me.id).map(x => x.event_id);
    const conn = db.ce_connections.filter(c => c.person_a === me.id || c.person_b === me.id).map(c => c.person_a === me.id ? c.person_b : c.person_a);
    const mine = [...me.disciplines, ...me.tags].map(s => s.toLowerCase());
    return db.ce_people.filter(p => p.id !== me.id && !conn.includes(p.id)).map(p => {
      const se = db.ce_event_people.filter(x => x.person_id === p.id && myEv.includes(x.event_id)).length;
      const common = [...new Set([...p.disciplines, ...p.tags].map(s => s.toLowerCase()).filter(s => mine.includes(s)))];
      return { person_id: p.id, first_name: p.first_name, last_name: p.last_name, headline: p.headline, score: se * 3 + common.length, shared_events: se, shared_interests: common };
    }).filter(x => x.score > 0).sort((x, y) => y.score - x.score);
  }
  if (fn === 'ce_add_admin') { const row = { email: a.p_email.trim().toLowerCase(), created_at: new Date().toISOString() }; db.ce_admins.push(row); return row; }
  if (fn === 'ce_remove_admin') { db.ce_admins = db.ce_admins.filter(x => x.email !== a.p_email); return true; }
}
const files = {};
let fnCalls = [];
function fakeClaude(body) {
  const msgs = body.messages; fnCalls.push(msgs);
  const last = msgs[msgs.length - 1];
  const results = Array.isArray(last.content) ? last.content.filter(b => b.type === 'tool_result') : [];
  const parse = (i) => { try { return JSON.parse(results[i].content); } catch { return results[i] && results[i].content; } };
  const turn = msgs.filter(m => m.role === 'assistant').length;
  const firstText = msgs[0].content.find(b => b.type === 'text').text;
  const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });
  if (turn === 0) return { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, tu('t1', 'search_events', { query: 'Founders Dinner', when: 'any' }), tu('t2', 'search_people', { query: 'Maya Chen' })], stop_reason: 'tool_use' };
  if (turn === 1) return { content: [tu('t3', 'save_event', { title: 'Studio Supper', starts_at: '2026-11-13T19:00', venue: 'The Loft', city: 'Brooklyn', description: 'Twelve founders around one table.', story: 'Maya Chen opened her studio for the evening.\n\nThe talk ran late.' })], stop_reason: 'tool_use' };
  if (turn === 2) { const ev = parse(0); return { content: [tu('t4', 'add_people_to_event', { event_id: ev.id, people: [{ name: 'Maya Chen', role: 'host' }, { name: 'Sam Ortiz', role: 'attendee' }] }), tu('t5', 'attach_photos', { event_id: ev.id, photo_ids: ['photo-1', 'photo-2'], cover_photo_id: 'photo-2' })], stop_reason: 'tool_use' }; }
  if (turn === 3) { const ev = msgs[msgs.length - 2].content[0].input.event_id; return { content: [{ type: 'text', text: 'Done. One more thing:' }, tu('t6', 'propose_publish', { event_id: ev, publish: true })], stop_reason: 'tool_use' }; }
  if (turn === 4) { const r = parse(0); return { content: [{ type: 'text', text: r.approved ? 'Studio Supper is live, with 2 photos and Maya as host.' : 'Left as a draft.' }], stop_reason: 'end_turn' }; }
  return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
}
async function handle(route) {
  const req = route.request(), u = new URL(req.url()), method = req.method();
  if (u.pathname.startsWith('/storage/v1/object/public/ce-photos/')) { const f = files[u.pathname.split('/ce-photos/')[1]]; return f ? route.fulfill({ status: 200, contentType: 'image/jpeg', body: f }) : route.fulfill({ status: 404 }); }
  if (u.pathname.startsWith('/storage/v1/object/ce-photos/') && method === 'POST') { const key = u.pathname.split('/ce-photos/')[1]; const raw = req.postDataBuffer(); const ct = req.headers()['content-type'] || '';
    if (ct.startsWith('multipart/')) { const bnd = Buffer.from('--' + ct.split('boundary=')[1]); let i = raw.indexOf(Buffer.from('Content-Type: image')); i = raw.indexOf(Buffer.from('\r\n\r\n'), i) + 4; const end = raw.indexOf(bnd, i) - 2; files[key] = raw.subarray(i, end); } else files[key] = raw; calls.push('UPLOAD ' + key + ' ' + files[key].length); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'ce-photos/' + key }) }); }
  const json = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: body === undefined ? '' : JSON.stringify(body) });
  if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
  if (u.pathname === '/auth/v1/token') {
    const b = req.postDataJSON();
    if (b.password !== 'right-password') return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 400 });
    return json(200, { access_token: 'x.' + Buffer.from(JSON.stringify({ sub: ADMIN.id, exp: 9999999999 })).toString('base64url') + '.y', token_type: 'bearer', expires_in: 3600, expires_at: 9999999999, refresh_token: 'r', user: ADMIN });
  }
  if (u.pathname === '/auth/v1/user') return json(200, ADMIN);
  if (u.pathname === '/auth/v1/logout') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  if (u.pathname === '/functions/v1/ce-assistant') { if (!(req.headers()['authorization'] || '').startsWith('Bearer x.')) return json(403, { error: 'Admins only.' }); return json(200, fakeClaude(req.postDataJSON())); }
  const m = u.pathname.match(/^\/rest\/v1\/(rpc\/)?(\w+)$/);
  if (!m) return json(404, {});
  calls.push(method + ' ' + u.pathname + u.search);
  if (m[1]) return json(200, rpc(m[2], req.postDataJSON() || {}));
  const t = m[2], q = [...u.searchParams], single = (req.headers()['accept'] || '').includes('vnd.pgrst.object');
  let rows = db[t];
  if (method === 'GET') {
    rows = filt(rows, q);
    const order = u.searchParams.get('order');
    if (order) { const keys = order.split(',').map(o => o.split('.')).reverse(); for (const [k, dir] of keys) rows = [...rows].sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? '')) * (dir === 'desc' ? -1 : 1)); }
    return json(200, rows);
  }
  if (method === 'POST') {
    const body = [].concat(req.postDataJSON()), out = [], upsert = (req.headers()['prefer'] || '').includes('merge-duplicates');
    for (const b of body) {
      const pk = keyOf[t] || ['id'];
      const ex = upsert && rows.find(r => pk.every(k => r[k] === b[k]));
      if (ex) { Object.assign(ex, b, { updated_at: new Date().toISOString() }); out.push(ex); continue; }
      const row = { id: uid(), slug: t === 'ce_events' ? (b.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + (b.starts_at || '').slice(0, 10) : undefined, photos: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString(), disciplines: [], tags: [], links: [], ...b };
      if (t === 'ce_connections' && row.person_a > row.person_b) [row.person_a, row.person_b] = [row.person_b, row.person_a];
      if (t === 'ce_connections' && rows.some(r => r.person_a === row.person_a && r.person_b === row.person_b && r.kind === row.kind)) return json(409, { code: '23505', message: 'duplicate key value violates unique constraint' });
      rows.push(row); out.push(row);
    }
    return json(201, single ? out[0] : out);
  }
  if (method === 'PATCH') { const hit = filt(rows, q); hit.forEach(r => Object.assign(r, req.postDataJSON(), { updated_at: new Date().toISOString() })); return json(200, single ? hit[0] : hit); }
  if (method === 'DELETE') { const hit = new Set(filt(rows, q)); db[t] = rows.filter(r => !hit.has(r)); return json(204); }
}

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  await ctx.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: UMD }));
  await ctx.route(SUPA + '/**', handle);
  // Three test photos (big, so shrinking is exercised).
  const maker = await ctx.newPage();
  const photos = [];
  for (const [i, c] of ['#c96', '#69c', '#9c6'].entries()) {
    await maker.setContent(`<div style="width:3000px;height:2000px;background:linear-gradient(135deg,${c},#222)"></div>`);
    await maker.setViewportSize({ width: 3000, height: 2000 });
    const f = S + `/photo${i}.png`; await maker.screenshot({ path: f }); photos.push(f);
  }
  await maker.close();
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());
  const ok = (cond, what) => { if (!cond) throw new Error('FAILED: ' + what); console.log('ok -', what); };
  const statusHas = (t) => p.waitForFunction((t) => document.querySelector('#status').textContent.includes(t), t);
  const go = async (hash, sel) => { await p.goto('http://localhost:8766/manage/' + hash); await p.waitForSelector(sel); };

  await p.goto('http://localhost:8766/manage/');
  await p.waitForSelector('#sign-in:not([hidden])');
  await p.fill('#si-email', 'admin@example.com'); await p.fill('#si-password', 'wrong'); await p.click('#sign-in button');
  await p.waitForFunction(() => document.querySelector('#si-status').textContent.includes('don’t match'));
  ok(true, 'wrong password rejected');
  await p.fill('#si-password', 'right-password'); await p.click('#sign-in button');
  await p.waitForSelector('text=What would you like to do?');
  ok(true, 'admin lands on the Start screen');
  await p.screenshot({ path: S + '/m-start-empty.png' });

  // Write up a past event from the Start screen, with photos.
  await p.click('text=Write up a past event'); await p.waitForSelector('h2:has-text("Write up a past event")');
  ok(await p.isVisible('label:has-text("The story: what happened")'), 'past event asks for the story');
  await p.click('.actions button:has-text("Save as draft")'); await statusHas('Give the event a name');
  ok(true, 'missing name explained');
  await p.fill('#ev-title', 'Opening Salon'); await p.fill('#ev-when', '2026-09-12T18:30'); await p.fill('#ev-venue', 'Gallery 9'); await p.fill('#ev-city', 'New York');
  await p.fill('#ev-summary', 'Where it started: forty people, one long table.');
  await p.fill('#ev-story', 'We opened the doors at half six.\n\nBy nine the room was full of people who had never met.');
  await p.setInputFiles('.field:has(.cover-box) input[type=file]', photos[0]);
  await p.waitForSelector('.cover img'); ok(true, 'cover photo uploaded and shown');
  await p.setInputFiles('.gallery + div input[type=file]', [photos[1], photos[2]]);
  await p.waitForFunction(() => document.querySelectorAll('.gallery .ph').length === 2); ok(true, 'two gallery photos uploaded');
  const up = calls.filter(c => c.startsWith('UPLOAD'));
  ok(up.length === 3 && up.every(c => c.includes('.jpg') && Number(c.split(' ')[2]) < 1500000), 'photos shrunk to JPEG before upload');
  await p.click('.actions button:has-text("Save and put on the website")'); await statusHas('on the website now');
  const salon = db.ce_events[0];
  ok(salon.published && salon.photos.length === 2 && salon.cover_url && salon.story.includes('half six'), 'past event saved with story, cover, photos, published');
  await p.waitForSelector('.pill.live'); ok(await p.isVisible('text=View on website'), 'shows it is live with a link');

  // Who was there: names typed, new ones become people.
  await p.fill('#who-names', 'Ada Lovelace, Cy Twombly, Dee Rees'); await p.click('.who-box button:has-text("Add")');
  await statusHas('3 new to People'); await p.waitForSelector('.pchip >> text=Dee Rees');
  ok(db.ce_people.length === 3 && db.ce_event_people.length === 3, 'typed names created people and attendance');
  await p.selectOption('.pchip:has-text("Ada Lovelace") select', 'host'); await statusHas('Updated');
  ok(db.ce_event_people.find(x => x.role === 'host'), 'role changed inline');
  await p.click('text=Connect everyone here with each other'); await statusHas('3 new connections');
  ok(db.ce_connections.length === 3, 'connect everyone');
  await p.screenshot({ path: S + '/m-event.png', fullPage: true });

  // Upcoming event.
  await go('#events/new', '#ev-title');
  ok(await p.isVisible('label:has-text("What to expect")'), 'upcoming asks what to expect');
  await p.fill('#ev-title', 'Founders Dinner'); await p.fill('#ev-when', '2026-12-10T19:00'); await p.fill('#ev-city', 'Brooklyn'); await p.fill('#ev-link', 'not a link');
  await p.click('.actions button:has-text("Save as draft")'); await statusHas('https://');
  await p.fill('#ev-link', 'https://rsvp.example'); await p.click('.actions button:has-text("Save as draft")'); await statusHas('draft');
  ok(db.ce_events.length === 2 && !db.ce_events[1].published, 'upcoming saved as draft');

  // People: paste a list, then add a photo to one.
  await go('#people/new', '#bulk');
  await p.fill('#bulk', 'Maya Chen, maya@example.com\nJordan Ellis\nAda Lovelace'); await p.click('text=Add everyone');
  await statusHas('2 added (1 were already there)');
  ok(db.ce_people.length === 5 && db.ce_people.find(x => x.email === 'maya@example.com').last_name === 'Chen', 'pasted list adds new people, skips existing');
  const ada = db.ce_people.find(x => x.first_name === 'Ada');
  await go('#people/' + ada.id, '#p-name');
  await p.setInputFiles('.photo-row input[type=file]', photos[1]); await p.waitForSelector('.photo-row img.avatar');
  await p.fill('#p-headline', 'Founder, Analytical Studio'); await p.fill('#p-links', '@ada'); await p.fill('#p-notes', 'Wants to meet investors');
  await p.click('details.more summary'); await p.fill('#p-disc', 'Design, Software');
  await p.click('button:has-text("Save changes")'); await statusHas('Saved');
  const ada2 = db.ce_people.find(x => x.id === ada.id);
  ok(ada2.photo_url && ada2.links[0] === 'https://instagram.com/ada' && ada2.disciplines.length === 2, 'person saved with photo, Instagram handle, interests');
  await p.waitForSelector('.items >> text=Opening Salon'); ok(true, 'person shows their events');
  await p.screenshot({ path: S + '/m-person.png', fullPage: true });

  // Website words.
  await go('#content', '#c-home-lede');
  await p.fill('#c-home-lede', 'A think tank for creative people.'); await p.click('.content-item:has(#c-home-lede) button'); await statusHas('live');
  ok(db.ce_site_content[0].value === 'A think tank for creative people.', 'website words saved');

  // Start screen now shows what's coming and what needs work.
  await go('#start', '.cards'); ok(await p.isVisible('text=Coming up') && await p.isVisible('.ev-list >> text=Founders Dinner'), 'start shows upcoming');
  await p.screenshot({ path: S + '/m-start.png' });

  // Connections tab and admins still work.
  await go('#connections', 'text=All connections'); await p.waitForSelector('.stat'); ok((await p.textContent('.stats')).includes('3connections'), 'connections overview');
  await go('#admins', '#ad-email'); await p.fill('#ad-email', 'new@example.com'); await p.click('text=Add admin'); await p.waitForSelector('.items >> text=new@example.com'); ok(true, 'admin added');

  // Assistant: from the Start screen, with photos.
  await go('#start', '#quick-ask');
  await p.fill('#quick-ask', 'Add last Friday’s Founders Dinner at The Loft, Maya hosted, Sam came.');
  await p.setInputFiles('.composer.compact input[type=file]', [photos[0], photos[2]]);
  await p.click('.composer.compact button[type=submit]');
  await p.waitForSelector('.msg.approve .btn.accent');
  ok(await p.isVisible('.msg.you img') && await p.isVisible('.msg.action >> text=Created “Studio Supper” (draft)'), 'assistant chat shows photos and what it did');
  const fd = db.ce_events.find(e => e.title === 'Studio Supper');
  ok(fd && !fd.published && fd.photos.length === 2 && fd.cover_url === fd.photos[1] && fd.story.includes('studio'), 'assistant created the draft event with story and photos');
  ok(db.ce_people.some(x => x.first_name === 'Sam') && db.ce_event_people.filter(x => x.event_id === fd.id).length === 2, 'assistant added people (creating new ones)');
  const firstReq = fnCalls[0][0].content;
  ok(firstReq.filter(b => b.type === 'image').length === 2 && firstReq.find(b => b.type === 'text').text.includes('photo-1, photo-2') && firstReq.find(b => b.type === 'text').text.includes('local time'), 'photos and local time sent to the assistant');
  ok(fnCalls[1].some(m => m.role === 'assistant' && m.content.some(b => b.type === 'thinking')), 'assistant turns passed back unchanged');
  ok(!fd.published, 'nothing published before approval');
  await p.click('.msg.approve .btn.accent'); await p.waitForSelector('text=is live, with 2 photos');
  ok(db.ce_events.find(e => e.id === fd.id).published, 'published only after Approve');
  await p.screenshot({ path: S + '/m-assistant.png', fullPage: true });
  await p.reload(); await p.waitForSelector('.msg.bot >> text=is live'); ok(true, 'conversation survives a reload');

  // Phone.
  await p.setViewportSize({ width: 390, height: 844 });
  await go('#events/' + salon.id, '.cover img');
  ok(await p.evaluate(() => document.documentElement.scrollWidth <= 390), 'event editor fits a phone');
  await p.screenshot({ path: S + '/m-phone.png', fullPage: true });

  // Public pages.
  const pub = await ctx.newPage(); pub.on('pageerror', e => errors.push('public: ' + e.message));
  await pub.setViewportSize({ width: 1280, height: 900 });
  await pub.goto('http://localhost:8766/'); await pub.waitForFunction(() => document.querySelector('.lede').textContent.includes('creative people')); ok(true, 'home shows edited headline');
  await pub.goto('http://localhost:8766/events/'); await pub.waitForSelector('#past img');
  ok(!(await pub.isVisible('text=Founders Dinner')), 'draft not public');
  await pub.screenshot({ path: S + '/pub-events.png', fullPage: true });
  await pub.click('text=Read the story'); await pub.waitForSelector('.story');
  ok((await pub.$$('.story p')).length === 2 && (await pub.$$('.photos img')).length === 2, 'event page: story paragraphs and photos');
  await pub.screenshot({ path: S + '/pub-event.png', fullPage: true });
  await pub.click('.photos button >> nth=1'); await pub.waitForSelector('dialog[open]'); await pub.keyboard.press('ArrowRight');
  ok((await pub.textContent('#viewer-count')) === '1 / 2', 'photo viewer with arrows');
  await pub.keyboard.press('Escape');
  await pub.goto('http://localhost:8766/events/event/?e=nope'); await pub.waitForSelector('text=isn’t available'); ok(true, 'unknown event handled');
  await pub.setViewportSize({ width: 390, height: 844 });
  await pub.goto('http://localhost:8766/events/event/?e=' + salon.slug); await pub.waitForSelector('.story');
  ok(await pub.evaluate(() => document.documentElement.scrollWidth <= 390), 'event page fits a phone');
  await pub.screenshot({ path: S + '/pub-event-phone.png', fullPage: true });

  const real = errors.filter(e => !/fonts\.g|net::ERR|Failed to load resource/.test(e));
  console.log(real.length ? 'ERRORS:\n' + real.join('\n') : 'no page errors');
  await b.close();
  if (real.length) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
