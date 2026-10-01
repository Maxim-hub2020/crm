import XCTest
import WebKit
@testable import CEHCRM

final class ScanRequestTests: XCTestCase {
    let session = "01234567-89ab-cdef-0123-456789abcdef"

    private func link(upload: String? = nil, extra: [URLQueryItem] = []) -> URL {
        var url = URLComponents(string: "cehcrm-lidar://scan")!
        url.queryItems = [
            URLQueryItem(name: "session", value: session),
            URLQueryItem(name: "token", value: "test-token"),
            URLQueryItem(name: "upload_url", value: upload ?? "https://cehcrm.ru/api/measurement-scan-sessions/\(session)/complete/")
        ] + extra
        return url.url!
    }

    func testValidRequest() {
        XCTAssertEqual(ScanRequest(url: link())?.sessionID, session)
    }

    func testRejectsDuplicateKeys() {
        XCTAssertNil(ScanRequest(url: link(extra: [URLQueryItem(name: "token", value: "duplicate")])))
    }

    func testRejectsUntrustedDestinations() {
        for url in ["https://example.com/upload", "http://cehcrm.ru/upload", "https://cehcrm.ru:8443/upload", "https://cehcrm.ru/api/other/"] {
            XCTAssertNil(ScanRequest(url: link(upload: url)))
        }
    }

    func testRejectsDifferentSessionAndQuery() {
        let base = "https://cehcrm.ru/api/measurement-scan-sessions/"
        XCTAssertNil(ScanRequest(url: link(upload: base + "aaaaaaaa-89ab-cdef-0123-456789abcdef/complete/")))
        XCTAssertNil(ScanRequest(url: link(upload: base + session + "/complete/?redirect=other")))
    }

    func testResultRoundTrip() throws {
        let element = ScannedElement(type: "socket_single", x: 0.5, y: 0.5, confidence: 0.5, label: "Test")
        let data = try JSONEncoder().encode(element)
        XCTAssertEqual(try JSONDecoder().decode(ScannedElement.self, from: data).type, "socket_single")
    }
}

@MainActor
final class NativeBridgeTests: XCTestCase {
    func testAppDeclaresCameraPermission() {
        let description = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String
        XCTAssertFalse(description?.isEmpty ?? true)
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, "4")
    }

    func testMobileConfigurationAnnouncesNativeBridgeBeforePageScripts() {
        let configuration = CRMWebView.configuration()
        XCTAssertEqual(configuration.defaultWebpagePreferences.preferredContentMode, .mobile)
        XCTAssertTrue(configuration.applicationNameForUserAgent?.contains("CEHCRM-iOS/") == true)
        let script = configuration.userContentController.userScripts.first
        XCTAssertEqual(script?.injectionTime, .atDocumentStart)
        XCTAssertEqual(script?.isForMainFrameOnly, true)
        XCTAssertTrue(script?.source.contains("CEHCRMNative") == true)
        XCTAssertTrue(script?.source.contains("location.origin !== info.origin") == true)
    }
}
