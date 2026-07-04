/**
 * RN entry point. On a device this boots the NATIVE syncular core:
 * `createNativeSyncClient` auto-resolves the codegen `NativeSyncular`
 * TurboModule and constructs a `NativeEventEmitter` over it (no injection —
 * that path is only for tests). Then it renders <App client={client}/>.
 *
 * The tiny `Boot` wrapper does the one async thing an app must: await the
 * native `create` (which opens the rusqlite file DB on the Rust side) before
 * mounting the hook tree. Everything after that is the framework-agnostic
 * <App/> — identical to the web demos.
 */
import { createNativeSyncClient } from '@syncular-v2/react-native';
import React, { useEffect, useState } from 'react';
import { AppRegistry, AppState, Text, View } from 'react-native';
import { name as appName } from './app.json';
import { App } from './src/App';
import { schema } from './src/syncular.generated';

function Boot() {
  const [client, setClient] = useState(undefined);
  const [error, setError] = useState(undefined);

  useEffect(() => {
    let live;
    let appStateSub;
    createNativeSyncClient({
      clientId: 'rn-example-device',
      schema,
      // Point at your server to engage the native transport; omit for a
      // purely offline-first demo (mutations still queue in the outbox).
      // baseUrl: 'https://your.server/sync',
    })
      .then((c) => {
        live = c;
        setClient(c);
        // Lifecycle: pause the native event pump in the background, resume on
        // foreground (§ battery-friendly; the outbox keeps queuing offline).
        appStateSub = AppState.addEventListener('change', (state) => {
          if (state === 'active') void c.resume();
          else void c.pause();
        });
      })
      .catch((e) => setError(String(e)));

    return () => {
      appStateSub?.remove();
      void live?.close();
    };
  }, []);

  if (error !== undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Text>failed to start: {error}</Text>
      </View>
    );
  }
  if (client === undefined) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Text>starting native syncular core…</Text>
      </View>
    );
  }
  return <App client={client} />;
}

AppRegistry.registerComponent(appName, () => Boot);
