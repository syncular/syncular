// The syncular React Native TurboModule — iOS header.
//
// Bridges the RN JS module (src/index.ts) to the syncular-ffi C core. The module
// name "Syncular" matches `TurboModuleRegistry.getEnforcing<Spec>('Syncular')`
// in src/NativeSyncular.ts and the codegenConfig. The generated spec protocol
// (`SyncularSpec`) is produced by RN codegen at the consuming app's build from
// the .ts spec; this class conforms to it.
//
// It also emits events on the `syncular::event` topic via RCTEventEmitter,
// driven by a background thread pumping `syncular_client_poll_event`.

#import <React/RCTEventEmitter.h>

#ifdef RCT_NEW_ARCH_ENABLED
// The codegen'd spec protocol header (SyncularSpec) is available under the new
// architecture; import it so the compiler checks conformance.
#import <SyncularSpec/SyncularSpec.h>
@interface Syncular : RCTEventEmitter <NativeSyncularSpec>
#else
#import <React/RCTBridgeModule.h>
@interface Syncular : RCTEventEmitter <RCTBridgeModule>
#endif

@end
