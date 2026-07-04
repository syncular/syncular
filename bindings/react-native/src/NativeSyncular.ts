/**
 * The TurboModule codegen spec for the syncular native module.
 *
 * RN's codegen reads this file (its name must start with `Native`) at the
 * consuming app's build and generates the C++/ObjC/Java interface glue. The
 * spec is deliberately MINIMAL — it mirrors the C-ABI FFI surface, not the
 * whole command set: one `command` dispatch (the entire method surface rides in
 * the JSON envelope), the `query` fast path, lifecycle (`create`/`close`), and
 * an event bridge (`pollEvent` + `addListener`/`removeListeners` for the
 * NativeEventEmitter). Everything speaks JSON strings so the bridge marshals no
 * custom types.
 *
 * All payloads are JSON STRINGS on the wire (not objects), matching the C ABI's
 * `char*` in / `char*` out exactly and keeping codegen's type surface trivial —
 * the JS layer (index.ts) parses/stringifies and owns the {$bytes:hex} bytes
 * convention.
 */
import type { TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  /**
   * Create the native core + issue `create`. `configJson` carries transport +
   * db path; `createJson` is the `{clientId, schema, limits}` create params.
   * Returns a reply JSON string (`{result}` / `{error}`). Idempotent-safe: a
   * second create replaces the core.
   */
  create(configJson: string, createJson: string): Promise<string>;

  /**
   * Run one JSON command (`{method, params}`) through the core. Returns the
   * reply JSON string (`{result}` / `{error}`). The whole command surface.
   */
  command(commandJson: string): Promise<string>;

  /**
   * The live-query fast path: read-only SQL over local tables. `paramsJson` is
   * a JSON array of driver values (bytes as `{$bytes:hex}`). Returns a reply
   * JSON string whose `result.rows` is the row array.
   */
  query(sql: string, paramsJson: string): Promise<string>;

  /** Close the native core, releasing db/transport/socket. */
  close(): Promise<void>;

  /**
   * Start the native side pumping `poll_event` and emitting each event JSON on
   * the `syncular::event` NativeEventEmitter topic. Called once after create.
   */
  startEvents(): void;

  /** Stop the native event pump (lifecycle pause). */
  stopEvents(): void;

  // NativeEventEmitter plumbing (required by the RN event contract).
  addListener(eventName: string): void;
  removeListeners(count: number): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Syncular');
