// dart:ffi bindings over the syncular-ffi C-ABI native core — the five
// functions in rust/ffi.h, hand-written (no ffigen; the surface is five
// functions of C strings, so codegen would add a dev-time dependency and a
// generated file for zero clarity). Kept in sync with rust/ffi.h; check.sh
// diffs the vendored header copy against rust/ffi.h and fails on drift, so
// this Dart translation is the only hand-maintained mirror.
//
// The C signatures (rust/ffi.h):
//   void*  syncular_client_new(const char* config_json);
//   char*  syncular_client_command(void* handle, const char* command_json);
//   char*  syncular_client_poll_event(void* handle, int64_t timeout_ms);
//   void   syncular_client_close(void* handle);
//   void   syncular_free_string(char* ptr);
//
// All strings are UTF-8, NUL-terminated. Strings RETURNED by command/
// poll_event are heap-owned by the library and MUST be released with
// syncular_free_string (never Dart's free) — SyncularFfi.commandString and
// pollEventString do exactly this before returning a Dart String.
import 'dart:convert';
import 'dart:ffi';
import 'dart:io' show Platform;

import 'package:ffi/ffi.dart';

// -- C typedefs (native) + Dart typedefs (called) ----------------------------

typedef _ClientNewNative = Pointer<Void> Function(Pointer<Utf8> configJson);
typedef _ClientNewDart = Pointer<Void> Function(Pointer<Utf8> configJson);

typedef _ClientCommandNative = Pointer<Utf8> Function(
    Pointer<Void> handle, Pointer<Utf8> commandJson);
typedef _ClientCommandDart = Pointer<Utf8> Function(
    Pointer<Void> handle, Pointer<Utf8> commandJson);

typedef _ClientPollEventNative = Pointer<Utf8> Function(
    Pointer<Void> handle, Int64 timeoutMs);
typedef _ClientPollEventDart = Pointer<Utf8> Function(
    Pointer<Void> handle, int timeoutMs);

typedef _ClientCloseNative = Void Function(Pointer<Void> handle);
typedef _ClientCloseDart = void Function(Pointer<Void> handle);

typedef _FreeStringNative = Void Function(Pointer<Utf8> ptr);
typedef _FreeStringDart = void Function(Pointer<Utf8> ptr);

/// Thin binding over the loaded `libsyncular` dynamic library: it resolves the
/// five C symbols and marshals Dart `String` <-> C `char*`, freeing every
/// library-owned return string via `syncular_free_string` (the ownership rule
/// in rust/ffi.h). Everything above this — JSON, typed conveniences, the poll
/// loop — lives in [SyncularClient].
class SyncularFfi {
  final _ClientNewDart _clientNew;
  final _ClientCommandDart _clientCommand;
  final _ClientPollEventDart _clientPollEvent;
  final _ClientCloseDart _clientClose;
  final _FreeStringDart _freeString;

  // The DynamicLibrary is not retained as a field: the looked-up function
  // pointers keep the library mapped, and nothing re-resolves symbols later.
  SyncularFfi._(DynamicLibrary lib)
      : _clientNew = lib
            .lookupFunction<_ClientNewNative, _ClientNewDart>(
                'syncular_client_new'),
        _clientCommand = lib
            .lookupFunction<_ClientCommandNative, _ClientCommandDart>(
                'syncular_client_command'),
        _clientPollEvent = lib
            .lookupFunction<_ClientPollEventNative, _ClientPollEventDart>(
                'syncular_client_poll_event'),
        _clientClose = lib
            .lookupFunction<_ClientCloseNative, _ClientCloseDart>(
                'syncular_client_close'),
        _freeString = lib
            .lookupFunction<_FreeStringNative, _FreeStringDart>(
                'syncular_free_string');

  /// Load `libsyncular` and bind the symbols.
  ///
  /// [libraryPath] pins an explicit dylib path (the tests use it, pointing at
  /// the freshly-built `target/debug/libsyncular.{dylib,so}`); otherwise the
  /// per-platform default name is opened from the loader search path (the same
  /// override-or-default shape as the Swift/Kotlin wrappers). The
  /// `SYNCULAR_LIBRARY_PATH` environment variable is honored as a fallback so
  /// `dart test` picks up the built core without code changes.
  factory SyncularFfi({String? libraryPath}) {
    final path = libraryPath ?? _resolveLibraryPath();
    final lib = path == null
        ? DynamicLibrary.process()
        : DynamicLibrary.open(path);
    return SyncularFfi._(lib);
  }

  static String? _resolveLibraryPath() {
    final env = Platform.environment['SYNCULAR_LIBRARY_PATH'];
    if (env != null && env.isNotEmpty) return env;
    // Per-platform default library name, resolved via the loader search path
    // (DYLD_LIBRARY_PATH / LD_LIBRARY_PATH / PATH). A consuming app that bundles
    // the core passes an absolute path instead.
    if (Platform.isMacOS) return 'libsyncular.dylib';
    if (Platform.isLinux || Platform.isAndroid) return 'libsyncular.so';
    if (Platform.isWindows) return 'syncular.dll';
    if (Platform.isIOS) return null; // statically linked into the process image
    return 'libsyncular.so';
  }

  /// `syncular_client_new(config_json)` → opaque handle (nullptr on failure).
  Pointer<Void> clientNew(String configJson) {
    final cConfig = configJson.toNativeUtf8();
    try {
      return _clientNew(cConfig);
    } finally {
      malloc.free(cConfig);
    }
  }

  /// `syncular_client_command(handle, command_json)` → owned reply JSON string
  /// (freed here), or `null` on a null handle.
  String? clientCommand(Pointer<Void> handle, String commandJson) {
    final cCommand = commandJson.toNativeUtf8();
    try {
      final replyPtr = _clientCommand(handle, cCommand);
      if (replyPtr == nullptr) return null;
      try {
        return replyPtr.toDartString();
      } finally {
        _freeString(replyPtr);
      }
    } finally {
      malloc.free(cCommand);
    }
  }

  /// `syncular_client_poll_event(handle, timeout_ms)` → owned event JSON string
  /// (freed here), or `null` if none arrived in time.
  String? clientPollEvent(Pointer<Void> handle, int timeoutMs) {
    final eventPtr = _clientPollEvent(handle, timeoutMs);
    if (eventPtr == nullptr) return null;
    try {
      return eventPtr.toDartString();
    } finally {
      _freeString(eventPtr);
    }
  }

  /// `syncular_client_close(handle)`.
  void clientClose(Pointer<Void> handle) => _clientClose(handle);
}

/// Encode a Dart JSON-able value to a compact JSON string for a command.
String encodeJson(Object? value) => jsonEncode(value);

/// Decode a JSON reply string to a Dart value (`Map`, `List`, scalar).
Object? decodeJson(String text) => jsonDecode(text);
