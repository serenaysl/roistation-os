(function () {
  var script = document.currentScript;
  if (!script) return;
  var origin = new URL(script.src).origin;
  // Optional attributes (existing embeds keep working unchanged):
  //   data-roistation-location="homepage" (default) | "service-page" | "footer"
  //   data-roistation-path="/hizmetler/boya"  (service pages; defaults to the current URL path)
  var locations = { homepage: 1, 'service-page': 1, footer: 1 };
  document.querySelectorAll('[data-roistation-site]').forEach(function (slot) {
    if (slot.querySelector('iframe[data-roistation-frame]')) return;
    var siteId = slot.getAttribute('data-roistation-site');
    if (!/^[a-z0-9-]+$/.test(siteId || '')) return;
    var location = slot.getAttribute('data-roistation-location') || '';
    if (location && !locations[location]) location = '';
    var query = '';
    if (location && location !== 'homepage') {
      query = '?location=' + encodeURIComponent(location);
      if (location === 'service-page') query += '&path=' + encodeURIComponent(slot.getAttribute('data-roistation-path') || window.location.pathname);
    }
    var frame = document.createElement('iframe');
    frame.src = origin + '/embed/' + encodeURIComponent(siteId) + query;
    frame.title = location === 'footer' ? 'Ek bilgiler' : 'Güncel içerikler ve iletişim formu';
    frame.setAttribute('data-roistation-frame', siteId);
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-top-navigation-by-user-activation');
    frame.style.cssText = 'width:100%;height:0;border:0;display:block;color-scheme:light';
    slot.appendChild(frame);
    window.addEventListener('message', function (event) {
      if (event.origin !== origin || event.source !== frame.contentWindow || !event.data || event.data.type !== 'roi-height' || event.data.siteId !== siteId) return;
      var height = Number(event.data.height);
      if (Number.isFinite(height) && height >= 0) frame.style.height = Math.min(height + (height ? 24 : 0), 100000) + 'px';
    });
  });
})();
