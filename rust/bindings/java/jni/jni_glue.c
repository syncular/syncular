#include <jni.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <stdatomic.h>
#include <syncular-runtime.h>

static inline bool boltffi_exception_pending(JNIEnv* env) {
    return (*env)->ExceptionCheck(env);
}

static inline bool boltffi_consume_pending_exception(JNIEnv* env) {
    if (!boltffi_exception_pending(env)) return false;
    (*env)->ExceptionClear(env);
    return true;
}

static inline void boltffi_throw_out_of_memory(JNIEnv* env, const char* message) {
    jclass oom_class = (*env)->FindClass(env, "java/lang/OutOfMemoryError");
    if (oom_class == NULL) return;
    (*env)->ThrowNew(env, oom_class, message);
    (*env)->DeleteLocalRef(env, oom_class);
}

static inline void boltffi_throw_illegal_argument(JNIEnv* env, const char* message) {
    jclass exception_class = (*env)->FindClass(env, "java/lang/IllegalArgumentException");
    if (exception_class == NULL) return;
    (*env)->ThrowNew(env, exception_class, message);
    (*env)->DeleteLocalRef(env, exception_class);
}

static inline void boltffi_throw_runtime(JNIEnv* env, const char* message) {
    jclass exception_class = (*env)->FindClass(env, "java/lang/RuntimeException");
    if (exception_class == NULL) return;
    (*env)->ThrowNew(env, exception_class, message);
    (*env)->DeleteLocalRef(env, exception_class);
}

static inline void boltffi_throw_status(JNIEnv* env, FfiStatus status, const char* fallback_message) {
    if (status.code == 3) {
        boltffi_throw_illegal_argument(env, "invalid argument");
    } else if (status.code == 4) {
        boltffi_throw_runtime(env, "operation cancelled");
    } else {
        boltffi_throw_runtime(env, fallback_message);
    }
}

static inline bool boltffi_try_jlong_to_usize(jlong value, uintptr_t* out_value) {
    if (value < 0) return false;
    uint64_t unsigned_value = (uint64_t)value;
    if (unsigned_value > (uint64_t)UINTPTR_MAX) return false;
    *out_value = (uintptr_t)unsigned_value;
    return true;
}

typedef struct {
    void (*free)(uint64_t handle);
    uint64_t (*clone)(uint64_t handle);
} BoltFFICallbackVTablePrefix;

static inline const BoltFFICallbackVTablePrefix* boltffi_callback_vtable_prefix(
    const BoltFFICallbackHandle* callback
) {
    return callback == NULL ? NULL : (const BoltFFICallbackVTablePrefix*)callback->vtable;
}

static inline void boltffi_release_callback_value(BoltFFICallbackHandle callback) {
    const BoltFFICallbackVTablePrefix* vtable = boltffi_callback_vtable_prefix(&callback);
    if (callback.handle != 0 && vtable != NULL && vtable->free != NULL) {
        vtable->free(callback.handle);
    }
}

static inline BoltFFICallbackHandle* boltffi_jvm_callback_handle_ref(jlong handle) {
    if (handle == 0) return NULL;
    return (BoltFFICallbackHandle*)(uintptr_t)handle;
}

static inline jlong boltffi_jvm_callback_handle_new_owned(
    JNIEnv* env,
    BoltFFICallbackHandle callback
) {
    if (callback.handle == 0 || callback.vtable == NULL) return 0;
    BoltFFICallbackHandle* stored_callback =
        (BoltFFICallbackHandle*)malloc(sizeof(BoltFFICallbackHandle));
    if (stored_callback == NULL) {
        boltffi_release_callback_value(callback);
        boltffi_throw_out_of_memory(env, "Failed to allocate callback handle");
        return 0;
    }
    *stored_callback = callback;
    return (jlong)(uintptr_t)stored_callback;
}

static inline void boltffi_jvm_callback_handle_release(BoltFFICallbackHandle* callback) {
    if (callback == NULL) return;
    boltffi_release_callback_value(*callback);
    free(callback);
}

static inline jlong boltffi_jvm_callback_handle_clone(
    JNIEnv* env,
    const BoltFFICallbackHandle* callback
) {
    const BoltFFICallbackVTablePrefix* vtable = boltffi_callback_vtable_prefix(callback);
    if (callback == NULL || callback->handle == 0 || vtable == NULL || vtable->clone == NULL) {
        return 0;
    }
    BoltFFICallbackHandle cloned_callback = {
        .handle = vtable->clone(callback->handle),
        .vtable = callback->vtable,
    };
    if (cloned_callback.handle == 0) {
        return 0;
    }
    return boltffi_jvm_callback_handle_new_owned(env, cloned_callback);
}

static inline jbyteArray boltffi_buf_to_jbytearray(JNIEnv* env, FfiBuf_u8 buf) {
    if (buf.ptr == NULL) {
        if (buf.len != 0) {
            boltffi_throw_runtime(env, "BoltFFI buffer pointer was null with non-zero length");
        }
        return NULL;
    }
    if (buf.len > (size_t)INT32_MAX) {
        boltffi_free_buf(buf);
        boltffi_throw_out_of_memory(env, "BoltFFI buffer too large for Java byte array");
        return NULL;
    }
    jsize len = (jsize)buf.len;
    jbyteArray arr = (*env)->NewByteArray(env, len);
    if (arr == NULL) {
        boltffi_free_buf(buf);
        return NULL;
    }
    (*env)->SetByteArrayRegion(env, arr, 0, len, (const jbyte*)buf.ptr);
    boltffi_free_buf(buf);
    if (boltffi_exception_pending(env)) {
        (*env)->DeleteLocalRef(env, arr);
        return NULL;
    }
    return arr;
}

static inline jbyteArray boltffi_status_buf_to_jbytearray(JNIEnv* env, FfiStatus status, FfiBuf_u8 buf) {
    if (status.code != 0) {
        if (buf.ptr != NULL) {
            boltffi_free_buf(buf);
        }
        boltffi_throw_status(env, status, "ffi call failed");
        return NULL;
    }
    return boltffi_buf_to_jbytearray(env, buf);
}

static inline uint32_t boltffi_le_u32(const uint8_t* bytes) {
    return
        ((uint32_t)bytes[0]) |
        ((uint32_t)bytes[1] << 8) |
        ((uint32_t)bytes[2] << 16) |
        ((uint32_t)bytes[3] << 24);
}

