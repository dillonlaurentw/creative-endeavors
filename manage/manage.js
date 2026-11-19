/* Creative Endeavors · Manage
   The admin side of the site: events (with photos and write-ups), people,
   who came to what, connections, partners, the words on the public pages,
   and admins. Everything is saved straight to the site's Supabase database;
   its row-level security (supabase/setup.sql) is what keeps it admin-only.
   Text from the database is always written with textContent, never as HTML. */
(function () {
  "use strict";

  var sb = window.supabase.createClient(CE.url, CE.key, { auth: { storage: window.localStorage, persistSession: true, autoRefreshToken: true } });
  var BUCKET = "ce-photos";
  var me = null;
  var people = [], events = [], personById = {}, eventById = {};

  var ROLES = ["host", "speaker", "performer", "artist", "attendee", "volunteer", "partner"];
  var KINDS = ["met", "collaborated", "introduced", "mentor", "friends"];
  var CONTENT = [
    { key: "home.lede", name: "Homepage headline", hint: "A think tank for creatives." },
    { key: "home.intro", name: "Homepage text", hint: "Paragraphs, with a blank line between them.", long: true, rows: 9 },
    { key: "home.epigraph", name: "Quote at the bottom of every page", hint: "“I can either spend my time designing the candle…” — Virgil Abloh", long: true },
    { key: "events.lede", name: "Events page headline", hint: "Events." },
    { key: "events.intro", name: "Events page introduction", hint: "Gatherings, conversations and experiences for people building creative endeavors.", long: true },
  ];

  // Helpers ----------------------------------------------------------------------

  function $(id) { return document.getElementById(id); }
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
  function fill(el, kids) { el.replaceChildren(); add(el, kids); return el; }
  var statusTimer;
  function say(text, kind) {
    var s = $("status");
    s.textContent = text || "";
    s.className = "status" + (kind ? " " + kind : "") + (text ? " show" : "");
    clearTimeout(statusTimer);
    if (kind === "ok") statusTimer = setTimeout(function () { s.className = "status"; }, 3500);
  }
  function fail(err, what) {
    console.error(err);
    var msg = (err && err.message) || "Something went wrong.";
    if (err && err.code === "23505") msg = "That already exists.";
    if (err && err.code === "23514") msg = "Something isn’t valid. Links need to start with https://.";
    if (err && (err.code === "42501" || /row-level security|Unauthorized/i.test(msg))) msg = "You don’t have permission to do that.";
    say((what ? what + ": " : "") + msg, "error");
  }
  function fullName(p) { return p ? [p.first_name, p.last_name].filter(Boolean).join(" ") : "Someone removed"; }
  function splitName(s) { s = s.trim().replace(/\s+/g, " "); var i = s.indexOf(" "); return i < 0 ? { first_name: s, last_name: null } : { first_name: s.slice(0, i), last_name: s.slice(i + 1) }; }
  function fmtDate(iso, withTime) {
    if (!iso) return "";
    var d = new Date(iso);
    var s = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    return withTime ? s + " · " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : s;
  }
  function toLocalInput(iso) {
    if (!iso) return "";
    var d = new Date(iso), p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).toISOString() : null; }
  function list(v) { return (v || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean); }
  function lines(v) { return (v || "").split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function clean(v) { v = (v == null ? "" : String(v)).trim(); return v === "" ? null : v; }
  function isPast(e) { var end = e.ends_at ? new Date(e.ends_at) : new Date(new Date(e.starts_at).setHours(23, 59, 59, 999)); return end < new Date(); }
  function matches(q, parts) { q = q.trim().toLowerCase(); return !q || parts.join(" ").toLowerCase().indexOf(q) !== -1; }
  function initials(p) { return ((p.first_name || "?")[0] + ((p.last_name || "")[0] || "")).toUpperCase(); }
  function avatar(p, size) {
    var cls = "avatar" + (size ? " " + size : "");
    return p && p.photo_url ? h("img", { class: cls, src: p.photo_url, alt: "" }) : h("span", { class: cls, "aria-hidden": "true", text: p ? initials(p) : "?" });
  }
  function eventUrl(e) { return "/events/event/?e=" + encodeURIComponent(e.slug || e.id); }

  // People and events are picked by typing a name.
  function personLabel(p) {
    var same = people.filter(function (x) { return fullName(x) === fullName(p); }).length > 1;
    return fullName(p) + (same ? " (" + (p.email || p.city || p.id.slice(0, 6)) + ")" : "");
  }
  function eventLabel(e) { return e.title + " · " + fmtDate(e.starts_at); }
  function refreshPickers() {
    fill($("dl-people"), people.map(function (p) { return h("option", { value: personLabel(p) }); }));
    fill($("dl-events"), events.map(function (e) { return h("option", { value: eventLabel(e) }); }));
  }
  function findPerson(label) { label = label.trim(); var l = label.toLowerCase(); return people.find(function (p) { return personLabel(p) === label; }) || people.find(function (p) { return fullName(p).toLowerCase() === l; }); }
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

  // Photos ------------------------------------------------------------------------

  // Shrinks a photo to at most 2000px on its long side (a JPEG, about 0.3–1 MB)
  // before upload, so phone photos upload quickly. Falls back to the original.
  function shrink(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) return Promise.resolve(file);
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 2000, w = img.naturalWidth, hgt = img.naturalHeight, k = Math.min(1, max / Math.max(w, hgt));
        var c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(hgt * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { resolve(b && (b.size < file.size || !/jpe?g/i.test(file.type)) ? b : file); }, "image/jpeg", 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function upload(file, folder) {
    return shrink(file).then(function (blob) {
      var ext = blob.type === "image/jpeg" ? "jpg" : (blob.type.split("/")[1] || "jpg");
      var path = folder + "/" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + "." + ext;
      return sb.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || "image/jpeg", cacheControl: "31536000" }).then(function (r) {
        if (r.error) throw r.error;
        return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
      });
    });
  }
  // A drop zone: click to choose, or drag photos onto it.
  function dropzone(label, multiple, onFiles) {
    var input = h("input", { type: "file", accept: "image/*", multiple: multiple, hidden: true });
    var zone = h("button", { type: "button", class: "drop" }, h("span", { class: "drop-icon", "aria-hidden": "true", text: "+" }), h("span", { text: label }));
    zone.addEventListener("click", function () { input.click(); });
    input.addEventListener("change", function () { if (input.files.length) onFiles([].slice.call(input.files)); input.value = ""; });
    ["dragenter", "dragover"].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (t) { zone.addEventListener(t, function () { zone.classList.remove("over"); }); });
    zone.addEventListener("drop", function (e) { e.preventDefault(); var f = [].filter.call(e.dataTransfer.files, function (x) { return /^image\//.test(x.type) || /\.(heic|heif)$/i.test(x.name); }); if (f.length) onFiles(multiple ? f : f.slice(0, 1)); });
    return h("div", null, zone, input);
  }
  function uploadMany(files, folder, done) {
    var n = 0;
    say("Uploading " + files.length + " photo" + (files.length === 1 ? "" : "s") + "…");
    return Promise.all(files.map(function (f) {
      return upload(f, folder).then(function (u) { n++; say("Uploading… " + n + " of " + files.length); return u; }).catch(function (e) { console.error(e); return null; });
    })).then(function (urls) {
      var ok = urls.filter(Boolean);
      if (ok.length === files.length) say("");
      if (ok.length < files.length) say((files.length - ok.length) + " photo" + (files.length - ok.length === 1 ? "" : "s") + " couldn’t be uploaded. Try again, or try a JPEG.", "error");
      done(ok);
    });
  }

  // Shared form pieces --------------------------------------------------------------

  function fieldWrap(label, input, opts) {
    opts = opts || {};
    return h("div", { class: "field" + (opts.wide ? " wide" : "") }, h("label", { for: input.id, text: label }), input, opts.help ? h("p", { class: "help", text: opts.help }) : null);
  }
  function txt(id, value, attrs) { return h("input", Object.assign({ id: id, type: "text", value: value == null ? "" : value }, attrs || {})); }
  function area(id, value, attrs) { return h("textarea", Object.assign({ id: id, rows: 4 }, attrs || {}), value || ""); }
  function split(left, right) { return h("div", { class: "split" }, h("section", { class: "side-list", "aria-label": "List" }, left), h("section", { class: "panel" }, right)); }
  var filters = { events: "all", eventsQ: "", peopleQ: "", connQ: "" };
  function searchBox(key, placeholder, rerender) {
    var input = h("input", { type: "search", placeholder: placeholder, value: filters[key], "aria-label": placeholder });
    input.addEventListener("input", function () { filters[key] = input.value; rerender(); });
    return input;
  }

  // Start -----------------------------------------------------------------------------

  function startTab() {
    var upcoming = events.filter(function (e) { return !isPast(e); }).reverse();
    var needWriteUp = events.filter(function (e) { return isPast(e) && (!e.story || !(e.photos || []).length && !e.cover_url); });
    var drafts = events.filter(function (e) { return !e.published; });
    function card(href, title, text) { return h("a", { class: "card", href: href }, h("span", { class: "card-t", text: title }), h("span", { class: "card-s", text: text })); }
    function evRow(e, note) {
      return h("li", null, h("a", { class: "ev-row", href: "#events/" + e.id }, e.cover_url ? h("img", { class: "thumb", src: e.cover_url, alt: "" }) : h("span", { class: "thumb blank", "aria-hidden": "true" }),
        h("span", { class: "main" }, h("span", { class: "t", text: e.title }), h("span", { class: "s", text: fmtDate(e.starts_at) + (note ? " · " + note : "") }))));
    }
    var first = (me && me.email || "").split("@")[0];
    return h("div", { class: "start" },
      h("h1", { class: "hello", text: "What would you like to do?" }),
      h("div", { class: "quick" }, h("p", { class: "quick-label", text: "Ask the assistant" }), composer(true)),
      h("h3", { text: "Or do it yourself" }),
      h("div", { class: "cards" },
        card("#events/new", "Add an upcoming event", "Name, date, place and a photo. Publish it when you’re ready."),
        card("#events/new-past", "Write up a past event", "Tell the story of what happened and add the photos."),
        card("#people/new", "Add people", "One person, or paste a whole list of names at once."),
        card("#content", "Change the website words", "The homepage headline, text and the quote.")),
      needWriteUp.length ? [h("h3", { text: "Past events that need a write-up or photos" }), h("ul", { class: "ev-list" }, needWriteUp.slice(0, 6).map(function (e) { return evRow(e, !e.story ? "no story yet" : "no photos yet"); }))] : null,
      upcoming.length ? [h("h3", { text: "Coming up" }), h("ul", { class: "ev-list" }, upcoming.slice(0, 6).map(function (e) { return evRow(e, e.published ? "on the website" : "draft"); }))] : null,
      drafts.length && !upcoming.length ? [h("h3", { text: "Drafts" }), h("ul", { class: "ev-list" }, drafts.slice(0, 6).map(function (e) { return evRow(e, "draft"); }))] : null,
      h("p", { class: "totals", text: events.length + " events · " + people.length + " people" + (first ? " · signed in as " + first : "") }));
  }

  // Events ------------------------------------------------------------------------------

  function eventsTab(id) {
    var listEl = h("ul", { class: "list" });
    function drawList() {
      var shown = events.filter(function (e) {
        var f = filters.events;
        var keep = f === "all" || (f === "drafts" ? !e.published : f === "past" ? isPast(e) : !isPast(e));
        return keep && matches(filters.eventsQ, [e.title, e.kind || "", e.city || "", e.venue || ""]);
      });
      fill(listEl, shown.length ? shown.map(function (e) {
        return h("li", null, h("a", { class: "row ev-row", href: "#events/" + e.id, "aria-current": e.id === id ? "true" : null },
          e.cover_url ? h("img", { class: "thumb", src: e.cover_url, alt: "" }) : h("span", { class: "thumb blank", "aria-hidden": "true" }),
          h("span", { class: "main" }, h("span", { class: "t" }, e.title, e.published ? null : h("span", { class: "badge", text: "Draft" })),
            h("span", { class: "s", text: fmtDate(e.starts_at) + (isPast(e) ? "" : " · upcoming") }))));
      }) : h("li", { class: "empty", text: events.length ? "No events match." : "No events yet." }));
    }
    var chips = h("div", { class: "chips", role: "group", "aria-label": "Show" }, [["all", "All"], ["upcoming", "Upcoming"], ["past", "Past"], ["drafts", "Drafts"]].map(function (c) {
      return h("button", { class: "chip", type: "button", "aria-pressed": String(filters.events === c[0]), text: c[1], onclick: function (ev) {
        filters.events = c[0];
        chips.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", String(b === ev.currentTarget)); });
        drawList();
      } });
    }));
    drawList();
    var left = [h("div", { class: "toolbar" }, h("a", { class: "btn", href: "#events/new", text: "+ New event" }), searchBox("eventsQ", "Search", drawList)), chips, listEl];
    var right;
    if (id === "new" || id === "new-past") right = eventEditor(null, id === "new-past");
    else if (id && eventById[id]) right = eventEditor(eventById[id]);
    else if (id) right = h("p", { class: "blank", text: "That event doesn’t exist any more." });
    else right = h("div", { class: "blank" }, h("p", { text: "Pick an event to edit it, or add a new one." }), h("p", null, h("a", { class: "btn ghost", href: "#events/new-past", text: "Write up a past event" })));
    return split(left, right);
  }

  function eventEditor(e, pastHint) {
    var isNew = !e;
    var state = { cover_url: e ? e.cover_url : null, photos: e ? (e.photos || []).slice() : [] };
    var past = e ? isPast(e) : !!pastHint;
    var folder = "events/" + (e ? e.id : "new-" + Date.now().toString(36));

    var title = txt("ev-title", e && e.title, { required: true, maxlength: 200, placeholder: "e.g. Founders Dinner" });
    var when = h("input", { id: "ev-when", type: "datetime-local", value: e ? toLocalInput(e.starts_at) : "", required: true });
    var venue = txt("ev-venue", e && e.venue, { maxlength: 200, placeholder: "e.g. The Loft" });
    var city = txt("ev-city", e && e.city, { maxlength: 100, placeholder: "e.g. Brooklyn" });
    var summary = txt("ev-summary", e && e.description, { maxlength: 300, placeholder: past ? "e.g. Forty founders, one long table." : "e.g. An evening with creative entrepreneurs." });
    var story = area("ev-story", e && e.story, { rows: 12, maxlength: 20000, placeholder: past ? "What happened? Who was there, what was talked about, what came out of it. Write as much as you like; leave a blank line between paragraphs." : "What to expect: who it’s for, what will happen, anything to bring." });
    var link = h("input", { id: "ev-link", type: "url", value: (e && e.link) || "", placeholder: "https://…" });
    var ends = h("input", { id: "ev-ends", type: "datetime-local", value: e ? toLocalInput(e.ends_at) : "" });
    var kind = txt("ev-kind", e && e.kind, { list: "dl-kinds", maxlength: 60, placeholder: "Dinner, salon, workshop…" });
    var storyLabel = h("label", { for: "ev-story", text: past ? "The story: what happened" : "What to expect" });
    var linkField = fieldWrap(past ? "Link (optional)" : "RSVP or tickets link (optional)", link, { wide: true });
    function updatePast() {
      var d = when.value ? new Date(when.value) : null;
      past = d ? isPast({ starts_at: d.toISOString(), ends_at: fromLocalInput(ends.value) }) : past;
      storyLabel.textContent = past ? "The story: what happened" : "What to expect";
      linkField.querySelector("label").textContent = past ? "Link (optional)" : "RSVP or tickets link (optional)";
    }
    when.addEventListener("change", updatePast); ends.addEventListener("change", updatePast);

    // Cover photo.
    var coverBox = h("div", { class: "cover-box" });
    function drawCover() {
      fill(coverBox, state.cover_url ? h("div", { class: "cover" }, h("img", { src: state.cover_url, alt: "Cover photo" }),
        h("div", { class: "cover-actions" }, h("button", { type: "button", class: "btn ghost small", text: "Change", onclick: function () { pick.querySelector("input").click(); } }),
          h("button", { type: "button", class: "btn ghost small", text: "Remove", onclick: function () { state.cover_url = null; drawCover(); dirty(); } })))
        : null);
      pick.hidden = !!state.cover_url;
      coverBox.appendChild(pick);
    }
    var pick = dropzone("Add a cover photo", false, function (files) {
      uploadMany(files, folder, function (urls) { if (urls[0]) { state.cover_url = urls[0]; drawCover(); dirty(); say("Photo added. Remember to save.", "ok"); } });
    });

    // Gallery.
    var gallery = h("div", { class: "gallery" });
    var galleryDrop = dropzone("Add photos (choose several at once)", true, function (files) {
      uploadMany(files, folder, function (urls) {
        if (!urls.length) return;
        state.photos = state.photos.concat(urls);
        if (!state.cover_url) { state.cover_url = urls[0]; drawCover(); }
        drawGallery(); dirty(); say(urls.length + " photo" + (urls.length === 1 ? "" : "s") + " added. Remember to save.", "ok");
      });
    });
    function drawGallery() {
      fill(gallery, state.photos.map(function (u, i) {
        return h("figure", { class: "ph" }, h("img", { src: u, alt: "", loading: "lazy" }),
          h("figcaption", null,
            state.cover_url === u ? h("span", { class: "ph-tag", text: "Cover" }) : h("button", { type: "button", class: "ph-btn", text: "Make cover", onclick: function () { state.cover_url = u; drawCover(); drawGallery(); dirty(); } }),
            h("button", { type: "button", class: "ph-btn", "aria-label": "Remove photo", text: "Remove", onclick: function () { state.photos.splice(i, 1); if (state.cover_url === u) state.cover_url = state.photos[0] || null; drawCover(); drawGallery(); dirty(); } })));
      }));
    }

    var more = h("details", { class: "more wide" }, h("summary", { text: "More details (optional)" }),
      h("div", { class: "fields inner" }, fieldWrap("Ends", ends), fieldWrap("Kind of event", kind)));
    var publishedNow = e ? e.published : false;
    var saveBtn = h("button", { class: "btn", type: "submit", text: isNew ? "Save as draft" : "Save changes" });
    var pubBtn = h("button", { class: "btn" + (publishedNow ? " ghost" : " accent"), type: "button", text: publishedNow ? "Take off the website" : (isNew ? "Save and put on the website" : "Put on the website") });
    var unsaved = h("span", { class: "unsaved", hidden: true, text: "Unsaved changes" });
    function dirty() { unsaved.hidden = false; }

    var form = h("form", { class: "fields", novalidate: true },
      fieldWrap("Name of the event", title, { wide: true }),
      fieldWrap("Date and time", when), h("div", { class: "field" }, h("span", { class: "label", text: " " }), h("p", { class: "help", text: past ? "This is a past event: it goes under Past on the website." : "Past dates are fine: they show under Past." })),
      fieldWrap("Place", venue), fieldWrap("City", city),
      h("div", { class: "field wide" }, h("span", { class: "label", text: "Cover photo" }), coverBox),
      fieldWrap("One-line summary", summary, { wide: true, help: "Shown in the list of events." }),
      h("div", { class: "field wide" }, storyLabel, story),
      h("div", { class: "field wide" }, h("span", { class: "label", text: "Photos" }), gallery, galleryDrop),
      linkField, more,
      h("div", { class: "actions sticky" }, saveBtn, pubBtn, unsaved, h("span", { class: "spacer" }),
        e && e.published ? h("a", { class: "link", href: eventUrl(e), target: "_blank", rel: "noopener", text: "View on website ↗" }) : null));
    form.addEventListener("input", dirty);

    function save(publish) {
      if (!title.value.trim()) { title.focus(); return say("Give the event a name.", "error"); }
      if (!when.value) { when.focus(); return say("Add the date and time.", "error"); }
      if (link.value && !/^https?:\/\//i.test(link.value.trim())) { link.focus(); return say("Links need to start with https://", "error"); }
      if (ends.value && ends.value < when.value) return say("The end has to be after the start.", "error");
      var data = {
        title: title.value.trim(), starts_at: fromLocalInput(when.value), ends_at: fromLocalInput(ends.value),
        venue: clean(venue.value), city: clean(city.value), description: clean(summary.value), story: clean(story.value),
        link: clean(link.value), kind: clean(kind.value), cover_url: state.cover_url, photos: state.photos,
      };
      if (publish !== undefined) data.published = publish;
      saveBtn.disabled = pubBtn.disabled = true;
      var q = e ? sb.from("ce_events").update(data).eq("id", e.id).select().single() : sb.from("ce_events").insert(data).select().single();
      q.then(function (r) {
        saveBtn.disabled = pubBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t save");
        unsaved.hidden = true;
        say(r.data.published ? (publish ? "It’s on the website now." : "Saved. The website is updated.") : (publish === false ? "Taken off the website. It’s a draft now." : "Saved as a draft."), "ok");
        loadEvents().then(function () { if (isNew) location.hash = "#events/" + r.data.id; else render(); });
      });
    }
    form.addEventListener("submit", function (ev) { ev.preventDefault(); save(); });
    pubBtn.addEventListener("click", function () { save(!publishedNow); });

    drawCover(); drawGallery();
    var out = [h("div", { class: "panel-head" }, h("h2", { text: isNew ? (pastHint ? "Write up a past event" : "New event") : e.title }),
      e ? h("span", { class: "pill" + (e.published ? " live" : ""), text: e.published ? "On the website" : "Draft" }) : null), form];
    if (e) {
      out.push(whoWasThere(e));
      out.push(h("div", { class: "danger-zone" }, h("button", { class: "link danger", type: "button", text: "Delete this event", onclick: function () {
        if (!confirm("Delete “" + e.title + "”? This can’t be undone. People stay; the list of who came is removed.")) return;
        sb.from("ce_events").delete().eq("id", e.id).then(function (r) { if (r.error) return fail(r.error, "Couldn’t delete"); say("Deleted.", "ok"); loadEvents().then(function () { location.hash = "#events"; }); });
      } })));
    } else {
      out.push(h("p", { class: "hint", text: "After saving you can add who was there." }));
    }
    return out;
  }

  // Who was there: type names (new names become new people), pick roles.
  function whoWasThere(e) {
    var box = h("section", { class: "who-box" });
    var listEl = h("ul", { class: "people-chips" });
    var namesIn = h("input", { id: "who-names", type: "text", list: "dl-people", placeholder: "Type names, separated by commas", autocomplete: "off" });
    var roleIn = h("select", { "aria-label": "Their role" }, ROLES.map(function (r) { return h("option", { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === "attendee" }); }));
    var addForm = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { for: "who-names", text: "Add people" }), namesIn), h("div", { class: "field" }, h("label", { class: "label", text: "As" }), roleIn), h("button", { class: "btn", type: "submit", text: "Add" }));
    var connectBtn = h("button", { class: "btn ghost", type: "button", text: "Connect everyone here with each other", onclick: function () {
      connectBtn.disabled = true;
      sb.rpc("ce_connect_event", { p_event: e.id }).then(function (r) {
        connectBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t connect them");
        say(r.data ? r.data + " new connection" + (r.data === 1 ? "" : "s") + " made." : "Everyone here is already connected.", "ok");
      });
    } });
    addForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var names = namesIn.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!names.length) return say("Type at least one name.", "error");
      var created = 0;
      Promise.all(names.map(function (n) {
        var p = findPerson(n);
        if (p) return p;
        created++;
        return sb.from("ce_people").insert(splitName(n)).select().single().then(function (r) { if (r.error) throw r.error; return r.data; });
      })).then(function (ps) {
        return sb.from("ce_event_people").upsert(ps.map(function (p) { return { event_id: e.id, person_id: p.id, role: roleIn.value }; })).then(function (r) {
          if (r.error) throw r.error;
          namesIn.value = "";
          say(ps.length + " added" + (created ? " (" + created + " new to People)" : "") + ".", "ok");
          return loadPeople().then(draw);
        });
      }).catch(function (err) { fail(err, "Couldn’t add"); });
    });
    function draw() {
      sb.from("ce_event_people").select("person_id, role").eq("event_id", e.id).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data.sort(function (a, b) { return ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || fullName(personById[a.person_id]).localeCompare(fullName(personById[b.person_id])); });
        fill(listEl, rows.length ? rows.map(function (x) {
          var p = personById[x.person_id];
          var sel = h("select", { class: "mini", "aria-label": "Role of " + fullName(p) }, ROLES.map(function (ro) { return h("option", { value: ro, text: ro, selected: ro === x.role }); }));
          sel.addEventListener("change", function () { sb.from("ce_event_people").update({ role: sel.value }).eq("event_id", e.id).eq("person_id", x.person_id).then(function (u) { if (u.error) fail(u.error); else say("Updated.", "ok"); }); });
          return h("li", { class: "pchip" }, avatar(p, "sm"), h("a", { href: "#people/" + x.person_id, text: fullName(p) }), sel,
            h("button", { class: "x", type: "button", "aria-label": "Remove " + fullName(p), text: "×", onclick: function () {
              sb.from("ce_event_people").delete().eq("event_id", e.id).eq("person_id", x.person_id).then(function (d) { if (d.error) return fail(d.error); draw(); });
            } }));
        }) : h("li", { class: "empty", text: "No one added yet." }));
        connectBtn.hidden = rows.length < 2;
      });
    }
    draw();
    add(box, [h("h3", { text: "Who was there" }), h("p", { class: "hint", text: "Only admins see this. New names are added to People automatically." }), listEl, addForm, h("div", { style: "margin-top:12px" }, connectBtn)]);
    return box;
  }

  // People ----------------------------------------------------------------------------

  function peopleTab(id) {
    var listEl = h("ul", { class: "list" });
    function drawList() {
      var shown = people.filter(function (p) { return matches(filters.peopleQ, [fullName(p), p.email || "", p.headline || "", p.city || "", (p.disciplines || []).join(" "), (p.tags || []).join(" ")]); });
      fill(listEl, shown.length ? shown.map(function (p) {
        return h("li", null, h("a", { class: "row person-row", href: "#people/" + p.id, "aria-current": p.id === id ? "true" : null }, avatar(p),
          h("span", { class: "main" }, h("span", { class: "t", text: fullName(p) }), h("span", { class: "s", text: [p.headline, p.city].filter(Boolean).join(" · ") || p.email || " " }))));
      }) : h("li", { class: "empty", text: people.length ? "No one matches." : "No one yet." }));
    }
    drawList();
    var left = [h("div", { class: "toolbar" }, h("a", { class: "btn", href: "#people/new", text: "+ Add people" }), searchBox("peopleQ", "Search", drawList)), listEl, h("p", { class: "count", text: people.length + " people" })];
    var right;
    if (id === "new") right = newPeople();
    else if (id && personById[id]) right = personEditor(personById[id]);
    else if (id) right = h("p", { class: "blank", text: "That person doesn’t exist any more." });
    else right = h("p", { class: "blank", text: "Pick someone to see their details, events and connections." });
    return split(left, right);
  }

  // Add one person, or paste a list.
  function newPeople() {
    var one = personEditor(null);
    var paste = area("bulk", "", { rows: 6, placeholder: "One person per line. Add an email after a comma if you have it:\nMaya Chen, maya@example.com\nJordan Ellis" });
    var bulkBtn = h("button", { class: "btn", type: "submit", text: "Add everyone" });
    var bulk = h("form", { class: "bulk" }, h("label", { for: "bulk", text: "Paste a list of names" }), paste, h("div", { class: "actions" }, bulkBtn));
    bulk.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var rows = lines(paste.value).map(function (l) {
        var parts = l.split(/\s*[,\t]\s*/), email = parts.find(function (x) { return /@/.test(x); });
        var name = parts.filter(function (x) { return x !== email; }).join(" ");
        return name ? Object.assign(splitName(name), email ? { email: email.toLowerCase() } : {}) : null;
      }).filter(Boolean);
      var fresh = rows.filter(function (r) { return !findPerson(fullName(r)) && !(r.email && people.some(function (p) { return (p.email || "").toLowerCase() === r.email; })); });
      if (!rows.length) return say("Paste at least one name.", "error");
      if (!fresh.length) return say("They’re all in People already.", "ok");
      bulkBtn.disabled = true;
      sb.from("ce_people").insert(fresh).then(function (r) {
        bulkBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t add");
        say(fresh.length + " added" + (rows.length > fresh.length ? " (" + (rows.length - fresh.length) + " were already there)" : "") + ".", "ok");
        paste.value = "";
        loadPeople().then(function () { location.hash = "#people"; render(); });
      });
    });
    return [h("h2", { text: "Add people" }), h("div", { class: "tabs-mini" }, h("p", { class: "hint", text: "Add one person with their details, or paste a list of names to add many at once." })), one.slice(1), h("h3", { text: "Or add many at once" }), bulk];
  }

  function personEditor(p) {
    var isNew = !p;
    var state = { photo_url: p ? p.photo_url : null };
    var name = txt("p-name", p ? fullName(p) : "", { required: true, maxlength: 200, placeholder: "First and last name", autocomplete: "off" });
    var headline = txt("p-headline", p && p.headline, { maxlength: 200, placeholder: "e.g. Founder of Studio Nine, designer" });
    var city = txt("p-city", p && p.city, { maxlength: 100 });
    var email = h("input", { id: "p-email", type: "email", value: (p && p.email) || "", autocomplete: "off" });
    var phone = h("input", { id: "p-phone", type: "tel", value: (p && p.phone) || "", maxlength: 40 });
    var links = area("p-links", p && (p.links || []).join("\n"), { rows: 2, placeholder: "Website or Instagram, one per line" });
    var bio = area("p-bio", p && p.bio, { rows: 4, maxlength: 4000, placeholder: "A few sentences about them and their work." });
    var notes = area("p-notes", p && p.notes, { rows: 3, maxlength: 8000, placeholder: "How you know them, what they’re looking for, who they should meet…" });
    var disciplines = txt("p-disc", p && (p.disciplines || []).join(", "), { placeholder: "Design, film, music" });
    var tags = txt("p-tags", p && (p.tags || []).join(", "), { placeholder: "Founder, speaker" });
    var pronouns = txt("p-pronouns", p && p.pronouns, { maxlength: 40 });

    var photoBox = h("div", { class: "photo-row" });
    var drop = dropzone("Add photo", false, function (files) {
      uploadMany(files, "people", function (u) { if (u[0]) { state.photo_url = u[0]; drawPhoto(); say("Photo added. Remember to save.", "ok"); } });
    });
    function drawPhoto() {
      fill(photoBox, [avatar({ photo_url: state.photo_url, first_name: name.value || "?", last_name: "" }, "lg"),
        h("div", null, drop, state.photo_url ? h("button", { class: "link", type: "button", text: "Remove photo", onclick: function () { state.photo_url = null; drawPhoto(); } }) : null)]);
      drop.querySelector(".drop span:last-child").textContent = state.photo_url ? "Change photo" : "Add photo";
    }

    var saveBtn = h("button", { class: "btn", type: "submit", text: isNew ? "Add person" : "Save changes" });
    var form = h("form", { class: "fields", novalidate: true },
      h("div", { class: "field wide" }, photoBox),
      fieldWrap("Name", name), fieldWrap("What they do", headline),
      fieldWrap("Email", email), fieldWrap("Phone", phone),
      fieldWrap("City", city), fieldWrap("Links", links),
      fieldWrap("About them", bio, { wide: true }),
      fieldWrap("Private notes", notes, { wide: true, help: "Only admins ever see these." }),
      h("details", { class: "more wide" }, h("summary", { text: "Interests and more (helps suggest connections)" }),
        h("div", { class: "fields inner" }, fieldWrap("Disciplines", disciplines, { help: "Separate with commas." }), fieldWrap("Tags", tags, { help: "Separate with commas." }), fieldWrap("Pronouns", pronouns))),
      h("div", { class: "actions sticky" }, saveBtn));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!name.value.trim()) { name.focus(); return say("Add their name.", "error"); }
      if (email.value && !email.checkValidity()) { email.focus(); return say("That email doesn’t look right.", "error"); }
      var badLink = lines(links.value).find(function (l) { return !/^https?:\/\//i.test(l) && !/^@/.test(l); });
      if (badLink) { links.focus(); return say("Links need to start with https:// (or use @handle for Instagram).", "error"); }
      var data = Object.assign(splitName(name.value), {
        headline: clean(headline.value), city: clean(city.value), email: clean(email.value) && email.value.trim().toLowerCase(), phone: clean(phone.value),
        links: lines(links.value).map(function (l) { return /^@/.test(l) ? "https://instagram.com/" + l.slice(1) : l; }),
        bio: clean(bio.value), notes: clean(notes.value), disciplines: list(disciplines.value), tags: list(tags.value), pronouns: clean(pronouns.value), photo_url: state.photo_url,
      });
      saveBtn.disabled = true;
      var q = p ? sb.from("ce_people").update(data).eq("id", p.id).select().single() : sb.from("ce_people").insert(data).select().single();
      q.then(function (r) {
        saveBtn.disabled = false;
        if (r.error) return fail(r.error, "Couldn’t save");
        say(p ? "Saved." : fullName(r.data) + " added.", "ok");
        loadPeople().then(function () { if (isNew) location.hash = "#people/" + r.data.id; else render(); });
      });
    });
    drawPhoto();
    var out = [h("h2", { text: p ? fullName(p) : "New person" }), form];
    if (p) {
      out.push(personEvents(p), personConnections(p));
      out.push(h("div", { class: "danger-zone" }, h("button", { class: "link danger", type: "button", text: "Delete " + fullName(p), onclick: function () {
        if (!confirm("Delete " + fullName(p) + "? Their events list and connections go too. This can’t be undone.")) return;
        sb.from("ce_people").delete().eq("id", p.id).then(function (r) { if (r.error) return fail(r.error, "Couldn’t delete"); say("Deleted.", "ok"); loadPeople().then(function () { location.hash = "#people"; }); });
      } })));
    }
    return out;
  }

  function personEvents(p) {
    var listEl = h("ul", { class: "items" });
    var evIn = h("input", { id: "pe-event", type: "text", list: "dl-events", placeholder: "Type an event name" });
    var roleIn = h("select", { "aria-label": "Role" }, ROLES.map(function (r) { return h("option", { value: r, text: r[0].toUpperCase() + r.slice(1), selected: r === "attendee" }); }));
    var form = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { for: "pe-event", text: "Add to an event" }), evIn), h("div", { class: "field" }, h("label", { class: "label", text: "As" }), roleIn), h("button", { class: "btn", type: "submit", text: "Add" }));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var e = findEvent(evIn.value);
      if (!e) return say("Pick an event from the list.", "error");
      sb.from("ce_event_people").upsert({ event_id: e.id, person_id: p.id, role: roleIn.value }).then(function (r) { if (r.error) return fail(r.error); evIn.value = ""; say("Added to " + e.title + ".", "ok"); draw(); });
    });
    function draw() {
      sb.from("ce_event_people").select("event_id, role").eq("person_id", p.id).then(function (r) {
        if (r.error) return fail(r.error);
        var rows = r.data.filter(function (x) { return eventById[x.event_id]; }).sort(function (a, b) { return eventById[b.event_id].starts_at.localeCompare(eventById[a.event_id].starts_at); });
        fill(listEl, rows.length ? rows.map(function (x) {
          var e = eventById[x.event_id];
          return h("li", null, h("span", { class: "main" }, h("a", { href: "#events/" + e.id, text: e.title }), h("span", { class: "s", text: fmtDate(e.starts_at) + " · " + x.role })),
            h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () { sb.from("ce_event_people").delete().eq("event_id", e.id).eq("person_id", p.id).then(function (d) { if (d.error) return fail(d.error); draw(); }); } }));
        }) : h("li", { class: "empty", text: "Not at any events yet." }));
      });
    }
    draw();
    return h("section", null, h("h3", { text: "Events" }), listEl, form);
  }

  function personConnections(p) {
    var listEl = h("ul", { class: "items" }), sugEl = h("ul", { class: "items" });
    var otherIn = h("input", { id: "pc-other", type: "text", list: "dl-people", placeholder: "Type a name" });
    var kindIn = h("select", { "aria-label": "How they’re connected" }, KINDS.map(function (k) { return h("option", { value: k, text: k[0].toUpperCase() + k.slice(1) }); }));
    var form = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { for: "pc-other", text: "Connect with" }), otherIn), h("div", { class: "field" }, h("label", { class: "label", text: "How" }), kindIn), h("button", { class: "btn", type: "submit", text: "Connect" }));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var o = findPerson(otherIn.value);
      if (!o) return say("Pick someone from the list.", "error");
      if (o.id === p.id) return say("That’s the same person.", "error");
      connect(p.id, o.id, kindIn.value).then(function (ok) { if (ok) { otherIn.value = ""; draw(); } });
    });
    function draw() {
      sb.from("ce_connections").select("*").or("person_a.eq." + p.id + ",person_b.eq." + p.id).order("created_at", { ascending: false }).then(function (r) {
        if (r.error) return fail(r.error);
        fill(listEl, r.data.length ? r.data.map(function (c) {
          var oid = c.person_a === p.id ? c.person_b : c.person_a, o = personById[oid], e = c.event_id && eventById[c.event_id];
          return h("li", null, h("span", { class: "main person-inline" }, avatar(o, "sm"), h("span", null, h("a", { href: "#people/" + oid, text: fullName(o) }), h("span", { class: "s", text: [c.kind, e ? "at " + e.title : null, c.note].filter(Boolean).join(" · ") }))),
            h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () { removeConnection(c).then(draw); } }));
        }) : h("li", { class: "empty", text: "No connections yet." }));
      });
      sb.rpc("ce_connection_suggestions", { p_person: p.id, p_limit: 8 }).then(function (r) {
        if (r.error) return fail(r.error);
        fill(sugEl, r.data.length ? r.data.map(function (s) {
          var why = [];
          if (s.shared_events) why.push(s.shared_events + " event" + (s.shared_events === 1 ? "" : "s") + " together");
          if (s.shared_interests && s.shared_interests.length) why.push("both " + s.shared_interests.join(", "));
          return h("li", null, h("span", { class: "main person-inline" }, avatar(personById[s.person_id], "sm"), h("span", null, h("a", { href: "#people/" + s.person_id, text: fullName(s) }), h("span", { class: "s", text: why.join(" · ") }))),
            h("button", { class: "btn ghost small", type: "button", text: "Connect", onclick: function () { connect(p.id, s.person_id, s.shared_events ? "met" : "introduced").then(function (ok) { if (ok) draw(); }); } }));
        }) : h("li", { class: "empty", text: "No suggestions yet. They appear when people share events or interests." }));
      });
    }
    draw();
    return h("section", null, h("h3", { text: "Connections" }), listEl, form, h("h3", { text: "People they should meet" }), h("p", { class: "hint", text: "Not connected yet, but were at the same events or share interests." }), sugEl);
  }

  function connect(a, b, kind, note, eventId) {
    return sb.from("ce_connections").insert({ person_a: a, person_b: b, kind: kind, note: note || null, event_id: eventId || null }).then(function (r) {
      if (r.error) { fail(r.error, "Couldn’t connect"); return false; }
      say(fullName(personById[a]) + " and " + fullName(personById[b]) + " are connected.", "ok");
      return true;
    });
  }
  function removeConnection(c) {
    if (!confirm("Remove the connection between " + fullName(personById[c.person_a]) + " and " + fullName(personById[c.person_b]) + "?")) return Promise.resolve();
    return sb.from("ce_connections").delete().eq("id", c.id).then(function (r) { if (r.error) fail(r.error); else say("Connection removed.", "ok"); });
  }

  // Connections overview --------------------------------------------------------------------

  function connectionsTab() {
    var stats = h("div", { class: "stats" }), listEl = h("ul", { class: "items" }), all = [];
    var aIn = h("input", { id: "c-a", type: "text", list: "dl-people", placeholder: "Type a name" });
    var bIn = h("input", { id: "c-b", type: "text", list: "dl-people", placeholder: "Type a name" });
    var kindIn = h("select", { id: "c-kind" }, KINDS.map(function (k) { return h("option", { value: k, text: k[0].toUpperCase() + k.slice(1) }); }));
    var evIn = h("input", { id: "c-ev", type: "text", list: "dl-events", placeholder: "Optional" });
    var noteIn = h("input", { id: "c-note", type: "text", placeholder: "Optional", maxlength: 2000 });
    var form = h("form", { class: "fields" }, fieldWrap("Person", aIn), fieldWrap("Connect with", bIn), fieldWrap("How", kindIn), fieldWrap("At an event", evIn), fieldWrap("Note", noteIn, { wide: true }), h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: "Connect" })));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      var a = findPerson(aIn.value), b = findPerson(bIn.value), e = evIn.value.trim() ? findEvent(evIn.value) : null;
      if (!a || !b) return say("Pick both people from the list.", "error");
      if (a.id === b.id) return say("Pick two different people.", "error");
      if (evIn.value.trim() && !e) return say("Pick the event from the list, or leave it empty.", "error");
      connect(a.id, b.id, kindIn.value, clean(noteIn.value), e && e.id).then(function (ok) { if (ok) { aIn.value = bIn.value = evIn.value = noteIn.value = ""; load(); } });
    });
    function draw() {
      var shown = all.filter(function (c) { var e = c.event_id && eventById[c.event_id]; return matches(filters.connQ, [fullName(personById[c.person_a]), fullName(personById[c.person_b]), c.kind, c.note || "", e ? e.title : ""]); });
      fill(listEl, shown.length ? shown.slice(0, 500).map(function (c) {
        var e = c.event_id && eventById[c.event_id];
        return h("li", null, h("span", { class: "main" }, h("a", { href: "#people/" + c.person_a, text: fullName(personById[c.person_a]) }), " & ", h("a", { href: "#people/" + c.person_b, text: fullName(personById[c.person_b]) }),
          h("span", { class: "s", text: [c.kind, e ? "at " + e.title : null, c.note].filter(Boolean).join(" · ") })),
          h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () { removeConnection(c).then(load); } }));
      }) : h("li", { class: "empty", text: all.length ? "No connections match." : "No connections yet. Connect people here, from a person’s page, or from an event." }));
    }
    function stat(n, l) { return h("div", { class: "stat" }, h("div", { class: "n", text: String(n) }), h("div", { class: "l", text: l })); }
    function load() {
      sb.from("ce_connections").select("*").order("created_at", { ascending: false }).limit(5000).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t load connections");
        all = r.data;
        var degree = {};
        all.forEach(function (c) { degree[c.person_a] = (degree[c.person_a] || 0) + 1; degree[c.person_b] = (degree[c.person_b] || 0) + 1; });
        var connected = Object.keys(degree).length, top = Object.keys(degree).sort(function (x, y) { return degree[y] - degree[x]; })[0];
        fill(stats, [stat(all.length, "connections"), stat(people.length - connected, "people not connected yet"),
          top ? h("div", { class: "stat" }, h("div", { class: "n" }, h("a", { href: "#people/" + top, class: "plain", text: fullName(personById[top]) })), h("div", { class: "l", text: "most connected (" + degree[top] + ")" })) : null]);
        draw();
      });
    }
    load();
    return h("div", null, stats, h("div", { class: "split" },
      h("section", { class: "panel" }, h("h2", { text: "Connect two people" }), form),
      h("section", { class: "panel" }, h("h2", { text: "All connections" }), h("div", { class: "toolbar", style: "margin-top:16px" }, searchBox("connQ", "Search", draw)), listEl)));
  }

  // Partners ---------------------------------------------------------------------------------

  function partnersTab(id) {
    var listEl = h("ul", { class: "list" }), right = h("div");
    sb.from("ce_partners").select("*").order("sort").order("name").then(function (r) {
      if (r.error) return fail(r.error, "Couldn’t load partners");
      var rows = r.data, current = rows.find(function (x) { return x.id === id; });
      fill(listEl, rows.length ? rows.map(function (x) {
        return h("li", null, h("a", { class: "row person-row", href: "#partners/" + x.id, "aria-current": x.id === id ? "true" : null }, x.logo_url ? h("img", { class: "avatar logo", src: x.logo_url, alt: "" }) : h("span", { class: "avatar logo", text: x.name[0] }),
          h("span", { class: "main" }, h("span", { class: "t" }, x.name, x.published ? null : h("span", { class: "badge", text: "Hidden" })), h("span", { class: "s", text: x.url || " " }))));
      }) : h("li", { class: "empty", text: "No partners yet." }));
      if (id === "new" || current) add(right, partnerEditor(current || null));
      else add(right, h("p", { class: "blank", text: id ? "That partner doesn’t exist any more." : "Pick a partner, or add one." }));
    });
    return split([h("div", { class: "toolbar" }, h("a", { class: "btn", href: "#partners/new", text: "+ New partner" })), listEl], right);
  }
  function partnerEditor(x) {
    var state = { logo_url: x ? x.logo_url : null };
    var name = txt("pa-name", x && x.name, { required: true, maxlength: 200 });
    var url = h("input", { id: "pa-url", type: "url", value: (x && x.url) || "", placeholder: "https://…" });
    var desc = area("pa-desc", x && x.description, { rows: 3, maxlength: 2000 });
    var sort = h("input", { id: "pa-sort", type: "number", value: x ? x.sort : 0 });
    var shown = h("input", { id: "pa-pub", type: "checkbox", checked: x ? x.published : true });
    var logoRow = h("div", { class: "photo-row" });
    var drop = dropzone("Add logo", false, function (f) { uploadMany(f, "partners", function (u) { if (u[0]) { state.logo_url = u[0]; drawLogo(); } }); });
    function drawLogo() { fill(logoRow, [state.logo_url ? h("img", { class: "avatar lg logo", src: state.logo_url, alt: "" }) : h("span", { class: "avatar lg logo", text: "Logo" }), drop]); }
    drawLogo();
    var form = h("form", { class: "fields", novalidate: true }, h("div", { class: "field wide" }, logoRow), fieldWrap("Name", name), fieldWrap("Website", url), fieldWrap("About them", desc, { wide: true }),
      fieldWrap("Order", sort, { help: "Lower numbers come first." }), h("div", { class: "field" }, h("span", { class: "label", text: " " }), h("label", { class: "check" }, shown, "Show publicly")),
      h("div", { class: "actions" }, h("button", { class: "btn", type: "submit", text: x ? "Save changes" : "Add partner" }), h("span", { class: "spacer" }),
        x ? h("button", { class: "link danger", type: "button", text: "Delete", onclick: function () { if (!confirm("Delete " + x.name + "?")) return; sb.from("ce_partners").delete().eq("id", x.id).then(function (r) { if (r.error) return fail(r.error); say("Deleted.", "ok"); location.hash = "#partners"; }); } }) : null));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!name.value.trim()) return say("Add a name.", "error");
      if (url.value && !/^https?:\/\//i.test(url.value)) return say("The website needs to start with https://", "error");
      var data = { name: name.value.trim(), url: clean(url.value), description: clean(desc.value), sort: Number(sort.value) || 0, published: shown.checked, logo_url: state.logo_url };
      (x ? sb.from("ce_partners").update(data).eq("id", x.id).select().single() : sb.from("ce_partners").insert(data).select().single()).then(function (r) {
        if (r.error) return fail(r.error, "Couldn’t save");
        say("Saved.", "ok"); if (x) render(); else location.hash = "#partners/" + r.data.id;
      });
    });
    return [h("h2", { text: x ? x.name : "New partner" }), form];
  }

  // Website words -------------------------------------------------------------------------------

  function contentTab() {
    var wrap = h("section", { class: "panel narrow" }, h("h2", { text: "Website words" }), h("p", { class: "hint", text: "Change what the website says. Saving puts it live straight away. Empty a box to go back to the original words." }));
    sb.from("ce_site_content").select("*").then(function (r) {
      if (r.error) return fail(r.error, "Couldn’t load");
      var saved = {};
      r.data.forEach(function (x) { saved[x.key] = x; });
      var items = CONTENT.slice();
      r.data.forEach(function (x) { if (!items.some(function (i) { return i.key === x.key; })) items.push({ key: x.key, name: x.key, long: true }); });
      items.forEach(function (it) {
        var id = "c-" + it.key.replace(/[^a-z0-9]/g, "-");
        var cur = saved[it.key] ? saved[it.key].value : "";
        var input = it.long ? h("textarea", { id: id, rows: it.rows || 3, placeholder: it.hint, maxlength: 8000 }, cur) : h("input", { id: id, type: "text", value: cur, placeholder: it.hint, maxlength: 8000 });
        var note = h("span", { class: "s", text: saved[it.key] ? "Changed " + fmtDate(saved[it.key].updated_at) : "Using the original words" });
        var btn = h("button", { class: "btn small", type: "button", text: "Save", onclick: function () {
          var v = input.value.trim();
          btn.disabled = true;
          (v ? sb.from("ce_site_content").upsert({ key: it.key, value: v }) : sb.from("ce_site_content").delete().eq("key", it.key)).then(function (res) {
            btn.disabled = false;
            if (res.error) return fail(res.error, "Couldn’t save");
            note.textContent = v ? "Saved just now" : "Using the original words";
            say(v ? "Saved. It’s live on the website." : "Back to the original words.", "ok");
          });
        } });
        wrap.appendChild(h("div", { class: "content-item" }, h("label", { for: id, class: "name", text: it.name }), h("div", { style: "margin-top:8px" }, input), h("div", { class: "row2" }, btn, note)));
      });
      wrap.appendChild(h("p", { class: "hint", style: "margin-top:24px" }, h("a", { href: "/", target: "_blank", rel: "noopener", text: "Open the website ↗" })));
    });
    return wrap;
  }

  // Admins ----------------------------------------------------------------------------------------

  function adminsTab() {
    var listEl = h("ul", { class: "items" });
    var emailIn = h("input", { id: "ad-email", type: "email", placeholder: "Their email address", required: true });
    var form = h("form", { class: "adder" }, h("div", { class: "field" }, h("label", { for: "ad-email", text: "Make someone an admin" }), emailIn), h("span"), h("button", { class: "btn", type: "submit", text: "Add admin" }));
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
        fill(listEl, r.data.map(function (a) {
          var self = a.email === (me.email || "").toLowerCase();
          return h("li", null, h("span", { class: "main" }, a.email, h("span", { class: "s", text: self ? "You" : "Since " + fmtDate(a.created_at) })),
            self ? null : h("button", { class: "link danger", type: "button", text: "Remove", onclick: function () {
              if (!confirm("Remove " + a.email + " as an admin?")) return;
              sb.rpc("ce_remove_admin", { p_email: a.email }).then(function (d) { if (d.error) return fail(d.error); say("Removed.", "ok"); load(); });
            } }));
        }));
      });
    }
    load();
    return h("section", { class: "panel narrow" }, h("h2", { text: "Admins" }), h("p", { class: "hint", text: "Admins can change everything here. Add their email address; they create their account at /manage/ with that email and confirm it." }), listEl, form);
  }

  // Assistant ---------------------------------------------------------------------------------------
  // A chat with Claude that does the admin work: the function in
  // supabase/functions/ce-assistant relays each turn to Claude; the tools it
  // asks for run here, with this admin's own permissions. Changes to the public
  // website wait for the admin to press Approve.

  var FN_URL = CE.url + "/functions/v1/ce-assistant";
  var MAX_STEPS = 30;
  var convo = null;
  try { convo = JSON.parse(localStorage.getItem("ce-assistant") || "null"); } catch (e) { convo = null; }
  if (!convo || !Array.isArray(convo.messages)) convo = freshConvo();
  // Reloaded mid-step: answer any tool calls left hanging so the conversation can go on.
  (function () {
    var last = convo.messages[convo.messages.length - 1];
    if (!last || last.role !== "assistant" || !Array.isArray(last.content)) return;
    var hanging = last.content.filter(function (b) { return b.type === "tool_use"; });
    if (hanging.length) convo.messages.push({ role: "user", content: hanging.map(function (b) { return { type: "tool_result", tool_use_id: b.id, content: "Not done: the admin reloaded the page before this finished.", is_error: true }; }) });
  })();
  var busy = false, pending = [], assistantView = null;
  function freshConvo() { return { messages: [], display: [], photos: {}, next: 1 }; }
  function saveConvo() { try { localStorage.setItem("ce-assistant", JSON.stringify(convo)); } catch (e) { /* too big or blocked: keep it in memory */ } }
  function show(item) { convo.display.push(item); saveConvo(); drawAssistant(); }

  function localNow() {
    var d = new Date(), tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { /* ignore */ }
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }) + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) + (tz ? " (" + tz + ")" : "");
  }
  function callAssistant() {
    return sb.auth.getSession().then(function (s) {
      var token = s.data.session && s.data.session.access_token;
      return fetch(FN_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: CE.key, Authorization: "Bearer " + token }, body: JSON.stringify({ messages: convo.messages }) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body.error || (r.status === 404 ? "The assistant isn’t switched on yet (its Supabase function hasn’t been deployed)." : "The assistant couldn’t be reached."));
        return body;
      });
    });
  }

  function sendToAssistant(text, files) {
    if (busy) return;
    text = (text || "").trim();
    if (!text && !(files && files.length)) return;
    busy = true; drawAssistant();
    var uploads = files && files.length ? new Promise(function (res) { uploadMany(files, "chat", res); }) : Promise.resolve([]);
    uploads.then(function (urls) {
      var ids = urls.map(function (u) { var id = "photo-" + convo.next++; convo.photos[id] = u; return id; });
      var content = urls.slice(0, 8).map(function (u) { return { type: "image", source: { type: "url", url: u } }; });
      var note = "[Admin’s local time: " + localNow() + "]\n" + (text || "Here are some photos.");
      if (ids.length) note += "\n\n[Photos shared: " + ids.join(", ") + (ids.length > 8 ? " (the first 8 are shown to you)" : "") + "]";
      content.push({ type: "text", text: note });
      convo.messages.push({ role: "user", content: content });
      show({ who: "you", text: text, photos: urls });
      return loop();
    }).catch(function (err) { show({ who: "error", text: err.message || String(err) }); })
      .then(function () { busy = false; saveConvo(); drawAssistant(); return Promise.all([loadPeople(), loadEvents()]); })
      .then(function () { drawAssistant(); });
  }

  function loop(step) {
    step = step || 0;
    if (step >= MAX_STEPS) { show({ who: "error", text: "That took a lot of steps, so I stopped. Tell me to carry on if there’s more to do." }); return Promise.resolve(); }
    return callAssistant().then(function (res) {
      convo.messages.push({ role: "assistant", content: res.content });
      res.content.forEach(function (b) { if (b.type === "text" && b.text.trim()) show({ who: "assistant", text: b.text.trim() }); });
      if (res.stop_reason === "refusal") { show({ who: "error", text: "The assistant can’t help with that one." }); return; }
      if (res.stop_reason === "max_tokens") { show({ who: "error", text: "That answer was cut off. Ask me to continue." }); return; }
      if (res.stop_reason === "pause_turn") return loop(step + 1);
      var uses = res.content.filter(function (b) { return b.type === "tool_use"; });
      if (!uses.length) { saveConvo(); return; }
      return uses.reduce(function (p, u) {
        return p.then(function (results) {
          return Promise.resolve().then(function () { return runTool(u.name, u.input || {}); })
            .then(function (out) { results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) }); return results; },
              function (err) { console.error(err); results.push({ type: "tool_result", tool_use_id: u.id, content: "Error: " + ((err && err.message) || String(err)), is_error: true }); return results; });
        });
      }, Promise.resolve([])).then(function (results) {
        convo.messages.push({ role: "user", content: results });
        saveConvo();
        return loop(step + 1);
      });
    });
  }

  // What the assistant did, in a line the admin can follow.
  function did(text, href) { show({ who: "action", text: text, href: href }); }
  function q(promise) { return promise.then(function (r) { if (r.error) throw new Error(r.error.message); return r.data; }); }
  function brief(p) { return { id: p.id, name: fullName(p), headline: p.headline, city: p.city, email: p.email, disciplines: p.disciplines, tags: p.tags }; }
  function briefEvent(e) { return { id: e.id, title: e.title, starts: toLocalInput(e.starts_at), venue: e.venue, city: e.city, published: e.published, past: isPast(e), has_story: !!e.story, photos: (e.photos || []).length }; }
  function search(listOf, query, parts) {
    var words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return listOf.slice(0, 15);
    var scored = listOf.map(function (x) { var hay = parts(x).join(" ").toLowerCase(); return { x: x, n: words.filter(function (w) { return hay.indexOf(w) !== -1; }).length }; });
    return scored.filter(function (s) { return s.n; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 15).map(function (s) { return s.x; });
  }
  function needEvent(id) { var e = eventById[id]; if (!e) throw new Error("No event with id " + id + ". Search for it first."); return e; }
  function needPerson(id) { var p = personById[id]; if (!p) throw new Error("No person with id " + id + ". Search for them first."); return p; }
  function localToIso(v, label) { if (!v) return null; var d = new Date(v); if (isNaN(d)) throw new Error(label + " must look like 2026-12-10T19:00."); return d.toISOString(); }
  function httpsOk(v) { if (v && !/^https?:\/\//i.test(v)) throw new Error("Links must start with https://"); return v || null; }
  function personFields(i) {
    var d = {};
    if (i.name) Object.assign(d, splitName(i.name));
    ["headline", "city", "bio", "notes", "phone"].forEach(function (k) { if (i[k] !== undefined) d[k] = clean(i[k]); });
    if (i.email !== undefined) d.email = clean(i.email) && i.email.trim().toLowerCase();
    if (i.links) d.links = i.links.map(function (l) { l = String(l).trim(); return /^@/.test(l) ? "https://instagram.com/" + l.slice(1) : l; }).filter(function (l) { return /^https?:\/\//i.test(l); });
    if (i.disciplines) d.disciplines = i.disciplines.map(String);
    if (i.tags) d.tags = i.tags.map(String);
    return d;
  }
  function refresh() { return Promise.all([loadPeople(), loadEvents()]); }

  function runTool(name, i) {
    switch (name) {
      case "search_people":
        return search(people, i.query, function (p) { return [fullName(p), p.email || "", p.headline || "", p.city || "", (p.disciplines || []).join(" "), (p.tags || []).join(" ")]; }).map(brief);
      case "get_person": {
        var p = needPerson(i.person_id);
        return Promise.all([q(sb.from("ce_event_people").select("event_id, role").eq("person_id", p.id)), q(sb.from("ce_connections").select("*").or("person_a.eq." + p.id + ",person_b.eq." + p.id))]).then(function (r) {
          return Object.assign({}, brief(p), { bio: p.bio, notes: p.notes, links: p.links, phone: p.phone, has_photo: !!p.photo_url,
            events: r[0].map(function (x) { var e = eventById[x.event_id]; return e ? { event_id: e.id, title: e.title, starts: toLocalInput(e.starts_at), role: x.role } : null; }).filter(Boolean),
            connections: r[1].map(function (c) { var o = c.person_a === p.id ? c.person_b : c.person_a; return { person_id: o, name: fullName(personById[o]), kind: c.kind, note: c.note }; }) });
        });
      }
      case "save_person": {
        var data = personFields(i);
        if (i.person_id) {
          var existing = needPerson(i.person_id);
          return q(sb.from("ce_people").update(data).eq("id", existing.id).select().single()).then(function (row) { did("Updated " + fullName(row), "#people/" + row.id); return refresh().then(function () { return brief(row); }); });
        }
        if (!data.first_name) throw new Error("A new person needs a name.");
        var dupe = findPerson(fullName(data));
        if (dupe) return { already_exists: true, person: brief(dupe), hint: "Pass person_id to update them instead." };
        return q(sb.from("ce_people").insert(data).select().single()).then(function (row) { did("Added " + fullName(row) + " to People", "#people/" + row.id); return refresh().then(function () { return brief(row); }); });
      }
      case "search_events": {
        var pool = events.filter(function (e) { return i.when === "upcoming" ? !isPast(e) : i.when === "past" ? isPast(e) : true; });
        return search(pool, i.query, function (e) { return [e.title, e.venue || "", e.city || "", e.kind || "", toLocalInput(e.starts_at)]; }).map(briefEvent);
      }
      case "get_event": {
        var e = needEvent(i.event_id);
        return q(sb.from("ce_event_people").select("person_id, role").eq("event_id", e.id)).then(function (rows) {
          return Object.assign(briefEvent(e), { ends: toLocalInput(e.ends_at), kind: e.kind, description: e.description, story: e.story, link: e.link, has_cover: !!e.cover_url,
            people: rows.map(function (x) { return { person_id: x.person_id, name: fullName(personById[x.person_id]), role: x.role }; }) });
        });
      }
      case "save_event": {
        var d = {};
        ["title", "venue", "city", "kind", "description", "story"].forEach(function (k) { if (i[k] !== undefined) d[k] = clean(i[k]); });
        if (i.link !== undefined) d.link = httpsOk(clean(i.link));
        if (i.starts_at !== undefined) d.starts_at = localToIso(i.starts_at, "starts_at");
        if (i.ends_at !== undefined) d.ends_at = localToIso(i.ends_at, "ends_at");
        if (i.event_id) {
          var ev = needEvent(i.event_id);
          return q(sb.from("ce_events").update(d).eq("id", ev.id).select().single()).then(function (row) { did("Updated “" + row.title + "”", "#events/" + row.id); return refresh().then(function () { return briefEvent(row); }); });
        }
        if (!d.title || !d.starts_at) throw new Error("A new event needs a title and starts_at.");
        d.published = false;
        return q(sb.from("ce_events").insert(d).select().single()).then(function (row) { did("Created “" + row.title + "” (draft)", "#events/" + row.id); return refresh().then(function () { return briefEvent(row); }); });
      }
      case "add_people_to_event": {
        var evt = needEvent(i.event_id), made = [];
        return (i.people || []).reduce(function (p, x) {
          return p.then(function (acc) {
            var found = x.person_id ? personById[x.person_id] : (x.name ? findPerson(x.name) : null);
            if (found) { acc.push({ person: found, role: x.role }); return acc; }
            if (!x.name) throw new Error("Each person needs a person_id or a name.");
            var fields = splitName(x.name); if (x.email) fields.email = x.email.trim().toLowerCase();
            return q(sb.from("ce_people").insert(fields).select().single()).then(function (row) { made.push(fullName(row)); people.push(row); personById[row.id] = row; acc.push({ person: row, role: x.role }); return acc; });
          });
        }, Promise.resolve([])).then(function (acc) {
          return q(sb.from("ce_event_people").upsert(acc.map(function (a) { return { event_id: evt.id, person_id: a.person.id, role: a.role || "attendee" }; }))).then(function () {
            did("Added " + acc.length + " to “" + evt.title + "”" + (made.length ? " (new: " + made.join(", ") + ")" : ""), "#events/" + evt.id);
            return refresh().then(function () { return { added: acc.map(function (a) { return { person_id: a.person.id, name: fullName(a.person), role: a.role }; }), created: made }; });
          });
        });
      }
      case "connect_people": {
        var a = needPerson(i.person_a), b = needPerson(i.person_b);
        if (a.id === b.id) throw new Error("That's the same person.");
        if (i.event_id) needEvent(i.event_id);
        return sb.from("ce_connections").insert({ person_a: a.id, person_b: b.id, kind: i.kind, note: clean(i.note), event_id: i.event_id || null }).then(function (r) {
          if (r.error && r.error.code === "23505") return { already_connected: true };
          if (r.error) throw new Error(r.error.message);
          did("Connected " + fullName(a) + " and " + fullName(b) + " (" + i.kind + ")", "#people/" + a.id);
          return { connected: true };
        });
      }
      case "connect_everyone_at_event": {
        var ce = needEvent(i.event_id);
        return q(sb.rpc("ce_connect_event", { p_event: ce.id })).then(function (n) { if (n) did("Connected everyone at “" + ce.title + "” (" + n + " new)", "#events/" + ce.id); return { new_connections: n }; });
      }
      case "suggest_connections":
        needPerson(i.person_id);
        return q(sb.rpc("ce_connection_suggestions", { p_person: i.person_id, p_limit: 10 })).then(function (rows) { return rows.map(function (s) { return { person_id: s.person_id, name: fullName(s), shared_events: s.shared_events, shared_interests: s.shared_interests }; }); });
      case "attach_photos": {
        var urls = (i.photo_ids || []).map(function (id) { var u = convo.photos[id]; if (!u) throw new Error("No shared photo called " + id + "."); return u; });
        if (!urls.length) throw new Error("No photos given.");
        if (i.person_id) {
          var pp = needPerson(i.person_id);
          return q(sb.from("ce_people").update({ photo_url: urls[0] }).eq("id", pp.id)).then(function () { did("Set " + fullName(pp) + "’s photo", "#people/" + pp.id); return refresh().then(function () { return { ok: true }; }); });
        }
        var ee = needEvent(i.event_id);
        var photos = (ee.photos || []).concat(urls.filter(function (u) { return (ee.photos || []).indexOf(u) === -1; }));
        var cover = i.cover_photo_id ? convo.photos[i.cover_photo_id] : (ee.cover_url || urls[0]);
        return q(sb.from("ce_events").update({ photos: photos, cover_url: cover || null }).eq("id", ee.id)).then(function () {
          did("Added " + urls.length + " photo" + (urls.length === 1 ? "" : "s") + " to “" + ee.title + "”", "#events/" + ee.id);
          return refresh().then(function () { return { photos_now: photos.length, cover_set: !!cover }; });
        });
      }
      case "propose_publish": {
        var pe = needEvent(i.event_id);
        return approve((i.publish ? "Put “" + pe.title + "” on the website?" : "Take “" + pe.title + "” off the website?"), i.publish ? "Publish" : "Take it off", "#events/" + pe.id).then(function (yes) {
          if (!yes) return { approved: false };
          return q(sb.from("ce_events").update({ published: !!i.publish }).eq("id", pe.id)).then(function () { did(i.publish ? "“" + pe.title + "” is on the website" : "“" + pe.title + "” is off the website", "#events/" + pe.id); return refresh().then(function () { return { approved: true, published: !!i.publish, url: "https://creativeendeavors.xyz" + eventUrl(eventById[pe.id] || pe) }; }); });
        });
      }
      case "propose_website_words": {
        var item = CONTENT.find(function (c) { return c.key === i.key; });
        if (!item) throw new Error("Unknown key.");
        return approve("Change “" + item.name + "” to:", "Make it live", null, i.value).then(function (yes) {
          if (!yes) return { approved: false };
          return q(sb.from("ce_site_content").upsert({ key: i.key, value: String(i.value).trim() })).then(function () { did("Updated " + item.name.toLowerCase() + " on the website", "#content"); return { approved: true }; });
        });
      }
      case "propose_delete": {
        if (i.event_id) {
          var de = needEvent(i.event_id);
          return approve("Delete the event “" + de.title + "”? This can’t be undone.", "Delete", "#events/" + de.id).then(function (yes) {
            if (!yes) return { approved: false };
            return q(sb.from("ce_events").delete().eq("id", de.id)).then(function () { did("Deleted “" + de.title + "”"); return refresh().then(function () { return { approved: true, deleted: true }; }); });
          });
        }
        if (i.person_id) {
          var dp = needPerson(i.person_id);
          return approve("Delete " + fullName(dp) + " from People? Their events list and connections go too.", "Delete", "#people/" + dp.id).then(function (yes) {
            if (!yes) return { approved: false };
            return q(sb.from("ce_people").delete().eq("id", dp.id)).then(function () { did("Deleted " + fullName(dp)); return refresh().then(function () { return { approved: true, deleted: true }; }); });
          });
        }
        throw new Error("Give an event_id or a person_id.");
      }
      default:
        throw new Error("Unknown tool " + name);
    }
  }

  // An Approve / No thanks card; resolves true or false.
  function approve(question, yesText, href, detail) {
    return new Promise(function (resolve) {
      var item = { who: "approve", text: question, detail: detail, href: href, yes: yesText, answer: null };
      pending.push({ item: item, resolve: resolve });
      show(item);
    });
  }
  function answer(item, yes) {
    var i = pending.findIndex(function (x) { return x.item === item; });
    item.answer = yes ? "approved" : "declined";
    saveConvo(); drawAssistant();
    if (i >= 0) { var p = pending.splice(i, 1)[0]; p.resolve(yes); }
  }

  function composer(compact) {
    var files = [];
    var input = h("textarea", { id: compact ? "quick-ask" : "ask", rows: compact ? 3 : 2, placeholder: compact ? "Tell the assistant what happened or what you need, e.g. “Add last Friday’s dinner at The Loft with Maya Chen and Jordan Ellis, and write it up from these notes…”" : "Message the assistant… (Enter to send, Shift+Enter for a new line)" });
    var chips = h("div", { class: "attach-list" });
    var picker = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true });
    function drawFiles() { fill(chips, files.map(function (f, n) { return h("span", { class: "attach" }, f.name, h("button", { type: "button", "aria-label": "Remove " + f.name, text: "×", onclick: function () { files.splice(n, 1); drawFiles(); } })); })); }
    picker.addEventListener("change", function () { files = files.concat([].slice.call(picker.files)); picker.value = ""; drawFiles(); });
    var form = h("form", { class: "composer" + (compact ? " compact" : "") },
      input, chips,
      h("div", { class: "composer-bar" }, h("button", { type: "button", class: "btn ghost small", text: "Add photos", onclick: function () { picker.click(); } }), picker, h("span", { class: "spacer" }),
        h("button", { type: "submit", class: "btn", disabled: busy, text: busy ? "Working…" : "Send" })));
    form.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (busy) return;
      var t = input.value, f = files.slice();
      if (!t.trim() && !f.length) return input.focus();
      input.value = ""; files = []; drawFiles();
      if (compact) location.hash = "#assistant";
      sendToAssistant(t, f);
    });
    input.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && !ev.shiftKey && !compact) { ev.preventDefault(); form.requestSubmit(); } });
    ["dragover", "drop"].forEach(function (t) { form.addEventListener(t, function (ev) { ev.preventDefault(); if (t === "drop") { files = files.concat([].filter.call(ev.dataTransfer.files, function (x) { return /^image\//.test(x.type); })); drawFiles(); } }); });
    return form;
  }

  function assistantTab() {
    assistantView = h("div", { class: "chat-log", "aria-live": "polite" });
    var wrap = h("section", { class: "assistant" },
      h("div", { class: "panel-head" }, h("h2", { text: "Assistant" }), h("span", { class: "spacer" }),
        h("button", { class: "link", type: "button", text: "New conversation", onclick: function () {
          if (busy) return say("Wait for the assistant to finish first.", "error");
          if (convo.messages.length && !confirm("Start a new conversation? This one will be cleared from this screen (nothing it saved is undone).")) return;
          pending.forEach(function (p) { p.resolve(false); }); pending = [];
          convo = freshConvo(); saveConvo(); render();
        } })),
      h("p", { class: "hint", text: "Tell it what happened, paste notes or lists, add photos. It creates events and people, writes the stories, makes connections, and asks before anything goes on the website." }),
      assistantView, composer(false));
    // Drawn once the tab is on the page (render attaches it after this returns).
    setTimeout(function () { drawAssistant(); var a = $("ask"); if (a) a.focus(); }, 0);
    return wrap;
  }
  function drawAssistant() {
    if (!assistantView || !document.body.contains(assistantView)) return;
    var items = convo.display.map(function (d) {
      if (d.who === "you") return h("div", { class: "msg you" }, d.photos && d.photos.length ? h("div", { class: "msg-photos" }, d.photos.map(function (u) { return h("img", { src: u, alt: "" }); })) : null, d.text ? h("p", { text: d.text }) : null);
      if (d.who === "assistant") return h("div", { class: "msg bot" }, d.text.split(/\n{2,}/).map(function (p) { return h("p", { text: p.replace(/\*\*(.+?)\*\*/g, "$1") }); }));
      if (d.who === "action") return h("div", { class: "msg action" }, h("span", { class: "tick", "aria-hidden": "true", text: "✓" }), d.href ? h("a", { href: d.href, text: d.text }) : d.text);
      if (d.who === "error") return h("div", { class: "msg err", text: d.text });
      if (d.who === "approve") {
        var live = pending.some(function (p) { return p.item === d; });
        return h("div", { class: "msg approve" }, h("p", { class: "q", text: d.text }), d.detail ? h("blockquote", { text: d.detail }) : null,
          d.answer ? h("p", { class: "s", text: d.answer === "approved" ? "Approved" : "Declined" })
            : live ? h("div", { class: "row2" }, h("button", { class: "btn accent small", type: "button", text: d.yes, onclick: function () { answer(d, true); } }), h("button", { class: "btn ghost small", type: "button", text: "No thanks", onclick: function () { answer(d, false); } }), d.href ? h("a", { class: "link", href: d.href, text: "Look first" }) : null)
              : h("p", { class: "s", text: "No longer waiting (page was reloaded)." }));
      }
    });
    if (!items.length) items = [h("div", { class: "chat-empty" }, h("p", { text: "Try:" }), h("ul", null, [
      "Add a past event: Founders Dinner at The Loft, Brooklyn, last Friday at 7. Maya Chen hosted; Jordan Ellis and Sam Ortiz came. Write it up from these notes: …",
      "Here’s our guest list (paste names and emails). Add them all to People.",
      "Who should Maya Chen meet next?",
      "Which past events still need a write-up?",
    ].map(function (t) { return h("li", null, h("button", { type: "button", class: "link", text: t, onclick: function () { var a = $("ask"); a.value = t; a.focus(); } })); })))];
    if (busy) items.push(h("div", { class: "msg bot thinking" }, h("span", { class: "dots", "aria-label": "Working" }, h("i"), h("i"), h("i"))));
    fill(assistantView, items);
    var form = assistantView.parentNode && assistantView.parentNode.querySelector(".composer button[type=submit]");
    if (form) { form.disabled = busy; form.textContent = busy ? "Working…" : "Send"; }
    assistantView.scrollTop = assistantView.scrollHeight;
    if (assistantView.lastChild && assistantView.lastChild.scrollIntoView && document.activeElement && document.activeElement.id !== "ask") assistantView.lastChild.scrollIntoView({ block: "nearest" });
  }

  // Routing -----------------------------------------------------------------------------------------

  var TABS = { start: startTab, assistant: assistantTab, events: eventsTab, people: peopleTab, connections: connectionsTab, partners: partnersTab, content: contentTab, admins: adminsTab };
  var lastTab = null;
  function render() {
    var parts = (location.hash.replace(/^#/, "") || "start").split("/");
    var tab = TABS[parts[0]] ? parts[0] : "start";
    if (tab !== lastTab) say("");
    lastTab = tab;
    document.querySelectorAll("nav.tabs a").forEach(function (a) { if (a.dataset.tab === tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    fill($("view"), TABS[tab](parts[1] ? decodeURIComponent(parts[1]) : null));
    var label = document.querySelector('nav.tabs a[data-tab="' + tab + '"]');
    document.title = (label ? label.textContent + " · " : "") + "Manage · Creative Endeavors";
  }
  window.addEventListener("hashchange", function () { render(); window.scrollTo({ top: 0 }); });

  // Signing in -----------------------------------------------------------------------------------------

  function gate(title, text, showForm) {
    $("app").hidden = true; $("gate").hidden = false;
    $("sign-in").hidden = !showForm;
    if (showForm) return setMode(mode, true);
    $("gate-title").textContent = title; $("gate-text").textContent = text;
  }
  var started = false;
  function start(session) {
    me = session ? session.user : null;
    $("who").hidden = !me;
    if (me) $("who-email").textContent = me.email || "";
    if (!me) { started = false; return gate("", "", true); }
    if (recovering) { started = false; mode = "newpass"; return gate("", "", true); }
    if (started) return;
    started = true;
    gate("Manage.", "One moment…", false);
    sb.rpc("ce_is_admin").then(function (r) {
      if (r.error) { started = false; return gate("Almost ready.", "The admin area isn’t set up in the database yet. Run supabase/setup.sql in Supabase (see the README).", false); }
      if (!r.data) { started = false; return gate("Admins only.", "You’re signed in as " + (me.email || "someone") + ", which isn’t on the admin list. Ask an admin to add your email in /manage/ → Admins.", false); }
      return Promise.all([loadPeople(), loadEvents()]).then(function () { $("gate").hidden = true; $("app").hidden = false; render(); });
    }).catch(function (err) { started = false; fail(err); gate("Manage.", "Something went wrong. Please refresh the page.", false); });
  }
  // The sign-in form has four modes. Admins create their own account here with
  // the email they were made an admin with (see the list in supabase/setup.sql).
  var MODES = {
    signin: { title: "Manage.", text: "Sign in with your Creative Endeavors account.", button: "Sign in", password: "Password", links: '<a href="#" data-mode="signup">Create an account</a> · <a href="#" data-mode="forgot">Forgot your password?</a>' },
    signup: { title: "Create an account.", text: "Use the email address you were made an admin with, and choose a password of at least 8 characters.", button: "Create account", password: "Choose a password", links: 'Already have an account? <a href="#" data-mode="signin">Sign in</a>' },
    forgot: { title: "Forgot your password?", text: "We’ll email you a link to choose a new one.", button: "Email me a link", links: '<a href="#" data-mode="signin">Back to sign in</a>' },
    newpass: { title: "Choose a new password.", text: "At least 8 characters.", button: "Save password", password: "New password", links: "" },
  };
  var mode = "signin";
  // Arriving from a password reset email (the link ends in type=recovery).
  var recovering = /type=recovery/.test(location.hash);
  function setMode(m, keepStatus) {
    mode = m; var c = MODES[m];
    $("gate-title").textContent = c.title; $("gate-text").textContent = c.text;
    $("si-submit").textContent = c.button;
    $("si-email-field").hidden = m === "newpass"; $("si-email").required = m !== "newpass";
    $("si-password-field").hidden = m === "forgot"; $("si-password").required = m !== "forgot";
    if (c.password) $("si-password-label").textContent = c.password;
    $("si-password").autocomplete = m === "signin" ? "current-password" : "new-password";
    // Only new passwords need to be 8+ characters; existing ones sign in as they are.
    if (m === "signup" || m === "newpass") $("si-password").minLength = 8; else $("si-password").removeAttribute("minlength");
    $("si-links").innerHTML = c.links;
    if (!keepStatus) { $("si-status").textContent = ""; $("si-status").className = "status"; }
  }
  $("si-links").addEventListener("click", function (ev) {
    var m = ev.target.getAttribute && ev.target.getAttribute("data-mode");
    if (m) { ev.preventDefault(); setMode(m); $(m === "newpass" ? "si-password" : "si-email").focus(); }
  });
  function siSay(text, error) { var st = $("si-status"); st.textContent = text; st.className = "status show" + (error ? " error" : ""); }
  var authMessages = {
    "Invalid login credentials": "That email and password don’t match.",
    "Email not confirmed": "Please confirm your email first: open the link we sent you, then sign in.",
    "User already registered": "There’s already an account with that email. Sign in, or reset your password.",
  };
  function authError(err) { return authMessages[err.message] || err.message; }
  $("sign-in").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = $("si-email").value.trim(), password = $("si-password").value;
    var back = location.origin + "/manage/";
    if (mode === "signin") {
      siSay("Signing in…");
      sb.auth.signInWithPassword({ email: email, password: password }).then(function (r) {
        if (r.error) return siSay(authError(r.error), true);
        siSay("");
      });
    } else if (mode === "signup") {
      siSay("Creating your account…");
      sb.auth.signUp({ email: email, password: password, options: { emailRedirectTo: back } }).then(function (r) {
        if (r.error) return siSay(authError(r.error), true);
        if (r.data && r.data.session) return siSay("");
        setMode("signin", true);
        siSay("Almost there. We’ve emailed " + email + " a link to confirm the address. Open it, and you’ll be signed in.");
      });
    } else if (mode === "forgot") {
      siSay("Sending…");
      sb.auth.resetPasswordForEmail(email, { redirectTo: back }).then(function (r) {
        if (r.error) return siSay(authError(r.error), true);
        siSay("If there’s an account for " + email + ", a link to choose a new password is on its way.");
      });
    } else if (mode === "newpass") {
      siSay("Saving…");
      sb.auth.updateUser({ password: password }).then(function (r) {
        if (r.error) return siSay(authError(r.error), true);
        recovering = false; $("si-password").value = ""; setMode("signin");
        sb.auth.getSession().then(function (s) { start(s.data.session); });
      });
    }
  });
  $("sign-out").addEventListener("click", function () { sb.auth.signOut(); });
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "SIGNED_OUT") { started = false; people = []; events = []; }
    // Deferred: supabase-js holds a lock during this callback, and database calls made inside it can stall.
    if (event === "PASSWORD_RECOVERY") recovering = true;
    if (event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "PASSWORD_RECOVERY") setTimeout(function () { start(session); }, 0);
  });
})();
