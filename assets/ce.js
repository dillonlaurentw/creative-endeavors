/* Creative Endeavors: the site's connection to its Supabase back end.
   The key below is the public "anon" key (the same one the community pages
   use). It can only do what the database's row-level security allows the
   public to do: read published events, published partners and site text. */
(function () {
  var URL = "https://rcpdsoqzlihwchariony.supabase.co";
  var KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjcGRzb3F6bGlod2NoYXJpb255Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg3NzYwNDQsImV4cCI6MjA4NDM1MjA0NH0.rMDgrkdhBVsoZRTC7bJK7kMIl3HhmLAGE1QGy9xDePU";

  function get(path) {
    return fetch(URL + "/rest/v1/" + path, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } })
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