static inline jstring boltffi_utf8_buf_to_jstring(JNIEnv* env, FfiBuf_u8 buf) {
    if (buf.ptr == NULL) {
        if (buf.len != 0) {
            boltffi_throw_runtime(env, "BoltFFI string buffer pointer was null with non-zero length");
        }
        return NULL;
    }
    if (buf.len < 4) {
        boltffi_free_buf(buf);
        boltffi_throw_runtime(env, "BoltFFI string buffer missing length prefix");
        return NULL;
    }

    const uint8_t* bytes = (const uint8_t*)buf.ptr;
    size_t payload_len = (size_t)boltffi_le_u32(bytes);
    if (payload_len > buf.len - 4) {
        boltffi_free_buf(buf);
        boltffi_throw_runtime(env, "BoltFFI string buffer length prefix exceeded payload");
        return NULL;
    }
    if (payload_len == 0) {
        boltffi_free_buf(buf);
        return (*env)->NewString(env, NULL, 0);
    }
    if (payload_len > (size_t)INT32_MAX) {
        boltffi_free_buf(buf);
        boltffi_throw_out_of_memory(env, "BoltFFI string too large for Java string");
        return NULL;
    }

    const uint8_t* utf8 = bytes + 4;
    jchar stack_chars[64];
    jchar* chars = stack_chars;
    if (payload_len > sizeof(stack_chars) / sizeof(stack_chars[0])) {
        chars = (jchar*)malloc(payload_len * sizeof(jchar));
        if (chars == NULL) {
            boltffi_free_buf(buf);
            boltffi_throw_out_of_memory(env, "Failed to allocate Java string buffer");
            return NULL;
        }
    }

    size_t in_pos = 0;
    size_t out_pos = 0;
    bool invalid_utf8 = false;
    while (in_pos < payload_len) {
        uint8_t b0 = utf8[in_pos];
        if (b0 < 0x80) {
            chars[out_pos++] = (jchar)b0;
            in_pos += 1;
            continue;
        }

        uint32_t codepoint = 0;
        if ((b0 & 0xE0) == 0xC0) {
            if (in_pos + 1 >= payload_len) {
                invalid_utf8 = true;
                break;
            }
            uint8_t b1 = utf8[in_pos + 1];
            if ((b1 & 0xC0) != 0x80) {
                invalid_utf8 = true;
                break;
            }
            codepoint = ((uint32_t)(b0 & 0x1F) << 6) | (uint32_t)(b1 & 0x3F);
            if (codepoint < 0x80) {
                invalid_utf8 = true;
                break;
            }
            chars[out_pos++] = (jchar)codepoint;
            in_pos += 2;
            continue;
        }

        if ((b0 & 0xF0) == 0xE0) {
            if (in_pos + 2 >= payload_len) {
                invalid_utf8 = true;
                break;
            }
            uint8_t b1 = utf8[in_pos + 1];
            uint8_t b2 = utf8[in_pos + 2];
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80) {
                invalid_utf8 = true;
                break;
            }
            codepoint =
                ((uint32_t)(b0 & 0x0F) << 12) |
                ((uint32_t)(b1 & 0x3F) << 6) |
                (uint32_t)(b2 & 0x3F);
            if (codepoint < 0x800 || (codepoint >= 0xD800 && codepoint <= 0xDFFF)) {
                invalid_utf8 = true;
                break;
            }
            chars[out_pos++] = (jchar)codepoint;
            in_pos += 3;
            continue;
        }

        if ((b0 & 0xF8) == 0xF0) {
            if (in_pos + 3 >= payload_len) {
                invalid_utf8 = true;
                break;
            }
            uint8_t b1 = utf8[in_pos + 1];
            uint8_t b2 = utf8[in_pos + 2];
            uint8_t b3 = utf8[in_pos + 3];
            if ((b1 & 0xC0) != 0x80 || (b2 & 0xC0) != 0x80 || (b3 & 0xC0) != 0x80) {
                invalid_utf8 = true;
                break;
            }
            codepoint =
                ((uint32_t)(b0 & 0x07) << 18) |
                ((uint32_t)(b1 & 0x3F) << 12) |
                ((uint32_t)(b2 & 0x3F) << 6) |
                (uint32_t)(b3 & 0x3F);
            if (codepoint < 0x10000 || codepoint > 0x10FFFF) {
                invalid_utf8 = true;
                break;
            }
            uint32_t surrogate = codepoint - 0x10000;
            chars[out_pos++] = (jchar)(0xD800 + (surrogate >> 10));
            chars[out_pos++] = (jchar)(0xDC00 + (surrogate & 0x3FF));
            in_pos += 4;
            continue;
        }

        invalid_utf8 = true;
        break;
    }

    jstring result = NULL;
    if (!invalid_utf8) {
        if (out_pos > (size_t)INT32_MAX) {
            boltffi_throw_out_of_memory(env, "BoltFFI string too large for Java string");
        } else {
            result = (*env)->NewString(env, chars, (jsize)out_pos);
        }
    }

    if (chars != stack_chars) {
        free(chars);
    }
    boltffi_free_buf(buf);

    if (invalid_utf8) {
        char message[96];
        snprintf(
            message,
            sizeof(message),
            "BoltFFI string buffer contained invalid UTF-8 at byte offset %zu",
            in_pos
        );
        boltffi_throw_runtime(env, message);
        return NULL;
    }
    return result;
}

static inline bool boltffi_lookup_static_method(
    JNIEnv* env,
    jclass cls,
    const char* name,
    const char* signature,
    jmethodID* out_method
) {
    *out_method = (*env)->GetStaticMethodID(env, cls, name, signature);
    if (*out_method != NULL) return true;
    boltffi_consume_pending_exception(env);
    return false;
}

typedef enum {
    BOLTFFI_GLOBAL_CLASS_OK = 0,
    BOLTFFI_GLOBAL_CLASS_MISSING = 1,
    BOLTFFI_GLOBAL_CLASS_FATAL = 2
} BoltFFIGlobalClassResult;

static inline BoltFFIGlobalClassResult boltffi_lookup_global_class(
    JNIEnv* env,
    const char* class_name,
    jclass* out_class
) {
    *out_class = NULL;
    jclass local_class = (*env)->FindClass(env, class_name);
    if (local_class == NULL) {
        boltffi_consume_pending_exception(env);
        return BOLTFFI_GLOBAL_CLASS_MISSING;
    }
    jclass global_class = (*env)->NewGlobalRef(env, local_class);
    (*env)->DeleteLocalRef(env, local_class);
    if (global_class == NULL) {
        boltffi_consume_pending_exception(env);
        return BOLTFFI_GLOBAL_CLASS_FATAL;
    }
    *out_class = global_class;
    return BOLTFFI_GLOBAL_CLASS_OK;
}

typedef enum {
    BOLTFFI_STATIC_CALL_CACHE_UNINIT = 0,
    BOLTFFI_STATIC_CALL_CACHE_INITING = 1,
    BOLTFFI_STATIC_CALL_CACHE_READY = 2,
    BOLTFFI_STATIC_CALL_CACHE_FAILED = 3
} BoltFFIStaticCallCacheState;

typedef struct {
    atomic_int state;
    jclass class_ref;
    jmethodID method;
} BoltFFIStaticCallCache;

#define BOLTFFI_STATIC_CALL_CACHE_INIT { 0, NULL, NULL }

