package com.syncular

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers [SyncularModule] with the React Native runtime. Add this package to
 * the app's `getPackages()` (or rely on autolinking, which discovers it via the
 * package's `react-native.config.js` / gradle). The module name is `Syncular`,
 * matching `TurboModuleRegistry.getEnforcing<Spec>('Syncular')`.
 */
class SyncularPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(SyncularModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
