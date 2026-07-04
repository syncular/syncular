// The syncular React Native TurboModule — iOS implementation (objc++).
//
// A THIN shim over the syncular-ffi C ABI (rust/ffi.h, linked from
// Syncular.xcframework via the podspec). It owns the opaque handle, forwards
// JSON command strings, and pumps `syncular_client_poll_event` on a background
// queue, emitting each event JSON on the `syncular::event` topic.
//
// Everything is JSON strings on the wire (matching the C ABI's char*/char*), so
// there is zero custom marshaling — the JS layer (src/index.ts) owns parsing and
// the {$bytes:hex} convention.

#import "Syncular.h"
#import "ffi.h"  // the C-ABI header, vendored from rust/ffi.h into the xcframework

@implementation Syncular {
  void *_handle;
  dispatch_queue_t _pollQueue;
  BOOL _pumping;
}

RCT_EXPORT_MODULE()

- (instancetype)init {
  if (self = [super init]) {
    _handle = NULL;
    _pumping = NO;
    _pollQueue = dispatch_queue_create("dev.syncular.poll", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

// The events this module can emit (the derived client-observable set).
- (NSArray<NSString *> *)supportedEvents {
  return @[ @"syncular::event" ];
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
  if (_handle != NULL) {
    syncular_client_close(_handle);
    _handle = NULL;
  }
  _handle = syncular_client_new([configJson UTF8String]);
  if (_handle == NULL) {
    reject(@"client.failed", @"syncular_client_new returned null", nil);
    return;
  }
  NSString *command =
      [NSString stringWithFormat:@"{\"method\":\"create\",\"params\":%@}", createJson];
  char *reply = syncular_client_command(_handle, [command UTF8String]);
  resolve(takeOwnedString(reply));
}

RCT_EXPORT_METHOD(command
                  : (NSString *)commandJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  if (_handle == NULL) {
    reject(@"client.closed", @"client is closed", nil);
    return;
  }
  char *reply = syncular_client_command(_handle, [commandJson UTF8String]);
  resolve(takeOwnedString(reply));
}

RCT_EXPORT_METHOD(query
                  : (NSString *)sql paramsJson
                  : (NSString *)paramsJson resolve
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  if (_handle == NULL) {
    reject(@"client.closed", @"client is closed", nil);
    return;
  }
  // The `query` command wraps the SQL + params; the JS side already ensured
  // paramsJson is a JSON array of driver values.
  NSString *command = [NSString
      stringWithFormat:@"{\"method\":\"query\",\"params\":{\"sql\":%@,\"params\":%@}}",
                       jsonString(sql), paramsJson];
  char *reply = syncular_client_command(_handle, [command UTF8String]);
  resolve(takeOwnedString(reply));
}

RCT_EXPORT_METHOD(close
                  : (RCTPromiseResolveBlock)resolve reject
                  : (RCTPromiseRejectBlock)reject) {
  [self stopPump];
  if (_handle != NULL) {
    syncular_client_close(_handle);
    _handle = NULL;
  }
  resolve(nil);
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

- (void)stopPump {
  @synchronized(self) {
    _pumping = NO;
  }
}

- (void)invalidate {
  [self stopPump];
  if (_handle != NULL) {
    syncular_client_close(_handle);
    _handle = NULL;
  }
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
