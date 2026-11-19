/* Creative Endeavors: the site's connection to its database (Supabase).
   This is the one place the database address and key live; every page uses
   these two lines. The key is the public "publishable" key: it can only do
   what the rules in supabase/setup.sql allow, so it's safe in a web page. */
(function () {
  var URL = "https://rcdjuxqojwcxfkdziwzw.supabase.co";
  var KEY = "sb_publishable_EGdeiS4rcz_5HL_CAR4BQg_OvRiT6FM";

  function get(path) {
    return fetch(URL + "/rest/v1/" + path, { headers: { apikey: KEY } })
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  window.CE = {
    url: URL,
    key: KEY,
    get: get,
    // Words edited in /manage/ → Site text. Elements marked data-content="key"
    // get that key's text; a key holding paragraphs separated by a blank line
    // fills one element per paragraph (data-content-paragraphs). Anything not
    // set keeps the words already on the page.
    applyContent: function () {
      var nodes = document.querySelectorAll("[data-content]");
      if (!nodes.length) return Promise.resolve();
      return get("ce_site_content?select=key,value").then(function (rows) {
        var map = {};
        rows.forEach(function (r) { map[r.key] = r.value; });
        nodes.forEach(function (n) {
          var v = map[n.getAttribute("data-content")];
          if (v == null || !v.trim()) return;
          if (n.hasAttribute("data-content-paragraphs")) {
            var cls = n.getAttribute("data-content-paragraphs");
            var frag = document.createDocumentFragment();
            v.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean).forEach(function (p) {
              var el = document.createElement("p"); el.className = cls; el.textContent = p; frag.appendChild(el);
            });
            n.replaceChildren(frag);
          } else {
            n.textContent = v.trim();
          }
        });
      }).catch(function () { /* keep the built-in words */ });
    },
  };
})();