static inline bool boltffi_static_call_cache_ensure(
    JNIEnv* env,
    BoltFFIStaticCallCache* cache,
    const char* class_name,
    const char* method_name,
    const char* method_signature
) {
    int state = atomic_load_explicit(&cache->state, memory_order_acquire);
    if (state == BOLTFFI_STATIC_CALL_CACHE_READY) return true;
    if (state == BOLTFFI_STATIC_CALL_CACHE_FAILED) return false;

    int expected = BOLTFFI_STATIC_CALL_CACHE_UNINIT;
    if (atomic_compare_exchange_strong_explicit(
            &cache->state,
            &expected,
            BOLTFFI_STATIC_CALL_CACHE_INITING,
            memory_order_acq_rel,
            memory_order_acquire)) {
        jclass class_ref = NULL;
        jmethodID method = NULL;
        BoltFFIGlobalClassResult class_result =
            boltffi_lookup_global_class(env, class_name, &class_ref);
        if (class_result != BOLTFFI_GLOBAL_CLASS_OK) {
            cache->class_ref = NULL;
            cache->method = NULL;
            atomic_store_explicit(
                &cache->state,
                BOLTFFI_STATIC_CALL_CACHE_FAILED,
                memory_order_release
            );
            return false;
        }
        if (!boltffi_lookup_static_method(env, class_ref, method_name, method_signature, &method)) {
            (*env)->DeleteGlobalRef(env, class_ref);
            cache->class_ref = NULL;
            cache->method = NULL;
            atomic_store_explicit(
                &cache->state,
                BOLTFFI_STATIC_CALL_CACHE_FAILED,
                memory_order_release
            );
            return false;
        }
        cache->class_ref = class_ref;
        cache->method = method;
        atomic_store_explicit(
            &cache->state,
            BOLTFFI_STATIC_CALL_CACHE_READY,
            memory_order_release
        );
        return true;
    }

    do {
        state = atomic_load_explicit(&cache->state, memory_order_acquire);
    } while (state == BOLTFFI_STATIC_CALL_CACHE_INITING);

    return state == BOLTFFI_STATIC_CALL_CACHE_READY;
}

static inline void boltffi_static_call_cache_reset(JNIEnv* env, BoltFFIStaticCallCache* cache) {
    if (cache->class_ref != NULL) {
        (*env)->DeleteGlobalRef(env, cache->class_ref);
        cache->class_ref = NULL;
    }
    cache->method = NULL;
    atomic_store_explicit(&cache->state, BOLTFFI_STATIC_CALL_CACHE_UNINIT, memory_order_release);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1runtime_1manifest_1json(JNIEnv *env, jclass cls) {
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_runtime_manifest_json();
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1take_1last_1open_1error(JNIEnv *env, jclass cls) {
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_take_last_open_error();
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1yjs_1build_1text_1update_1json(JNIEnv *env, jclass cls, jbyteArray args_json) {
    bool _boltffi_input_error = false;

    jbyte _args_json_stack[8];
    uintptr_t _args_json_len = (uintptr_t)(*env)->GetArrayLength(env, args_json);
    uint8_t* _args_json_ptr = NULL;
    bool _args_json_needs_release = false;
    if (_args_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, args_json, 0, (jsize)_args_json_len, _args_json_stack);
        if (boltffi_exception_pending(env)) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_ptr = (uint8_t*)_args_json_stack;
        }
    } else {
        _args_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, args_json, NULL);
        if (_args_json_ptr == NULL) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_yjs_build_text_update_json((const uint8_t*)_args_json_ptr, (uintptr_t)_args_json_len);
boltffi_input_cleanup:
    if (_args_json_needs_release) (*env)->ReleaseByteArrayElements(env, args_json, (jbyte*)_args_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1yjs_1apply_1text_1updates_1json(JNIEnv *env, jclass cls, jbyteArray args_json) {
    bool _boltffi_input_error = false;

    jbyte _args_json_stack[8];
    uintptr_t _args_json_len = (uintptr_t)(*env)->GetArrayLength(env, args_json);
    uint8_t* _args_json_ptr = NULL;
    bool _args_json_needs_release = false;
    if (_args_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, args_json, 0, (jsize)_args_json_len, _args_json_stack);
        if (boltffi_exception_pending(env)) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_ptr = (uint8_t*)_args_json_stack;
        }
    } else {
        _args_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, args_json, NULL);
        if (_args_json_ptr == NULL) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_yjs_apply_text_updates_json((const uint8_t*)_args_json_ptr, (uintptr_t)_args_json_len);
boltffi_input_cleanup:
    if (_args_json_needs_release) (*env)->ReleaseByteArrayElements(env, args_json, (jbyte*)_args_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1yjs_1apply_1envelope_1to_1payload_1json(JNIEnv *env, jclass cls, jbyteArray args_json) {
    bool _boltffi_input_error = false;

    jbyte _args_json_stack[8];
    uintptr_t _args_json_len = (uintptr_t)(*env)->GetArrayLength(env, args_json);
    uint8_t* _args_json_ptr = NULL;
    bool _args_json_needs_release = false;
    if (_args_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, args_json, 0, (jsize)_args_json_len, _args_json_stack);
        if (boltffi_exception_pending(env)) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_ptr = (uint8_t*)_args_json_stack;
        }
    } else {
        _args_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, args_json, NULL);
        if (_args_json_ptr == NULL) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_yjs_apply_envelope_to_payload_json((const uint8_t*)_args_json_ptr, (uintptr_t)_args_json_len);
boltffi_input_cleanup:
    if (_args_json_needs_release) (*env)->ReleaseByteArrayElements(env, args_json, (jbyte*)_args_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1yjs_1materialize_1row_1json(JNIEnv *env, jclass cls, jbyteArray args_json) {
    bool _boltffi_input_error = false;

    jbyte _args_json_stack[8];
    uintptr_t _args_json_len = (uintptr_t)(*env)->GetArrayLength(env, args_json);
    uint8_t* _args_json_ptr = NULL;
    bool _args_json_needs_release = false;
    if (_args_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, args_json, 0, (jsize)_args_json_len, _args_json_stack);
        if (boltffi_exception_pending(env)) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_ptr = (uint8_t*)_args_json_stack;
        }
    } else {
        _args_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, args_json, NULL);
        if (_args_json_ptr == NULL) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_yjs_materialize_row_json((const uint8_t*)_args_json_ptr, (uintptr_t)_args_json_len);
boltffi_input_cleanup:
    if (_args_json_needs_release) (*env)->ReleaseByteArrayElements(env, args_json, (jbyte*)_args_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1encryption_1helper_1json(JNIEnv *env, jclass cls, jbyteArray method, jbyteArray args_json) {
    bool _boltffi_input_error = false;

    jbyte _method_stack[8];
    uintptr_t _method_len = (uintptr_t)(*env)->GetArrayLength(env, method);
    uint8_t* _method_ptr = NULL;
    bool _method_needs_release = false;
    if (_method_len <= 8) {
        (*env)->GetByteArrayRegion(env, method, 0, (jsize)_method_len, _method_stack);
        if (boltffi_exception_pending(env)) {
            _method_len = 0;
            _boltffi_input_error = true;
        } else {
            _method_ptr = (uint8_t*)_method_stack;
        }
    } else {
        _method_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, method, NULL);
        if (_method_ptr == NULL) {
            _method_len = 0;
            _boltffi_input_error = true;
        } else {
            _method_needs_release = true;
        }
    }

    jbyte _args_json_stack[8];
    uintptr_t _args_json_len = (uintptr_t)(*env)->GetArrayLength(env, args_json);
    uint8_t* _args_json_ptr = NULL;
    bool _args_json_needs_release = false;
    if (_args_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, args_json, 0, (jsize)_args_json_len, _args_json_stack);
        if (boltffi_exception_pending(env)) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_ptr = (uint8_t*)_args_json_stack;
        }
    } else {
        _args_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, args_json, NULL);
        if (_args_json_ptr == NULL) {
            _args_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _args_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_encryption_helper_json((const uint8_t*)_method_ptr, (uintptr_t)_method_len, (const uint8_t*)_args_json_ptr, (uintptr_t)_args_json_len);
boltffi_input_cleanup:
    if (_method_needs_release) (*env)->ReleaseByteArrayElements(env, method, (jbyte*)_method_ptr, JNI_ABORT);
    if (_args_json_needs_release) (*env)->ReleaseByteArrayElements(env, args_json, (jbyte*)_args_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}

JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1last_1error_1message(JNIEnv *env, jclass cls) {
    FfiString out = { 0 };
    FfiStatus status = boltffi_last_error_message(&out);
    if (status.code != 0 || out.ptr == NULL || out.len == 0) {
        boltffi_free_string(out);
        return (*env)->NewByteArray(env, 0);
    }
    jbyteArray result = (*env)->NewByteArray(env, (jsize)out.len);
    if (result != NULL) {
        (*env)->SetByteArrayRegion(env, result, 0, (jsize)out.len, (const jbyte*)out.ptr);
    }
    boltffi_free_string(out);
    return result;
}

JNIEXPORT jlong JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1open(JNIEnv *env, jclass cls, jobject config) {
    bool _boltffi_input_error = false;
    jlong _config_size = (*env)->GetDirectBufferCapacity(env, config);
    uint8_t* _config_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, config);
    uintptr_t _config_len = (_config_ptr && _config_size > 0) ? (uintptr_t)_config_size : 0;
    void* _handle = NULL;
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _handle = boltffi_syncular_bolt_client_open((const uint8_t*)_config_ptr, (uintptr_t)_config_len);
boltffi_input_cleanup:
    if (_boltffi_input_error) return 0;
    return (jlong)_handle;
}

JNIEXPORT jlong JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1open_1async(JNIEnv *env, jclass cls, jobject config) {
    bool _boltffi_input_error = false;
    jlong _config_size = (*env)->GetDirectBufferCapacity(env, config);
    uint8_t* _config_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, config);
    uintptr_t _config_len = (_config_ptr && _config_size > 0) ? (uintptr_t)_config_size : 0;
    void* _handle = NULL;
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _handle = boltffi_syncular_bolt_client_open_async((const uint8_t*)_config_ptr, (uintptr_t)_config_len);
boltffi_input_cleanup:
    if (_boltffi_input_error) return 0;
    return (jlong)_handle;
}

