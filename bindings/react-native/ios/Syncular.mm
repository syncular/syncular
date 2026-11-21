// The syncular React Native TurboModule — iOS implementation (objc++).
//
// A THIN shim over the syncular-ffi C ABI (rust/ffi.h, linked from
// Syncular.xcframework via the podspec). It owns the opaque handle, forwards
// JSON command strings, and pumps `syncular_client_poll_event` on a background
// queue, emitting each event JSON on the `syncular::event` topic. A second
// pump polls `syncular_client_poll_headers` from create to close and emits each
// header request on the `syncular::headers` topic.
//
// Commands run on a private serial queue, never on the module's method queue:
// a command can block inside the core until the JS header source answers its
// header request, and that answer (`provideHeaders`) arrives on the method
// queue.
//
// Everything is JSON strings on the wire (matching the C ABI's char*/char*), so
// there is zero custom marshaling — the JS layer (src/index.ts) owns parsing and
// the {$bytes:hex} convention.

#import "Syncular.h"
#import "ffi.h"  // the C-ABI header, vendored from rust/ffi.h into the xcframework

@implementation Syncular {
  void *_handle;
  dispatch_queue_t _commandQueue;
  dispatch_queue_t _pollQueue;
  dispatch_queue_t _headerQueue;
  BOOL _pumping;
  BOOL _headerPumping;
}

RCT_EXPORT_MODULE()

