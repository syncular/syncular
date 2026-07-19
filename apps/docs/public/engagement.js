(() => {
  if (
    navigator.globalPrivacyControl === true ||
    navigator.doNotTrack === '1' ||
    !/^\/blog\/[a-z0-9][a-z0-9-]*\/?$/.test(location.pathname)
  ) {
    return;
  }

  const params = new URLSearchParams(location.search);
  const payload = {
    path: location.pathname,
    referrer: document.referrer,
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
    if (
      reported ||
      payload.activeSeconds < 30 ||
      payload.scrollDepth < 0.6
    ) {
      return;
    }

    reported = true;
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
  setInterval(() => {
    if (document.visibilityState === 'visible') payload.activeSeconds += 1;
    reportIfRead();
  }, 1000);
})();
