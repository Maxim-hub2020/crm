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
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNil(payload["id"])
        XCTAssertEqual(try JSONDecoder().decode(ScannedElement.self, from: data).type, "socket_single")
    }
}

@MainActor
final class NativeBridgeTests: XCTestCase {
    func testAppDeclaresCameraPermission() {
        let description = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String
        XCTAssertFalse(description?.isEmpty ?? true)
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, "6")
    }

    func testMobileConfigurationAnnouncesNativeBridgeBeforePageScripts() {
        let configuration = CRMWebView.configuration()
        XCTAssertEqual(configuration.defaultWebpagePreferences.preferredContentMode, .mobile)
        XCTAssertTrue(configuration.applicationNameForUserAgent?.contains("CEHCRM-iOS/") == true)
        let script = configuration.userContentController.userScripts.first
        XCTAssertEqual(script?.injectionTime, .atDocumentStart)
        XCTAssertEqual(script?.isForMainFrameOnly, true)
        XCTAssertTrue(script?.source.contains("CEHCRMNative") == true)
        XCTAssertTrue(script?.source.contains("route: true") == true)
        XCTAssertTrue(script?.source.contains("location.origin !== info.origin") == true)
    }

    func testYandexRouteBridgeAcceptsOnlyExpectedDestinationAndSchemes() {
        let message = [
            "action": "openRoute",
            "url": "https://yandex.ru/maps/?mode=routes&rtext=~47.23,39.71&rtt=auto",
            "mapsUrl": "yandexmaps://build_route_on_map/?lat_to=47.23&lon_to=39.71",
            "navigatorUrl": "yandexnavi://build_route_on_map?lat_to=47.23&lon_to=39.71",
        ]
        XCTAssertEqual(URL(string: message["url"]!)?.host, "yandex.ru")
        XCTAssertTrue(["/maps", "/maps/"].contains(URL(string: message["url"]!)?.path ?? ""))
        XCTAssertEqual(URLComponents(string: message["url"]!)?.queryItems?.first(where: { $0.name == "mode" })?.value, "routes")
        XCTAssertEqual(URL(string: message["mapsUrl"]!)?.scheme, "yandexmaps")
        XCTAssertNotNil(YandexRouteLink(message: message))
        var changed = message
        changed["url"] = "https://example.com/maps/?mode=routes&rtext=~test"
        XCTAssertNil(YandexRouteLink(message: changed))
        changed = message
        changed["mapsUrl"] = "yandexmaps://other-host/"
        XCTAssertNil(YandexRouteLink(message: changed))
        changed = message
        changed["mapsUrl"] = "yandexmaps://maps.yandex.ru/?text=address"
        XCTAssertNil(YandexRouteLink(message: changed))
    }
}
