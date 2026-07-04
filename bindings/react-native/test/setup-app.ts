/**
 * Preload for the App integration test: register happy-dom (so
 * `@testing-library/react` can render) and mock `react-native`'s primitive
 * components down to DOM tags, so the example's `App.tsx` — which imports
 * <View>/<Text>/<FlatList>/… from `react-native` — renders under bun with NO
 * device and NO Metro. This mirrors `packages/react/test/setup.ts` (the same
 * happy-dom harness the hooks are already tested with); it only adds the
 * `react-native` shim, because those primitives are the one thing bun can't
 * resolve off-device.
 *
 * The shim is deliberately shallow — it maps each primitive to the nearest DOM
 * element and forwards the handlers the test drives (`onPress`, `onChangeText`,
 * `onSubmitEditing`). It is NOT a react-native reimplementation; it exists only
 * so the SAME App component that ships to the device also renders here, proving
 * the hooks↔module wiring. Native layout/StyleSheet is a no-op (irrelevant to
 * the data-flow proof).
 */

import { mock } from 'bun:test';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import * as React from 'react';

GlobalRegistrator.register();

type AnyProps = Record<string, unknown> & { children?: React.ReactNode };

/**
 * Drop RN-only props that a DOM element / happy-dom cannot accept (notably
 * `style` — RN style objects are not CSS, and happy-dom throws on unknown
 * style keys). Keeps only what the test needs to inspect.
 */
function domProps(props: AnyProps): Record<string, unknown> {
  const {
    style: _style,
    accessibilityRole: _role,
    accessibilityState: _state,
    ...rest
  } = props;
  return rest;
}

/** A primitive → DOM-tag component (RN-only props stripped). */
function primitive(tag: string) {
  return (props: AnyProps) =>
    React.createElement(
      tag,
      domProps(props),
      props.children as React.ReactNode,
    );
}

mock.module('react-native', () => ({
  View: primitive('div'),
  Text: primitive('span'),
  // TextInput: forward value + onChangeText/onSubmitEditing to input events.
  TextInput: (props: AnyProps) =>
    React.createElement('input', {
      value: props.value as string,
      placeholder: props.placeholder as string,
      onChange: (e: { target: { value: string } }) =>
        (props.onChangeText as ((v: string) => void) | undefined)?.(
          e.target.value,
        ),
      onKeyDown: (e: { key: string }) => {
        if (e.key === 'Enter') {
          (props.onSubmitEditing as (() => void) | undefined)?.();
        }
      },
    }),
  // Pressable: a <button> firing onPress on click.
  Pressable: (props: AnyProps) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: props.onPress as (() => void) | undefined,
        disabled: props.disabled as boolean | undefined,
        'aria-label':
          (props.accessibilityRole as string | undefined) ?? undefined,
      },
      props.children as React.ReactNode,
    ),
  // FlatList: render each item's renderItem output into a <ul>.
  FlatList: (props: AnyProps) => {
    const data = (props.data as unknown[] | undefined) ?? [];
    const renderItem = props.renderItem as (arg: {
      item: unknown;
    }) => React.ReactElement;
    const keyExtractor = props.keyExtractor as
      | ((item: unknown, i: number) => string)
      | undefined;
    return React.createElement(
      'ul',
      {},
      data.map((item, i) =>
        React.createElement(
          'li',
          { key: keyExtractor?.(item, i) ?? String(i) },
          renderItem({ item }),
        ),
      ),
    );
  },
  StyleSheet: { create: <T>(styles: T): T => styles },
}));