- (instancetype)init {
  if (self = [super init]) {
    _handle = NULL;
    _pumping = NO;
    _headerPumping = NO;
    _commandQueue = dispatch_queue_create("dev.syncular.command", DISPATCH_QUEUE_SERIAL);
    _pollQueue = dispatch_queue_create("dev.syncular.poll", DISPATCH_QUEUE_SERIAL);
    _headerQueue = dispatch_queue_create("dev.syncular.headers", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

// The events this module can emit (the derived client-observable set).
- (NSArray<NSString *> *)supportedEvents {
  return @[ @"syncular::event", @"syncular::headers" ];
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

// -- Helpers ----------------------------------------------------------------

// Copy an owned C string out to an NSString and free it via the library. Never
// call free() on a syncular-owned pointer.
static NSString *takeOwnedString(char *ptr) {
  if (ptr == NULL) {
    return nil;
  }
  NSString *out = [NSString stringWithUTF8String:ptr];
  syncular_free_string(ptr);
  return out;
}

// -- Spec methods -----------------------------------------------------------

RCT_EXPORT_METHOD(create
                  : (NSString *)configJson createJson
                  : (NSString *)createJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  dispatch_async(_commandQueue, ^{
    [self closeHandle];
    void *handle = syncular_client_new([configJson UTF8String]);
    if (handle == NULL) {
      reject(@"client.failed", @"syncular_client_new returned null", nil);
      return;
    }
    @synchronized(self) {
      self->_handle = handle;
      self->_headerPumping = YES;
    }
    [self pumpHeaders];
    NSString *command =
        [NSString stringWithFormat:@"{\"method\":\"create\",\"params\":%@}", createJson];
    char *reply = syncular_client_command(handle, [command UTF8String]);
    resolve(takeOwnedString(reply));
  });
}

RCT_EXPORT_METHOD(command
                  : (NSString *)commandJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  dispatch_async(_commandQueue, ^{
    if (self->_handle == NULL) {
      reject(@"client.closed", @"client is closed", nil);
      return;
    }
    char *reply = syncular_client_command(self->_handle, [commandJson UTF8String]);
    resolve(takeOwnedString(reply));
  });
}

RCT_EXPORT_METHOD(query
                  : (NSString *)sql paramsJson
                  : (NSString *)paramsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  dispatch_async(_commandQueue, ^{
    if (self->_handle == NULL) {
      reject(@"client.closed", @"client is closed", nil);
      return;
    }
    // The `query` command wraps the SQL + params; the JS side already ensured
    // paramsJson is a JSON array of driver values.
    NSString *command = [NSString
        stringWithFormat:@"{\"method\":\"query\",\"params\":{\"sql\":%@,\"params\":%@}}",
                         jsonString(sql), paramsJson];
    char *reply = syncular_client_command(self->_handle, [command UTF8String]);
    resolve(takeOwnedString(reply));
  });
}

RCT_EXPORT_METHOD(close
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  dispatch_async(_commandQueue, ^{
    [self closeHandle];
    resolve(nil);
  });
}

// Runs on the method queue, outside `_commandQueue`: the command waiting for
// these headers occupies it. `syncular_client_provide_headers` takes no core
// lock; holding `self` only keeps `closeHandle` from freeing the handle under
// it. The core's reply carries nothing the JS source could act on.
RCT_EXPORT_METHOD(provideHeaders : (double)requestId headersJson : (NSString *)headersJson) {
  @synchronized(self) {
    if (_handle != NULL) {
      takeOwnedString(syncular_client_provide_headers(_handle, (uint64_t)requestId,
                                                      [headersJson UTF8String]));
    }
  }
}

RCT_EXPORT_METHOD(startEvents) {
  [self startPump];
}

RCT_EXPORT_METHOD(stopEvents) {
  [self stopPump];
}

// -- Event pump -------------------------------------------------------------

- (void)startPump {
  @synchronized(self) {
    if (_pumping || _handle == NULL) {
      return;
    }
    _pumping = YES;
  }
  __weak Syncular *weakSelf = self;
  dispatch_async(_pollQueue, ^{
    Syncular *strongSelf = weakSelf;
    while (strongSelf != nil) {
      @synchronized(strongSelf) {
        if (!strongSelf->_pumping || strongSelf->_handle == NULL) {
          break;
        }
      }
      // 25 ms bounded wait: responsive to stop, cheap when idle.
      char *event = syncular_client_poll_event(strongSelf->_handle, 25);
      if (event == NULL) {
        continue;
      }
      NSString *json = takeOwnedString(event);
      if (json != nil) {
        [strongSelf sendEventWithName:@"syncular::event" body:json];
      }
    }
  });
}

// Clears the flag, then joins the pump: the pump block leaves its loop within
// one 25 ms poll once `_pumping` is NO, and this empty block runs after it on
// the serial queue. A caller frees `_handle` only after no thread is inside
// `syncular_client_poll_event`. Never call this from `_pollQueue`.
- (void)stopPump {
  @synchronized(self) {
    _pumping = NO;
  }
  dispatch_sync(_pollQueue, ^{
  });
}

// -- Header pump ------------------------------------------------------------

// Polls the header channel until `closeHandle` clears `_headerPumping`; it
// keeps running through `stopEvents`, because a command may need headers
// while the app is in the background.
- (void)pumpHeaders {
  __weak Syncular *weakSelf = self;
  dispatch_async(_headerQueue, ^{
    Syncular *strongSelf = weakSelf;
    while (strongSelf != nil) {
      @synchronized(strongSelf) {
        if (!strongSelf->_headerPumping || strongSelf->_handle == NULL) {
          break;
        }
      }
      char *request = syncular_client_poll_headers(strongSelf->_handle, 25);
      if (request == NULL) {
        continue;
      }
      NSString *json = takeOwnedString(request);
      if (json != nil) {
        [strongSelf sendEventWithName:@"syncular::headers" body:json];
      }
    }
  });
}

// Stops both pumps, then frees the handle. Runs on `_commandQueue` (or after
// it drained), so no command is inside the core. The empty block joins the
// header pump the same way `stopPump` joins the event pump.
- (void)closeHandle {
  [self stopPump];
  @synchronized(self) {
    _headerPumping = NO;
  }
  dispatch_sync(_headerQueue, ^{
  });
  @synchronized(self) {
    if (_handle != NULL) {
      syncular_client_close(_handle);
      _handle = NULL;
    }
  }
}

- (void)invalidate {
  dispatch_sync(_commandQueue, ^{
    [self closeHandle];
  });
  [super invalidate];
}

// JSON-encode a string (for embedding SQL in the command envelope).
static NSString *jsonString(NSString *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@[ value ]
                                                 options:0
                                                   error:nil];
  NSString *arr = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  // arr is `["..."]`; strip the brackets to get the bare JSON string literal.
  return [arr substringWithRange:NSMakeRange(1, arr.length - 2)];
}

@end
