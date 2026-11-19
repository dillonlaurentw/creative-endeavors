/* Creative Endeavors · Manage
   Edit events, people, who came to what, connections, partners, the words on
   the public pages, and who the admins are. Everything goes straight to the
   site's Supabase database; row-level security there (supabase/migrations)
   is what actually keeps it admin-only. This page just hides itself from
   anyone who isn't an admin. All text from the database is written with
   textContent, never as HTML. */
(function () {
  "use strict";

  var sb = window.supabase.createClient(CE.url, CE.key, { auth: { storage: window.localStorage, persistSession: true, autoRefreshToken: true } });
  var me = null;            // signed-in user
  var people = [];          // all people, by first name
  var events = [];          // all events, newest first
  var personById = {}, eventById = {};

  var ROLES = ["host", "speaker", "performer", "artist", "attendee", "volunteer", "partner"];
  var KINDS = ["met", "collaborated", "introduced", "mentor", "friends"];
  var CONTENT = [
    { key: "home.lede", name: "Home: headline", hint: "A think tank for creatives." },
    { key: "home.intro", name: "Home: what we are", hint: "Paragraphs, separated by a blank line.", long: true },
    { key: "home.epigraph", name: "Quote at the foot of every page", hint: "“I can either spend my time designing the candle…” — Virgil Abloh", long: true },
    { key: "events.lede", name: "Events: headline", hint: "Events." },
    { key: "events.intro", name: "Events: introduction", hint: "Gatherings, conversations and experiences for people building creative endeavors.", long: true },
  ];

  // Little helpers ------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
  // h("div", {class: "x", onclick: fn}, child, "text", …)
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else if (k === "value") el.value = v;
      else if (k === "checked") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    });
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  var statusTimer;
  function say(text, kind) {
    var s = $("status");
    s.textContent = text || "";
    s.className = "status" + (kind ? " " + kind : "");
    clearTimeout(statusTimer);
    if (kind === "ok") statusTimer = setTimeout(function () { s.textContent = ""; s.className = "status"; }, 4000);
  }
  function fail(err, what) {
    console.error(err);
    var msg = (err && err.message) || "Something went wrong.";
    if (err && err.code === "23505") msg = "That already exists.";
    if (err && err.code === "23514") msg = "Something in the form isn’t valid (check links start with https://, and emails).";
    if (err && (err.code === "42501" || /row-level security/i.test(msg))) msg = "You don’t have permission to do that.";
    say((what ? what + ": " : "") + msg, "error");
  }
  function fullName(p) { return p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "Someone removed"; }
  function fmtDate(iso, withTime) {
    if (!iso) return "";
    var d = new Date(iso);
    var s = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    return withTime ? s + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : s;
  }
  // ISO ↔ <input type="datetime-local">, in the admin's own time zone.
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
  function list(v) { return (v || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean); }
  function lines(v) { return (v || "").split(/\n|,\s*(?=https?:)/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function clean(v) { v = (v == null ? "" : String(v)).trim(); return v === "" ? null : v; }
  function isPast(e) { var end = e.ends_at ? new Date(e.ends_at) : new Date(new Date(e.starts_at).setHours(23, 59, 59, 999)); return end < new Date(); }
  function matches(q, parts) { q = q.trim().toLowerCase(); return !q || parts.join(" ").toLowerCase().indexOf(q) !== -1; }

  // People and events are picked by typing a name (with suggestions).
  function personLabel(p) {
    var same = people.filter(function (x) { return fullName(x) === fullName(p); }).length > 1;
    return fullName(p) + (same ? " (" + (p.email || p.city || p.id.slice(0, 6)) + ")" : "");
  }
  function eventLabel(e) { return e.title + " · " + fmtDate(e.starts_at); }
  function refreshPickers() {
    $("dl-people").replaceChildren.apply($("dl-people"), people.map(function (p) { return h("option", { value: personLabel(p) }); }));
    $("dl-events").replaceChildren.apply($("dl-events"), events.map(function (e) { return h("option", { value: eventLabel(e) }); }));
  }
  function findPerson(label) { label = label.trim(); return people.find(function (p) { return personLabel(p) === label; }) || people.find(function (p) { return fullName(p).toLowerCase() === label.toLowerCase(); }); }
  function findEvent(label) { label = label.trim(); return events.find(function (e) { return eventLabel(e) === label; }) || events.find(function (e) { return e.title.toLowerCase() === label.toLowerCase(); }); }

  function loadPeople() {
    return sb.from("ce_people").select("*").order("first_name").order("last_name").limit(5000).then(function (r) {
      if (r.error) throw r.error;
      people = r.data; personById = {};
      people.forEach(function (p) { personById[p.id] = p; });
      refreshPickers();
    });
  }
  function loadEvents() {
    return sb.from("ce_events").select("*").order("starts_at", { ascending: false }).limit(5000).then(function (r) {
      if (r.error) throw r.error;
      events = r.data; eventById = {};
      events.forEach(function (e) { eventById[e.id] = e; });
      refreshPickers();
    });
  }

  // Generic editor: a form built from a list of fields -------------------------

  function field(f, row) {
    var id = "f-" + f.name, v = row ? row[f.name] : f.default;
    var input;
    if (f.type === "textarea") input = h("textarea", { id: id, name: f.name, rows: f.rows || 4, maxlength: f.max, placeholder: f.placeholder }, v || "");
    else if (f.type === "checkbox") return h("div", { class: "field" + (f.wide ? " wide" : "") }, h("span", { class: "label", text: " " }), h("label", { class: "check" }, h("input", { id: id, name: f.name, type: "checkbox", checked: v }), f.label));
    else if (f.type === "datetime") input = h("input", { id: id, name: f.name, type: "datetime-local", value: toLocalInput(v), required: f.required });
    else if (f.type === "list") input = h("input", { id: id, name: f.name, type: "text", value: (v || []).join(", "), placeholder: f.placeholder });
    else if (f.type === "lines") input = h("textarea", { id: id, name: f.name, rows: 3, placeholder: f.placeholder }, (v || []).join("\n"));
    else input = h("input", { id: id, name: f.name, type: f.type || "text", value: v == null ? "" : v, required: f.required, maxlength: f.max, placeholder: f.placeholder, list: f.list, inputmode: f.inputmode });
    return h("div", { class: "field" + (f.wide ? " wide" : "") }, h("label", { for: id, text: f.label + (f.required ? "" : "") }), input, f.help ? h("p", { class: "help", text: f.help }) : null);
  }
  function readForm(form, fields) {
    var out = {};
    fields.forEach(function (f) {
      var el = form.elements[f.name];
      if (f.type === "checkbox") out[f.name] = el.checked;
      else if (f.type === "datetime") out[f.name] = fromLocalInput(el.value);
      else if (f.type === "list") out[f.name] = list(el.value);
      else if (f.type === "lines") out[f.name] = lines(el.value);
      else if (f.type === "number") out[f.name] = el.value === "" ? 0 : Number(el.value);
      else out[f.name] = clean(el.value);
    });
    return out;
  }
  // Save/delete wiring shared by events, people and partners.
  function editor(opts) {
    var row = opts.row;
    var form = h("form", { class: "fields", novalidate: false }, opts.fields.map(function (f) { return field(f, row); }));
    var saveBtn = h("button", { class: "btn", type: "submit", text: row ? "Save" : opts.createText || "Add" });
    form.appendChild(h("div", { class: "actions" }, saveBtn,
      row ? null : h("button", { class: "btn ghost", type: "button", text: "Cancel", onclick: function () { location.hash = "#" + opts.tab; } }),
      h("span", { class: "spacer" }),
      row ? h("button", { class: "link danger", type: "button", text: "Delete", onclick: function () {
        if (!confirm(opts.confirmDelete(row))) return;
        sb.from(opts.table).delete().eq("id", row.id).then(function (r) {
          if (r.error) return fail(r.error, "Couldn’t delete");
          say("Deleted.", "ok");
          Promise.resolve(opts.after && opts.after()).then(function () { location.hash = "#" + opts.tab; render(); });
        });
      } }) : null));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!form.reportValidity()) return;
      var data = readForm(form, opts.fields);
      if (opts.check) { var problem = opts.check(data); if (problem) return say(problem, "error"); }
      saveBtn.disabled = true;
      var q = row ? sb.from(opts.table).update(data).eq("id", row.id).select().single() : sb.from(opts.table).insert(data).select().single();
      q.then(function (r) {
        saveBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t save");
        say(row ? "Saved." : "Added.", "ok");
        Promise.resolve(opts.after && opts.after()).then(function () {
          if (row) render(); else location.hash = "#" + opts.tab + "/" + r.data.id;
        });
      });
    });
    return form;
  }

  // Layout for list + editor tabs.
  function split(left, right) { return h("div", { class: "split" }, h("section", { "aria-label": "List" }, left), h("section", { class: "panel" }, right)); }
  var filters = { events: "upcoming", eventsQ: "", peopleQ: "", connQ: "" };
  function searchBox(key, placeholder, rerender) {
    var input = h("input", { type: "search", placeholder: placeholder, value: filters[key], "aria-label": placeholder });
    input.addEventListener("input", function () { filters[key] = input.value; rerender(); });
    return input;
  }

  // Events ----------------------------------------------------------------------

  var EVENT_FIELDS = [
    { name: "title", label: "Title", required: true, max: 200, wide: true },
    { name: "starts_at", label: "Starts", type: "datetime", required: true },
    { name: "ends_at", label: "Ends (optional)", type: "datetime" },
    { name: "kind", label: "Kind", list: "dl-kinds", max: 60, placeholder: "Dinner, salon, workshop…" },
    { name: "city", label: "City", max: 100 },
    { name: "venue", label: "Venue", max: 200, wide: true },
    { name: "description", label: "Description", type: "textarea", max: 4000, wide: true },
    { name: "link", label: "Link (RSVP or details)", type: "url", placeholder: "https://", wide: true },
    { name: "image_url", label: "Image link", type: "url", placeholder: "https://", wide: true },
    { name: "published", label: "Show on the Events page", type: "checkbox", wide: true },
  ];

  function eventsTab(id) {
    var listEl = h("ul", { class: "list" });
    var countEl = h("p", { class: "count" });
    function drawList() {
      var shown = events.filter(function (e) {
        var f = filters.events;
        var keep = f === "all" || (f === "drafts" ? !e.published : f === "past" ? isPast(e) : !isPast(e));
        return keep && matches(filters.eventsQ, [e.title, e.kind || "", e.city || "", e.venue || ""]);
      });
      if (filters.events === "upcoming") shown = shown.slice().reverse();
      listEl.replaceChildren.apply(listEl, shown.length ? shown.map(function (e) {
        return h("li", null, h("a", { class: "row", href: "#events/" + e.id, "aria-current": e.id === id ? "true" : null },
          h("span", { class: "t" }, e.title, e.published ? null : h("span", { class: "badge", text: "Draft" })),
          h("span", { class: "s", text: [fmtDate(e.starts_at, true), e.city].filter(Boolean).join(" · ") })));
      }) : [h("li", { class: "empty", text: events.length ? "No events match." : "No events yet. Add the first one." })]);
      countEl.textContent = shown.length + " of " + events.length + " events";
    }
    var chips = h("div", { class: "chips", role: "group", "aria-label": "Show" }, [["upcoming", "Upcoming"], ["past", "Past"], ["drafts", "Drafts"], ["all", "All"]].map(function (c) {
      return h("button", { class: "chip", type: "button", "aria-pressed": String(filters.events === c[0]), text: c[1], onclick: function (ev) {
        filters.events = c[0];
        chips.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", String(b === ev.currentTarget)); });
        drawList();
      } });
    }));
    drawList();
    var left = [h("div", { class: "toolbar" }, searchBox("eventsQ", "Search events", drawList), h("a", { class: "btn", href: "#events/new", text: "New event", role: "button" })), chips, listEl, countEl];

    var right;
    if (id === "new") right = [h("h2", { text: "New event" }), editor({ table: "ce_events", tab: "events", fields: EVENT_FIELDS, createText: "Add event", after: loadEvents, check: checkEvent })];
    else if (id && eventById[id]) right = eventPanel(eventById[id]);
    else if (id) right = [h("p", { class: "blank", text: "That event doesn’t exist any more." })];
    else right = [h("p", { class: "blank", text: "Choose an event, or add a new one. Past events can be added too: they show under Past on the Events page." })];
    return split(left, right);
  }
  function checkEvent(d) { if (d.ends_at && d.starts_at && d.ends_at < d.starts_at) return "The end has to be after the start."; }

  function eventPanel(e) {
    var who = h("ul", { class: "items" });
    var panel = [
      h("h2", { text: e.title }),
      h("p", { class: "hint", text: (e.published ? "On the Events page" : "Draft: not on the Events page") + " · " + (isPast(e) ? "Past" : "Upcoming") }),
      editor({ table: "ce_events", tab: "events", row: e, fields: EVENT_FIELDS, after: loadEvents, check: checkEvent, confirmDelete: function () { return "Delete “" + e.title + "”? Who came to it is deleted too; connections made there are kept."; } }),
      h("h3", { text: "Who was there" }),
      h("p", { class: "hint", text: isPast(e) ? "Everyone who came, and in what role." : "Hosts, speakers and who’s coming." }),
      who,
    ];
    var personIn = h("input", { type: "text", list: "dl-people", placeholder: "Type a name", "aria-label": "Person" });
    var roleIn = h("select", { "aria-label": "Role" }, ROLES.map(function (r) { return h("option", { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === "attendee" }); }));
    var addBtn = h("button", { class: "btn", type: "submit", text: "Add" });
    var adder = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { class: "label", text: "Person" }), personIn), h("div", { class: "field" }, h("label", { class: "label", text: "Role" }), roleIn), addBtn);
    adder.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var p = findPerson(personIn.value);
      if (!p) return say("Pick someone from the list, or add them under People first.", "error");
      sb.from("ce_event_people").upsert({ event_id: e.id, person_id: p.id, role: roleIn.value }).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t add them");
        personIn.value = ""; say(fullName(p) + " added.", "ok"); draw();
      });
    });
    var connectBtn = h("button", { class: "btn ghost", type: "button", text: "Connect everyone who was there", onclick: function () {
      connectBtn.disabled = true;
      sb.rpc("ce_connect_event", { p_event: e.id }).then(function (r) {
        connectBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t connect them");
        say(r.data ? r.data + " new connection" + (r.data === 1 ? "" : "s") + " (“met”) made." : "Everyone here is already connected.", "ok");
      });
    } });
    panel.push(adder, h("div", { class: "actions", style: "margin-top:16px" }, connectBtn));
    function draw() {
      sb.from("ce_event_people").select("person_id, role").eq("event_id", e.id).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t load who was there");
        var rows = r.data.sort(function (a, b) { return ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || fullName(personById[a.person_id]).localeCompare(fullName(personById[b.person_id])); });
        who.replaceChildren.apply(who, rows.length ? rows.map(function (x) {
          var p = personById[x.person_id];
          return h("li", null,
            h("span", { class: "main" }, h("a", { href: "#people/" + x.person_id, text: fullName(p) }), p && p.headline ? h("span", { class: "s", text: p.headline }) : null),
            h("span", { class: "side" }, h("span", { class: "s", text: x.role }),
              h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () {
                sb.from("ce_event_people").delete().eq("event_id", e.id).eq("person_id", x.person_id).then(function (d) { if (d.error) return fail(d.error); say("Removed.", "ok"); draw(); });
              } })));
        }) : [h("li", { class: "empty", text: "No one added yet." })]);
        connectBtn.hidden = rows.length < 2;
      });
    }
    draw();
    return panel;
  }

  // People ----------------------------------------------------------------------

  var PERSON_FIELDS = [
    { name: "first_name", label: "First name", required: true, max: 100 },
    { name: "last_name", label: "Last name", max: 100 },
    { name: "email", label: "Email", type: "email" },
    { name: "phone", label: "Phone", type: "tel", max: 40, inputmode: "tel" },
    { name: "headline", label: "What they do", max: 200, wide: true, placeholder: "Founder, Studio Nine · Designer" },
    { name: "disciplines", label: "Disciplines", type: "list", placeholder: "Design, film, music", help: "Separate with commas." },
    { name: "tags", label: "Tags", type: "list", placeholder: "Founder, speaker, 2026 cohort", help: "Separate with commas." },
    { name: "city", label: "City", max: 100 },
    { name: "pronouns", label: "Pronouns", max: 40 },
    { name: "bio", label: "Bio", type: "textarea", max: 4000, wide: true },
    { name: "links", label: "Links", type: "lines", placeholder: "https://…  (one per line)", wide: true },
    { name: "notes", label: "Private notes", type: "textarea", max: 8000, wide: true, help: "Only admins see these." },
  ];

  function peopleTab(id) {
    var listEl = h("ul", { class: "list" });
    var countEl = h("p", { class: "count" });
    function drawList() {
      var shown = people.filter(function (p) { return matches(filters.peopleQ, [fullName(p), p.email || "", p.headline || "", p.city || "", (p.disciplines || []).join(" "), (p.tags || []).join(" ")]); });
      listEl.replaceChildren.apply(listEl, shown.length ? shown.map(function (p) {
        return h("li", null, h("a", { class: "row", href: "#people/" + p.id, "aria-current": p.id === id ? "true" : null },
          h("span", { class: "t", text: fullName(p) }),
          h("span", { class: "s", text: [p.headline, p.city].filter(Boolean).join(" · ") || (p.disciplines || []).join(", ") || p.email || " " })));
      }) : [h("li", { class: "empty", text: people.length ? "No one matches." : "No one yet. Add the first person." })]);
      countEl.textContent = shown.length + " of " + people.length + " people";
    }
    drawList();
    var left = [h("div", { class: "toolbar" }, searchBox("peopleQ", "Search name, email, discipline, tag", drawList), h("a", { class: "btn", href: "#people/new", text: "New person", role: "button" })), listEl, countEl];
    var right;
    if (id === "new") right = [h("h2", { text: "New person" }), editor({ table: "ce_people", tab: "people", fields: PERSON_FIELDS, createText: "Add person", after: loadPeople })];
    else if (id && personById[id]) right = personPanel(personById[id]);
    else if (id) right = [h("p", { class: "blank", text: "That person doesn’t exist any more." })];
    else right = [h("p", { class: "blank", text: "Choose someone, or add a new person. Their details, notes, events and connections are only visible to admins." })];
    return split(left, right);
  }

  function personPanel(p) {
    var evList = h("ul", { class: "items" }), connList = h("ul", { class: "items" }), sugList = h("ul", { class: "items" });
    var panel = [
      h("h2", { text: fullName(p) }),
      p.headline ? h("p", { class: "hint", text: p.headline }) : null,
      editor({ table: "ce_people", tab: "people", row: p, fields: PERSON_FIELDS, after: loadPeople, confirmDelete: function () { return "Delete " + fullName(p) + "? Their event history and connections are deleted too."; } }),
      h("h3", { text: "Events" }), evList,
    ];
    // Add to an event.
    var evIn = h("input", { type: "text", list: "dl-events", placeholder: "Type an event", "aria-label": "Event" });
    var roleIn = h("select", { "aria-label": "Role" }, ROLES.map(function (r) { return h("option", { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === "attendee" }); }));
    var evForm = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { class: "label", text: "Event" }), evIn), h("div", { class: "field" }, h("label", { class: "label", text: "Role" }), roleIn), h("button", { class: "btn", type: "submit", text: "Add" }));
    evForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var e = findEvent(evIn.value);
      if (!e) return say("Pick an event from the list, or add it under Events first.", "error");
      sb.from("ce_event_people").upsert({ event_id: e.id, person_id: p.id, role: roleIn.value }).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t add");
        evIn.value = ""; say("Added to " + e.title + ".", "ok"); drawEvents(); drawSuggestions();
      });
    });
    panel.push(evForm);

    // Connections.
    panel.push(h("h3", { text: "Connections" }), connList);
    var otherIn = h("input", { type: "text", list: "dl-people", placeholder: "Type a name", "aria-label": "Connect with" });
    var kindIn = h("select", { "aria-label": "How" }, KINDS.map(function (k) { return h("option", { value: k, text: k[0].toUpperCase() + k.slice(1) }); }));
    var noteIn = h("input", { type: "text", placeholder: "Note (optional)", "aria-label": "Note", maxlength: 2000 });
    var connForm = h("form", { class: "adder four" }, h("div", { class: "field" }, h("label", { class: "label", text: "Connect with" }), otherIn), h("div", { class: "field" }, h("label", { class: "label", text: "How" }), kindIn), h("div", { class: "field" }, h("label", { class: "label", text: "Note" }), noteIn), h("button", { class: "btn", type: "submit", text: "Connect" }));
    connForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var o = findPerson(otherIn.value);
      if (!o) return say("Pick someone from the list.", "error");
      if (o.id === p.id) return say("That’s the same person.", "error");
      connect(p.id, o.id, kindIn.value, clean(noteIn.value)).then(function (ok) { if (ok) { otherIn.value = ""; noteIn.value = ""; drawConnections(); drawSuggestions(); } });
    });
    panel.push(connForm);

    panel.push(h("h3", { text: "Suggested connections" }), h("p", { class: "hint", text: "People they’re not connected to yet who were at the same events or share disciplines and tags." }), sugList);

    function drawEvents() {
      sb.from("ce_event_people").select("event_id, role").eq("person_id", p.id).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data.filter(function (x) { return eventById[x.event_id]; }).sort(function (a, b) { return eventById[b.event_id].starts_at.localeCompare(eventById[a.event_id].starts_at); });
        evList.replaceChildren.apply(evList, rows.length ? rows.map(function (x) {
          var e = eventById[x.event_id];
          return h("li", null, h("span", { class: "main" }, h("a", { href: "#events/" + e.id, text: e.title }), h("span", { class: "s", text: fmtDate(e.starts_at) + (isPast(e) ? "" : " · upcoming") })),
            h("span", { class: "side" }, h("span", { class: "s", text: x.role }), h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () {
              sb.from("ce_event_people").delete().eq("event_id", e.id).eq("person_id", p.id).then(function (d) { if (d.error) return fail(d.error); drawEvents(); drawSuggestions(); });
            } })));
        }) : [h("li", { class: "empty", text: "No events yet." })]);
      });
    }
    function drawConnections() {
      sb.from("ce_connections").select("*").or("person_a.eq." + p.id + ",person_b.eq." + p.id).order("created_at", { ascending: false }).then(function (r) {
        if (r.error) return fail(r.error);
        connList.replaceChildren.apply(connList, r.data.length ? r.data.map(function (c) {
          var oid = c.person_a === p.id ? c.person_b : c.person_a, o = personById[oid], e = c.event_id && eventById[c.event_id];
          return h("li", null, h("span", { class: "main" }, h("a", { href: "#people/" + oid, text: fullName(o) }), h("span", { class: "s", text: [c.kind, e ? "at " + e.title : null, c.note].filter(Boolean).join(" · ") })),
            h("span", { class: "side" }, h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () { removeConnection(c).then(function () { drawConnections(); drawSuggestions(); }); } })));
        }) : [h("li", { class: "empty", text: "No connections yet." })]);
      });
    }
    function drawSuggestions() {
      sb.rpc("ce_connection_suggestions", { p_person: p.id, p_limit: 10 }).then(function (r) {
        if (r.error) return fail(r.error);
        sugList.replaceChildren.apply(sugList, r.data.length ? r.data.map(function (s) {
          var why = [];
          if (s.shared_events) why.push(s.shared_events + " event" + (s.shared_events === 1 ? "" : "s") + " together");
          if (s.shared_interests && s.shared_interests.length) why.push("both " + s.shared_interests.join(", "));
          return h("li", null, h("span", { class: "main" }, h("a", { href: "#people/" + s.person_id, text: fullName(s) }), h("span", { class: "s", text: why.join(" · ") })),
            h("span", { class: "side" }, h("button", { class: "btn ghost small", type: "button", text: "Connect", onclick: function () {
              connect(p.id, s.person_id, s.shared_events ? "met" : "introduced", null).then(function (ok) { if (ok) { drawConnections(); drawSuggestions(); } });
            } })));
        }) : [h("li", { class: "empty", text: "No suggestions yet. Add them to events, or give them disciplines and tags." })]);
      });
    }
    drawEvents(); drawConnections(); drawSuggestions();
    return panel;
  }

  function connect(a, b, kind, note, eventId) {
    return sb.from("ce_connections").insert({ person_a: a, person_b: b, kind: kind, note: note, event_id: eventId || null }).then(function (r) {
      if (r.error) { fail(r.error, "Couldn’t connect"); return false; }
      say(fullName(personById[a]) + " and " + fullName(personById[b]) + " are connected (" + kind + ").", "ok");
      return true;
    });
  }
  function removeConnection(c) {
    if (!confirm("Remove the connection between " + fullName(personById[c.person_a]) + " and " + fullName(personById[c.person_b]) + "?")) return Promise.resolve();
    return sb.from("ce_connections").delete().eq("id", c.id).then(function (r) { if (r.error) fail(r.error); else say("Connection removed.", "ok"); });
  }

  // Connections -------------------------------------------------------------------

  function connectionsTab() {
    var wrap = h("div");
    var stats = h("div", { class: "stats" });
    var listEl = h("ul", { class: "items" });
    var all = [];
    var aIn = h("input", { type: "text", list: "dl-people", placeholder: "Type a name", "aria-label": "Person" });
    var bIn = h("input", { type: "text", list: "dl-people", placeholder: "Type a name", "aria-label": "Other person" });
    var kindIn = h("select", { "aria-label": "How" }, KINDS.map(function (k) { return h("option", { value: k, text: k[0].toUpperCase() + k.slice(1) }); }));
    var evIn = h("input", { type: "text", list: "dl-events", placeholder: "Event (optional)", "aria-label": "Event" });
    var noteIn = h("input", { type: "text", placeholder: "Note (optional)", "aria-label": "Note", maxlength: 2000 });
    var form = h("form", { class: "fields" },
      h("div", { class: "field" }, h("label", { class: "label", text: "Person" }), aIn),
      h("div", { class: "field" }, h("label", { class: "label", text: "Connect with" }), bIn),
      h("div", { class: "field" }, h("label", { class: "label", text: "How" }), kindIn),
      h("div", { class: "field" }, h("label", { class: "label", text: "Where (event)" }), evIn),
      h("div", { class: "field wide" }, h("label", { class: "label", text: "Note" }), noteIn),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Connect" })));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var a = findPerson(aIn.value), b = findPerson(bIn.value), e = evIn.value.trim() ? findEvent(evIn.value) : null;
      if (!a || !b) return say("Pick both people from the list.", "error");
      if (a.id === b.id) return say("Pick two different people.", "error");
      if (evIn.value.trim() && !e) return say("Pick the event from the list, or leave it empty.", "error");
      connect(a.id, b.id, kindIn.value, clean(noteIn.value), e && e.id).then(function (ok) { if (ok) { aIn.value = bIn.value = evIn.value = noteIn.value = ""; load(); } });
    });
    var search = searchBox("connQ", "Search connections", draw);
    function draw() {
      var shown = all.filter(function (c) { var e = c.event_id && eventById[c.event_id]; return matches(filters.connQ, [fullName(personById[c.person_a]), fullName(personById[c.person_b]), c.kind, c.note || "", e ? e.title : ""]); });
      listEl.replaceChildren.apply(listEl, shown.length ? shown.slice(0, 500).map(function (c) {
        var e = c.event_id && eventById[c.event_id];
        return h("li", null, h("span", { class: "main" },
          h("a", { href: "#people/" + c.person_a, text: fullName(personById[c.person_a]) }), " — ", h("a", { href: "#people/" + c.person_b, text: fullName(personById[c.person_b]) }),
          h("span", { class: "s", text: [c.kind, e ? "at " + e.title : null, c.note, fmtDate(c.created_at)].filter(Boolean).join(" · ") })),
          h("span", { class: "side" }, h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () { removeConnection(c).then(load); } })));
      }) : [h("li", { class: "empty", text: all.length ? "No connections match." : "No connections yet. Connect people here, from someone’s page, or from an event (“Connect everyone who was there”)." })]);
    }
    function load() {
      sb.from("ce_connections").select("*").order("created_at", { ascending: false }).limit(5000).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t load connections");
        all = r.data;
        var degree = {};
        all.forEach(function (c) { degree[c.person_a] = (degree[c.person_a] || 0) + 1; degree[c.person_b] = (degree[c.person_b] || 0) + 1; });
        var connectedPeople = Object.keys(degree).length;
        var top = Object.keys(degree).sort(function (x, y) { return degree[y] - degree[x]; })[0];
        stats.replaceChildren(
          stat(all.length, "connections"),
          stat(people.length ? Math.round((connectedPeople / people.length) * 100) + "%" : "–", "of people connected"),
          stat(people.length - connectedPeople, "not connected yet"),
          top ? h("div", { class: "stat" }, h("div", { class: "n" }, h("a", { href: "#people/" + top, text: fullName(personById[top]), style: "text-decoration:none" })), h("div", { class: "l", text: "most connected (" + degree[top] + ")" })) : null);
        draw();
      });
    }
    function stat(n, l) { return h("div", { class: "stat" }, h("div", { class: "n", text: String(n) }), h("div", { class: "l", text: l })); }
    load();
    add(wrap, [stats, h("div", { class: "split" },
      h("section", { class: "panel" }, h("h2", { text: "Connect two people" }), form),
      h("section", { class: "panel" }, h("h2", { text: "All connections" }), h("div", { class: "toolbar", style: "margin-top:16px" }, search), listEl))]);
    return wrap;
  }

  // Partners ---------------------------------------------------------------------

  var PARTNER_FIELDS = [
    { name: "name", label: "Name", required: true, max: 200, wide: true },
    { name: "description", label: "Description", type: "textarea", max: 2000, wide: true },
    { name: "url", label: "Website", type: "url", placeholder: "https://" },
    { name: "logo_url", label: "Logo link", type: "url", placeholder: "https://" },
    { name: "sort", label: "Order", type: "number", help: "Lower numbers come first." },
    { name: "published", label: "Show publicly", type: "checkbox" },
  ];
  function partnersTab(id) {
    var listEl = h("ul", { class: "list" });
    var right = h("div");
    sb.from("ce_partners").select("*").order("sort").order("name").then(function (r) {
      if (r.error) return fail(r.error, "Couldn’t load partners");
      var rows = r.data, current = rows.find(function (x) { return x.id === id; });
      listEl.replaceChildren.apply(listEl, rows.length ? rows.map(function (x) {
        return h("li", null, h("a", { class: "row", href: "#partners/" + x.id, "aria-current": x.id === id ? "true" : null },
          h("span", { class: "t" }, x.name, x.published ? null : h("span", { class: "badge", text: "Hidden" })), h("span", { class: "s", text: x.url || " " })));
      }) : [h("li", { class: "empty", text: "No partners yet." })]);
      if (id === "new") add(right, [h("h2", { text: "New partner" }), editor({ table: "ce_partners", tab: "partners", fields: PARTNER_FIELDS, createText: "Add partner" })]);
      else if (current) add(right, [h("h2", { text: current.name }), editor({ table: "ce_partners", tab: "partners", row: current, fields: PARTNER_FIELDS, confirmDelete: function () { return "Delete " + current.name + "?"; } })]);
      else add(right, h("p", { class: "blank", text: id ? "That partner doesn’t exist any more." : "Choose a partner, or add one. Partners are saved here now; the Partners page will list the ones marked “Show publicly” once it’s connected." }));
    });
    return split([h("div", { class: "toolbar" }, h("a", { class: "btn", href: "#partners/new", text: "New partner", role: "button" })), listEl], right);
  }

  // Site text --------------------------------------------------------------------

  function contentTab() {
    var wrap = h("section", { class: "panel" }, h("h2", { text: "Site text" }), h("p", { class: "hint", text: "Change the words on the public pages. Leave a box empty to use the words built into the page." }));
    sb.from("ce_site_content").select("*").then(function (r) {
      if (r.error) return fail(r.error, "Couldn’t load site text");
      var saved = {};
      r.data.forEach(function (x) { saved[x.key] = x; });
      var items = CONTENT.slice();
      r.data.forEach(function (x) { if (!items.some(function (i) { return i.key === x.key; })) items.push({ key: x.key, name: x.key, long: true }); });
      items.forEach(function (it) {
        var id = "c-" + it.key.replace(/[^a-z0-9]/g, "-");
        var cur = saved[it.key] ? saved[it.key].value : "";
        var input = it.long ? h("textarea", { id: id, rows: it.key === "home.intro" ? 8 : 3, placeholder: it.hint, maxlength: 8000 }, cur) : h("input", { id: id, type: "text", value: cur, placeholder: it.hint, maxlength: 8000 });
        var note = h("span", { class: "s", style: "color:var(--muted);font-size:13px", text: saved[it.key] ? "Changed " + fmtDate(saved[it.key].updated_at, true) : "Using the built-in words" });
        var btn = h("button", { class: "btn small", type: "button", text: "Save", onclick: function () {
          var v = input.value.trim();
          btn.disabled = true;
          var q = v ? sb.from("ce_site_content").upsert({ key: it.key, value: v }) : sb.from("ce_site_content").delete().eq("key", it.key);
          q.then(function (res) {
            btn.disabled = false;
            if (res.error) return fail(res.error, "Couldn’t save");
            note.textContent = v ? "Saved just now" : "Using the built-in words";
            say(v ? "Saved. It’s live on the site." : "Back to the built-in words.", "ok");
          });
        } });
        wrap.appendChild(h("div", { class: "content-item" }, h("label", { for: id }, h("span", { class: "name", text: it.name }), " ", h("span", { class: "k", text: it.key })), h("div", { style: "margin-top:8px" }, input), h("div", { class: "row2" }, btn, note)));
      });
      // Add a new key (for pages wired up later).
      var keyIn = h("input", { type: "text", placeholder: "new.key", "aria-label": "New key", pattern: "[a-z0-9_.\\-]{1,80}" });
      var addForm = h("form", { class: "adder", style: "margin-top:32px" }, h("div", { class: "field" }, h("label", { class: "label", text: "Add another piece of text (for a page marked up with data-content)" }), keyIn), h("span"), h("button", { class: "btn ghost", type: "submit", text: "Add" }));
      addForm.addEventListener("submit", function (ev) {
        ev.preventDefault();
        var k = keyIn.value.trim().toLowerCase();
        if (!/^[a-z0-9_.-]{1,80}$/.test(k)) return say("Keys use lowercase letters, numbers, dots, dashes and underscores.", "error");
        sb.from("ce_site_content").upsert({ key: k, value: "(new text)" }).then(function (res) { if (res.error) return fail(res.error); render(); });
      });
      wrap.appendChild(addForm);
    });
    return wrap;
  }

  // Admins -----------------------------------------------------------------------

  function adminsTab() {
    var listEl = h("ul", { class: "items" });
    var emailIn = h("input", { type: "email", placeholder: "Their sign-in email", "aria-label": "Email", required: true });
    var form = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { class: "label", text: "Make someone an admin" }), emailIn), h("span"), h("button", { class: "btn", type: "submit", text: "Add admin" }));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      sb.rpc("ce_add_admin", { p_email: emailIn.value }).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t add");
        emailIn.value = ""; say((r.data && r.data.email) + " is now an admin.", "ok"); load();
      });
    });
    function load() {
      sb.from("ce_admins").select("*").order("created_at").then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t load admins");
        listEl.replaceChildren.apply(listEl, r.data.map(function (a) {
          var self = a.user_id === me.id;
          return h("li", null, h("span", { class: "main" }, a.email || a.user_id, self ? h("span", { class: "s", text: "You" }) : h("span", { class: "s", text: "Since " + fmtDate(a.created_at) })),
            self ? null : h("span", { class: "side" }, h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () {
              if (!confirm("Remove " + (a.email || "this admin") + " as an admin?")) return;
              sb.rpc("ce_remove_admin", { p_user: a.user_id }).then(function (d) { if (d.error) return fail(d.error); say("Removed.", "ok"); load(); });
            } })));
        }));
      });
    }
    load();
    return h("section", { class: "panel" }, h("h2", { text: "Admins" }), h("p", { class: "hint", text: "Admins can see and change everything here. They need an account on the site first (they sign up through Join or Sign in)." }), listEl, form);
  }

  // Routing ------------------------------------------------------------------------

  var TABS = { events: eventsTab, people: peopleTab, connections: connectionsTab, partners: partnersTab, content: contentTab, admins: adminsTab };
  var lastTab = null;
  function render() {
    var parts = (location.hash.replace(/^#/, "") || "events").split("/");
    var tab = TABS[parts[0]] ? parts[0] : "events";
    if (tab !== lastTab) say("");
    lastTab = tab;
    document.querySelectorAll("nav.tabs a").forEach(function (a) { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    var view = $("view");
    view.replaceChildren(TABS[tab](parts[1] ? decodeURIComponent(parts[1]) : null));
    document.title = (document.querySelector('nav.tabs a[data-tab="' + tab + '"]').textContent) + " · Manage · Creative Endeavors";
  }
  window.addEventListener("hashchange", function () { render(); window.scrollTo({ top: 0 }); });

  // Signing in -----------------------------------------------------------------------

  function gate(title, text, showForm) {
    $("app").hidden = true; $("gate").hidden = false;
    $("gate-title").textContent = title; $("gate-text").textContent = text;
    $("sign-in").hidden = !showForm;
  }
  var started = false;
  function start(session) {
    me = session ? session.user : null;
    $("who").hidden = !me;
    if (me) $("who-email").textContent = me.email || "";
    if (!me) { started = false; return gate("Manage.", "Sign in with your Creative Endeavors account.", true); }
    if (started) return;
    started = true;
    gate("Manage.", "Checking you’re an admin…", false);
    sb.rpc("ce_is_admin").then(function (r) {
      if (r.error) { started = false; return gate("Manage.", "The admin area couldn’t be reached. If this is a new setup, the database migration in supabase/migrations may not have been run yet.", false); }
      if (!r.data) { started = false; return gate("Admins only.", "You’re signed in as " + (me.email || "someone") + ", which isn’t a Creative Endeavors admin account.", false); }
      return Promise.all([loadPeople(), loadEvents()]).then(function () {
        $("gate").hidden = true; $("app").hidden = false;
        render();
      });
    }).catch(function (err) { started = false; fail(err); gate("Manage.", "Something went wrong loading the admin area. Please try again.", false); });
  }
  $("sign-in").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var st = $("si-status");
    st.textContent = "Signing in…"; st.className = "status";
    sb.auth.signInWithPassword({ email: $("si-email").value.trim(), password: $("si-password").value }).then(function (r) {
      if (r.error) { st.textContent = r.error.message === "Invalid login credentials" ? "That email and password don’t match." : r.error.message; st.className = "status error"; return; }
      st.textContent = "";
    });
  });
  $("sign-out").addEventListener("click", function () { sb.auth.signOut(); });
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT") { started = false; people = []; events = []; }
    // Deferred: supabase-js holds a lock during this callback, and database calls made inside it can stall.
    if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT") setTimeout(function () { start(session); }, 0);
  });
})();
