require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# The syncular React Native module podspec.
#
# Links the native core as a prebuilt `Syncular.xcframework` (produced by
# `rust/scripts/build-native.sh apple` on a full-Xcode machine — iOS device +
# simulator + macOS slices). The framework embeds `ffi.h` (a copy of
# rust/ffi.h), so `ios/Syncular.mm` compiles against `#import "ffi.h"`.
#
# Consuming apps run `pod install`; the xcframework must be present at
# `ios/Syncular.xcframework` (drop it there from build-native.sh's output, or
# wire a `prepare_command`/download step in your app's Podfile). It is not
# committed to this repo — it is a build artifact.
Pod::Spec.new do |s|
  s.name         = "syncular-react-native"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = "https://github.com/bkniffler/syncular"
  s.license      = "MIT"
  s.authors      = "syncular"
  s.platforms    = { :ios => "14.0" }
  s.source       = { :git => "https://github.com/bkniffler/syncular.git" }

  s.source_files = "ios/**/*.{h,m,mm}"

  # The prebuilt native core. Present after build-native.sh assembles it.
  s.vendored_frameworks = "ios/Syncular.xcframework"

  # React Native dependency (Fabric/TurboModule aware). `install_modules_dependencies`
  # wires the correct RN pods and the new-arch flags for both architectures.
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
