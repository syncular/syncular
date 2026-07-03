/**
 * A MINIMAL ambient stub for `react-native` — just enough surface for this
 * module to typecheck standalone (`tsc --noEmit`) without installing the full
 * React Native package (heavy, and unnecessary for the JS-bridge verification
 * bar). In a consuming RN app the real `react-native` types are present and
 * this stub is shadowed (the app's node_modules resolution wins).
 *
 * Only the two symbols this module references are declared: `TurboModule` +
 * `TurboModuleRegistry` (for the codegen spec) and `NativeEventEmitter` (for
 * the event bridge auto-resolution).
 */
declare module 'react-native' {
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
}