JNIEXPORT void JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1free(JNIEnv *env, jclass cls, jlong handle) {
    if (handle != 0) boltffi_syncular_bolt_client_free((void*)handle);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1open_1command_1id(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_open_command_id((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1is_1open_1finished(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_is_open_finished((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1finish_1open_1timeout(JNIEnv *env, jclass cls, jlong handle, jlong timeout_ms) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_finish_open_timeout((void*)handle, timeout_ms);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1runtime_1manifest_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_runtime_manifest_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1set_1auth_1headers_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray headers_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _headers_json_stack[8];
    uintptr_t _headers_json_len = (uintptr_t)(*env)->GetArrayLength(env, headers_json);
    uint8_t* _headers_json_ptr = NULL;
    bool _headers_json_needs_release = false;
    if (_headers_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, headers_json, 0, (jsize)_headers_json_len, _headers_json_stack);
        if (boltffi_exception_pending(env)) {
            _headers_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _headers_json_ptr = (uint8_t*)_headers_json_stack;
        }
    } else {
        _headers_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, headers_json, NULL);
        if (_headers_json_ptr == NULL) {
            _headers_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _headers_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_set_auth_headers_json((void*)handle, (const uint8_t*)_headers_json_ptr, (uintptr_t)_headers_json_len);
boltffi_input_cleanup:
    if (_headers_json_needs_release) (*env)->ReleaseByteArrayElements(env, headers_json, (jbyte*)_headers_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1set_1subscriptions_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray subscriptions_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _subscriptions_json_stack[8];
    uintptr_t _subscriptions_json_len = (uintptr_t)(*env)->GetArrayLength(env, subscriptions_json);
    uint8_t* _subscriptions_json_ptr = NULL;
    bool _subscriptions_json_needs_release = false;
    if (_subscriptions_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, subscriptions_json, 0, (jsize)_subscriptions_json_len, _subscriptions_json_stack);
        if (boltffi_exception_pending(env)) {
            _subscriptions_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _subscriptions_json_ptr = (uint8_t*)_subscriptions_json_stack;
        }
    } else {
        _subscriptions_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, subscriptions_json, NULL);
        if (_subscriptions_json_ptr == NULL) {
            _subscriptions_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _subscriptions_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_set_subscriptions_json((void*)handle, (const uint8_t*)_subscriptions_json_ptr, (uintptr_t)_subscriptions_json_len);
boltffi_input_cleanup:
    if (_subscriptions_json_needs_release) (*env)->ReleaseByteArrayElements(env, subscriptions_json, (jbyte*)_subscriptions_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1force_1subscriptions_1bootstrap_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray subscription_ids_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _subscription_ids_json_stack[8];
    uintptr_t _subscription_ids_json_len = (uintptr_t)(*env)->GetArrayLength(env, subscription_ids_json);
    uint8_t* _subscription_ids_json_ptr = NULL;
    bool _subscription_ids_json_needs_release = false;
    if (_subscription_ids_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, subscription_ids_json, 0, (jsize)_subscription_ids_json_len, _subscription_ids_json_stack);
        if (boltffi_exception_pending(env)) {
            _subscription_ids_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _subscription_ids_json_ptr = (uint8_t*)_subscription_ids_json_stack;
        }
    } else {
        _subscription_ids_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, subscription_ids_json, NULL);
        if (_subscription_ids_json_ptr == NULL) {
            _subscription_ids_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _subscription_ids_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_force_subscriptions_bootstrap_json((void*)handle, (const uint8_t*)_subscription_ids_json_ptr, (uintptr_t)_subscription_ids_json_len);
boltffi_input_cleanup:
    if (_subscription_ids_json_needs_release) (*env)->ReleaseByteArrayElements(env, subscription_ids_json, (jbyte*)_subscription_ids_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1set_1field_1encryption_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray config_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _config_json_stack[8];
    uintptr_t _config_json_len = (uintptr_t)(*env)->GetArrayLength(env, config_json);
    uint8_t* _config_json_ptr = NULL;
    bool _config_json_needs_release = false;
    if (_config_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, config_json, 0, (jsize)_config_json_len, _config_json_stack);
        if (boltffi_exception_pending(env)) {
            _config_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _config_json_ptr = (uint8_t*)_config_json_stack;
        }
    } else {
        _config_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, config_json, NULL);
        if (_config_json_ptr == NULL) {
            _config_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _config_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_set_field_encryption_json((void*)handle, (const uint8_t*)_config_json_ptr, (uintptr_t)_config_json_len);
boltffi_input_cleanup:
    if (_config_json_needs_release) (*env)->ReleaseByteArrayElements(env, config_json, (jbyte*)_config_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1set_1encrypted_1crdt_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray config_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _config_json_stack[8];
    uintptr_t _config_json_len = (uintptr_t)(*env)->GetArrayLength(env, config_json);
    uint8_t* _config_json_ptr = NULL;
    bool _config_json_needs_release = false;
    if (_config_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, config_json, 0, (jsize)_config_json_len, _config_json_stack);
        if (boltffi_exception_pending(env)) {
            _config_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _config_json_ptr = (uint8_t*)_config_json_stack;
        }
    } else {
        _config_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, config_json, NULL);
        if (_config_json_ptr == NULL) {
            _config_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _config_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_set_encrypted_crdt_json((void*)handle, (const uint8_t*)_config_json_ptr, (uintptr_t)_config_json_len);
boltffi_input_cleanup:
    if (_config_json_needs_release) (*env)->ReleaseByteArrayElements(env, config_json, (jbyte*)_config_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1trigger_1sync(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_trigger_sync((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1trigger_1sync_1websocket(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_trigger_sync_websocket((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1sync_1now(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_sync_now((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1sync_1websocket(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_sync_websocket((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1pause_1sync_1worker(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_pause_sync_worker((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1resume_1sync_1worker(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_resume_sync_worker((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1resume_1from_1background(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_resume_from_background((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1sync_1worker_1running(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_sync_worker_running((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1start_1realtime_1worker(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_start_realtime_worker((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1start(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_start((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1stop_1realtime_1worker(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_stop_realtime_worker((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1stop(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_stop((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1join_1presence(JNIEnv *env, jclass cls, jlong handle, jbyteArray scope_key, jobject metadata_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _scope_key_stack[8];
    uintptr_t _scope_key_len = (uintptr_t)(*env)->GetArrayLength(env, scope_key);
    uint8_t* _scope_key_ptr = NULL;
    bool _scope_key_needs_release = false;
    if (_scope_key_len <= 8) {
        (*env)->GetByteArrayRegion(env, scope_key, 0, (jsize)_scope_key_len, _scope_key_stack);
        if (boltffi_exception_pending(env)) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_ptr = (uint8_t*)_scope_key_stack;
        }
    } else {
        _scope_key_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, scope_key, NULL);
        if (_scope_key_ptr == NULL) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_needs_release = true;
        }
    }
    jlong _metadata_json_size = (*env)->GetDirectBufferCapacity(env, metadata_json);
    uint8_t* _metadata_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, metadata_json);
    uintptr_t _metadata_json_len = (_metadata_json_ptr && _metadata_json_size > 0) ? (uintptr_t)_metadata_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_join_presence((void*)handle, (const uint8_t*)_scope_key_ptr, (uintptr_t)_scope_key_len, (const uint8_t*)_metadata_json_ptr, (uintptr_t)_metadata_json_len);
boltffi_input_cleanup:
    if (_scope_key_needs_release) (*env)->ReleaseByteArrayElements(env, scope_key, (jbyte*)_scope_key_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1leave_1presence(JNIEnv *env, jclass cls, jlong handle, jbyteArray scope_key) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _scope_key_stack[8];
    uintptr_t _scope_key_len = (uintptr_t)(*env)->GetArrayLength(env, scope_key);
    uint8_t* _scope_key_ptr = NULL;
    bool _scope_key_needs_release = false;
    if (_scope_key_len <= 8) {
        (*env)->GetByteArrayRegion(env, scope_key, 0, (jsize)_scope_key_len, _scope_key_stack);
        if (boltffi_exception_pending(env)) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_ptr = (uint8_t*)_scope_key_stack;
        }
    } else {
        _scope_key_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, scope_key, NULL);
        if (_scope_key_ptr == NULL) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_leave_presence((void*)handle, (const uint8_t*)_scope_key_ptr, (uintptr_t)_scope_key_len);
boltffi_input_cleanup:
    if (_scope_key_needs_release) (*env)->ReleaseByteArrayElements(env, scope_key, (jbyte*)_scope_key_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1update_1presence_1metadata(JNIEnv *env, jclass cls, jlong handle, jbyteArray scope_key, jbyteArray metadata_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _scope_key_stack[8];
    uintptr_t _scope_key_len = (uintptr_t)(*env)->GetArrayLength(env, scope_key);
    uint8_t* _scope_key_ptr = NULL;
    bool _scope_key_needs_release = false;
    if (_scope_key_len <= 8) {
        (*env)->GetByteArrayRegion(env, scope_key, 0, (jsize)_scope_key_len, _scope_key_stack);
        if (boltffi_exception_pending(env)) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_ptr = (uint8_t*)_scope_key_stack;
        }
    } else {
        _scope_key_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, scope_key, NULL);
        if (_scope_key_ptr == NULL) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_needs_release = true;
        }
    }

    jbyte _metadata_json_stack[8];
    uintptr_t _metadata_json_len = (uintptr_t)(*env)->GetArrayLength(env, metadata_json);
    uint8_t* _metadata_json_ptr = NULL;
    bool _metadata_json_needs_release = false;
    if (_metadata_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, metadata_json, 0, (jsize)_metadata_json_len, _metadata_json_stack);
        if (boltffi_exception_pending(env)) {
            _metadata_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _metadata_json_ptr = (uint8_t*)_metadata_json_stack;
        }
    } else {
        _metadata_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, metadata_json, NULL);
        if (_metadata_json_ptr == NULL) {
            _metadata_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _metadata_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_update_presence_metadata((void*)handle, (const uint8_t*)_scope_key_ptr, (uintptr_t)_scope_key_len, (const uint8_t*)_metadata_json_ptr, (uintptr_t)_metadata_json_len);
boltffi_input_cleanup:
    if (_scope_key_needs_release) (*env)->ReleaseByteArrayElements(env, scope_key, (jbyte*)_scope_key_ptr, JNI_ABORT);
    if (_metadata_json_needs_release) (*env)->ReleaseByteArrayElements(env, metadata_json, (jbyte*)_metadata_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1presence_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray scope_key) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _scope_key_stack[8];
    uintptr_t _scope_key_len = (uintptr_t)(*env)->GetArrayLength(env, scope_key);
    uint8_t* _scope_key_ptr = NULL;
    bool _scope_key_needs_release = false;
    if (_scope_key_len <= 8) {
        (*env)->GetByteArrayRegion(env, scope_key, 0, (jsize)_scope_key_len, _scope_key_stack);
        if (boltffi_exception_pending(env)) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_ptr = (uint8_t*)_scope_key_stack;
        }
    } else {
        _scope_key_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, scope_key, NULL);
        if (_scope_key_ptr == NULL) {
            _scope_key_len = 0;
            _boltffi_input_error = true;
        } else {
            _scope_key_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_presence_json((void*)handle, (const uint8_t*)_scope_key_ptr, (uintptr_t)_scope_key_len);
boltffi_input_cleanup:
    if (_scope_key_needs_release) (*env)->ReleaseByteArrayElements(env, scope_key, (jbyte*)_scope_key_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1start_1event_1stream(JNIEnv *env, jclass cls, jlong handle, jlong capacity) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_start_event_stream((void*)handle, capacity);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1next_1event_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_next_event_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1next_1event_1json_1timeout(JNIEnv *env, jclass cls, jlong handle, jlong timeout_ms) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_next_event_json_timeout((void*)handle, timeout_ms);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1close_1event_1stream(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_close_event_stream((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1apply_1mutation_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray mutation_json, jobject local_row_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _mutation_json_stack[8];
    uintptr_t _mutation_json_len = (uintptr_t)(*env)->GetArrayLength(env, mutation_json);
    uint8_t* _mutation_json_ptr = NULL;
    bool _mutation_json_needs_release = false;
    if (_mutation_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, mutation_json, 0, (jsize)_mutation_json_len, _mutation_json_stack);
        if (boltffi_exception_pending(env)) {
            _mutation_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _mutation_json_ptr = (uint8_t*)_mutation_json_stack;
        }
    } else {
        _mutation_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, mutation_json, NULL);
        if (_mutation_json_ptr == NULL) {
            _mutation_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _mutation_json_needs_release = true;
        }
    }
    jlong _local_row_json_size = (*env)->GetDirectBufferCapacity(env, local_row_json);
    uint8_t* _local_row_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, local_row_json);
    uintptr_t _local_row_json_len = (_local_row_json_ptr && _local_row_json_size > 0) ? (uintptr_t)_local_row_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_apply_mutation_json((void*)handle, (const uint8_t*)_mutation_json_ptr, (uintptr_t)_mutation_json_len, (const uint8_t*)_local_row_json_ptr, (uintptr_t)_local_row_json_len);
boltffi_input_cleanup:
    if (_mutation_json_needs_release) (*env)->ReleaseByteArrayElements(env, mutation_json, (jbyte*)_mutation_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1mutation_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray mutation_json, jobject local_row_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _mutation_json_stack[8];
    uintptr_t _mutation_json_len = (uintptr_t)(*env)->GetArrayLength(env, mutation_json);
    uint8_t* _mutation_json_ptr = NULL;
    bool _mutation_json_needs_release = false;
    if (_mutation_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, mutation_json, 0, (jsize)_mutation_json_len, _mutation_json_stack);
        if (boltffi_exception_pending(env)) {
            _mutation_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _mutation_json_ptr = (uint8_t*)_mutation_json_stack;
        }
    } else {
        _mutation_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, mutation_json, NULL);
        if (_mutation_json_ptr == NULL) {
            _mutation_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _mutation_json_needs_release = true;
        }
    }
    jlong _local_row_json_size = (*env)->GetDirectBufferCapacity(env, local_row_json);
    uint8_t* _local_row_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, local_row_json);
    uintptr_t _local_row_json_len = (_local_row_json_ptr && _local_row_json_size > 0) ? (uintptr_t)_local_row_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_mutation_json((void*)handle, (const uint8_t*)_mutation_json_ptr, (uintptr_t)_mutation_json_len, (const uint8_t*)_local_row_json_ptr, (uintptr_t)_local_row_json_len);
boltffi_input_cleanup:
    if (_mutation_json_needs_release) (*env)->ReleaseByteArrayElements(env, mutation_json, (jbyte*)_mutation_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1yjs_1update_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray update_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _update_json_stack[8];
    uintptr_t _update_json_len = (uintptr_t)(*env)->GetArrayLength(env, update_json);
    uint8_t* _update_json_ptr = NULL;
    bool _update_json_needs_release = false;
    if (_update_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, update_json, 0, (jsize)_update_json_len, _update_json_stack);
        if (boltffi_exception_pending(env)) {
            _update_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _update_json_ptr = (uint8_t*)_update_json_stack;
        }
    } else {
        _update_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, update_json, NULL);
        if (_update_json_ptr == NULL) {
            _update_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _update_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_yjs_update_json((void*)handle, (const uint8_t*)_update_json_ptr, (uintptr_t)_update_json_len);
boltffi_input_cleanup:
    if (_update_json_needs_release) (*env)->ReleaseByteArrayElements(env, update_json, (jbyte*)_update_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1open_1crdt_1field_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_open_crdt_field_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1apply_1crdt_1field_1text_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_apply_crdt_field_text_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1apply_1crdt_1field_1yjs_1update_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_apply_crdt_field_yjs_update_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1crdt_1field_1yjs_1update_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_crdt_field_yjs_update_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1crdt_1field_1text_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_crdt_field_text_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1crdt_1field_1compaction_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_crdt_field_compaction_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1materialize_1crdt_1field_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_materialize_crdt_field_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1crdt_1document_1snapshot_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_crdt_document_snapshot_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1crdt_1update_1log_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_crdt_update_log_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1snapshot_1crdt_1field_1state_1vector_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_snapshot_crdt_field_state_vector_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1compact_1crdt_1field_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_compact_crdt_field_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1apply_1encrypted_1crdt_1update_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_apply_encrypted_crdt_update_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1encrypted_1crdt_1update_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_encrypted_crdt_update_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1apply_1encrypted_1crdt_1checkpoint_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_apply_encrypted_crdt_checkpoint_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1encrypted_1crdt_1checkpoint_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_encrypted_crdt_checkpoint_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1list_1table_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray table) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _table_stack[8];
    uintptr_t _table_len = (uintptr_t)(*env)->GetArrayLength(env, table);
    uint8_t* _table_ptr = NULL;
    bool _table_needs_release = false;
    if (_table_len <= 8) {
        (*env)->GetByteArrayRegion(env, table, 0, (jsize)_table_len, _table_stack);
        if (boltffi_exception_pending(env)) {
            _table_len = 0;
            _boltffi_input_error = true;
        } else {
            _table_ptr = (uint8_t*)_table_stack;
        }
    } else {
        _table_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, table, NULL);
        if (_table_ptr == NULL) {
            _table_len = 0;
            _boltffi_input_error = true;
        } else {
            _table_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_list_table_json((void*)handle, (const uint8_t*)_table_ptr, (uintptr_t)_table_len);
boltffi_input_cleanup:
    if (_table_needs_release) (*env)->ReleaseByteArrayElements(env, table, (jbyte*)_table_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1query_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_query_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1refresh_1snapshot_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_refresh_snapshot_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1store_1blob_1file_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray path, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _path_stack[8];
    uintptr_t _path_len = (uintptr_t)(*env)->GetArrayLength(env, path);
    uint8_t* _path_ptr = NULL;
    bool _path_needs_release = false;
    if (_path_len <= 8) {
        (*env)->GetByteArrayRegion(env, path, 0, (jsize)_path_len, _path_stack);
        if (boltffi_exception_pending(env)) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_ptr = (uint8_t*)_path_stack;
        }
    } else {
        _path_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, path, NULL);
        if (_path_ptr == NULL) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_needs_release = true;
        }
    }
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_store_blob_file_json((void*)handle, (const uint8_t*)_path_ptr, (uintptr_t)_path_len, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_path_needs_release) (*env)->ReleaseByteArrayElements(env, path, (jbyte*)_path_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1store_1blob_1file_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray path, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _path_stack[8];
    uintptr_t _path_len = (uintptr_t)(*env)->GetArrayLength(env, path);
    uint8_t* _path_ptr = NULL;
    bool _path_needs_release = false;
    if (_path_len <= 8) {
        (*env)->GetByteArrayRegion(env, path, 0, (jsize)_path_len, _path_stack);
        if (boltffi_exception_pending(env)) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_ptr = (uint8_t*)_path_stack;
        }
    } else {
        _path_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, path, NULL);
        if (_path_ptr == NULL) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_needs_release = true;
        }
    }
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_store_blob_file_json((void*)handle, (const uint8_t*)_path_ptr, (uintptr_t)_path_len, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_path_needs_release) (*env)->ReleaseByteArrayElements(env, path, (jbyte*)_path_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1retrieve_1blob_1file_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray ref_json, jbyteArray path, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _ref_json_stack[8];
    uintptr_t _ref_json_len = (uintptr_t)(*env)->GetArrayLength(env, ref_json);
    uint8_t* _ref_json_ptr = NULL;
    bool _ref_json_needs_release = false;
    if (_ref_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, ref_json, 0, (jsize)_ref_json_len, _ref_json_stack);
        if (boltffi_exception_pending(env)) {
            _ref_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _ref_json_ptr = (uint8_t*)_ref_json_stack;
        }
    } else {
        _ref_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, ref_json, NULL);
        if (_ref_json_ptr == NULL) {
            _ref_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _ref_json_needs_release = true;
        }
    }

    jbyte _path_stack[8];
    uintptr_t _path_len = (uintptr_t)(*env)->GetArrayLength(env, path);
    uint8_t* _path_ptr = NULL;
    bool _path_needs_release = false;
    if (_path_len <= 8) {
        (*env)->GetByteArrayRegion(env, path, 0, (jsize)_path_len, _path_stack);
        if (boltffi_exception_pending(env)) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_ptr = (uint8_t*)_path_stack;
        }
    } else {
        _path_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, path, NULL);
        if (_path_ptr == NULL) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_needs_release = true;
        }
    }
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_retrieve_blob_file_json((void*)handle, (const uint8_t*)_ref_json_ptr, (uintptr_t)_ref_json_len, (const uint8_t*)_path_ptr, (uintptr_t)_path_len, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_ref_json_needs_release) (*env)->ReleaseByteArrayElements(env, ref_json, (jbyte*)_ref_json_ptr, JNI_ABORT);
    if (_path_needs_release) (*env)->ReleaseByteArrayElements(env, path, (jbyte*)_path_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1retrieve_1blob_1file_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray ref_json, jbyteArray path, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _ref_json_stack[8];
    uintptr_t _ref_json_len = (uintptr_t)(*env)->GetArrayLength(env, ref_json);
    uint8_t* _ref_json_ptr = NULL;
    bool _ref_json_needs_release = false;
    if (_ref_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, ref_json, 0, (jsize)_ref_json_len, _ref_json_stack);
        if (boltffi_exception_pending(env)) {
            _ref_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _ref_json_ptr = (uint8_t*)_ref_json_stack;
        }
    } else {
        _ref_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, ref_json, NULL);
        if (_ref_json_ptr == NULL) {
            _ref_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _ref_json_needs_release = true;
        }
    }

    jbyte _path_stack[8];
    uintptr_t _path_len = (uintptr_t)(*env)->GetArrayLength(env, path);
    uint8_t* _path_ptr = NULL;
    bool _path_needs_release = false;
    if (_path_len <= 8) {
        (*env)->GetByteArrayRegion(env, path, 0, (jsize)_path_len, _path_stack);
        if (boltffi_exception_pending(env)) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_ptr = (uint8_t*)_path_stack;
        }
    } else {
        _path_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, path, NULL);
        if (_path_ptr == NULL) {
            _path_len = 0;
            _boltffi_input_error = true;
        } else {
            _path_needs_release = true;
        }
    }
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_retrieve_blob_file_json((void*)handle, (const uint8_t*)_ref_json_ptr, (uintptr_t)_ref_json_len, (const uint8_t*)_path_ptr, (uintptr_t)_path_len, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_ref_json_needs_release) (*env)->ReleaseByteArrayElements(env, ref_json, (jbyte*)_ref_json_ptr, JNI_ABORT);
    if (_path_needs_release) (*env)->ReleaseByteArrayElements(env, path, (jbyte*)_path_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1is_1blob_1local(JNIEnv *env, jclass cls, jlong handle, jbyteArray hash) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _hash_stack[8];
    uintptr_t _hash_len = (uintptr_t)(*env)->GetArrayLength(env, hash);
    uint8_t* _hash_ptr = NULL;
    bool _hash_needs_release = false;
    if (_hash_len <= 8) {
        (*env)->GetByteArrayRegion(env, hash, 0, (jsize)_hash_len, _hash_stack);
        if (boltffi_exception_pending(env)) {
            _hash_len = 0;
            _boltffi_input_error = true;
        } else {
            _hash_ptr = (uint8_t*)_hash_stack;
        }
    } else {
        _hash_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, hash, NULL);
        if (_hash_ptr == NULL) {
            _hash_len = 0;
            _boltffi_input_error = true;
        } else {
            _hash_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_is_blob_local((void*)handle, (const uint8_t*)_hash_ptr, (uintptr_t)_hash_len);
boltffi_input_cleanup:
    if (_hash_needs_release) (*env)->ReleaseByteArrayElements(env, hash, (jbyte*)_hash_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1process_1blob_1upload_1queue_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_process_blob_upload_queue_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1process_1blob_1upload_1queue(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_process_blob_upload_queue((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1blob_1upload_1queue_1stats_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_blob_upload_queue_stats_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1blob_1cache_1stats_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_blob_cache_stats_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1prune_1blob_1cache(JNIEnv *env, jclass cls, jlong handle, jlong max_bytes) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_prune_blob_cache((void*)handle, max_bytes);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1prune_1blob_1cache(JNIEnv *env, jclass cls, jlong handle, jlong max_bytes) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_prune_blob_cache((void*)handle, max_bytes);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1clear_1blob_1cache(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_clear_blob_cache((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1clear_1blob_1cache(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_clear_blob_cache((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1compact_1storage_1json(JNIEnv *env, jclass cls, jlong handle, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_compact_storage_json((void*)handle, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1compact_1storage_1json(JNIEnv *env, jclass cls, jlong handle, jobject options_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    jlong _options_json_size = (*env)->GetDirectBufferCapacity(env, options_json);
    uint8_t* _options_json_ptr = (uint8_t*)(*env)->GetDirectBufferAddress(env, options_json);
    uintptr_t _options_json_len = (_options_json_ptr && _options_json_size > 0) ? (uintptr_t)_options_json_size : 0;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_compact_storage_json((void*)handle, (const uint8_t*)_options_json_ptr, (uintptr_t)_options_json_len);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1app_1tables_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_app_tables_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1app_1table_1metadata_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_app_table_metadata_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1app_1schema_1state_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_app_schema_state_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1register_1query_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray query_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _query_json_stack[8];
    uintptr_t _query_json_len = (uintptr_t)(*env)->GetArrayLength(env, query_json);
    uint8_t* _query_json_ptr = NULL;
    bool _query_json_needs_release = false;
    if (_query_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, query_json, 0, (jsize)_query_json_len, _query_json_stack);
        if (boltffi_exception_pending(env)) {
            _query_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _query_json_ptr = (uint8_t*)_query_json_stack;
        }
    } else {
        _query_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, query_json, NULL);
        if (_query_json_ptr == NULL) {
            _query_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _query_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_register_query_json((void*)handle, (const uint8_t*)_query_json_ptr, (uintptr_t)_query_json_len);
boltffi_input_cleanup:
    if (_query_json_needs_release) (*env)->ReleaseByteArrayElements(env, query_json, (jbyte*)_query_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1unregister_1query(JNIEnv *env, jclass cls, jlong handle, jbyteArray id) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _id_stack[8];
    uintptr_t _id_len = (uintptr_t)(*env)->GetArrayLength(env, id);
    uint8_t* _id_ptr = NULL;
    bool _id_needs_release = false;
    if (_id_len <= 8) {
        (*env)->GetByteArrayRegion(env, id, 0, (jsize)_id_len, _id_stack);
        if (boltffi_exception_pending(env)) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_ptr = (uint8_t*)_id_stack;
        }
    } else {
        _id_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, id, NULL);
        if (_id_ptr == NULL) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_unregister_query((void*)handle, (const uint8_t*)_id_ptr, (uintptr_t)_id_len);
boltffi_input_cleanup:
    if (_id_needs_release) (*env)->ReleaseByteArrayElements(env, id, (jbyte*)_id_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1observed_1queries_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_observed_queries_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1diagnostic_1snapshot_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_diagnostic_snapshot_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1local_1health_1check_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_local_health_check_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1repair_1local_1health_1json(JNIEnv *env, jclass cls, jlong handle, jbyteArray request_json) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _request_json_stack[8];
    uintptr_t _request_json_len = (uintptr_t)(*env)->GetArrayLength(env, request_json);
    uint8_t* _request_json_ptr = NULL;
    bool _request_json_needs_release = false;
    if (_request_json_len <= 8) {
        (*env)->GetByteArrayRegion(env, request_json, 0, (jsize)_request_json_len, _request_json_stack);
        if (boltffi_exception_pending(env)) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_ptr = (uint8_t*)_request_json_stack;
        }
    } else {
        _request_json_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, request_json, NULL);
        if (_request_json_ptr == NULL) {
            _request_json_len = 0;
            _boltffi_input_error = true;
        } else {
            _request_json_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_repair_local_health_json((void*)handle, (const uint8_t*)_request_json_ptr, (uintptr_t)_request_json_len);
boltffi_input_cleanup:
    if (_request_json_needs_release) (*env)->ReleaseByteArrayElements(env, request_json, (jbyte*)_request_json_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1outbox_1summaries_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_outbox_summaries_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1conflict_1summaries_1json(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_conflict_summaries_json((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1resolve_1conflict(JNIEnv *env, jclass cls, jlong handle, jbyteArray id, jbyteArray resolution) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _id_stack[8];
    uintptr_t _id_len = (uintptr_t)(*env)->GetArrayLength(env, id);
    uint8_t* _id_ptr = NULL;
    bool _id_needs_release = false;
    if (_id_len <= 8) {
        (*env)->GetByteArrayRegion(env, id, 0, (jsize)_id_len, _id_stack);
        if (boltffi_exception_pending(env)) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_ptr = (uint8_t*)_id_stack;
        }
    } else {
        _id_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, id, NULL);
        if (_id_ptr == NULL) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_needs_release = true;
        }
    }

    jbyte _resolution_stack[8];
    uintptr_t _resolution_len = (uintptr_t)(*env)->GetArrayLength(env, resolution);
    uint8_t* _resolution_ptr = NULL;
    bool _resolution_needs_release = false;
    if (_resolution_len <= 8) {
        (*env)->GetByteArrayRegion(env, resolution, 0, (jsize)_resolution_len, _resolution_stack);
        if (boltffi_exception_pending(env)) {
            _resolution_len = 0;
            _boltffi_input_error = true;
        } else {
            _resolution_ptr = (uint8_t*)_resolution_stack;
        }
    } else {
        _resolution_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, resolution, NULL);
        if (_resolution_ptr == NULL) {
            _resolution_len = 0;
            _boltffi_input_error = true;
        } else {
            _resolution_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_resolve_conflict((void*)handle, (const uint8_t*)_id_ptr, (uintptr_t)_id_len, (const uint8_t*)_resolution_ptr, (uintptr_t)_resolution_len);
boltffi_input_cleanup:
    if (_id_needs_release) (*env)->ReleaseByteArrayElements(env, id, (jbyte*)_id_ptr, JNI_ABORT);
    if (_resolution_needs_release) (*env)->ReleaseByteArrayElements(env, resolution, (jbyte*)_resolution_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1enqueue_1resolve_1conflict(JNIEnv *env, jclass cls, jlong handle, jbyteArray id, jbyteArray resolution) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _id_stack[8];
    uintptr_t _id_len = (uintptr_t)(*env)->GetArrayLength(env, id);
    uint8_t* _id_ptr = NULL;
    bool _id_needs_release = false;
    if (_id_len <= 8) {
        (*env)->GetByteArrayRegion(env, id, 0, (jsize)_id_len, _id_stack);
        if (boltffi_exception_pending(env)) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_ptr = (uint8_t*)_id_stack;
        }
    } else {
        _id_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, id, NULL);
        if (_id_ptr == NULL) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_needs_release = true;
        }
    }

    jbyte _resolution_stack[8];
    uintptr_t _resolution_len = (uintptr_t)(*env)->GetArrayLength(env, resolution);
    uint8_t* _resolution_ptr = NULL;
    bool _resolution_needs_release = false;
    if (_resolution_len <= 8) {
        (*env)->GetByteArrayRegion(env, resolution, 0, (jsize)_resolution_len, _resolution_stack);
        if (boltffi_exception_pending(env)) {
            _resolution_len = 0;
            _boltffi_input_error = true;
        } else {
            _resolution_ptr = (uint8_t*)_resolution_stack;
        }
    } else {
        _resolution_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, resolution, NULL);
        if (_resolution_ptr == NULL) {
            _resolution_len = 0;
            _boltffi_input_error = true;
        } else {
            _resolution_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_enqueue_resolve_conflict((void*)handle, (const uint8_t*)_id_ptr, (uintptr_t)_id_len, (const uint8_t*)_resolution_ptr, (uintptr_t)_resolution_len);
boltffi_input_cleanup:
    if (_id_needs_release) (*env)->ReleaseByteArrayElements(env, id, (jbyte*)_id_ptr, JNI_ABORT);
    if (_resolution_needs_release) (*env)->ReleaseByteArrayElements(env, resolution, (jbyte*)_resolution_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1retry_1conflict_1keep_1local(JNIEnv *env, jclass cls, jlong handle, jbyteArray id) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;

    jbyte _id_stack[8];
    uintptr_t _id_len = (uintptr_t)(*env)->GetArrayLength(env, id);
    uint8_t* _id_ptr = NULL;
    bool _id_needs_release = false;
    if (_id_len <= 8) {
        (*env)->GetByteArrayRegion(env, id, 0, (jsize)_id_len, _id_stack);
        if (boltffi_exception_pending(env)) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_ptr = (uint8_t*)_id_stack;
        }
    } else {
        _id_ptr = (uint8_t*)(*env)->GetByteArrayElements(env, id, NULL);
        if (_id_ptr == NULL) {
            _id_len = 0;
            _boltffi_input_error = true;
        } else {
            _id_needs_release = true;
        }
    }
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_retry_conflict_keep_local((void*)handle, (const uint8_t*)_id_ptr, (uintptr_t)_id_len);
boltffi_input_cleanup:
    if (_id_needs_release) (*env)->ReleaseByteArrayElements(env, id, (jbyte*)_id_ptr, JNI_ABORT);
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}
JNIEXPORT jbyteArray JNICALL Java_dev_syncular_client_Native_boltffi_1syncular_1bolt_1client_1shutdown(JNIEnv *env, jclass cls, jlong handle) {
    if (handle == 0) return NULL;
    bool _boltffi_input_error = false;
    FfiBuf_u8 _buf = {0};
    if (_boltffi_input_error) goto boltffi_input_cleanup;
    _buf = boltffi_syncular_bolt_client_shutdown((void*)handle);
boltffi_input_cleanup:
    if (_boltffi_input_error) return NULL;
    return boltffi_buf_to_jbytearray(env, _buf);
}