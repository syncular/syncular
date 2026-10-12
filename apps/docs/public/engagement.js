// Loads Cloudflare Web Analytics and counts one read per blog post view: 30
// active seconds and 60% scroll depth. The client router swaps pages without
// reloading, so this script runs once per full load and starts and stops a
// view on the router's page events.
(() => {
  if (
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === '1' ||
    navigator.doNotTrack === 'yes' ||
    navigator.msDoNotTrack === '1'
  ) {
    return;
  }

  // The beacon counts visits and Core Web Vitals from browsers that run
  // JavaScript, which keeps scanners out, and reports each client-router
  // navigation itself. Local dev servers stay out of the production numbers.
  if (location.hostname === 'syncular.dev') {
    const beacon = document.createElement('script');
    beacon.defer = true;
    beacon.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    beacon.dataset.cfBeacon = JSON.stringify({
      token: '80122b6445c84fd9a96643dd415510e0',
    });
    document.head.append(beacon);
  }

  const post = /^\/blog\/[a-z0-9][a-z0-9-]*\/?$/;
  let referrerHostname = (() => {
    try {
      return document.referrer ? new URL(document.referrer).hostname : '';
    } catch {
      return '';
    }
  })();
  let stopView;

  const startView = () => {
    if (!post.test(location.pathname)) return;

    const params = new URLSearchParams(location.search);
    const payload = {
      path: location.pathname,
      referrer: referrerHostname,
      utmSource: params.get('utm_source'),
      utmMedium: params.get('utm_medium'),
      utmCampaign: params.get('utm_campaign'),
      activeSeconds: 0,
      scrollDepth: 0,
    };
    let reported = false;

    const updateDepth = () => {
      const height = document.documentElement.scrollHeight;
      payload.scrollDepth = Math.max(
        payload.scrollDepth,
        height > 0 ? Math.min(1, (scrollY + innerHeight) / height) : 1,
      );
    };

    const reportIfRead = () => {
      updateDepth();
      if (reported || payload.activeSeconds < 30 || payload.scrollDepth < 0.6) {
        return;
      }

      reported = true;
      stopView();
      const body = JSON.stringify(payload);
      if (!navigator.sendBeacon('/_analytics/read', body)) {
        void fetch('/_analytics/read', {
          method: 'POST',
          body,
          keepalive: true,
          headers: { 'content-type': 'application/json' },
        });
      }
    };

    addEventListener('scroll', updateDepth, { passive: true });
    updateDepth();
    const ticker = setInterval(() => {
      if (document.visibilityState === 'visible') payload.activeSeconds += 1;
      reportIfRead();
    }, 1000);
    stopView = () => {
      clearInterval(ticker);
      removeEventListener('scroll', updateDepth);
      stopView = undefined;
    };
  };

  document.addEventListener('astro:page-load', () => {
    stopView?.();
    startView();
  });
  // A navigation inside the site arrives from this host.
  document.addEventListener('astro:before-swap', () => {
    stopView?.();
    referrerHostname = location.hostname;
  });
})();
