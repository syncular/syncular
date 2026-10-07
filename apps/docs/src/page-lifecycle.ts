// Page scripts under <ClientRouter>. The router swaps the body without
// reloading, so a bundled script evaluates once per full load while its
// page comes and goes. `pageScript` runs `init` on each page view (the
// first load and every swap) and runs the teardown `init` returns before
// the next swap, so timers, observers, and window listeners never outlive
// the page that created them.
export type Teardown = () => void;

export const pageScript = (
  init: () => Teardown | undefined,
  target: EventTarget = document,
  pageLoaded: () => boolean = () =>
    'pageLoaded' in document.documentElement.dataset,
): void => {
  let teardown: Teardown | undefined;
  const stop = () => {
    teardown?.();
    teardown = undefined;
  };
  target.addEventListener('astro:page-load', () => {
    stop();
    teardown = init();
  });
  target.addEventListener('astro:before-swap', stop);
  // A module that evaluates after its page's `astro:page-load` already
  // fired (a slow module graph) would otherwise never initialise.
  if (pageLoaded()) teardown = init();
};
