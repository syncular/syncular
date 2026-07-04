/**
 * A MINIMAL ambient stub for `react-native` — just enough surface for this
 * module AND the example (`example/src/App.tsx`) to typecheck standalone
 * (`tsc --noEmit`) without installing the full React Native package (heavy, and
 * unnecessary for the JS-bridge + hooks-integration verification bar). In a
 * consuming RN app the real `react-native` types are present and this stub is
 * shadowed (the app's node_modules resolution wins).
 *
 * Declared: the module's own needs — `TurboModule` + `TurboModuleRegistry`
 * (codegen spec) and `NativeEventEmitter` (event bridge) — plus the handful of
 * primitives + APIs the example App uses (`View`/`Text`/`TextInput`/
 * `Pressable`/`FlatList`/`StyleSheet`/`AppState`/`AppRegistry`). The shapes are
 * intentionally loose (the real RN types are far richer) — enough to typecheck
 * the App's usage, not to re-declare RN.
 */
declare module 'react-native' {
  import type { ComponentType, ReactNode } from 'react';

  export interface TurboModule {}

  export const TurboModuleRegistry: {
    getEnforcing<T>(name: string): T;
    get<T>(name: string): T | null;
  };

  export class NativeEventEmitter {
    constructor(nativeModule?: unknown);
    addListener(
      eventType: string,
      listener: (payload: never) => void,
    ): { remove(): void };
  }

  // -- primitive components (loose props; App uses a small subset) ------------
  export interface ViewProps {
    style?: unknown;
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
  }
  export const View: ComponentType<ViewProps>;
  export const Text: ComponentType<ViewProps>;

  export interface TextInputProps {
    style?: unknown;
    value?: string;
    placeholder?: string;
    autoCorrect?: boolean;
    onChangeText?: (text: string) => void;
    onSubmitEditing?: () => void;
  }
  export const TextInput: ComponentType<TextInputProps>;

  export interface PressableProps extends ViewProps {
    onPress?: () => void;
    disabled?: boolean;
  }
  export const Pressable: ComponentType<PressableProps>;

  export interface FlatListProps<T> {
    data: readonly T[];
    keyExtractor?: (item: T, index: number) => string;
    renderItem: (info: { item: T; index: number }) => ReactNode;
    style?: unknown;
  }
  export const FlatList: <T>(props: FlatListProps<T>) => ReactNode;

  export const StyleSheet: {
    create<T extends Record<string, unknown>>(styles: T): T;
  };

  // -- app APIs the entry point uses -----------------------------------------
  export const AppState: {
    addEventListener(
      type: 'change',
      handler: (state: 'active' | 'background' | 'inactive') => void,
    ): { remove(): void };
  };

  export const AppRegistry: {
    registerComponent(appKey: string, getComponent: () => ComponentType): void;
  };
}
