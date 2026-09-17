/* This translation unit exists so that the CSyncularFFI clang target has a
 * source file. SwiftPM's swiftbuild engine puts a `<Target>.o` at
 * `.build/out/Products/<config>/CSyncularFFI.o` into every library product's
 * libtool file list, but a header-only clang target compiles nothing and so
 * never produces that object, and `swift build` dies with "Build input file
 * cannot be found: .../CSyncularFFI.o". The repo's Swift bindings are the only
 * place this shape appears; keep this file until SwiftPM stops referencing
 * sources-less clang targets from the product link step. */
