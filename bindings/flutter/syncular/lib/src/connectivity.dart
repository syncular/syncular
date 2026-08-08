import 'dart:async';

import 'client.dart';

/// Adapts a Flutter connectivity plugin's current value and change stream.
class FlutterConnectivitySignal {
  FlutterConnectivitySignal({required this.online, required this.changes});

  final bool online;
  final Stream<bool> changes;
}

/// Binds connectivity evidence to the client's offline lifecycle.
class SyncularConnectivityAdapter {
  SyncularConnectivityAdapter(
    SyncularClient client,
    FlutterConnectivitySignal signal,
  ) {
    signal.online ? client.resume() : client.pause();
    _subscription = signal.changes.distinct().listen((online) {
      online ? client.resume() : client.pause();
    });
  }

  StreamSubscription<bool>? _subscription;

  Future<void> close() async {
    await _subscription?.cancel();
    _subscription = null;
  }
}
