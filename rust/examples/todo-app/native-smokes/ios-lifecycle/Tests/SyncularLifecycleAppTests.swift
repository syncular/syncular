import XCTest
@testable import SyncularLifecycleApp

final class SyncularLifecycleAppTests: XCTestCase {
    func testSyncularNativeLifecycleInsideIOSApp() throws {
        try SyncularIOSLifecycleScenario.run()
    }
}
