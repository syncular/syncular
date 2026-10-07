import { describe, expect, test } from 'bun:test';
import { pageScript } from '../src/page-lifecycle';

describe('pageScript', () => {
  test('runs init on each page load and teardown before the next swap', () => {
    const target = new EventTarget();
    const log: string[] = [];
    let views = 0;
    pageScript(
      () => {
        const view = ++views;
        log.push(`init ${view}`);
        return () => log.push(`teardown ${view}`);
      },
      target,
      () => false,
    );

    target.dispatchEvent(new Event('astro:page-load'));
    target.dispatchEvent(new Event('astro:before-swap'));
    target.dispatchEvent(new Event('astro:page-load'));
    target.dispatchEvent(new Event('astro:before-swap'));

    expect(log).toEqual(['init 1', 'teardown 1', 'init 2', 'teardown 2']);
  });

  test('tears down a view that is initialised twice without a swap', () => {
    const target = new EventTarget();
    const log: string[] = [];
    let views = 0;
    pageScript(
      () => {
        const view = ++views;
        log.push(`init ${view}`);
        return () => log.push(`teardown ${view}`);
      },
      target,
      () => false,
    );

    target.dispatchEvent(new Event('astro:page-load'));
    target.dispatchEvent(new Event('astro:page-load'));

    expect(log).toEqual(['init 1', 'teardown 1', 'init 2']);
  });

  test('tears down once and ignores pages whose init returns nothing', () => {
    const target = new EventTarget();
    let tornDown = 0;
    let present = true;
    pageScript(
      () => (present ? () => void tornDown++ : undefined),
      target,
      () => false,
    );

    target.dispatchEvent(new Event('astro:page-load'));
    target.dispatchEvent(new Event('astro:before-swap'));
    target.dispatchEvent(new Event('astro:before-swap'));
    present = false;
    target.dispatchEvent(new Event('astro:page-load'));
    target.dispatchEvent(new Event('astro:before-swap'));

    expect(tornDown).toBe(1);
  });

  test('initialises immediately when the page-load event already fired', () => {
    const target = new EventTarget();
    const log: string[] = [];
    pageScript(
      () => {
        log.push('init');
        return () => log.push('teardown');
      },
      target,
      () => true,
    );

    expect(log).toEqual(['init']);
    target.dispatchEvent(new Event('astro:before-swap'));
    expect(log).toEqual(['init', 'teardown']);
  });
});
